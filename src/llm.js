import { logger } from "./logger.js";
import { clip } from "./text.js";

// Local-first LLM layer. By design the model is only touched while a brief is
// actually being built; `unload()` frees the GPU the moment we are done. The
// provider seam keeps a future `claude-cli` path a config flip away.

const DEFAULT_URL = "http://localhost:11434";

function cfg() {
  return {
    enabled: process.env.LLM_ENABLED !== "false",
    provider: process.env.LLM_PROVIDER || "ollama",
    url: process.env.OLLAMA_URL || DEFAULT_URL,
    model: process.env.OLLAMA_MODEL || "qwen3:8b",
    keepAlive: process.env.OLLAMA_KEEP_ALIVE || "5m",
    batchSize: Number.parseInt(process.env.LLM_CLASSIFY_BATCH ?? "12", 10)
  };
}

export const ALEX_CONTEXT = `Studio Low Five is Alex Stahlmann's studio. Alex's commercial focus:
- Brand voice extraction: helping teams define and scale a distinct brand voice so AI-assisted content does not read generic.
- A workflow / prompt library: reusable operating procedures for content and marketing work (process over one-off prompt tricks).
- Chain Chasers: a casual, disc-golf-flavored indie/mobile game; cares about disc golf culture, indie game design, nostalgia, community.
Alex's point of view: most "AI content" problems are upstream of the prompt; trends matter only once translated into a specific customer problem; repeatable workflows beat prompt novelty.
Audience: small-business owners, founders, marketers, copywriters, and the disc golf and indie/mobile game communities.`;

function stripThink(text = "") {
  // qwen3 emits <think>...</think> reasoning; strip it defensively even when
  // thinking is disabled, so JSON parsing and prose stay clean.
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function isQwen3(model) {
  return /qwen3/i.test(model);
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function ollamaChat(messages, { json = false, temperature = 0, timeoutMs = 120000 } = {}) {
  const c = cfg();
  const body = {
    model: c.model,
    stream: false,
    keep_alive: c.keepAlive,
    options: { temperature },
    messages
  };
  if (isQwen3(c.model)) body.think = false;
  if (json) body.format = "json";

  const res = await fetch(`${c.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`Ollama ${res.status} ${res.statusText}`);
  const data = await res.json();
  return stripThink(data.message?.content || "");
}

export async function isAvailable() {
  const c = cfg();
  if (!c.enabled) return false;
  if (c.provider !== "ollama") {
    logger.warn(`LLM provider "${c.provider}" not implemented; skipping LLM enrichment.`);
    return false;
  }
  try {
    const res = await fetch(`${c.url}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const data = await res.json();
    const models = (data.models ?? []).map((m) => m.name);
    if (!models.includes(c.model)) {
      logger.warn(`Ollama is up but model "${c.model}" is not pulled.`, { available: models });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Free the model from VRAM. Called at the end of every brief so the GPU is only
// occupied during the run, never idle between runs.
export async function unload() {
  const c = cfg();
  if (c.provider !== "ollama") return;
  try {
    await fetch(`${c.url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: c.model, keep_alive: 0 }),
      signal: AbortSignal.timeout(10000)
    });
    logger.info("Released Ollama model from VRAM", { model: c.model });
  } catch (error) {
    logger.warn("Could not unload Ollama model", { error: error.message });
  }
}

const CLASSIFY_SYSTEM = `You triage social and web posts for a market-intelligence brief.
${ALEX_CONTEXT}

For each numbered post decide:
- is_promo (boolean): TRUE if the post's primary purpose is promotion or self-marketing — sales CTAs ("DM us", "book a demo", "sign up", "link in bio", discount codes), affiliate or SEO bait, hashtag stuffing, automated press-release style announcements, or anything that markets AT an audience rather than being a genuine human opinion, question, complaint, or discussion. Otherwise FALSE.
- relevance (integer 1-5): how useful the post is as a STRATEGIC signal — a live audience pain, opinion, question, or debate Alex can interpret into positioning, content, or a product angle. USE THE FULL SCALE AND BE STINGY WITH 5s:
  5 = a specific, genuine audience pain/opinion/debate squarely on brand voice, AI content quality, copywriting, small-business marketing, or content/prompt workflows — something Alex could build a post or product angle on.
  4 = clearly on one of those themes and useful, but more general, second-hand, or a notable competitor/product framing.
  3 = related and mildly useful.
  2 = merely MENTIONS a topic keyword (a listing, announcement, roundup, or tourism/event post that happens to name e.g. "disc golf" or "indie game") with no audience insight.
  1 = unrelated noise.
  Disc golf and indie/mobile games are a SECONDARY interest: score them >=4 ONLY when there is real community sentiment or a concrete design insight — never for tourism, venue listings, or generic announcements that merely mention them.
- why (string, max 12 words).

Be strict on both axes: marketing spam is is_promo=true even when on-topic, and a keyword match alone is relevance 2, not 5.
Return ONLY JSON of the form {"items":[{"n":1,"is_promo":false,"relevance":4,"why":"..."}]}.`;

// Classify signals as genuine vs promo and attach an LLM relevance read.
// Returns the kept signals (promo dropped), each with a `.llm` field, plus a
// `totalScore` nudged by the LLM's relevance so ranking reflects it.
export async function classifyAndFilter(signals) {
  if (!signals.length) return signals;
  const byId = new Map();
  const batches = chunk(signals, Math.max(4, cfg().batchSize));

  for (const batch of batches) {
    const list = batch
      .map((s, i) => `${i + 1}. ${clip(`${s.title} — ${s.summary || ""}`.replace(/\s+/g, " "), 280)}`)
      .join("\n");
    try {
      const content = await ollamaChat(
        [
          { role: "system", content: CLASSIFY_SYSTEM },
          { role: "user", content: `Classify these ${batch.length} posts:\n\n${list}` }
        ],
        { json: true }
      );
      const parsed = safeJson(content);
      for (const item of parsed?.items ?? []) {
        const signal = batch[Number(item.n) - 1];
        if (signal) byId.set(signal.id, item);
      }
    } catch (error) {
      logger.warn("LLM classification batch failed; keeping batch unfiltered", { error: error.message });
    }
  }

  const kept = [];
  let dropped = 0;
  for (const signal of signals) {
    const verdict = byId.get(signal.id);
    if (!verdict) {
      kept.push(signal); // unclassified (e.g. batch error) -> keep, don't lose data
      continue;
    }
    if (verdict.is_promo) {
      dropped++;
      continue;
    }
    const relevance = Math.max(1, Math.min(5, Number(verdict.relevance) || 3));
    kept.push({
      ...signal,
      llm: { relevance, why: verdict.why },
      totalScore: (signal.totalScore ?? 0) + (relevance - 3) * 2
    });
  }
  logger.info(`LLM classify: kept ${kept.length}, dropped ${dropped} promo`, { batches: batches.length });
  return kept;
}

const INTERPRET_SYSTEM = `You are a sharp marketing strategist writing for Alex Stahlmann of Studio Low Five.
${ALEX_CONTEXT}

Given one market signal, return ONLY JSON:
{"why_it_matters":"1-2 sentences on the live audience concern or buying context this reveals",
 "tie_in":"1 sentence connecting it to brand voice extraction, the workflow/prompt library, or Chain Chasers (or say it is general market context)",
 "angle":"a single punchy line Alex could post, in his plain, contrarian, practical voice",
 "urgency":"1 short sentence on timing"}
No hype, no emoji, no hashtags. Be concrete and specific to THIS signal.`;

export async function interpretSignals(signals) {
  const out = new Map();
  for (const signal of signals) {
    try {
      const content = await ollamaChat(
        [
          { role: "system", content: INTERPRET_SYSTEM },
          {
            role: "user",
            content: `Signal:\nTitle: ${signal.title}\nSummary: ${clip(signal.summary || "", 600)}\nSource: ${signal.sourceName}`
          }
        ],
        { json: true }
      );
      const parsed = safeJson(content);
      if (parsed) {
        out.set(signal.id, {
          whyItMatters: parsed.why_it_matters,
          tieIn: parsed.tie_in,
          angle: parsed.angle,
          urgency: parsed.urgency
        });
      }
    } catch (error) {
      logger.warn("LLM interpret failed for a signal", { id: signal.id, error: error.message });
    }
  }
  return out;
}

const BRIEF_SYSTEM = `You are a sharp marketing strategist writing for Alex Stahlmann of Studio Low Five.
${ALEX_CONTEXT}

Given today's selected signals, synthesize the brief. Be honest about a quiet day — if signals are weak, say so and do not manufacture importance. Return ONLY JSON:
{"one_thing":"the single most worthwhile action today in one sentence, or a plain statement that today is quiet and not worth a post",
 "executive_summary":"2-3 sentences on the real read today, matching the assessed strength",
 "linkedin_angles":["3 short post-worthy lines in Alex's plain, contrarian, practical voice"],
 "video_ideas":[{"hook":"...","premise":"...","visual":"...","fit":"which product/beat it supports"}]}
Ground everything in the actual signals. No hype, no emoji, no hashtags.`;

export async function synthesizeBrief(signals, { dayStrength = "moderate" } = {}) {
  const list = signals
    .slice(0, 16)
    .map((s, i) => `${i + 1}. [${s.sourceName}] ${clip(s.title, 160)}`)
    .join("\n");
  try {
    const content = await ollamaChat(
      [
        { role: "system", content: BRIEF_SYSTEM },
        { role: "user", content: `Today's strength: ${dayStrength}.\nToday's selected signals:\n\n${list}` }
      ],
      { json: true }
    );
    const parsed = safeJson(content);
    if (!parsed) return null;
    return {
      oneThing: parsed.one_thing,
      executiveSummary: parsed.executive_summary,
      linkedinAngles: Array.isArray(parsed.linkedin_angles) ? parsed.linkedin_angles : [],
      videoIdeas: Array.isArray(parsed.video_ideas) ? parsed.video_ideas : []
    };
  } catch (error) {
    logger.warn("LLM brief synthesis failed", { error: error.message });
    return null;
  }
}
