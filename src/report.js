import { clip, stripMarkdown } from "./text.js";

function reportWindowStart(now = new Date()) {
  const day = now.getDay();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (day === 1) {
    start.setDate(start.getDate() - 3);
    start.setHours(17, 0, 0, 0);
  } else {
    start.setDate(start.getDate() - 1);
  }
  return start;
}

function signalWindowDate(signal) {
  const published = Date.parse(signal.publishedAt);
  if (Number.isFinite(published)) return new Date(published);
  return new Date(signal.collectedAt);
}

// A 1-5 quality read per signal. Prefer the LLM's relevance grade; fall back to
// the strongest keyword score so the gate still works without the LLM.
export function signalQuality(signal) {
  if (signal.llm?.relevance != null) return signal.llm.relevance;
  const product = Math.max(signal.scores.brandVoice, signal.scores.workflowLibrary, signal.scores.chainChasers);
  return Math.max(product, signal.scores.businessOpportunity, signal.scores.contentPotential);
}

function qualityBar() {
  const value = Number.parseInt(process.env.QUALITY_BAR ?? "3", 10);
  return Number.isFinite(value) ? value : 3;
}

// Quality-gated selection: only signals that clear the bar, ranked, capped — and
// we DON'T backfill to a fixed count. A thin day returns few (or zero) signals on
// purpose, so the brief reads as thin instead of padded.
export function selectReportSignals(signals, now = new Date(), opts = {}) {
  const start = reportWindowStart(now);
  const max = opts.max ?? (now.getDay() === 1 ? 8 : 6);
  const bar = qualityBar();
  return signals
    .filter((signal) => signalWindowDate(signal) >= start)
    .map((signal) => ({ ...signal, quality: signalQuality(signal) }))
    .filter((signal) => signal.quality >= bar)
    .sort((a, b) => b.quality - a.quality || b.totalScore - a.totalScore)
    .slice(0, max);
}

// How strong is today, used to keep the brief honest (and suppress speculative
// sections on quiet days). Based on count and how many are genuinely strong (>=4).
export function assessDayStrength(selected) {
  const strong = selected.filter((s) => (s.quality ?? signalQuality(s)) >= 4).length;
  if (!selected.length) return "empty";
  if (selected.length <= 1 || strong === 0) return "thin";
  if (selected.length <= 3 || strong < 3) return "moderate";
  return "strong";
}

function scoreLine(scores) {
  return `Alex ${scores.alex}/5 | Brand voice ${scores.brandVoice}/5 | Workflow library ${scores.workflowLibrary}/5 | Chain Chasers ${scores.chainChasers}/5 | Timeliness ${scores.timeliness}/5 | Content ${scores.contentPotential}/5 | Business ${scores.businessOpportunity}/5`;
}

function inferTieIn(signal) {
  const best = Object.entries({
    "brand voice extraction": signal.scores.brandVoice,
    "workflow prompt library": signal.scores.workflowLibrary,
    "Chain Chasers": signal.scores.chainChasers
  }).sort((a, b) => b[1] - a[1])[0];
  if (best[1] <= 2) return "Mostly useful as market context for Alex's point of view.";
  return `Strongest tie-in: ${best[0]}.`;
}

function angleFor(signal) {
  const text = `${signal.title} ${signal.summary}`.toLowerCase();
  if (text.includes("brand") || text.includes("voice") || text.includes("ai content")) {
    return "The problem with AI content usually starts before anyone opens ChatGPT.";
  }
  if (text.includes("prompt") || text.includes("workflow")) {
    return "A good prompt is not magic text. It is a small operating procedure.";
  }
  if (text.includes("disc") || text.includes("game") || text.includes("indie")) {
    return "Nostalgia works when it makes the experience easier to love, not just older-looking.";
  }
  return "Most trends are only useful after you translate them into a specific customer problem.";
}

function urgency(signal) {
  if (signal.labels.includes("Action Today")) return "Act today if you want to be early in the conversation.";
  if (signal.labels.includes("Hot")) return "Worth using this week while the conversation has heat.";
  return "Keep watching; useful, but not urgent yet.";
}

function sourceLinks(signal) {
  return (signal.urls?.length ? signal.urls : [signal.url]).filter(Boolean).map((url) => `- ${url}`).join("\n");
}

function repeatedThemes(signals) {
  const themes = [
    ["AI content sameness", ["ai", "content", "voice", "generic"]],
    ["Workflow over prompt novelty", ["workflow", "prompt", "process", "template"]],
    ["Small business marketing uncertainty", ["marketing", "customer", "sales", "small business"]],
    ["Disc golf and indie-game community hooks", ["disc", "game", "indie", "mobile"]]
  ];
  return themes
    .map(([theme, words]) => {
      const count = signals.filter((signal) => words.some((word) => `${signal.title} ${signal.summary}`.toLowerCase().includes(word))).length;
      return { theme, count };
    })
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

function audienceLanguage(signals) {
  return signals
    .flatMap((signal) => [signal.title, signal.summary])
    .filter(Boolean)
    .map(stripMarkdown)
    .filter((line) => line.length >= 20)
    .slice(0, 8)
    .map((line) => `- "${clip(line, 150)}"`)
    .join("\n");
}

function connectorHealthLines(status) {
  if (!status?.sources?.length) {
    return ["- No connector status recorded for this run. Run `npm run collect` before reporting."];
  }
  const broken = status.sources.filter((source) => source.status === "error");
  const empty = status.sources.filter((source) => source.status === "empty");
  const ok = status.sources.filter((source) => source.status === "ok");

  const lines = [];
  lines.push(`Sources reporting: ${ok.length} ok, ${empty.length} empty, ${broken.length} failed (of ${status.sources.length} enabled).`);
  if (broken.length) {
    broken.forEach((source) => lines.push(`- FAILED ${source.name}: ${clip(source.error || "unknown error", 160)}`));
  }
  if (empty.length) {
    lines.push(`- Empty (no items): ${empty.map((source) => source.name).join(", ")}`);
  }
  if (broken.length || empty.length) {
    lines.push("If key sources failed or are empty, treat a thin report as a collection problem, not a quiet market.");
  }
  return lines;
}

export function generateReport(scoredSignals, options = {}) {
  const now = options.now ?? new Date();
  const selected =
    options.selected ?? (options.allSignals ? scoredSignals : selectReportSignals(scoredSignals, now));
  const date = now.toISOString().slice(0, 10);
  const isMonday = now.getDay() === 1;
  const themes = repeatedThemes(selected);
  const interpretations = options.interpretations ?? null;
  const llmBrief = options.llmBrief ?? null;
  const dayStrength = options.dayStrength ?? assessDayStrength(selected);
  // Speculative content (post angles, video ideas, reply targets) is only worth
  // generating when the day actually has substance. On thin days we suppress it
  // rather than manufacture padding the reader learns to skim past.
  const showSpeculative = dayStrength === "moderate" || dayStrength === "strong";
  const oneThing =
    llmBrief?.oneThing ||
    (selected.length
      ? `${selected[0].title} — ${interpretations?.get(selected[0].id)?.angle ?? angleFor(selected[0])}`
      : null);

  const lines = [];
  lines.push(`# Morning Brief - ${date}`);
  lines.push("");
  const analysis = options.llmActive
    ? `Analysis: filtered & ranked by ${options.llmModel || "local model"}; prose ${
        options.polishModel ? `polished by ${options.polishModel}` : `written by ${options.llmModel || "local model"}`
      }`
    : "Analysis: keyword scoring only (LLM unavailable — interpretive sections are templated)";
  lines.push(`_${analysis}${options.feedbackActive ? "; ranking tuned by your reactions" : ""}._`);
  lines.push("");
  lines.push("## Connector Health");
  connectorHealthLines(options.connectorStatus).forEach((line) => lines.push(line));
  lines.push("");
  // Lead with the single most worthwhile action — the first thing you read.
  lines.push("## If You Do One Thing Today");
  if (oneThing) {
    lines.push(oneThing);
  } else {
    const reason = options.connectorStatus?.sources?.some((s) => s.status === "error")
      ? "Nothing cleared the bar — but sources failed today (see Connector Health), so treat this as a collection gap, not a quiet market."
      : "Nothing cleared the bar today. Genuinely quiet — skip posting and reclaim the time.";
    lines.push(reason);
  }
  lines.push("");

  lines.push("## Executive Summary");
  if (!selected.length) {
    lines.push(
      "No signals cleared the quality bar for this window. Check Connector Health above before treating the quiet as a market read."
    );
  } else {
    if (llmBrief?.executiveSummary) {
      // The LLM already writes an honest, strength-aware summary; don't prepend.
      lines.push(llmBrief.executiveSummary);
    } else {
      const strengthNote =
        dayStrength === "thin"
          ? "Thin day — a couple of real signals, nothing that demands a post. "
          : dayStrength === "strong"
          ? "Strong day — several signals worth acting on. "
          : "";
      const topTheme = themes[0]?.theme ?? "useful but fragmented conversations";
      lines.push(
        `${strengthNote}The strongest read today is ${topTheme.toLowerCase()}. The opportunities are not link-chasing; they are translating live market language into sharper positioning, useful content, and small product tests.`
      );
    }
  }
  lines.push("");

  if (isMonday && selected.length) {
    lines.push("## Weekend Catch-Up");
    lines.push("Weekend signals are folded into today's ranking.");
    lines.push("");
  }

  lines.push(`## Best Signals${selected.length ? ` (${selected.length})` : ""}`);
  if (!selected.length) {
    lines.push("- Nothing cleared the quality bar today. No filler.");
    lines.push("");
  }
  selected.forEach((signal, index) => {
    const interp = interpretations?.get(signal.id);
    lines.push(`### ${index + 1}. ${signal.title}`);
    if (signal.resurfaceReason) lines.push(`↻ Resurfaced: ${signal.resurfaceReason}`);
    lines.push(`Labels: ${signal.labels.join(", ")} | Quality ${signal.quality ?? signalQuality(signal)}/5`);
    lines.push(`Sources: ${signal.sourceName}`);
    lines.push(`Scores: ${scoreLine(signal.scores)}`);
    lines.push(`What happened: ${clip(signal.summary || signal.title, 320)}`);
    lines.push(`Why it matters: ${interp?.whyItMatters ?? "This points to a live audience concern or buying context Alex can interpret instead of merely repeat."}`);
    lines.push(`Why Alex should care: ${interp?.tieIn ?? inferTieIn(signal)}`);
    lines.push(`Suggested angle: "${interp?.angle ?? angleFor(signal)}"`);
    lines.push(`Urgency: ${interp?.urgency ?? urgency(signal)}`);
    lines.push("Source links:");
    lines.push(sourceLinks(signal) || "- No source URL captured.");
    lines.push("");
  });

  if (selected.length) {
    lines.push("## Repeated Themes");
    lines.push(themes.length ? themes.map((item) => `- ${item.theme}: ${item.count} signal(s)`).join("\n") : "- No clear repeated themes today.");
    lines.push("");

    lines.push("## Audience Language");
    lines.push(audienceLanguage(selected) || "- Not enough conversational language collected today.");
    lines.push("");
  }

  // Speculative output is suppressed on thin/empty days to keep the brief honest.
  if (showSpeculative) {
    lines.push("## LinkedIn Angles");
    if (llmBrief?.linkedinAngles?.length) {
      llmBrief.linkedinAngles.forEach((angle) => lines.push(`- "${stripMarkdown(angle)}"`));
    } else {
      lines.push('- "AI does not kill brand voice. It exposes whether you had one to begin with."');
      lines.push('- "The companies getting useful AI content are not better at prompts. They are clearer about standards."');
      lines.push('- "A prompt library is only valuable if it teaches a repeatable way to think."');
    }
    lines.push("");

    lines.push("## Short-Form Video Ideas");
    if (llmBrief?.videoIdeas?.length) {
      llmBrief.videoIdeas.forEach((idea) =>
        lines.push(`- Hook: ${idea.hook} Premise: ${idea.premise} Visual: ${idea.visual} Fit: ${idea.fit}`)
      );
    } else {
      lines.push("- Hook: Your AI content sounds generic because your inputs are generic. Premise: show the difference between a vague prompt and a voice-informed workflow. Visual: split-screen prompt teardown. Fit: directly supports brand voice extraction.");
      lines.push("- Hook: Stop saving prompts. Start saving decisions. Premise: explain why reusable workflows beat one-off prompt tricks. Visual: messy prompt folder vs clean workflow checklist. Fit: supports the workflow library.");
    }
    lines.push("");

    const replyTargets = selected.filter((signal) => signal.connector === "reddit" || signal.labels.includes("Conversation")).slice(0, 5);
    if (replyTargets.length) {
      lines.push("## Reply / Engagement Opportunities");
      replyTargets.forEach((signal) => {
        lines.push(`- ${signal.url} - Reply angle: add a practical distinction, not a pitch. Use the thread's pain point to explain what a better workflow or clearer brand standard would change.`);
      });
      lines.push("");
    }
  }

  return {
    title: `Morning Brief - ${date}`,
    body: lines.join("\n"),
    signalCount: selected.length,
    generatedAt: now.toISOString()
  };
}
