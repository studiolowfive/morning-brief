import { fetchJson } from "../http.js";

let cachedJwt = null;

async function getSessionJwt() {
  if (cachedJwt) return cachedJwt;
  const identifier = process.env.BLUESKY_IDENTIFIER;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!identifier || !password) throw new Error("BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD are required");

  const session = await fetchJson("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password })
  });
  cachedJwt = session.accessJwt;
  return cachedJwt;
}

export async function collectBluesky(source, limit) {
  const jwt = await getSessionJwt();
  const url = `https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(source.query)}&limit=${limit}&sort=latest`;
  const data = await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json"
    }
  });

  return (data.posts ?? []).map((post) => ({
    id: `${source.id}:${post.uri}`,
    connector: "bluesky",
    sourceId: source.id,
    sourceName: source.name,
    title: post.record?.text?.split(/\r?\n/)[0]?.slice(0, 120) || "Bluesky post",
    url: post.author?.handle && post.uri?.includes("/app.bsky.feed.post/")
      ? `https://bsky.app/profile/${post.author.handle}/post/${post.uri.split("/").at(-1)}`
      : "",
    summary: post.record?.text || "",
    publishedAt: post.record?.createdAt || post.indexedAt || new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    score: post.likeCount ?? 0,
    comments: post.replyCount ?? 0,
    reposts: post.repostCount ?? 0,
    topics: source.topics ?? []
  }));
}
