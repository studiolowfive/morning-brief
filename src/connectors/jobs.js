import { fetchJson } from "../http.js";
import { clip } from "../text.js";

// JSearch (RapidAPI) job listings. Aggregates Google for Jobs — LinkedIn, Indeed,
// Glassdoor, ZipRecruiter, company pages — so one call per query covers the
// boards Alex's job search cares about. Jobs flow as their own lane and feed the
// brief's Roles & Gigs section (not the market-signal ranking).

function rapidApiKey() {
  return process.env.JSEARCH_API_KEY || process.env.RAPIDAPI_KEY || "";
}

export async function collectJobs(source, limit) {
  const key = rapidApiKey();
  if (!key) throw new Error("JSEARCH_API_KEY is required for job listings");

  const params = new URLSearchParams({
    query: source.query,
    num_pages: "1",
    country: process.env.JOBS_COUNTRY || "us",
    date_posted: process.env.JOBS_DATE_POSTED || "week"
  });
  if (source.remoteOnly) params.set("remote_jobs_only", "true");

  // v5 search endpoint is /search-v2 (not /search).
  const data = await fetchJson(`https://jsearch.p.rapidapi.com/search-v2?${params.toString()}`, {
    headers: {
      "X-RapidAPI-Key": key,
      "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      Accept: "application/json"
    },
    // JSearch (Google for Jobs aggregation) is slow — well past the 15s default.
    timeoutMs: 30000
  });

  // search-v2 nests results under data.jobs (older /search used data directly).
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
