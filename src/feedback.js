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

// 🔁 means "this is a repeat — stop showing it." Handled as suppression, not a
// weight (it's not a vote against the source/topic).
const REPEAT_TOKENS = ["🔁", "repeat", "arrows_clockwise", "arrows_counterclockwise"];

const INDEX_FILE = "feedback-index.jsonl";
const WEIGHTS_FILE = "learned-weights.json";
const SUPPRESS_FILE = "suppressed-signals.json";
const SEEN_FILE = "seen-signals.json";

function repeatWindowDays() {
  return Number.parseInt(process.env.REPEAT_WINDOW_DAYS ?? "30", 10);
}

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

function hasRepeatReaction(raw) {
  return extractReactionStrings(raw).some((rx) => REPEAT_TOKENS.some((t) => rx === t || rx.includes(t)));
}

// Signals the user 🔁-flagged as repeats: permanently suppressed (never resurfaced).
export function getSuppressedIds() {
  return new Set(readJson(SUPPRESS_FILE) ?? []);
}

// Signal ids already shown to the user within the repeat window — the "same
// pulls" we don't re-surface. Unions posted market signals (feedback-index) and
// everything recorded as surfaced (seen-signals, which also covers job listings
// that aren't posted as individual reactable messages).
export function getSeenIds(windowDays = repeatWindowDays()) {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const ids = new Set();
  for (const row of readJsonl(INDEX_FILE)) {
    if (row.signalId && (Date.parse(row.postedAt) || 0) >= cutoff) ids.add(row.signalId);
  }
  const store = readJson(SEEN_FILE) ?? {};
  for (const [id, rec] of Object.entries(store)) {
    if ((Date.parse(rec.lastSurfacedAt) || 0) >= cutoff) ids.add(id);
  }
  return ids;
}

// Everything to drop from a new brief: previously-surfaced (windowed) + 🔁-suppressed.
export function getExcludedIds() {
  const excluded = getSeenIds();
  for (const id of getSuppressedIds()) excluded.add(id);
  return excluded;
}

// Record engagement metrics for the signals we just showed, so a later run can
// tell whether a repeat has materially grown since it was last surfaced.
export function recordSurfaced(signals) {
  if (!signals?.length) return;
  const store = readJson(SEEN_FILE) ?? {};
  const now = new Date().toISOString();
  for (const s of signals) {
    const prev = store[s.id] ?? {};
    store[s.id] = {
      firstSurfacedAt: prev.firstSurfacedAt ?? now,
      lastSurfacedAt: now,
      timesShown: (prev.timesShown ?? 0) + 1,
      score: s.score ?? 0,
      comments: s.comments ?? 0,
      reposts: s.reposts ?? 0,
      crossSourceCount: s.crossSourceCount ?? 1
    };
  }
  writeJson(SEEN_FILE, store);
}

// Decide if a repeat has grown enough to justify resurfacing. Returns a human
// explanation, or null to keep it suppressed. Thresholds are deliberately
// conservative so resurfacing is the exception, not the norm.
function resurfaceReason(current, prev) {
  const curCross = current.crossSourceCount ?? 1;
  const prevCross = prev.crossSourceCount ?? 1;
  if (curCross > prevCross) {
    return `now appearing across ${curCross} sources (was ${prevCross}) since last shown`;
  }
  const curEng = (current.score ?? 0) + (current.comments ?? 0);
  const prevEng = (prev.score ?? 0) + (prev.comments ?? 0);
  if (curEng >= 25 && curEng >= prevEng * 2) {
    return `engagement more than doubled (${prevEng} → ${curEng}) since last shown`;
  }
  return null;
}

// Repeat policy: drop 🔁-suppressed and previously-seen signals, EXCEPT resurface
// a seen signal whose metrics grew materially (tagged with .resurfaceReason).
export function applyRepeatPolicy(signals) {
  const seenIds = getSeenIds();
  const suppressed = getSuppressedIds();
  const metrics = readJson(SEEN_FILE) ?? {};

  const kept = [];
  let droppedRepeat = 0;
  let droppedSuppressed = 0;
  let resurfaced = 0;

  for (const signal of signals) {
    if (suppressed.has(signal.id)) {
      droppedSuppressed++;
      continue;
    }
    if (!seenIds.has(signal.id)) {
      kept.push(signal); // fresh
      continue;
    }
    const reason = metrics[signal.id] ? resurfaceReason(signal, metrics[signal.id]) : null;
    if (reason) {
      kept.push({ ...signal, resurfaceReason: reason });
      resurfaced++;
    } else {
      droppedRepeat++;
    }
  }
  return { signals: kept, droppedRepeat, droppedSuppressed, resurfaced };
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
  const suppressed = getSuppressedIds();
  let reactedCount = 0;
  let suppressedAdded = 0;

  for (const row of recent) {
    let raw;
    try {
      raw = await getMessageReactions(row.messageId);
    } catch (error) {
      logger.warn("Could not read reactions for a message", { messageId: row.messageId, error: error.message });
      continue;
    }
    // 🔁 = "stop showing this" — permanently suppress this signal id.
    if (hasRepeatReaction(raw) && row.signalId && !suppressed.has(row.signalId)) {
      suppressed.add(row.signalId);
      suppressedAdded++;
    }
    const { score, matched } = scoreReactions(raw);
    if (!matched.length) continue; // no weight reaction = no signal, skip
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
  if (suppressedAdded) writeJson(SUPPRESS_FILE, [...suppressed]);
  logger.info(`Learned from ${reactedCount} reacted signals`, {
    sources: Object.keys(weights.sources).length,
    topics: Object.keys(weights.topics).length,
    newlySuppressed: suppressedAdded
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
