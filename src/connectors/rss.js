import { fetchText } from "../http.js";
import { decodeHtml } from "../text.js";

function tagValue(item, tag) {
  const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeHtml(match?.[1] ?? "");
}

function attrValue(item, tag, attr) {
  const match = item.match(new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*>`, "i"));
  return decodeHtml(match?.[1] ?? "");
}

function parseRss(xml) {
  const chunks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
  return chunks.map((item) => {
    const link = tagValue(item, "link") || attrValue(item, "link", "href");
    return {
      title: tagValue(item, "title"),
      url: link,
      summary: tagValue(item, "description") || tagValue(item, "summary") || tagValue(item, "content:encoded"),
      publishedAt: tagValue(item, "pubDate") || tagValue(item, "published") || tagValue(item, "updated")
    };
  });
}

export async function collectRss(source, limit) {
  const xml = await fetchText(source.url);
  return parseRss(xml).slice(0, limit).map((item) => ({
    id: `${source.id}:${item.url || item.title}`,
    connector: "rss",
    sourceId: source.id,
    sourceName: source.name,
    title: item.title || "Untitled RSS item",
    url: item.url,
    summary: item.summary === "Comments" ? "" : item.summary,
    publishedAt: item.publishedAt ? new Date(item.publishedAt).toISOString() : new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    topics: source.topics ?? []
  }));
}
