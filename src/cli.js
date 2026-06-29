#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadEnv, envBool, envInt } from "./env.js";
import { logger } from "./logger.js";
import { loadSourceConfig } from "./config.js";
import { collectFromConfig } from "./connectors/index.js";
import { appendJsonl, readJsonl, readJson, readLatestReport, readManualSignals, writeText, writeJson, compactSignals } from "./storage.js";
import { dedupeSignals } from "./dedupe.js";
import { scoreSignals } from "./scoring.js";
import { generateReport, selectReportSignals, assessDayStrength } from "./report.js";
import { postReport, postBriefWithFeedback } from "./clickup.js";
import { isAvailable as llmAvailable, classifyAndFilter, interpretSignals, synthesizeBrief, unload as llmUnload } from "./llm.js";
import { isPolishEnabled, polishBrief } from "./polish.js";
import { applyLearnedWeights, learnFromReactions, recordPostedSignals, getExcludedIds } from "./feedback.js";

loadEnv();

const command = process.argv[2] || "help";
const maxItems = envInt("MAX_ITEMS_PER_SOURCE", 15);

function isWeekend(date = new Date()) {
  return [0, 6].includes(date.getDay());
}

async function setup() {
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), "logs"), { recursive: true });
  if (!fs.existsSync(path.join(process.cwd(), ".env"))) {
    fs.copyFileSync(path.join(process.cwd(), ".env.example"), path.join(process.cwd(), ".env"));
  }
  logger.info("Setup complete. Edit .env and config/sources.json next.");
}

function buildConnectorStatus(config, items, failures, runId) {
  const countsBySource = items.reduce((acc, item) => {
    acc[item.sourceId] = (acc[item.sourceId] ?? 0) + 1;
    return acc;
  }, {});
  const failureBySource = new Map(failures.map((failure) => [failure.sourceId, failure.message]));

  const sources = [];
  for (const list of Object.values(config)) {
    if (!Array.isArray(list)) continue;
    for (const source of list.filter((item) => item.enabled)) {
      const items = countsBySource[source.id] ?? 0;
      const error = failureBySource.get(source.id) ?? null;
      sources.push({
        sourceId: source.id,
        name: source.name,
        items,
        status: error ? "error" : items > 0 ? "ok" : "empty",
        error
      });
    }
  }
  return { runId, generatedAt: runId, sources };
}

async function collect() {
  const config = loadSourceConfig();
  const runId = new Date().toISOString();
  const { items, failures } = await collectFromConfig(config, maxItems);
  const stamped = items.map((item) => ({ ...item, runId }));
  appendJsonl("signals.jsonl", stamped);

  const retentionDays = envInt("SIGNAL_RETENTION_DAYS", 14);
  const compaction = compactSignals("signals.jsonl", retentionDays);

  writeJson("connector-status.json", buildConnectorStatus(config, items, failures, runId));

  logger.info(`Collected ${stamped.length} raw signals`, {
    failures: failures.length,
    storeKept: compaction.kept,
    storeRemoved: compaction.removed
  });
  if (failures.length) appendJsonl("connector-failures.jsonl", failures.map((failure) => ({ ...failure, ts: runId })));
  return stamped;
}

async function testConnectors() {
  const config = loadSourceConfig();
  const { items, failures } = await collectFromConfig(config, 3);
  const successfulSources = new Set(items.map((item) => item.sourceId));
  logger.info(`Connector test complete`, { items: items.length, successfulSources: successfulSources.size, failures: failures.length });
  if (failures.length) {
    failures.forEach((failure) => logger.warn("Connector test failure", failure));
  }
  if (successfulSources.size < 3) {
    logger.error("Connector test failed: fewer than 3 sources produced items.");
    process.exitCode = 1;
  }
}

async function buildReport({ allSignals = false } = {}) {
  const stored = readJsonl("signals.jsonl");
  const manual = readManualSignals();
  const connectorStatus = readJson("connector-status.json");
  const now = new Date();

  let scored = scoreSignals(dedupeSignals([...stored, ...manual]));

  // Don't repeat the same pulls: drop signals already surfaced in a prior brief
  // (within REPEAT_WINDOW_DAYS) or 🔁-flagged by the user as repeats.
  const excluded = getExcludedIds();
  if (excluded.size) {
    const before = scored.length;
    scored = scored.filter((signal) => !excluded.has(signal.id));
    logger.info(`Repeat filter: dropped ${before - scored.length} previously-surfaced/suppressed signals`);
  }

  // Apply learned taste from past emoji reactions (no-op until feedback exists).
  const learned = applyLearnedWeights(scored);
  scored = learned.signals;

  const options = { allSignals, connectorStatus, now, feedbackActive: learned.active };

  // LLM enrichment runs only when Ollama is reachable with the configured model,
  // and the model is unloaded from VRAM as soon as we're done (active during use
  // only). Any failure degrades to keyword scoring rather than aborting the brief.
  const llmActive = await llmAvailable();
  if (llmActive) {
    try {
      // Heavy lift: Qwen filters spam and scores relevance across everything.
      scored = await classifyAndFilter(scored);
    } catch (error) {
      logger.warn("LLM classification failed; continuing with keyword scoring", { error: error.message });
    }
  }

  // Qwen rates nearly everything on-topic as 5/5, so its score can't gate. When
  // Claude polish is on, send it a WIDER candidate pool and let it grade + drop;
  // its keep/quality verdict becomes the real gate. Otherwise fall back to the
  // (coarser) Qwen/keyword gate.
  const finalMax = now.getDay() === 1 ? 8 : 6;
  let selected = allSignals ? scored : selectReportSignals(scored, now);

  if (llmActive) {
    try {
      options.llmActive = true;
      options.llmModel = process.env.OLLAMA_MODEL || "qwen3:8b";

      const usePolish = isPolishEnabled() && !allSignals;
      const candidates = usePolish ? selectReportSignals(scored, now, { max: finalMax * 2 }) : selected;

      let polished = null;
      if (usePolish && candidates.length) {
        polished = await polishBrief(candidates, { dayStrength: assessDayStrength(candidates) });
      }

      if (polished) {
        // Claude is the gate: keep what it kept, rank by its quality, cap.
        selected = candidates
          .map((s) => {
            const v = polished.interpretations.get(s.id);
            return { ...s, quality: v?.quality ?? s.quality, _keep: v ? v.keep : true };
          })
          .filter((s) => s._keep)
          .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || b.totalScore - a.totalScore)
          .slice(0, finalMax);
        options.interpretations = polished.interpretations;
        options.llmBrief = polished.brief;
        options.polishModel = process.env.CLAUDE_CLI_MODEL || "claude-cli";
      } else if (selected.length) {
        // Qwen-only generation path (no Claude).
        options.interpretations = await interpretSignals(selected);
        options.llmBrief = await synthesizeBrief(selected, { dayStrength: assessDayStrength(selected) });
      }
    } catch (error) {
      logger.warn("LLM enrichment failed; falling back to keyword report", { error: error.message });
    } finally {
      await llmUnload();
    }
  }

  options.selected = selected;
  options.dayStrength = assessDayStrength(selected);

  const report = generateReport(scored, options);
  appendJsonl("reports.jsonl", report);
  const markdownPath = writeText(`report-${report.generatedAt.slice(0, 10)}.md`, report.body);
  // Persist the exact built brief so `publish` can post it without rebuilding.
  const interpObj = options.interpretations ? Object.fromEntries(options.interpretations) : null;
  writeJson("last-brief.json", { report, selected, interpretations: interpObj });
  logger.info(`Generated report with ${report.signalCount} signals`, { markdownPath, llm: llmActive });
  console.log(report.body);
  return { report, selected, interpretations: options.interpretations ?? new Map() };
}

async function postClickUp() {
  const report = readLatestReport();
  if (!report) throw new Error("No report found. Run npm run report first.");
  if (envBool("MORNING_BRIEF_DRY_RUN", false)) {
    logger.info("Dry run enabled; not posting to ClickUp.");
    return;
  }
  const result = await postReport(report);
  logger.info(`Posted report to ClickUp ${result.destination}`, { channelError: result.channelError });
}

async function postDaily(report, selected, interpretations = new Map()) {
  // Per-signal posting so each item is individually reactable; falls back to a
  // single whole-report post if feedback is off or channel posting fails.
  if (process.env.FEEDBACK_ENABLED !== "false" && selected.length) {
    try {
      const { entries } = await postBriefWithFeedback(report, selected, interpretations);
      recordPostedSignals(entries.filter((entry) => entry.messageId));
      const posted = entries.filter((entry) => entry.messageId).length;
      logger.info(`Posted brief with ${posted} reactable signals to ClickUp channel`);
      return;
    } catch (error) {
      logger.warn("Per-signal feedback posting failed; falling back to whole-report post", { error: error.message });
    }
  }
  const result = await postReport(report);
  logger.info(`Posted report to ClickUp ${result.destination}`, { channelError: result.channelError });
}

async function daily() {
  // Learn from yesterday's reactions before building today's brief.
  await learnFromReactions();
  await collect();
  if (isWeekend()) {
    logger.info("Weekend collection complete. No report will be posted Saturday or Sunday.");
    return;
  }
  const { report, selected, interpretations } = await buildReport();
  if (!selected.length) logger.warn("Daily report has no selected signals. Posting is still allowed, but review connector health.");
  if (!envBool("MORNING_BRIEF_DRY_RUN", false)) {
    await postDaily(report, selected, interpretations);
  } else {
    logger.info("Dry run enabled; daily report was not posted.");
  }
}

async function publish() {
  // Post the most recently built brief per-signal (no rebuild, no collect, no
  // weekday gate) — for posting on demand outside the daily run.
  const data = readJson("last-brief.json");
  if (!data?.report) throw new Error("No brief found. Run `npm run report` first.");
  if (envBool("MORNING_BRIEF_DRY_RUN", false)) {
    logger.info("Dry run enabled; not posting to ClickUp.");
    return;
  }
  const interpretations = data.interpretations ? new Map(Object.entries(data.interpretations)) : new Map();
  await postDaily(data.report, data.selected ?? [], interpretations);
}

async function feedback() {
  const weights = await learnFromReactions();
  if (!weights) {
    logger.info("No feedback learned yet. Post a brief, react to signals, then run this again.");
    return;
  }
  console.log(JSON.stringify(weights, null, 2));
}

function help() {
  console.log(`Morning Brief

Commands:
  npm run setup
  npm run test:connectors
  npm run collect
  npm run report
  npm run post:clickup
  npm run daily
  npm run publish
  npm run feedback
`);
}

try {
  if (command === "setup") await setup();
  else if (command === "collect") await collect();
  else if (command === "test-connectors") await testConnectors();
  else if (command === "report") await buildReport({ allSignals: process.argv.includes("--all") });
  else if (command === "post-clickup") await postClickUp();
  else if (command === "daily") await daily();
  else if (command === "publish") await publish();
  else if (command === "feedback") await feedback();
  else help();
} catch (error) {
  logger.error(error.message, { stack: error.stack });
  process.exitCode = 1;
}
