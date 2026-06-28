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
import { generateReport, selectReportSignals } from "./report.js";
import { postReport } from "./clickup.js";
import { isAvailable as llmAvailable, classifyAndFilter, interpretSignals, synthesizeBrief, unload as llmUnload } from "./llm.js";
import { isPolishEnabled, polishBrief } from "./polish.js";

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
  const options = { allSignals, connectorStatus, now };

  // LLM enrichment runs only when Ollama is reachable with the configured model,
  // and the model is unloaded from VRAM as soon as we're done (active during use
  // only). Any failure degrades to keyword scoring rather than aborting the brief.
  const llmActive = await llmAvailable();
  if (llmActive) {
    try {
      // Heavy lift: Qwen filters spam and scores relevance across everything.
      scored = await classifyAndFilter(scored);
      const selected = allSignals ? scored : selectReportSignals(scored, now);
      options.selected = selected;
      options.llmActive = true;
      options.llmModel = process.env.OLLAMA_MODEL || "qwen3:8b";

      if (selected.length) {
        // Polish: hand the filtered, ranked picks to the Claude CLI for the
        // final prose. Falls back to Qwen generation if the CLI isn't ready.
        let polished = null;
        if (isPolishEnabled()) {
          polished = await polishBrief(selected);
        }
        if (polished) {
          options.interpretations = polished.interpretations;
          options.llmBrief = polished.brief;
          options.polishModel = process.env.CLAUDE_CLI_MODEL || "claude-cli";
        } else {
          options.interpretations = await interpretSignals(selected);
          options.llmBrief = await synthesizeBrief(selected);
        }
      }
    } catch (error) {
      logger.warn("LLM enrichment failed; falling back to keyword report", { error: error.message });
    } finally {
      await llmUnload();
    }
  }

  const report = generateReport(scored, options);
  appendJsonl("reports.jsonl", report);
  const markdownPath = writeText(`report-${report.generatedAt.slice(0, 10)}.md`, report.body);
  logger.info(`Generated report with ${report.signalCount} signals`, { markdownPath, llm: llmActive });
  console.log(report.body);
  return report;
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

async function daily() {
  await collect();
  if (isWeekend()) {
    logger.info("Weekend collection complete. No report will be posted Saturday or Sunday.");
    return;
  }
  const report = await buildReport();
  const selected = selectReportSignals(scoreSignals(dedupeSignals(readJsonl("signals.jsonl"))));
  if (!selected.length) logger.warn("Daily report has no selected signals. Posting is still allowed, but review connector health.");
  if (!envBool("MORNING_BRIEF_DRY_RUN", false)) {
    const result = await postReport(report);
    logger.info(`Daily report posted to ClickUp ${result.destination}`, { channelError: result.channelError });
  } else {
    logger.info("Dry run enabled; daily report was not posted.");
  }
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
`);
}

try {
  if (command === "setup") await setup();
  else if (command === "collect") await collect();
  else if (command === "test-connectors") await testConnectors();
  else if (command === "report") await buildReport({ allSignals: process.argv.includes("--all") });
  else if (command === "post-clickup") await postClickUp();
  else if (command === "daily") await daily();
  else help();
} catch (error) {
  logger.error(error.message, { stack: error.stack });
  process.exitCode = 1;
}
