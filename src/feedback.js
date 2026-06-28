import { logger } from "./logger.js";
import { appendJsonl, readJsonl, readJson, writeJson } from "./storage.js";
import { getMessageReactions } from "./clickup.js";

// Feedback loop: each posted signal carries a ClickUp message id. Alex reacts
// with emoji; we read those reactions back, turn them into per-source and
// per-topic weights, and feed them into scoring so the brief learns his taste.
//
// Emoji vocabulary (edit weights here):
//   ✅ acted on it  -> strongest positive
//   🔥 great, more like this
//   👍 useful
//   👎 noise, less like this
const REACTION_GROUPS = [
  { weight: 3, tokens: ["✅", "white_check_mark", "heavy_check_mark", "✔"] },
  { weight: 2, tokens: ["🔥", "fire"] },
  { weight: 1, tokens: ["👍", "+1", "thumbsup"] },
  { weight: -2, tokens: ["👎", "-1", "thumbsdown"] }
];

const INDEX_FILE = "feedback-index.jsonl";
const WEIGHTS_FILE = "learned-weights.json";

function windowDays() {
  return Number.parseInt(process.env.FEEDBACK_WINDOW_DAYS ?? "14", 10);
}

function strength() {
  const value = Number.parseFloat(process.env.FEEDBACK_STRENGTH ?? "1");
  return Number.isFinite(value) ? value : 1;
}

// Pull the reaction identifiers out of ClickUp's response. Confirmed live shape
// is { data: [{ reaction: "+1", user_id, date }] } — ClickUp uses emoji
// shortcodes ("+1", "-1", "fire", "white_check_mark"). Fallbacks cover other
// shapes/field names defensively.
function extractReactionStrings(raw) {
  const list = Array.isArray(raw) ? raw : raw?.data ?? raw?.reactions ?? [];
  return list
    .map((item) => (typeof item === "string" ? item : item?.reaction ?? item?.emoji ?? item?.name ?? ""))
    .filter(Boolean);
}

export function scoreReactions(raw) {
  let score = 0;
  const matched = [];
  for (const rx of extractReactionStrings(raw)) {
    const group = REACTION_GROUPS.find((g) => g.tokens.some((token) => rx === token || rx.includes(token)));
    if (group) {
      score += group.weight;
      matched.push(group.tokens[0]);
    }
  }
  return { score, matched };
}

// Record the signals we just posted, so a later run can look up their reactions.
export function recordPostedSignals(entries) {
  if (!entries?.length) return;
  const date = new Date().toISOString();
  appendJsonl(
    INDEX_FILE,
    entries.map((entry) => ({
      postedAt: date,
      messageId: entry.messageId,
      signalId: entry.signalId,
      sourceId: entry.sourceId,
      topics: entry.topics ?? [],
      title: entry.title
    }))
  );
}

function clampWeight(value) {
  return Math.max(-3, Math.min(3, value));
}

// Read reactions for every posted signal inside the window and recompute the
// learned weights from scratch (idempotent — late reactions are picked up, and
// re-runs never double-count).
export async function learnFromReactions() {
  if (process.env.FEEDBACK_ENABLED === "false") {
    logger.info("Feedback disabled; skipping reaction learning.");
    return null;
  }
  const index = readJsonl(INDEX_FILE);
  if (!index.length) {
    logger.info("No posted signals on record yet; nothing to learn from.");
    return null;
  }

  const cutoff = Date.now() - windowDays() * 24 * 60 * 60 * 1000;
  const recent = index.filter((row) => Date.parse(row.postedAt) >= cutoff && row.messageId);

  const sourceAgg = new Map();
  const topicAgg = new Map();
  let reactedCount = 0;

  for (const row of recent) {
    let raw;
    try {
      raw = await getMessageReactions(row.messageId);
    } catch (error) {
      logger.warn("Could not read reactions for a message", { messageId: row.messageId, error: error.message });
      continue;
    }
    const { score, matched } = scoreReactions(raw);
    if (!matched.length) continue; // no reaction = no signal, skip (not a downvote)
    reactedCount++;

    const push = (map, key) => {
      if (!key) return;
      const cur = map.get(key) ?? { sum: 0, n: 0 };
      cur.sum += score;
      cur.n += 1;
      map.set(key, cur);
    };
    push(sourceAgg, row.sourceId);
    for (const topic of row.topics ?? []) push(topicAgg, topic);
  }

  const toWeights = (map) =>
    Object.fromEntries([...map.entries()].map(([key, { sum, n }]) => [key, clampWeight(sum / n)]));

  const weights = {
    updatedAt: new Date().toISOString(),
    windowDays: windowDays(),
    reactedSignals: reactedCount,
    sources: toWeights(sourceAgg),
    topics: toWeights(topicAgg)
  };
  writeJson(WEIGHTS_FILE, weights);
  logger.info(`Learned from ${reactedCount} reacted signals`, {
    sources: Object.keys(weights.sources).length,
    topics: Object.keys(weights.topics).length
  });
  return weights;
}

// Nudge each signal's totalScore by the learned weight of its source and the
// average learned weight of its topics. Pure; safe to call even with no data.
export function applyLearnedWeights(signals) {
  const weights = readJson(WEIGHTS_FILE);
  if (!weights || (!Object.keys(weights.sources ?? {}).length && !Object.keys(weights.topics ?? {}).length)) {
    return { signals, active: false };
  }
  const k = strength();
  const adjusted = signals.map((signal) => {
    const sourceW = weights.sources?.[signal.sourceId] ?? 0;
    const topicList = signal.topics ?? [];
    const topicW = topicList.length
      ? topicList.reduce((sum, t) => sum + (weights.topics?.[t] ?? 0), 0) / topicList.length
      : 0;
    const delta = k * (sourceW + topicW);
    if (!delta) return signal;
    return { ...signal, totalScore: (signal.totalScore ?? 0) + delta, learnedDelta: delta };
  });
  return { signals: adjusted, active: true, weights };
}

export function getLearnedWeights() {
  return readJson(WEIGHTS_FILE);
}
