import { fetchJson } from "../http.js";
import { collectRss } from "./rss.js";

function redditUserAgent() {
  return process.env.REDDIT_USER_AGENT || "morning-brief/0.1 by StudioLowFive";
}

function hasOAuthCreds() {
  return Boolean(
    process.env.REDDIT_CLIENT_ID &&
      process.env.REDDIT_CLIENT_SECRET &&
      process.env.REDDIT_USERNAME &&
      process.env.REDDIT_PASSWORD
  );
}

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getOAuthToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const basic = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: "password",
    username: process.env.REDDIT_USERNAME,
    password: process.env.REDDIT_PASSWORD
  }).toString();

  const data = await fetchJson("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": redditUserAgent()
    },
    body
  });

  if (!data.access_token) throw new Error("Reddit OAuth returned no access_token");
  cachedToken = data.access_token;
  // Refresh a minute before the stated expiry to avoid edge-of-expiry 401s.
  cachedTokenExpiry = Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000;
  return cachedToken;
}

function mapListing(data, source) {
  return (data.data?.children ?? [])
    .filter(({ kind }) => kind === "t3")
    .map(({ data: post }) => ({
      id: `${source.id}:${post.id}`,
      connector: "reddit",
      sourceId: source.id,
      sourceName: source.name,
      title: post.title,
      url: `https://www.reddit.com${post.permalink}`,
      summary: post.selftext || post.link_flair_text || "",
      publishedAt: new Date(post.created_utc * 1000).toISOString(),
      collectedAt: new Date().toISOString(),
      score: post.score ?? 0,
      comments: post.num_comments ?? 0,
      topics: source.topics ?? []
    }));
}

async function collectRedditOAuth(source, limit) {
  const token = await getOAuthToken();
  const sort = source.sort || "hot";
  const url = `https://oauth.reddit.com/r/${encodeURIComponent(source.subreddit)}/${sort}?limit=${limit}&raw_json=1`;
  const data = await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": redditUserAgent()
    }
  });
  return mapListing(data, source);
}

function rssCandidates(subreddit) {
  const name = encodeURIComponent(subreddit);
  return [
    `https://old.reddit.com/r/${name}/.rss`,
    `https://www.reddit.com/r/${name}/.rss`
  ];
}

async function collectRedditRss(source, limit) {
  const failures = [];
  for (const url of rssCandidates(source.subreddit)) {
    try {
      const rssItems = await collectRss({ ...source, url }, limit);
      return rssItems.map((item) => ({
        ...item,
        connector: "reddit",
        sourceId: source.id,
        sourceName: source.name
      }));
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(failures.join(" | "));
}

async function collectRedditAnonJson(source, limit) {
  const sort = source.sort || "hot";
  const url = `https://www.reddit.com/r/${encodeURIComponent(source.subreddit)}/${sort}.json?limit=${limit}&raw_json=1`;
  const data = await fetchJson(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": redditUserAgent()
    }
  });
  return mapListing(data, source);
}

export async function collectReddit(source, limit) {
  // Preferred path: authenticated OAuth. Anonymous Reddit endpoints are
  // aggressively rate-limited (429) from shared/cloud IPs; an OAuth script app
  // gets its own ~100 req/min budget and is the only reliable route.
  if (hasOAuthCreds()) {
    try {
      return await collectRedditOAuth(source, limit);
    } catch (error) {
      // Fall through to the public routes so a bad token still degrades gracefully.
      if (process.env.REDDIT_USE_JSON === "true") {
        try {
          return await collectRedditAnonJson(source, limit);
        } catch {
          /* fall through to RSS */
        }
      }
      try {
        return await collectRedditRss(source, limit);
      } catch (rssError) {
        throw new Error(`OAuth failed (${error.message}); fallback failed (${rssError.message})`);
      }
    }
  }

  if (process.env.REDDIT_USE_JSON === "true") {
    try {
      return await collectRedditAnonJson(source, limit);
    } catch (error) {
      if (!/403|429|blocked/i.test(error.message)) throw error;
      return collectRedditRss(source, limit);
    }
  }

  return collectRedditRss(source, limit);
}
