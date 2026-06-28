export async function fetchText(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.text();
}

export async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": process.env.REDDIT_USER_AGENT || "morning-brief/0.1",
        Accept: "*/*",
        ...(options.headers ?? {})
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}
