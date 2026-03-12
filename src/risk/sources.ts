/**
 * External risk data sources for supply chain risk assessment.
 *
 * Two-phase approach:
 *   1. Fetch real data from public web APIs and news sources via web-agent
 *   2. Feed that real data into AI prompts for contextual risk scoring
 *
 * This ensures AI analysis is grounded in actual current data, not just
 * general knowledge. Each risk category has configurable data source URLs
 * that can be extended via config.
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

// ── Configurable Data Source URLs ────────────────────────────────
// These are public APIs and data feeds. Users can override via env vars.

const DATA_SOURCES = {
  // Freight & shipping
  freightIndex: process.env.SC_FREIGHT_INDEX_URL ?? "https://fbx.freightos.com/api/lane/FBX",
  portCongestion: process.env.SC_PORT_CONGESTION_URL ?? "",

  // Commodity prices (public JSON APIs)
  metalPrices: process.env.SC_METAL_PRICES_URL ?? "",
  oilPrice: process.env.SC_OIL_PRICE_URL ?? "",

  // Exchange rates (free tier)
  exchangeRates: process.env.SC_EXCHANGE_RATES_URL ?? "https://open.er-api.com/v6/latest/USD",

  // Weather / natural disasters
  weatherAlerts: process.env.SC_WEATHER_ALERTS_URL ?? "",

  // Custom user-defined feeds (semicolon-separated URLs)
  customFeeds: (process.env.SC_CUSTOM_FEEDS ?? "").split(";").filter(Boolean),
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
const TTL_WEB_FETCH = 4 * 60 * 60 * 1000;     // 4 hours for raw web data

// ── Web Data Fetching ────────────────────────────────────────────

async function fetchWebData(url: string): Promise<string | null> {
  if (!url) return null;

  const cached = getCached<string>(`web:${url}`);
  if (cached) return cached;

  try {
    const result = await sendTask(WORKER_URLS.web, {
      skillId: "fetch_url",
      args: { url, format: "text" },
      message: { role: "user" as const, parts: [{ kind: "text" as const, text: url }] },
    });
    // Truncate to keep prompts focused
    const truncated = result.slice(0, 3000);
    setCache(`web:${url}`, truncated, TTL_WEB_FETCH);
    return truncated;
  } catch (err) {
    log(`web fetch failed for ${url}: ${err}`);
    return null;
  }
}

async function callApi(url: string, method = "GET"): Promise<string | null> {
  if (!url) return null;

  const cached = getCached<string>(`api:${url}`);
  if (cached) return cached;

  try {
    const result = await sendTask(WORKER_URLS.web, {
      skillId: "call_api",
      args: { url, method },
      message: { role: "user" as const, parts: [{ kind: "text" as const, text: url }] },
    });
    const truncated = result.slice(0, 3000);
    setCache(`api:${url}`, truncated, TTL_WEB_FETCH);
    return truncated;
  } catch (err) {
    log(`API call failed for ${url}: ${err}`);
    return null;
  }
}

/**
 * Fetch all available live data feeds in parallel.
 * Returns a map of source name → raw data string.
 */
async function fetchLiveDataFeeds(): Promise<Map<string, string>> {
  const feeds = new Map<string, string>();

  const fetches: Array<{ name: string; promise: Promise<string | null> }> = [];

  if (DATA_SOURCES.freightIndex) {
    fetches.push({ name: "freight_index", promise: fetchWebData(DATA_SOURCES.freightIndex) });
  } else {
    log("no freight index URL configured — set SC_FREIGHT_INDEX_URL env var");
  }
  if (DATA_SOURCES.exchangeRates) {
    fetches.push({ name: "exchange_rates", promise: callApi(DATA_SOURCES.exchangeRates) });
  } else {
    log("no exchange rates URL configured — set SC_EXCHANGE_RATES_URL env var");
  }
  if (DATA_SOURCES.metalPrices) {
    fetches.push({ name: "metal_prices", promise: callApi(DATA_SOURCES.metalPrices) });
  } else {
    log("no metal prices URL configured — set SC_METAL_PRICES_URL env var for commodity risk data");
  }
  if (DATA_SOURCES.oilPrice) {
    fetches.push({ name: "oil_price", promise: callApi(DATA_SOURCES.oilPrice) });
  } else {
    log("no oil price URL configured — set SC_OIL_PRICE_URL env var for commodity risk data");
  }
  if (DATA_SOURCES.weatherAlerts) {
    fetches.push({ name: "weather_alerts", promise: fetchWebData(DATA_SOURCES.weatherAlerts) });
  } else {
    log("no weather alerts URL configured — set SC_WEATHER_ALERTS_URL env var");
  }
  if (DATA_SOURCES.portCongestion) {
    fetches.push({ name: "port_congestion", promise: fetchWebData(DATA_SOURCES.portCongestion) });
  } else {
    log("no port congestion URL configured — set SC_PORT_CONGESTION_URL env var");
  }

  for (const url of DATA_SOURCES.customFeeds) {
    fetches.push({ name: `custom:${url.slice(0, 50)}`, promise: fetchWebData(url) });
  }

  const results = await Promise.allSettled(fetches.map((f) => f.promise));

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled" && result.value) {
      feeds.set(fetches[i].name, result.value);
    }
  }

  log(`fetched ${feeds.size}/${fetches.length} live data feeds`);
  return feeds;
}

// ── AI-Based Risk Assessment (with real data) ────────────────────

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
 * Phase 1: Fetch real data from web APIs (freight indices, exchange rates, etc.)
 * Phase 2: Feed real data + context into AI for intelligent risk scoring
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

  // Phase 1: Fetch live data
  log("fetching live data feeds for risk assessment");
  const liveData = await fetchLiveDataFeeds();

  // Build context string from live data
  const liveDataContext = liveData.size > 0
    ? "\n\n## LIVE DATA (fetched just now from real sources)\n" +
      Array.from(liveData.entries())
        .map(([name, data]) => `### ${name}\n${data.slice(0, 800)}`)
        .join("\n\n")
    : "\n\n(No live data feeds available — assess based on your current knowledge)";

  // Phase 2: AI analysis grounded in real data
  log("assessing external risk factors via AI with live data");

  const factors = await Promise.all([
    assessFreightRisk(context.vendorCountries, liveData),
    assessWeatherRisk(context.vendorCountries, liveData),
    assessEconomicRisk(context.vendorCountries, liveData),
    assessGeopoliticalRisk(context.vendorCountries, liveData),
    assessCommodityRisk(context.commodities ?? context.componentCategories, liveData),
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
  dataSources: string[];
}

function parseRiskResponse(raw: string, fallbackScore: number): RiskAssessment {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      score: Math.max(0, Math.min(100, Number(parsed.score ?? fallbackScore))),
      details: Array.isArray(parsed.details) ? parsed.details : [],
      dataSources: Array.isArray(parsed.dataSources) ? parsed.dataSources : [],
    };
  } catch {
    return { score: fallbackScore, details: [raw.slice(0, 200)], dataSources: [] };
  }
}

const RISK_PROMPT_SUFFIX = `
Respond with ONLY valid JSON:
{
  "score": <0-100, where 0=no risk, 100=extreme risk>,
  "details": ["<brief risk factor 1>", "<brief risk factor 2>", ...],
  "dataSources": ["<which data sources informed this score>"]
}
Be concise. Max 5 detail items. Base your score on CONCRETE evidence from the live data when available — not guesses.`;

function extractLiveData(liveData: Map<string, string>, ...keys: string[]): string {
  const parts: string[] = [];
  for (const key of keys) {
    const data = liveData.get(key);
    if (data) parts.push(`[${key}]: ${data.slice(0, 600)}`);
  }
  return parts.length > 0
    ? `\n\nLIVE DATA:\n${parts.join("\n\n")}`
    : "\n\n(No specific live data available for this category)";
}

async function assessFreightRisk(countries: string[], liveData: Map<string, string>): Promise<RiskAssessment> {
  const cacheKey = `freight-${countries.sort().join(",")}`;
  const cached = getCached<RiskAssessment>(cacheKey);
  if (cached) return cached;

  const dataContext = extractLiveData(liveData, "freight_index", "port_congestion");

  try {
    const raw = await askAI(`You are a freight logistics analyst. Assess current freight and shipping risk for supply chains involving: ${countries.join(", ")}.

Analyze the following real-time data and score the risk level:
${dataContext}

Consider: container shipping rates vs. historical averages, port congestion levels, active route disruptions (Suez, Panama Canal, Red Sea, Strait of Hormuz), carrier capacity utilization, fuel surcharges.

If live data shows specific rate increases or disruptions, reference them directly.
${RISK_PROMPT_SUFFIX}`);

    const result = parseRiskResponse(raw, 30);
    setCache(cacheKey, result, TTL_FREIGHT);
    return result;
  } catch (err) {
    log(`freight risk assessment failed: ${err}`);
    return { score: 30, details: ["Freight risk data unavailable"], dataSources: [] };
  }
}

async function assessWeatherRisk(countries: string[], liveData: Map<string, string>): Promise<RiskAssessment> {
  const cacheKey = `weather-${countries.sort().join(",")}`;
  const cached = getCached<RiskAssessment>(cacheKey);
  if (cached) return cached;

  const dataContext = extractLiveData(liveData, "weather_alerts");

  try {
    const raw = await askAI(`You are a meteorological risk analyst. Assess weather-related supply chain risks for manufacturing and logistics in: ${countries.join(", ")}.

${dataContext}

Consider: active extreme weather events (hurricanes, typhoons, flooding, droughts, wildfires), seasonal patterns for the current month, climate-related disruptions to transportation infrastructure.

Score based on CURRENT and IMMINENT threats, not general seasonal risk.
${RISK_PROMPT_SUFFIX}`);

    const result = parseRiskResponse(raw, 20);
    setCache(cacheKey, result, TTL_WEATHER);
    return result;
  } catch (err) {
    log(`weather risk assessment failed: ${err}`);
    return { score: 20, details: ["Weather risk data unavailable"], dataSources: [] };
  }
}

async function assessEconomicRisk(countries: string[], liveData: Map<string, string>): Promise<RiskAssessment> {
  const cacheKey = `economic-${countries.sort().join(",")}`;
  const cached = getCached<RiskAssessment>(cacheKey);
  if (cached) return cached;

  const dataContext = extractLiveData(liveData, "exchange_rates");

  try {
    const raw = await askAI(`You are a macroeconomic risk analyst. Assess economic risks affecting supply chains in: ${countries.join(", ")}.

${dataContext}

Consider: current inflation rates, currency exchange rate movements (use the live data above), central bank interest rate trends, active trade tariffs/duties, sanctions regimes, recession indicators, labor market disruptions.

If exchange rate data shows significant moves for relevant currencies, reference specific rates.
${RISK_PROMPT_SUFFIX}`);

    const result = parseRiskResponse(raw, 25);
    setCache(cacheKey, result, TTL_ECONOMIC);
    return result;
  } catch (err) {
    log(`economic risk assessment failed: ${err}`);
    return { score: 25, details: ["Economic risk data unavailable"], dataSources: [] };
  }
}

async function assessGeopoliticalRisk(countries: string[], liveData: Map<string, string>): Promise<RiskAssessment> {
  const cacheKey = `geopolitical-${countries.sort().join(",")}`;
  const cached = getCached<RiskAssessment>(cacheKey);
  if (cached) return cached;

  // Geopolitical analysis benefits from any custom feeds
  const customData = Array.from(liveData.entries())
    .filter(([k]) => k.startsWith("custom:"))
    .map(([k, v]) => `[${k}]: ${v.slice(0, 500)}`)
    .join("\n\n");

  const dataContext = customData
    ? `\n\nCUSTOM INTELLIGENCE FEEDS:\n${customData}`
    : "\n\n(No custom intelligence feeds configured)";

  try {
    const raw = await askAI(`You are a geopolitical risk analyst. Assess geopolitical risks for supply chains involving: ${countries.join(", ")}.

${dataContext}

Consider: active conflicts affecting trade routes, trade war escalation, export control regimes (e.g. semiconductor controls), sanctions (OFAC, EU, UN), political instability in supplier nations, regulatory changes affecting cross-border trade.

Focus on ACTIONABLE risks that could disrupt supply in the next 1-3 months.
${RISK_PROMPT_SUFFIX}`);

    const result = parseRiskResponse(raw, 25);
    setCache(cacheKey, result, TTL_GEOPOLITICAL);
    return result;
  } catch (err) {
    log(`geopolitical risk assessment failed: ${err}`);
    return { score: 25, details: ["Geopolitical risk data unavailable"], dataSources: [] };
  }
}

async function assessCommodityRisk(categories: string[], liveData: Map<string, string>): Promise<RiskAssessment> {
  const cacheKey = `commodity-${categories.sort().join(",")}`;
  const cached = getCached<RiskAssessment>(cacheKey);
  if (cached) return cached;

  const dataContext = extractLiveData(liveData, "metal_prices", "oil_price");

  try {
    const raw = await askAI(`You are a commodity markets analyst. Assess price and availability risks for these material categories: ${categories.join(", ")}.

${dataContext}

Consider: current spot prices vs. 3-month and 12-month averages, supply-demand imbalances, inventory levels at exchanges (LME, COMEX), production disruptions, export restrictions, futures curve (contango/backwardation signals), substitute material availability.

If live price data is available above, calculate the percentage change and flag significant moves.
${RISK_PROMPT_SUFFIX}`);

    const result = parseRiskResponse(raw, 25);
    setCache(cacheKey, result, TTL_COMMODITY);
    return result;
  } catch (err) {
    log(`commodity risk assessment failed: ${err}`);
    return { score: 25, details: ["Commodity risk data unavailable"], dataSources: [] };
  }
}
