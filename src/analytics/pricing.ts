/**
 * Price Optimization from Historical Quote Data
 *
 * Analyzes price distributions, calculates elasticity per product group,
 * and generates pricing recommendations to maximize revenue and win rate.
 */

import type { QuoteRecord, WinLossAnalysis } from "./win-loss.js";

export interface PriceBand {
  range: string;
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  winRate: number;
  dealCount: number;
  optimalPrice: number;
}

export interface PriceElasticity {
  productGroup: string;
  elasticity: number;
  confidence: number;
}

export interface PricingRecommendation {
  productGroup: string;
  currentAvgPrice: number;
  recommendedPrice: number;
  expectedWinRateChange: number;
  expectedRevenueImpact: number;
  rationale: string;
}

export interface PricingAnalysis {
  priceBands: PriceBand[];
  elasticity: PriceElasticity[];
  recommendations: PricingRecommendation[];
  overallPriceWinCorrelation: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
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

function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(0);
}

// ── Price Band Construction ──────────────────────────────────────────

function buildPriceBands(quotes: QuoteRecord[], bandCount: number = 5): PriceBand[] {
  if (quotes.length === 0) return [];

  const sorted = [...quotes].sort((a, b) => a.totalValue - b.totalValue);
  const minVal = sorted[0].totalValue;
  const maxVal = sorted[sorted.length - 1].totalValue;

  if (maxVal === minVal) {
    const wr = quotes.filter((q) => q.status === "converted").length / quotes.length;
    return [
      {
        range: `${formatCurrency(minVal)}`,
        minPrice: minVal,
        maxPrice: maxVal,
        avgPrice: minVal,
        winRate: wr,
        dealCount: quotes.length,
        optimalPrice: minVal,
      },
    ];
  }

  // Use logarithmic bands for better distribution across orders of magnitude
  const logMin = Math.log10(Math.max(minVal, 1));
  const logMax = Math.log10(Math.max(maxVal, 1));
  const logStep = (logMax - logMin) / bandCount;

  const bands: PriceBand[] = [];

  for (let i = 0; i < bandCount; i++) {
    const lo = Math.pow(10, logMin + i * logStep);
    const hi = i === bandCount - 1 ? maxVal + 1 : Math.pow(10, logMin + (i + 1) * logStep);

    const inBand = quotes.filter((q) => q.totalValue >= lo && q.totalValue < hi);
    if (inBand.length === 0) continue;

    const wins = inBand.filter((q) => q.status === "converted");
    const winRate = wins.length / inBand.length;
    const prices = inBand.map((q) => q.totalValue);
    const avg = mean(prices);

    // Optimal price: weighted average skewed toward won deals
    const wonPrices = wins.map((q) => q.totalValue);
    const optimalPrice = wonPrices.length > 0 ? mean(wonPrices) : avg;

    bands.push({
      range: `${formatCurrency(lo)}-${formatCurrency(hi > maxVal ? maxVal : hi)}`,
      minPrice: lo,
      maxPrice: hi > maxVal ? maxVal : hi,
      avgPrice: avg,
      winRate,
      dealCount: inBand.length,
      optimalPrice,
    });
  }

  return bands;
}

// ── Elasticity Calculation ───────────────────────────────────────────

function computeElasticity(quotes: QuoteRecord[]): PriceElasticity[] {
  const groups = groupBy(quotes, (q) => q.productGroup ?? "unknown");
  const results: PriceElasticity[] = [];

  for (const [pg, pgQuotes] of groups) {
    if (pgQuotes.length < 5) continue;

    const prices = pgQuotes.map((q) => q.totalValue);
    const wins = pgQuotes.map((q) => (q.status === "converted" ? 1 : 0));
    const corr = pearsonCorrelation(prices, wins);

    // Elasticity approximation: negative correlation means price-sensitive
    // Scale to a more interpretable range
    const avgPrice = mean(prices);
    const avgWin = mean(wins);
    const elasticity = avgWin > 0 && avgPrice > 0 ? corr * (avgPrice / avgWin) * -1 : 0;

    results.push({
      productGroup: pg,
      elasticity: Math.round(elasticity * 100) / 100,
      confidence: Math.min(pgQuotes.length / 50, 1),
    });
  }

  return results.sort((a, b) => a.elasticity - b.elasticity);
}

// ── Recommendations ──────────────────────────────────────────────────

function generateRecommendations(
  quotes: QuoteRecord[],
  elasticity: PriceElasticity[],
  winLossData?: WinLossAnalysis,
): PricingRecommendation[] {
  const groups = groupBy(quotes, (q) => q.productGroup ?? "unknown");
  const recommendations: PricingRecommendation[] = [];

  for (const [pg, pgQuotes] of groups) {
    if (pgQuotes.length < 5) continue;

    const wins = pgQuotes.filter((q) => q.status === "converted");
    const losses = pgQuotes.filter((q) => q.status !== "converted");

    const currentAvg = mean(pgQuotes.map((q) => q.totalValue));
    const wonAvg = wins.length > 0 ? mean(wins.map((q) => q.totalValue)) : currentAvg;
    const lostAvg = losses.length > 0 ? mean(losses.map((q) => q.totalValue)) : currentAvg;

    const currentWinRate = wins.length / pgQuotes.length;
    const el = elasticity.find((e) => e.productGroup === pg);

    let recommendedPrice = currentAvg;
    let rationale = "";
    let expectedWinRateChange = 0;

    if (el && el.elasticity < -0.5 && el.confidence > 0.3) {
      // Price-sensitive: recommend moving toward winning price point
      recommendedPrice = wonAvg;
      const priceDelta = (recommendedPrice - currentAvg) / currentAvg;
      expectedWinRateChange = Math.min(Math.abs(priceDelta) * 0.3, 0.15);
      rationale = `Product group is price-sensitive (elasticity=${el.elasticity}). Aligning to historical winning price point.`;
    } else if (wonAvg > lostAvg * 1.05) {
      // Winners pay more — room to increase
      recommendedPrice = currentAvg * 1.05;
      expectedWinRateChange = -0.02;
      rationale = "Won deals averaged higher prices than losses — modest price increase unlikely to hurt win rate.";
    } else if (lostAvg > wonAvg * 1.1) {
      // Losing on price — consider reduction
      recommendedPrice = currentAvg * 0.95;
      expectedWinRateChange = 0.05;
      rationale = "Lost deals had significantly higher prices — a targeted reduction may recover lost opportunities.";
    } else {
      recommendedPrice = currentAvg;
      expectedWinRateChange = 0;
      rationale = "Pricing is well-calibrated for this segment. No change recommended.";
    }

    // Augment with win/loss data if available
    if (winLossData) {
      const pgPattern = winLossData.byProductGroup.find(
        (p) => p.insight.startsWith(pg),
      );
      if (pgPattern && pgPattern.winRate < winLossData.overallWinRate - 0.15) {
        rationale += ` Note: this product group underperforms overall win rate (${(pgPattern.winRate * 100).toFixed(0)}% vs ${(winLossData.overallWinRate * 100).toFixed(0)}%).`;
      }
    }

    const expectedRevenueImpact =
      (recommendedPrice - currentAvg) * wins.length +
      expectedWinRateChange * pgQuotes.length * recommendedPrice;

    recommendations.push({
      productGroup: pg,
      currentAvgPrice: Math.round(currentAvg * 100) / 100,
      recommendedPrice: Math.round(recommendedPrice * 100) / 100,
      expectedWinRateChange: Math.round(expectedWinRateChange * 1000) / 1000,
      expectedRevenueImpact: Math.round(expectedRevenueImpact),
      rationale,
    });
  }

  return recommendations.sort(
    (a, b) => b.expectedRevenueImpact - a.expectedRevenueImpact,
  );
}

// ── Core Analysis ────────────────────────────────────────────────────

export function optimizePricing(
  quotes: QuoteRecord[],
  winLossData?: WinLossAnalysis,
): PricingAnalysis {
  process.stderr.write(
    `[pricing] Optimizing pricing across ${quotes.length} quotes\n`,
  );

  // Overall correlation between price and win
  const prices = quotes.map((q) => q.totalValue);
  const wins = quotes.map((q) => (q.status === "converted" ? 1 : 0));
  const overallPriceWinCorrelation =
    Math.round(pearsonCorrelation(prices, wins) * 1000) / 1000;

  const priceBands = buildPriceBands(quotes);
  const elasticity = computeElasticity(quotes);
  const recommendations = generateRecommendations(quotes, elasticity, winLossData);

  process.stderr.write(
    `[pricing] Complete: ${priceBands.length} bands, ${elasticity.length} elasticity groups, ${recommendations.length} recommendations (price-win r=${overallPriceWinCorrelation})\n`,
  );

  return {
    priceBands,
    elasticity,
    recommendations,
    overallPriceWinCorrelation,
  };
}
