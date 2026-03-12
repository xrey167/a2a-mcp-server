/**
 * External risk data sources for supply chain risk assessment.
 *
 * Aggregates global risk factors via web-agent (fetch_url) and ai-agent (ask_claude).
 * Categories: freight/shipping, weather, economic, geopolitical, commodity prices.
 *
 * Uses in-memory cache with TTL to avoid excessive external calls.
 */

import type { ExternalRiskFactors } from "./scoring.js";
import { sendTask } from "../a2a.js";

function log(msg: string) {
  process.stderr.write(`[risk-sources] ${msg}\n`);
}

const WORKER_URLS = {
  ai: process.env.A2A_WORKER_AI_URL ?? "http://localhost:8083",
  web: process.env.A2A_WORKER_WEB_URL ?? "http://localhost:8082",
};

// ── Cache ────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T, ttlMs: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// TTL constants
const TTL_WEATHER = 6 * 60 * 60 * 1000;      // 6 hours
const TTL_ECONOMIC = 24 * 60 * 60 * 1000;     // 24 hours
const TTL_GEOPOLITICAL = 12 * 60 * 60 * 1000; // 12 hours
const TTL_FREIGHT = 12 * 60 * 60 * 1000;      // 12 hours
const TTL_COMMODITY = 12 * 60 * 60 * 1000;    // 12 hours

// ── AI-Based Risk Assessment ─────────────────────────────────────

async function askAI(prompt: string): Promise<string> {
  return sendTask(WORKER_URLS.ai, {
    skillId: "ask_claude",
    args: { prompt },
    message: { role: "user" as const, parts: [{ kind: "text" as const, text: prompt }] },
  });
}

/**
 * Assess external risk factors for a set of supply chain components.
 *
 * Uses AI to evaluate current global conditions relevant to the given
 * vendor regions and component categories.
 */
export async function assessExternalRisks(context: {
  vendorCountries: string[];
  componentCategories: string[];
  commodities?: string[];
}): Promise<ExternalRiskFactors> {
  const cacheKey = `external-${context.vendorCountries.sort().join(",")}-${context.componentCategories.sort().join(",")}`;
  const cached = getCached<ExternalRiskFactors>(cacheKey);
  if (cached) {
    log("using cached external risk factors");
    return cached;
  }

  log("assessing external risk factors via AI");

  const factors = await Promise.all([
    assessFreightRisk(context.vendorCountries),
    assessWeatherRisk(context.vendorCountries),
    assessEconomicRisk(context.vendorCountries),
    assessGeopoliticalRisk(context.vendorCountries),
    assessCommodityRisk(context.commodities ?? context.componentCategories),
  ]);

  const result: ExternalRiskFactors = {
    freightRisk: factors[0].score,
    weatherRisk: factors[1].score,
    economicRisk: factors[2].score,
    geopoliticalRisk: factors[3].score,
    commodityPriceRisk: factors[4].score,
    details: [
      ...factors[0].details,
      ...factors[1].details,
      ...factors[2].details,
      ...factors[3].details,
      ...factors[4].details,
    ],
  };

  setCache(cacheKey, result, Math.min(TTL_WEATHER, TTL_FREIGHT));
  return result;
}

interface RiskAssessment {
  score: number;
  details: string[];
}

function parseRiskResponse(raw: string, fallbackScore: number): RiskAssessment {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      score: Math.max(0, Math.min(100, Number(parsed.score ?? fallbackScore))),
      details: Array.isArray(parsed.details) ? parsed.details : [],
    };
  } catch {
    // If AI response isn't valid JSON, use fallback
    return { score: fallbackScore, details: [raw.slice(0, 200)] };
  }
}

const RISK_PROMPT_SUFFIX = `
Respond with ONLY valid JSON:
{
  "score": <0-100, where 0=no risk, 100=extreme risk>,
  "details": ["<brief risk factor 1>", "<brief risk factor 2>", ...]
}
Be concise. Max 5 detail items.`;

async function assessFreightRisk(countries: string[]): Promise<RiskAssessment> {
  const cacheKey = `freight-${countries.sort().join(",")}`;
  const cached = getCached<RiskAssessment>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await askAI(`Assess current global freight and shipping risk for supply chains involving these countries: ${countries.join(", ")}.

Consider: container shipping rates, port congestion, route disruptions (Suez, Panama Canal, Red Sea), carrier availability, fuel costs.
${RISK_PROMPT_SUFFIX}`);

    const result = parseRiskResponse(raw, 30);
    setCache(cacheKey, result, TTL_FREIGHT);
    return result;
  } catch (err) {
    log(`freight risk assessment failed: ${err}`);
    return { score: 30, details: ["Freight risk data unavailable"] };
  }
}

async function assessWeatherRisk(countries: string[]): Promise<RiskAssessment> {
  const cacheKey = `weather-${countries.sort().join(",")}`;
  const cached = getCached<RiskAssessment>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await askAI(`Assess current weather-related supply chain risks for manufacturing and logistics in these regions: ${countries.join(", ")}.

Consider: extreme weather events, natural disasters, seasonal patterns, climate-related disruptions.
${RISK_PROMPT_SUFFIX}`);

    const result = parseRiskResponse(raw, 20);
    setCache(cacheKey, result, TTL_WEATHER);
    return result;
  } catch (err) {
    log(`weather risk assessment failed: ${err}`);
    return { score: 20, details: ["Weather risk data unavailable"] };
  }
}

async function assessEconomicRisk(countries: string[]): Promise<RiskAssessment> {
  const cacheKey = `economic-${countries.sort().join(",")}`;
  const cached = getCached<RiskAssessment>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await askAI(`Assess current economic risks affecting supply chains in these countries: ${countries.join(", ")}.

Consider: inflation, currency volatility, interest rates, trade tariffs, sanctions, economic slowdown, labor markets.
${RISK_PROMPT_SUFFIX}`);

    const result = parseRiskResponse(raw, 25);
    setCache(cacheKey, result, TTL_ECONOMIC);
    return result;
  } catch (err) {
    log(`economic risk assessment failed: ${err}`);
    return { score: 25, details: ["Economic risk data unavailable"] };
  }
}

async function assessGeopoliticalRisk(countries: string[]): Promise<RiskAssessment> {
  const cacheKey = `geopolitical-${countries.sort().join(",")}`;
  const cached = getCached<RiskAssessment>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await askAI(`Assess current geopolitical risks for supply chains involving these countries: ${countries.join(", ")}.

Consider: political instability, trade wars, sanctions, export controls, regional conflicts, regulatory changes.
${RISK_PROMPT_SUFFIX}`);

    const result = parseRiskResponse(raw, 25);
    setCache(cacheKey, result, TTL_GEOPOLITICAL);
    return result;
  } catch (err) {
    log(`geopolitical risk assessment failed: ${err}`);
    return { score: 25, details: ["Geopolitical risk data unavailable"] };
  }
}

async function assessCommodityRisk(categories: string[]): Promise<RiskAssessment> {
  const cacheKey = `commodity-${categories.sort().join(",")}`;
  const cached = getCached<RiskAssessment>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await askAI(`Assess current commodity price risks for these material categories: ${categories.join(", ")}.

Consider: raw material price trends, supply shortages, demand spikes, futures market signals, substitute availability.
${RISK_PROMPT_SUFFIX}`);

    const result = parseRiskResponse(raw, 25);
    setCache(cacheKey, result, TTL_COMMODITY);
    return result;
  } catch (err) {
    log(`commodity risk assessment failed: ${err}`);
    return { score: 25, details: ["Commodity risk data unavailable"] };
  }
}
