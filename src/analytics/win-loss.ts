/**
 * Win/Loss Analysis for Q2O (Quote-to-Order) Pipeline
 *
 * Segments historical quote data across multiple dimensions,
 * identifies statistically significant win/loss patterns,
 * and generates actionable recommendations.
 */

export interface QuoteRecord {
  quoteId: string;
  customerId: string;
  customerName: string;
  industry?: string;
  productGroup?: string;
  totalValue: number;
  currency: string;
  createdAt: string;
  closedAt: string;
  status: "converted" | "rejected" | "expired";
  revisionCount: number;
  daysToClose: number;
  discountPercent: number;
  sentimentScore?: number;
  ownerName?: string;
}

export interface WinLossPattern {
  dimension: string;
  insight: string;
  winRate: number;
  sampleSize: number;
  significance: "high" | "medium" | "low";
}

export interface WinLossAnalysis {
  totalDeals: number;
  wonDeals: number;
  lostDeals: number;
  overallWinRate: number;

  byDealSize: WinLossPattern[];
  byIndustry: WinLossPattern[];
  byProductGroup: WinLossPattern[];
  byDuration: WinLossPattern[];
  byDiscount: WinLossPattern[];
  bySentiment: WinLossPattern[];

  topWinFactors: WinLossPattern[];
  topLossFactors: WinLossPattern[];
  recommendations: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function significance(size: number): "high" | "medium" | "low" {
  if (size > 20) return "high";
  if (size > 10) return "medium";
  return "low";
}

function winRateFor(quotes: QuoteRecord[]): number {
  if (quotes.length === 0) return 0;
  const wins = quotes.filter((q) => q.status === "converted").length;
  return wins / quotes.length;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(item);
  }
  return map;
}

function dealSizeBucket(value: number): string {
  if (value < 5_000) return "micro (<5k)";
  if (value < 25_000) return "small (5k-25k)";
  if (value < 100_000) return "mid (25k-100k)";
  if (value < 500_000) return "large (100k-500k)";
  return "enterprise (500k+)";
}

function durationBucket(days: number): string {
  if (days <= 7) return "fast (≤7d)";
  if (days <= 30) return "standard (8-30d)";
  if (days <= 90) return "extended (31-90d)";
  return "long (>90d)";
}

function discountBucket(pct: number): string {
  if (pct === 0) return "no discount";
  if (pct <= 5) return "light (1-5%)";
  if (pct <= 15) return "moderate (6-15%)";
  if (pct <= 25) return "heavy (16-25%)";
  return "deep (>25%)";
}

function sentimentBucket(score: number): string {
  if (score >= 0.7) return "positive (≥0.7)";
  if (score >= 0.4) return "neutral (0.4-0.69)";
  return "negative (<0.4)";
}

function patternsFromGroups(
  groups: Map<string, QuoteRecord[]>,
  dimensionName: string,
  overallWinRate: number,
): WinLossPattern[] {
  const patterns: WinLossPattern[] = [];
  for (const [key, quotes] of groups) {
    const rate = winRateFor(quotes);
    const diff = rate - overallWinRate;
    const direction = diff > 0 ? "higher" : "lower";
    const absDiff = Math.abs(diff * 100).toFixed(1);

    patterns.push({
      dimension: dimensionName,
      insight: `${key}: win rate ${(rate * 100).toFixed(1)}% (${absDiff}pp ${direction} than average)`,
      winRate: rate,
      sampleSize: quotes.length,
      significance: significance(quotes.length),
    });
  }
  return patterns.sort((a, b) => b.winRate - a.winRate);
}

// ── Core Analysis ────────────────────────────────────────────────────

export function analyzeWinLoss(quotes: QuoteRecord[]): WinLossAnalysis {
  const totalDeals = quotes.length;
  const wonDeals = quotes.filter((q) => q.status === "converted").length;
  const lostDeals = totalDeals - wonDeals;
  const overallWinRate = totalDeals > 0 ? wonDeals / totalDeals : 0;

  process.stderr.write(
    `[win-loss] Analyzing ${totalDeals} quotes (${wonDeals} won, ${lostDeals} lost, rate=${(overallWinRate * 100).toFixed(1)}%)\n`,
  );

  // Segment by deal size
  const byDealSize = patternsFromGroups(
    groupBy(quotes, (q) => dealSizeBucket(q.totalValue)),
    "dealSize",
    overallWinRate,
  );

  // Segment by industry
  const byIndustry = patternsFromGroups(
    groupBy(quotes, (q) => q.industry ?? "unknown"),
    "industry",
    overallWinRate,
  );

  // Segment by product group
  const byProductGroup = patternsFromGroups(
    groupBy(quotes, (q) => q.productGroup ?? "unknown"),
    "productGroup",
    overallWinRate,
  );

  // Segment by deal duration
  const byDuration = patternsFromGroups(
    groupBy(quotes, (q) => durationBucket(q.daysToClose)),
    "duration",
    overallWinRate,
  );

  // Segment by discount level
  const byDiscount = patternsFromGroups(
    groupBy(quotes, (q) => discountBucket(q.discountPercent)),
    "discount",
    overallWinRate,
  );

  // Segment by sentiment (only quotes that have it)
  const withSentiment = quotes.filter((q) => q.sentimentScore !== undefined);
  const bySentiment =
    withSentiment.length > 0
      ? patternsFromGroups(
          groupBy(withSentiment, (q) => sentimentBucket(q.sentimentScore!)),
          "sentiment",
          overallWinRate,
        )
      : [];

  // Collect all patterns, find significant deviations
  const allPatterns = [
    ...byDealSize,
    ...byIndustry,
    ...byProductGroup,
    ...byDuration,
    ...byDiscount,
    ...bySentiment,
  ];

  const DEVIATION_THRESHOLD = 0.15;

  const topWinFactors = allPatterns
    .filter(
      (p) =>
        p.winRate - overallWinRate > DEVIATION_THRESHOLD &&
        p.significance !== "low",
    )
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 5);

  const topLossFactors = allPatterns
    .filter(
      (p) =>
        overallWinRate - p.winRate > DEVIATION_THRESHOLD &&
        p.significance !== "low",
    )
    .sort((a, b) => a.winRate - b.winRate)
    .slice(0, 5);

  // Generate recommendations
  const recommendations: string[] = [];

  for (const factor of topWinFactors) {
    recommendations.push(
      `Double down on ${factor.dimension} segment "${factor.insight.split(":")[0]}" — win rate is ${(factor.winRate * 100).toFixed(0)}% vs ${(overallWinRate * 100).toFixed(0)}% overall.`,
    );
  }

  for (const factor of topLossFactors) {
    recommendations.push(
      `Review strategy for ${factor.dimension} segment "${factor.insight.split(":")[0]}" — win rate only ${(factor.winRate * 100).toFixed(0)}% vs ${(overallWinRate * 100).toFixed(0)}% overall.`,
    );
  }

  // Discount-specific recommendation
  const heavyDiscount = byDiscount.find(
    (p) => p.insight.startsWith("heavy") || p.insight.startsWith("deep"),
  );
  const noDiscount = byDiscount.find((p) => p.insight.startsWith("no discount"));
  if (heavyDiscount && noDiscount && heavyDiscount.winRate <= noDiscount.winRate) {
    recommendations.push(
      "Heavy discounting does not improve win rates — consider value-based selling instead of price concessions.",
    );
  }

  // Duration recommendation
  const longDeals = byDuration.find((p) => p.insight.startsWith("long"));
  if (longDeals && longDeals.winRate < overallWinRate - 0.1) {
    recommendations.push(
      "Deals taking >90 days have significantly lower win rates. Implement stage-gate reviews to disqualify or accelerate stalled opportunities.",
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      "No strong deviation patterns found. Consider collecting more data or adding dimensions such as competitor presence or buyer persona.",
    );
  }

  process.stderr.write(
    `[win-loss] Analysis complete: ${topWinFactors.length} win factors, ${topLossFactors.length} loss factors, ${recommendations.length} recommendations\n`,
  );

  return {
    totalDeals,
    wonDeals,
    lostDeals,
    overallWinRate,
    byDealSize,
    byIndustry,
    byProductGroup,
    byDuration,
    byDiscount,
    bySentiment,
    topWinFactors,
    topLossFactors,
    recommendations,
  };
}
