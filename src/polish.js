import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { logger } from "./logger.js";
import { clip } from "./text.js";
import { ALEX_CONTEXT } from "./llm.js";

// "Polish" tier: Qwen does the heavy lifting (filter + rank), then the Claude
// CLI writes the final reader-facing prose in a single call. Runs under the
// user's Claude Code subscription (no API billing). Degrades silently to the
// Qwen generation path when the CLI is missing or not logged in.

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function newestExeIn(base) {
  if (!base || !fs.existsSync(base)) return null;
  const versions = fs
    .readdirSync(base)
    .filter((d) => /^\d+\.\d+\.\d+$/.test(d))
    .sort(compareSemver)
    .reverse();
  for (const v of versions) {
    const exe = path.join(base, v, "claude.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

// Resolve the Claude Code CLI. Prefer an explicit override. Claude installs as a
// packaged (MSIX) app, so for a normal (non-packaged) process like this one the
// physically real files live under the package LocalCache, not the virtualized
// %APPDATA%\Claude path — check the package location first, then fall back.
export function resolveClaudeCli() {
  if (process.env.CLAUDE_CLI_PATH) {
    return fs.existsSync(process.env.CLAUDE_CLI_PATH) ? process.env.CLAUDE_CLI_PATH : null;
  }

  const localAppData = process.env.LOCALAPPDATA || "";
  const packagesDir = path.join(localAppData, "Packages");
  if (fs.existsSync(packagesDir)) {
    const claudePackages = fs
      .readdirSync(packagesDir)
      .filter((d) => /^Claude_/.test(d))
      .map((d) => path.join(packagesDir, d, "LocalCache", "Roaming", "Claude", "claude-code"));
    for (const base of claudePackages) {
      const exe = newestExeIn(base);
      if (exe) return exe;
    }
  }

  return newestExeIn(path.join(process.env.APPDATA || "", "Claude", "claude-code"));
}

export function isPolishEnabled() {
  return process.env.LLM_POLISH_PROVIDER === "claude-cli" && Boolean(resolveClaudeCli());
}

function runClaude(prompt, { timeoutMs = 150000 } = {}) {
  const exe = resolveClaudeCli();
  if (!exe) return Promise.reject(new Error("Claude CLI not found"));
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json"];
    if (process.env.CLAUDE_CLI_MODEL) args.push("--model", process.env.CLAUDE_CLI_MODEL);
    // Run in a neutral cwd so the CLI does not auto-load this project's
    // CLAUDE.md / memory as context — the polish prompt is fully self-contained,
    // and that extra context just burns the subscription's usage budget.
    const child = spawn(exe, args, { windowsHide: true, cwd: os.tmpdir() });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Claude CLI timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const envelope = safeJson(out);
      if (!envelope) return reject(new Error(`Claude CLI gave no JSON: ${out.slice(0, 160)} ${err.slice(0, 160)}`));
      if (envelope.is_error) return reject(new Error(envelope.result || "Claude CLI error"));
      resolve(envelope.result || "");
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function buildPolishPrompt(signals, dayStrength = "moderate") {
  const list = signals
    .map((s, i) => {
      const hint = s.llm ? ` [qwen relevance ${s.llm.relevance}: ${s.llm.why}]` : "";
      return `${i + 1}. id=${s.id}${hint}\n   [${s.sourceName}] ${s.title}\n   ${clip((s.summary || "").replace(/\s+/g, " "), 400)}`;
    })
    .join("\n\n");

  return `${ALEX_CONTEXT}

You are Alex's sharp marketing strategist. Below are today's pre-filtered, pre-ranked market signals (a local model already removed spam and scored relevance). Today's strength has been assessed as "${dayStrength}". Write the brief in Alex's plain, contrarian, practical voice. No hype, no emoji, no hashtags. Be concrete and specific to each signal — never generic.

Be honest about a quiet day: if the signals are weak, say so plainly and do NOT manufacture importance. "one_thing" should name the single most worthwhile action today — or, if nothing is genuinely worth acting on, say exactly that (e.g. "Nothing today worth a post; <one-line reason>").

You are also the QUALITY GATE. For each signal set:
- "quality" (1-5, BE STINGY): 5 = a specific, genuine audience pain/opinion/debate squarely on brand voice, AI content quality, copywriting, small-business marketing, or content/prompt workflows that Alex could build a post or product angle on; 3 = related and mildly useful; 2 = merely mentions a topic keyword (a listing, announcement, tourism/event post) with no audience insight; 1 = noise. Disc golf / indie games are secondary — only 4+ with real community sentiment or a concrete design insight, never for venue listings or generic mentions.
- "keep" (boolean): FALSE if the signal is not worth Alex's attention (keyword-mention only, listing/announcement, off-thesis, or just weak). Drop freely — a short sharp brief beats a padded one. It is fine to keep only 2-3, or even fewer.

Refer to signals by their SUBJECT, never by number, in one_thing / executive_summary / linkedin_angles / video_ideas (the reader does not see your numbering).

Return ONLY a JSON object, no prose around it:
{
  "one_thing": "the single most worthwhile action today, in one sentence — or a plain statement that today is quiet and not worth a post",
  "executive_summary": "2-3 sentences on the real read today, matching the assessed strength (don't oversell a thin day)",
  "signals": [
    {"n": 1, "quality": 4, "keep": true, "why_it_matters": "1-2 sentences on the live audience concern or buying context", "tie_in": "1 sentence linking to brand voice extraction, the workflow/prompt library, or Chain Chasers (or 'general market context')", "angle": "one punchy line Alex could post", "urgency": "1 short sentence on timing"}
  ],
  "linkedin_angles": ["3 post-worthy lines in Alex's voice, grounded in today's KEPT signals"],
  "video_ideas": [{"hook": "...", "premise": "...", "visual": "...", "fit": "which product/beat it supports"}]
}

Use the same "n" numbers as the signals below. Provide one signals[] entry per signal (including the ones you drop, so I can read your keep/quality verdict).

SIGNALS:
${list}`;
}

// Single Claude CLI call that produces both per-signal interpretations and the
// brief-level synthesis. Returns { interpretations: Map, brief } or null.
export async function polishBrief(signals, { dayStrength = "moderate" } = {}) {
  if (!signals.length) return null;
  try {
    const text = await runClaude(buildPolishPrompt(signals, dayStrength));
    const parsed = safeJson(text);
    if (!parsed) {
      logger.warn("Claude polish returned unparseable output; falling back to Qwen generation");
      return null;
    }
    const interpretations = new Map();
    for (const item of parsed.signals ?? []) {
      const signal = signals[Number(item.n) - 1];
      if (signal) {
        interpretations.set(signal.id, {
          whyItMatters: item.why_it_matters,
          tieIn: item.tie_in,
          angle: item.angle,
          urgency: item.urgency,
          quality: Number(item.quality) || null,
          keep: item.keep !== false
        });
      }
    }
    const brief = {
      oneThing: parsed.one_thing,
      executiveSummary: parsed.executive_summary,
      linkedinAngles: Array.isArray(parsed.linkedin_angles) ? parsed.linkedin_angles : [],
      videoIdeas: Array.isArray(parsed.video_ideas) ? parsed.video_ideas : []
    };
    logger.info(`Claude polish complete for ${interpretations.size} signals`);
    return { interpretations, brief };
  } catch (error) {
    logger.warn("Claude polish failed; falling back to Qwen generation", { error: error.message });
    return null;
  }
}
