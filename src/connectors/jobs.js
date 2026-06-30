import { fetchJson } from "../http.js";
import { clip } from "../text.js";
import { collectRss } from "./rss.js";

// Job listings, multi-provider, all normalized to one shape tagged connector:"jobs"
// so they flow into the Roles & Gigs lane (Track B):
//   - jsearch : JSearch/RapidAPI (Google for Jobs) — local + remote, needs a key
//   - wwr     : We Work Remotely category RSS — remote-first, keyless
//   - remotive: Remotive public API — remote marketing, keyless

function rapidApiKey() {
  return process.env.JSEARCH_API_KEY || process.env.RAPIDAPI_KEY || "";
}

function isWeekend() {
  return [0, 6].includes(new Date().getDay());
}

async function collectJSearch(source, limit) {
  const key = rapidApiKey();
  if (!key) throw new Error("JSEARCH_API_KEY is required for job listings");
  // Skip the (metered) JSearch calls on weekends to conserve the free quota —
  // Monday's date_posted=week pull catches anything posted over the weekend.
  if (process.env.JOBS_SKIP_WEEKEND !== "false" && isWeekend()) return [];

  const params = new URLSearchParams({
    query: source.query,
    num_pages: "1",
    country: process.env.JOBS_COUNTRY || "us",
    date_posted: process.env.JOBS_DATE_POSTED || "week"
  });
  if (source.remoteOnly) params.set("remote_jobs_only", "true");

  // v5 search endpoint is /search-v2 (not /search), and JSearch is slow.
  const data = await fetchJson(`https://jsearch.p.rapidapi.com/search-v2?${params.toString()}`, {
    headers: {
      "X-RapidAPI-Key": key,
      "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      Accept: "application/json"
    },
    timeoutMs: 30000
  });

  const jobs = data.data?.jobs ?? (Array.isArray(data.data) ? data.data : []);
  return jobs.slice(0, limit).map((job) => {
    const loc = [job.job_city, job.job_state].filter(Boolean).join(", ");
    const where = job.job_is_remote ? "Remote" : loc || job.job_country || "";
    return {
      id: `${source.id}:${job.job_id}`,
      connector: "jobs",
      sourceId: source.id,
      sourceName: source.name,
      title: `${job.job_title} — ${job.employer_name || "Unknown"}${where ? ` (${where})` : ""}`,
      url: job.job_apply_link || job.job_google_link || "",
      summary: clip((job.job_description || "").replace(/\s+/g, " "), 700),
      publishedAt: job.job_posted_at_datetime_utc || new Date().toISOString(),
      collectedAt: new Date().toISOString(),
      employer: job.employer_name,
      location: where,
      remote: Boolean(job.job_is_remote),
      publisher: job.job_publisher,
      topics: source.topics ?? ["role"]
    };
  });
}

async function collectWwr(source, limit) {
  // We Work Remotely category RSS; reuse the RSS parser, then re-tag as jobs.
  const items = await collectRss(source, limit);
  return items.map((item) => {
    const idx = (item.title || "").indexOf(":"); // WWR titles are "Company: Role"
    const employer = idx > 0 ? item.title.slice(0, idx).trim() : "";
    const role = idx > 0 ? item.title.slice(idx + 1).trim() : item.title;
    return {
      ...item,
      connector: "jobs",
      title: `${role}${employer ? ` — ${employer}` : ""} (Remote)`,
      employer,
      location: "Remote",
      remote: true,
      topics: source.topics ?? ["role"]
    };
  });
}

async function collectRemotive(source, limit) {
  const category = source.category || "marketing";
  const data = await fetchJson(
    `https://remotive.com/api/remote-jobs?category=${encodeURIComponent(category)}&limit=${limit}`,
    { timeoutMs: 20000 }
  );
  return (data.jobs ?? []).slice(0, limit).map((job) => ({
    id: `${source.id}:${job.id}`,
    connector: "jobs",
    sourceId: source.id,
    sourceName: source.name,
    title: `${job.title} — ${job.company_name} (${job.candidate_required_location || "Remote"})`,
    url: job.url,
    summary: clip((job.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), 700),
    publishedAt: job.publication_date || new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    employer: job.company_name,
    location: job.candidate_required_location || "Remote",
    remote: true,
    topics: source.topics ?? ["role"]
  }));
}

export async function collectJobs(source, limit) {
  const provider = source.provider || "jsearch";
  if (provider === "jsearch") return collectJSearch(source, limit);
  if (provider === "wwr") return collectWwr(source, limit);
  if (provider === "remotive") return collectRemotive(source, limit);
  throw new Error(`Unknown jobs provider "${provider}" for ${source.id}`);
}
