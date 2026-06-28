const lexicons = {
  alex: ["copywriting", "positioning", "brand", "marketing", "content", "strategy", "small business", "founder"],
  brandVoice: ["brand voice", "voice", "tone", "generic", "differentiated", "content quality", "ai content", "copy"],
  workflow: ["workflow", "prompt", "process", "template", "system", "automation", "operation", "repeatable"],
  chainChasers: ["disc golf", "discgolf", "putter", "course", "mobile game", "indie game", "retro", "arcade"],
  content: ["debate", "mistake", "how do i", "why", "problem", "trend", "launch", "new", "complaint"],
  business: ["pricing", "offer", "launch", "buyer", "customer", "monetize", "conversion", "sales"]
};

function scoreText(text, words) {
  const lower = text.toLowerCase();
  const hits = words.reduce((count, word) => count + (lower.includes(word) ? 1 : 0), 0);
  return Math.max(1, Math.min(5, 1 + hits));
}

function sourceBoost(signal) {
  const boost = {
    alex: 0,
    brandVoice: 0,
    workflowLibrary: 0,
    chainChasers: 0,
    contentPotential: 0,
    businessOpportunity: 0
  };
  if (signal.sourceId === "openai-blog") {
    boost.brandVoice = 1;
    boost.workflowLibrary = 1;
  }
  if (signal.sourceId === "producthunt") {
    boost.workflowLibrary = 1;
    boost.businessOpportunity = 1;
  }
  if ((signal.topics ?? []).some((topic) => /disc golf|chain chasers|indie games|mobile games/i.test(topic))) {
    boost.chainChasers = 1;
  }
  return boost;
}

function recencyScore(publishedAt) {
  const ageHours = (Date.now() - new Date(publishedAt).getTime()) / 36e5;
  if (ageHours <= 12) return 5;
  if (ageHours <= 24) return 4;
  if (ageHours <= 72) return 3;
  if (ageHours <= 168) return 2;
  return 1;
}

export function scoreSignals(signals) {
  return signals.map((signal) => {
    const text = `${signal.title} ${signal.summary}`;
    const boost = sourceBoost(signal);
    const scores = {
      alex: Math.min(5, scoreText(text, lexicons.alex) + boost.alex),
      brandVoice: Math.min(5, scoreText(text, lexicons.brandVoice) + boost.brandVoice),
      workflowLibrary: Math.min(5, scoreText(text, lexicons.workflow) + boost.workflowLibrary),
      chainChasers: Math.min(5, scoreText(text, lexicons.chainChasers) + boost.chainChasers),
      timeliness: recencyScore(signal.publishedAt),
      contentPotential: Math.min(5, scoreText(text, lexicons.content) + boost.contentPotential),
      businessOpportunity: Math.min(5, scoreText(text, lexicons.business) + boost.businessOpportunity)
    };

    const volumeBoost = signal.crossSourceCount > 1 || (signal.comments ?? 0) > 40 || (signal.score ?? 0) > 100;
    const productRelevance = Math.max(scores.brandVoice, scores.workflowLibrary, scores.chainChasers);
    const strategicRelevance = Math.max(productRelevance, scores.businessOpportunity);
    const labels = [];
    if (volumeBoost) labels.push("Hot");
    if (productRelevance >= 3 || scores.businessOpportunity >= 4) labels.push("Opportunity");
    if (scores.contentPotential >= 3) labels.push("Conversation");
    if (scores.timeliness >= 4 && (volumeBoost || scores.contentPotential >= 3) && strategicRelevance >= 3) labels.push("Action Today");
    if (!labels.length) labels.push("Watch");

    const total =
      scores.alex * 1.2 +
      scores.brandVoice * 1.3 +
      scores.workflowLibrary * 1.2 +
      scores.chainChasers * 1.2 +
      scores.timeliness * 0.7 +
      scores.contentPotential +
      scores.businessOpportunity * 1.2 +
      (volumeBoost ? 2 : 0);

    return { ...signal, scores, labels, totalScore: total };
  });
}
