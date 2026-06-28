import { slugText } from "./text.js";

export function dedupeSignals(signals) {
  const seen = new Map();

  for (const signal of signals) {
    const canonicalUrl = (signal.url || "").split("?")[0].replace(/\/$/, "");
    const key = canonicalUrl || slugText(signal.title).slice(0, 90);
    const titleKey = slugText(signal.title).slice(0, 90);
    const existingKey = seen.has(key) ? key : [...seen.keys()].find((candidate) => candidate.includes(titleKey) || titleKey.includes(candidate));

    if (existingKey && seen.has(existingKey)) {
      const existing = seen.get(existingKey);
      existing.sourceNames = Array.from(new Set([...(existing.sourceNames ?? [existing.sourceName]), signal.sourceName]));
      existing.sourceName = existing.sourceNames.join(", ");
      existing.sourceIds = Array.from(new Set([...(existing.sourceIds ?? [existing.sourceId]), signal.sourceId]));
      existing.urls = Array.from(new Set([...(existing.urls ?? [existing.url]), signal.url].filter(Boolean)));
      existing.summary = existing.summary || signal.summary;
      existing.crossSourceCount = existing.sourceIds.length;
      existing.score = Math.max(existing.score ?? 0, signal.score ?? 0);
      existing.comments = Math.max(existing.comments ?? 0, signal.comments ?? 0);
      continue;
    }

    seen.set(key, {
      ...signal,
      sourceNames: [signal.sourceName],
      sourceIds: [signal.sourceId],
      urls: signal.url ? [signal.url] : [],
      crossSourceCount: 1
    });
  }

  return [...seen.values()];
}
