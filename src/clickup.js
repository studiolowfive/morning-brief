import { fetchJson } from "./http.js";

function clickupHeaders() {
  if (!process.env.CLICKUP_API_TOKEN) throw new Error("CLICKUP_API_TOKEN is required");
  return {
    Authorization: process.env.CLICKUP_API_TOKEN,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

export async function postToClickUpChannel(report) {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error("CLICKUP_API_TOKEN is missing");

  const body = {
    content: report.body,
    text: report.body,
    message: report.body
  };

  const candidateUrls = [
    process.env.CLICKUP_CHANNEL_POST_URL,
    process.env.CLICKUP_WORKSPACE_ID && process.env.CLICKUP_CHANNEL_ID
      ? `https://api.clickup.com/api/v3/workspaces/${process.env.CLICKUP_WORKSPACE_ID}/chat/channels/${process.env.CLICKUP_CHANNEL_ID}/messages`
      : null,
    process.env.CLICKUP_WORKSPACE_ID && process.env.CLICKUP_CHANNEL_ID
      ? `https://api.clickup.com/api/v3/workspaces/${process.env.CLICKUP_WORKSPACE_ID}/channels/${process.env.CLICKUP_CHANNEL_ID}/messages`
      : null
  ].filter(Boolean);

  if (!candidateUrls.length) throw new Error("Set CLICKUP_CHANNEL_POST_URL or CLICKUP_WORKSPACE_ID + CLICKUP_CHANNEL_ID");

  const failures = [];
  for (const url of candidateUrls) {
    try {
      return await fetchJson(url, {
        method: "POST",
        headers: clickupHeaders(),
        body: JSON.stringify(body)
      });
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(`ClickUp Channel post failed. ${failures.join(" | ")}`);
}

export async function createFallbackTask(report) {
  if (!process.env.CLICKUP_FALLBACK_LIST_ID) throw new Error("CLICKUP_FALLBACK_LIST_ID is required for fallback task posting");
  const url = `https://api.clickup.com/api/v2/list/${process.env.CLICKUP_FALLBACK_LIST_ID}/task`;
  return fetchJson(url, {
    method: "POST",
    headers: clickupHeaders(),
    body: JSON.stringify({
      name: `Morning Brief - ${report.generatedAt.slice(0, 10)}`,
      description: report.body,
      markdown_description: report.body,
      tags: ["morning-brief", "agent-report"]
    })
  });
}

export async function postReport(report) {
  try {
    const result = await postToClickUpChannel(report);
    return { destination: "channel", result };
  } catch (channelError) {
    const result = await createFallbackTask(report);
    return { destination: "fallback-task", channelError: channelError.message, result };
  }
}
