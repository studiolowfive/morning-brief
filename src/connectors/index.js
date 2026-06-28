import { collectRss } from "./rss.js";
import { collectReddit } from "./reddit.js";
import { collectYouTube } from "./youtube.js";
import { collectBluesky } from "./bluesky.js";
import { logger } from "../logger.js";

const collectors = {
  rss: collectRss,
  reddit: collectReddit,
  youtube: collectYouTube,
  bluesky: collectBluesky
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayFor(type) {
  if (type === "reddit") return Number.parseInt(process.env.REDDIT_DELAY_MS ?? "1200", 10);
  return Number.parseInt(process.env.CONNECTOR_DELAY_MS ?? "0", 10);
}

export async function collectFromConfig(config, limit) {
  const results = [];
  const failures = [];

  for (const [type, sources] of Object.entries(config)) {
    const collect = collectors[type];
    if (!collect) continue;
    for (const source of sources.filter((item) => item.enabled)) {
      try {
        logger.info(`Collecting ${source.name}`, { type, sourceId: source.id });
        const items = await collect(source, limit);
        results.push(...items);
      } catch (error) {
        failures.push({ type, sourceId: source.id, message: error.message });
        logger.warn(`Connector failed: ${source.name}`, { type, sourceId: source.id, error: error.message });
      }
      const waitMs = delayFor(type);
      if (waitMs > 0) await sleep(waitMs);
    }
  }

  return { items: results, failures };
}
