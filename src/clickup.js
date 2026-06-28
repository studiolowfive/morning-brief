import { fetchJson } from "./http.js";
import { clip } from "./text.js";

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

function workspaceId() {
  const id = process.env.CLICKUP_WORKSPACE_ID;
  if (!id) throw new Error("CLICKUP_WORKSPACE_ID is required for chat messages");
  return id;
}

function channelId() {
  const id = process.env.CLICKUP_CHANNEL_ID;
  if (!id) throw new Error("CLICKUP_CHANNEL_ID is required for chat messages");
  return id;
}

function extractMessageId(result) {
  return result?.id ?? result?.data?.id ?? result?.message?.id ?? null;
}

// Post a single chat message; when parentId is given, post it as a reply
// (threaded under the brief header). Returns the new message id.
export async function postChannelMessage(content, parentId = null) {
  const wid = workspaceId();
  const body = JSON.stringify({ content, content_format: "text/md" });
  const headers = clickupHeaders();
  const base = `https://api.clickup.com/api/v3/workspaces/${wid}`;
  const urls = parentId
    ? [`${base}/chat/messages/${parentId}/replies`, `${base}/chat/channels/${channelId()}/messages`]
    : [`${base}/chat/channels/${channelId()}/messages`];

  const failures = [];
  for (const url of urls) {
    try {
      const result = await fetchJson(url, { method: "POST", headers, body });
      return { id: extractMessageId(result), result };
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(`Chat message post failed. ${failures.join(" | ")}`);
}

export async function getMessageReactions(messageId) {
  const wid = workspaceId();
  const url = `https://api.clickup.com/api/v3/workspaces/${wid}/chat/messages/${messageId}/reactions?limit=100`;
  return fetchJson(url, { headers: clickupHeaders() });
}

// Post the brief as a header message plus one reactable message per signal.
// Each signal is formatted with blank-line spacing (ClickUp collapses single
// line breaks) and a cleaned single-line title (raw posts carry their own
// newlines). Returns the per-signal entries (with message ids) for the index.
export async function postBriefWithFeedback(report, selected, interpretations = new Map()) {
  const header = await postChannelMessage(
    [
      `📋 *${report.title}*`,
      "React on each signal to tune tomorrow's brief:",
      "🔥 more like this   ·   👍 useful   ·   👎 noise   ·   ✅ acted on it"
    ].join("\n\n")
  );
  const parentId = header.id;

  const entries = [];
  for (let i = 0; i < selected.length; i++) {
    const signal = selected[i];
    const interp = interpretations.get(signal.id);
    const cleanTitle = clip((signal.title || "Untitled").replace(/\s+/g, " ").trim(), 120);
    const why = interp?.whyItMatters || signal.llm?.why || (signal.labels ?? []).join(", ");
    const angle = interp?.angle;

    const blocks = [`*${i + 1}. ${cleanTitle}*`, why];
    if (angle) blocks.push(`💬 Angle: ${angle}`);
    blocks.push(`_${signal.sourceName}_`);
    if (signal.url) blocks.push(signal.url);
    const content = blocks.join("\n\n");

    try {
      const msg = await postChannelMessage(content, parentId);
      entries.push({
        messageId: msg.id,
        signalId: signal.id,
        sourceId: signal.sourceId,
        topics: signal.topics ?? [],
        title: cleanTitle
      });
    } catch (error) {
      // Don't let one failed signal post abort the whole brief.
      entries.push({ messageId: null, signalId: signal.id, error: error.message });
    }
  }
  return { destination: "channel", headerId: parentId, entries };
}
