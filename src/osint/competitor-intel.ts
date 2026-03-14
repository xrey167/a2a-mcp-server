// src/osint/competitor-intel.ts
// Competitor intelligence module — parses raw news/market data, classifies
// signals, assesses threat level, and generates SWOT-style briefs.

// ── Types ────────────────────────────────────────────────────────

export interface CompetitorProfile {
  name: string;
  domains: string[];
  industry: string;
  knownProducts: string[];
}

export interface CompetitorSignal {
  type: "news" | "market" | "product" | "hiring" | "patent";
  title: string;
  source: string;
  date: string;
  sentiment: "positive" | "neutral" | "negative";
  relevance: "high" | "medium" | "low";
  summary: string;
}

export interface CompetitorBrief {
  competitor: CompetitorProfile;
  signals: CompetitorSignal[];
  threatLevel: "high" | "medium" | "low";
  marketPosition: string;
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  recentMoves: string[];
  recommendations: string[];
  assessedAt: string;
}

// ── Signal Classification ────────────────────────────────────────

const SIGNAL_TYPE_KEYWORDS: Record<CompetitorSignal["type"], string[]> = {
  news: ["announce", "launch", "release", "update", "report", "press", "statement"],
  market: ["stock", "share", "revenue", "earnings", "valuation", "ipo", "funding", "invest"],
  product: ["product", "feature", "version", "upgrade", "beta", "ga", "platform", "tool"],
  hiring: ["hire", "recruit", "team", "talent", "headcount", "job", "position", "engineer"],
  patent: ["patent", "intellectual property", "trademark", "filing", "invention"],
};

const POSITIVE_KEYWORDS = [
  "growth", "profit", "innovation", "award", "partnership", "expansion",
  "record", "success", "milestone", "breakthrough", "surpass",
];
const NEGATIVE_KEYWORDS = [
  "loss", "decline", "lawsuit", "layoff", "breach", "recall", "fine",
  "investigation", "downturn", "restructuring", "delay", "vulnerability",
];

function classifySignalType(text: string): CompetitorSignal["type"] {
  const lower = text.toLowerCase();
  let bestType: CompetitorSignal["type"] = "news";
  let bestScore = 0;

  for (const [type, keywords] of Object.entries(SIGNAL_TYPE_KEYWORDS)) {
    const score = keywords.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestType = type as CompetitorSignal["type"];
    }
  }
  return bestType;
}

function classifySentiment(text: string): CompetitorSignal["sentiment"] {
  const lower = text.toLowerCase();
  const pos = POSITIVE_KEYWORDS.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
  const neg = NEGATIVE_KEYWORDS.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
  if (pos > neg) return "positive";
  if (neg > pos) return "negative";
  return "neutral";
}

function scoreRelevance(text: string, competitor: CompetitorProfile): CompetitorSignal["relevance"] {
  const lower = text.toLowerCase();
  const nameMentions = lower.includes(competitor.name.toLowerCase()) ? 2 : 0;
  const domainMentions = competitor.domains.reduce(
    (n, d) => n + (lower.includes(d.toLowerCase()) ? 1 : 0), 0,
  );
  const productMentions = competitor.knownProducts.reduce(
    (n, p) => n + (lower.includes(p.toLowerCase()) ? 1 : 0), 0,
  );
  const total = nameMentions + domainMentions + productMentions;
  if (total >= 3) return "high";
  if (total >= 1) return "medium";
  return "low";
}

// ── Data Extraction ──────────────────────────────────────────────

function extractText(item: unknown): { title: string; body: string; source: string; date: string } {
  const obj = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
  const title = String(obj.title ?? obj.headline ?? obj.name ?? "");
  const body = String(obj.content ?? obj.summary ?? obj.description ?? obj.text ?? "");
  const source = String(obj.source ?? obj.feed ?? obj.url ?? obj.provider ?? "unknown");
  const date = String(obj.date ?? obj.publishedAt ?? obj.timestamp ?? new Date().toISOString());
  return { title, body, source, date };
}

function parseSignals(items: unknown[], competitor: CompetitorProfile): CompetitorSignal[] {
  const signals: CompetitorSignal[] = [];
  for (const item of items) {
    const { title, body, source, date } = extractText(item);
    const combined = `${title} ${body}`;
    if (!combined.trim()) continue;

    signals.push({
      type: classifySignalType(combined),
      title: title || body.slice(0, 80),
      source,
      date,
      sentiment: classifySentiment(combined),
      relevance: scoreRelevance(combined, competitor),
      summary: body.slice(0, 200) || title,
    });
  }
  return signals;
}

// ── Threat Assessment ────────────────────────────────────────────

function assessThreatLevel(signals: CompetitorSignal[]): CompetitorBrief["threatLevel"] {
  const highRelevance = signals.filter(s => s.relevance === "high").length;
  const positiveSignals = signals.filter(s => s.sentiment === "positive").length;
  const productSignals = signals.filter(s => s.type === "product" || s.type === "patent").length;

  const threatScore = highRelevance * 3 + positiveSignals * 2 + productSignals * 2;
  if (threatScore >= 15) return "high";
  if (threatScore >= 6) return "medium";
  return "low";
}

function deriveMarketPosition(signals: CompetitorSignal[], competitor: CompetitorProfile): string {
  const marketSignals = signals.filter(s => s.type === "market");
  const positiveMarket = marketSignals.filter(s => s.sentiment === "positive").length;
  const negativeMarket = marketSignals.filter(s => s.sentiment === "negative").length;

  if (positiveMarket > negativeMarket + 2) {
    return `${competitor.name} appears to be in a strong market position with positive momentum`;
  }
  if (negativeMarket > positiveMarket + 2) {
    return `${competitor.name} shows signs of market weakness or contraction`;
  }
  return `${competitor.name} maintains a stable market position in ${competitor.industry}`;
}

function deriveSWOT(signals: CompetitorSignal[], competitor: CompetitorProfile): {
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
} {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const opportunities: string[] = [];

  const positiveProduct = signals.filter(s => s.type === "product" && s.sentiment === "positive");
  if (positiveProduct.length > 0) strengths.push("Active product development and innovation");

  const hiringSignals = signals.filter(s => s.type === "hiring");
  if (hiringSignals.length > 1) strengths.push("Aggressive talent acquisition");

  const patentSignals = signals.filter(s => s.type === "patent");
  if (patentSignals.length > 0) strengths.push("IP portfolio expansion");

  const negativeNews = signals.filter(s => s.sentiment === "negative");
  if (negativeNews.length > 2) weaknesses.push("Negative press coverage may impact brand");

  const negativeMarket = signals.filter(s => s.type === "market" && s.sentiment === "negative");
  if (negativeMarket.length > 0) weaknesses.push("Market indicators suggest financial pressure");

  if (weaknesses.length > 0) opportunities.push("Competitor vulnerabilities create market entry points");
  if (hiringSignals.length === 0) opportunities.push("Competitor may be under-investing in talent");
  if (competitor.knownProducts.length < 3) opportunities.push("Limited product portfolio leaves gaps");

  if (strengths.length === 0) strengths.push("Established brand presence in " + competitor.industry);
  if (weaknesses.length === 0) weaknesses.push("No significant weaknesses detected in current data");
  if (opportunities.length === 0) opportunities.push("Monitor for emerging gaps in competitor strategy");

  return { strengths, weaknesses, opportunities };
}

// ── Public API ───────────────────────────────────────────────────

export function buildCompetitorBrief(
  competitor: CompetitorProfile,
  newsData: unknown[],
  marketData: unknown[],
): CompetitorBrief {
  const newsSignals = parseSignals(newsData, competitor);
  const marketSignals = parseSignals(marketData, competitor);
  const allSignals = [...newsSignals, ...marketSignals]
    .sort((a, b) => b.date.localeCompare(a.date));

  const threatLevel = assessThreatLevel(allSignals);
  const marketPosition = deriveMarketPosition(allSignals, competitor);
  const { strengths, weaknesses, opportunities } = deriveSWOT(allSignals, competitor);

  const recentMoves = allSignals
    .filter(s => s.relevance !== "low")
    .slice(0, 5)
    .map(s => `[${s.type}] ${s.title}`);

  const recommendations: string[] = [];
  if (threatLevel === "high") {
    recommendations.push("Increase monitoring frequency to daily");
    recommendations.push("Conduct detailed competitive analysis on overlapping product areas");
  }
  if (threatLevel === "medium") {
    recommendations.push("Review competitive positioning quarterly");
  }
  if (allSignals.some(s => s.type === "patent")) {
    recommendations.push("Review patent filings for potential IP conflicts");
  }
  if (allSignals.some(s => s.type === "hiring" && s.relevance === "high")) {
    recommendations.push("Assess talent pipeline overlap and retention risk");
  }
  if (recommendations.length === 0) {
    recommendations.push("Maintain standard monitoring cadence");
  }

  return {
    competitor,
    signals: allSignals,
    threatLevel,
    marketPosition,
    strengths,
    weaknesses,
    opportunities,
    recentMoves,
    recommendations,
    assessedAt: new Date().toISOString(),
  };
}
