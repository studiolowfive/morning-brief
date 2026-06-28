import { collectRss } from "./rss.js";

export async function collectYouTube(source, limit) {
  const query = encodeURIComponent(source.query);
  return collectRss(
    {
      ...source,
      url: `https://www.youtube.com/feeds/videos.xml?search_query=${query}`,
      name: source.name || `YouTube: ${source.query}`
    },
    limit
  ).then((items) => items.map((item) => ({ ...item, connector: "youtube" })));
}
