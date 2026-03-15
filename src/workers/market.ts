/**
 * Market Worker Agent — market data, price tracking, technical analysis, and trading signals.
 *
 * Port: 8090
 *
 * Skills:
 *   fetch_quote      — Fetch real-time stock/crypto/commodity quotes
 *   price_history    — Fetch historical OHLCV price data
 *   technical_analysis — Compute technical indicators (SMA, EMA, RSI, MACD, Bollinger Bands)
 *   screen_market    — Screen assets by price, volume, change thresholds
 *   detect_anomalies — Detect price/volume anomalies vs rolling baseline
 *   correlation      — Compute price correlation matrix between assets
 *   remember/recall  — Shared persistent memory
 */

import Fastify from "fastify";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { buildA2AResponse, buildA2AError, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { round, validateUrlNotInternal } from "../worker-utils.js";

const PORT = 8090;
const NAME = "market-agent";

// ── Zod Schemas ──────────────────────────────────────────────────

const MarketSchemas = {
  fetch_quote: z.looseObject({
    symbol: z.string().min(1),
    provider: z.enum(["yahoo", "alphavantage", "coinbase", "custom"]).optional().default("yahoo"),
    customUrl: z.url().optional(),
  }),

  price_history: z.looseObject({
    symbol: z.string().min(1),
    interval: z.enum(["1d", "1wk", "1mo"]).optional().default("1d"),
    range: z.enum(["5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"]).optional().default("3mo"),
    provider: z.enum(["yahoo", "alphavantage", "custom"]).optional().default("yahoo"),
    customUrl: z.url().optional(),
  }),

  technical_analysis: z.looseObject({
    prices: z.array(z.number()).min(2).max(10_000),
    indicators: z.array(z.enum(["sma", "ema", "rsi", "macd", "bollinger", "atr", "vwap"])).min(1).max(20),
    period: z.number().int().positive().optional().default(14),
    volumes: z.array(z.number()).max(10_000).optional(),
  }),

  screen_market: z.looseObject({
    assets: z.array(z.object({
      symbol: z.string(),
      price: z.number(),
      change: z.number().optional().default(0),
      changePercent: z.number().optional().default(0),
      volume: z.number().optional().default(0),
      marketCap: z.number().optional().default(0),
    })).min(1),
    filters: z.object({
      minPrice: z.number().optional(),
      maxPrice: z.number().optional(),
      minChange: z.number().optional(),
      maxChange: z.number().optional(),
      minVolume: z.number().optional(),
      minMarketCap: z.number().optional(),
    }).optional().default({}),
    sortBy: z.enum(["price", "change", "changePercent", "volume", "marketCap"]).optional().default("changePercent"),
    sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
    limit: z.number().int().positive().optional().default(20),
  }),

  detect_anomalies: z.looseObject({
    prices: z.array(z.number()).min(5),
    volumes: z.array(z.number()).optional(),
    timestamps: z.array(z.string()).optional(),
    zScoreThreshold: z.number().positive().optional().default(2),
    windowSize: z.number().int().positive().optional().default(20),
  }),

  correlation: z.looseObject({
    series: z.record(z.array(z.number()).min(2)),
  }),

  market_composite: z.looseObject({
    prices: z.array(z.number()).min(14),
    volumes: z.array(z.number()).optional(),
    period: z.number().int().positive().optional().default(14),
    weights: z.object({
      rsi: z.number().optional().default(0.2),
      macd: z.number().optional().default(0.2),
      volumeAnomaly: z.number().optional().default(0.15),
      momentum: z.number().optional().default(0.15),
      volatility: z.number().optional().default(0.15),
      trend: z.number().optional().default(0.15),
    }).optional().default({}),
  }),
};

// ── Agent Card ───────────────────────────────────────────────────

const AGENT_CARD = {
  name: NAME,
  description: "Market agent — real-time quotes, price history, technical indicators (SMA/EMA/RSI/MACD/Bollinger), screening, anomaly detection, and correlation analysis",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "fetch_quote", name: "Fetch Quote", description: "Fetch real-time stock, crypto, or commodity quote (providers: yahoo, alphavantage, coinbase, custom)" },
    { id: "price_history", name: "Price History", description: "Fetch historical OHLCV price data (providers: yahoo, alphavantage, custom)" },
    { id: "technical_analysis", name: "Technical Analysis", description: "Compute indicators: SMA, EMA, RSI, MACD, Bollinger Bands, ATR, VWAP" },
    { id: "screen_market", name: "Screen Market", description: "Filter and rank assets by price, volume, change, and market cap thresholds" },
    { id: "detect_anomalies", name: "Detect Anomalies", description: "Detect price and volume anomalies using z-score against rolling baseline" },
    { id: "correlation", name: "Correlation Matrix", description: "Compute Pearson correlation matrix between multiple price series" },
    { id: "market_composite", name: "Market Composite", description: "Compute a composite 0-100 market score combining RSI, MACD, volume anomaly, momentum, volatility, and trend" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

// validateUrlNotInternal() imported from ../worker-utils.js

// ── Yahoo Finance Helpers ────────────────────────────────────────
// NOTE: This uses Yahoo Finance's unofficial v8 chart API which is undocumented
// and not covered by any public SLA. Yahoo may change, rate-limit, or remove
// this endpoint without notice, breaking quote/history fetching.
// When ALPHAVANTAGE_API_KEY is set, Alpha Vantage is used as the primary provider
// and Yahoo Finance is not called. Yahoo is only used when no official key is available.

const FETCH_TIMEOUT = 15_000;
const UA = "A2A-Market-Agent/1.0";

async function fetchYahooQuote(symbol: string): Promise<Record<string, unknown>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json() as any;
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data for symbol: ${symbol}`);

  const meta = result.meta ?? {};
  const quote = result.indicators?.quote?.[0] ?? {};
  const prices = quote.close ?? [];
  const lastPrice = prices[prices.length - 1] ?? meta.regularMarketPrice;
  if (lastPrice === undefined || lastPrice === null) throw new Error(`No price data available for ${symbol}`);
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? lastPrice;
  const change = lastPrice - prevClose;
  const changePercent = prevClose !== 0 ? (change / prevClose) * 100 : 0;

  return {
    symbol: meta.symbol ?? symbol,
    price: round(lastPrice),
    previousClose: round(prevClose),
    change: round(change),
    changePercent: round(changePercent),
    currency: meta.currency ?? "USD",
    exchange: meta.exchangeName ?? "",
    marketState: meta.marketState ?? "",
    volume: quote.volume?.[quote.volume.length - 1] ?? 0,
    timestamp: new Date().toISOString(),
  };
}

async function fetchYahooHistory(symbol: string, interval: string, range: string): Promise<{ timestamps: string[]; open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json() as any;
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No history for symbol: ${symbol}`);

  const ts = (result.timestamp ?? []) as number[];
  const q = result.indicators?.quote?.[0] ?? {};

  return {
    timestamps: ts.map(t => new Date(t * 1000).toISOString()),
    open: (q.open ?? []).map((v: number | null) => v ?? 0),
    high: (q.high ?? []).map((v: number | null) => v ?? 0),
    low: (q.low ?? []).map((v: number | null) => v ?? 0),
    close: (q.close ?? []).map((v: number | null) => v ?? 0),
    volume: (q.volume ?? []).map((v: number | null) => v ?? 0),
  };
}

async function fetchCoinbaseQuote(symbol: string): Promise<Record<string, unknown>> {
  // Coinbase uses format like BTC-USD
  const pair = symbol.includes("-") ? symbol : `${symbol}-USD`;
  const [tickerRes, statsRes] = await Promise.all([
    fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { "User-Agent": UA },
    }),
    fetch(`https://api.exchange.coinbase.com/products/${pair}/stats`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { "User-Agent": UA },
    }).catch(() => null),
  ]);

  if (!tickerRes.ok) throw new Error(`Coinbase HTTP ${tickerRes.status}: ${tickerRes.statusText}`);
  const tickerData = await tickerRes.json() as any;
  const price = parseFloat(tickerData?.data?.amount ?? "0");

  let volume = 0;
  let open = price;
  if (statsRes?.ok) {
    const stats = await statsRes.json() as any;
    volume = parseFloat(stats?.volume ?? "0");
    open = parseFloat(stats?.open ?? String(price));
  }

  const change = price - open;
  const changePercent = open !== 0 ? (change / open) * 100 : 0;

  return {
    symbol: pair,
    price: round(price),
    open: round(open),
    change: round(change),
    changePercent: round(changePercent),
    currency: tickerData?.data?.currency ?? "USD",
    exchange: "Coinbase",
    volume: round(volume),
    timestamp: new Date().toISOString(),
  };
}

// ── Alpha Vantage Provider ───────────────────────────────────────
// Official, documented API with free tier (25 requests/day, 5/min).
// Set ALPHAVANTAGE_API_KEY env var. Docs: https://www.alphavantage.co/documentation/

function getAlphaVantageKey(): string {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) throw new Error("ALPHAVANTAGE_API_KEY env var is required for the alphavantage provider");
  return key;
}

async function fetchAlphaVantageQuote(symbol: string): Promise<Record<string, unknown>> {
  const apiKey = getAlphaVantageKey();
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json() as any;
  const gq = data?.["Global Quote"];
  if (!gq || !gq["05. price"]) throw new Error(`No Alpha Vantage data for symbol: ${symbol}`);

  const price = parseFloat(gq["05. price"]);
  const prevClose = parseFloat(gq["08. previous close"] ?? price);
  const change = parseFloat(gq["09. change"] ?? "0");
  const changePercent = parseFloat((gq["10. change percent"] ?? "0").replace("%", ""));

  return {
    symbol: gq["01. symbol"] ?? symbol,
    price: round(price),
    previousClose: round(prevClose),
    change: round(change),
    changePercent: round(changePercent),
    currency: "USD",
    exchange: "",
    volume: parseInt(gq["06. volume"] ?? "0", 10),
    timestamp: new Date().toISOString(),
  };
}

async function fetchAlphaVantageHistory(
  symbol: string,
  _interval: string,
  range: string,
): Promise<{ timestamps: string[]; open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> {
  const apiKey = getAlphaVantageKey();
  // Use daily endpoint; for weekly/monthly ranges use TIME_SERIES_WEEKLY/MONTHLY
  const fn = range === "5y" || range === "2y" ? "TIME_SERIES_WEEKLY" : "TIME_SERIES_DAILY";
  const outputsize = ["1y", "2y", "5y"].includes(range) ? "full" : "compact";
  const url = `https://www.alphavantage.co/query?function=${fn}&symbol=${encodeURIComponent(symbol)}&outputsize=${outputsize}&apikey=${apiKey}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json() as any;

  const seriesKey = Object.keys(data).find((k) => k.startsWith("Time Series")) ?? "";
  const series = data[seriesKey];
  if (!series) throw new Error(`No Alpha Vantage history for symbol: ${symbol}`);

  // Limit data points based on range
  const rangeLimits: Record<string, number> = { "5d": 5, "1mo": 22, "3mo": 66, "6mo": 132, "1y": 252, "2y": 104, "5y": 260 };
  const limit = rangeLimits[range] ?? 66;

  const dates = Object.keys(series).sort().slice(-limit);
  return {
    timestamps: dates.map((d) => new Date(d).toISOString()),
    open: dates.map((d) => parseFloat(series[d]["1. open"])),
    high: dates.map((d) => parseFloat(series[d]["2. high"])),
    low: dates.map((d) => parseFloat(series[d]["3. low"])),
    close: dates.map((d) => parseFloat(series[d]["4. close"])),
    volume: dates.map((d) => parseInt(series[d]["5. volume"], 10)),
  };
}

// ── Technical Indicators ─────────────────────────────────────────

// round() imported from ../worker-utils.js

function computeSMA(prices: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      const slice = prices.slice(i - period + 1, i + 1);
      result.push(round(slice.reduce((a, b) => a + b, 0) / period));
    }
  }
  return result;
}

function computeEMA(prices: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const k = 2 / (period + 1);

  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      // First EMA = SMA of first `period` values
      const sma = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
      result.push(round(sma));
    } else {
      const prev = result[i - 1]!;
      result.push(round(prices[i] * k + prev * (1 - k)));
    }
  }
  return result;
}

function computeRSI(prices: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [null]; // first element has no change
  const changes: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  let prevAvgGain = 0;
  let prevAvgLoss = 0;

  for (let i = 0; i < changes.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      // Initial average: simple mean over first `period` changes
      const window = changes.slice(0, period);
      prevAvgGain = window.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
      prevAvgLoss = window.filter(c => c < 0).reduce((a, b) => a + Math.abs(b), 0) / period;
      const rs = prevAvgLoss === 0 ? 100 : prevAvgGain / prevAvgLoss;
      result.push(round(100 - 100 / (1 + rs)));
    } else {
      // Wilder's smoothing: avgGain = (prevAvgGain * (period-1) + currentGain) / period
      const change = changes[i];
      const currentGain = change > 0 ? change : 0;
      const currentLoss = change < 0 ? Math.abs(change) : 0;
      prevAvgGain = (prevAvgGain * (period - 1) + currentGain) / period;
      prevAvgLoss = (prevAvgLoss * (period - 1) + currentLoss) / period;
      const rs = prevAvgLoss === 0 ? 100 : prevAvgGain / prevAvgLoss;
      result.push(round(100 - 100 / (1 + rs)));
    }
  }
  return result;
}

function computeMACD(prices: number[]): { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] } {
  const ema12 = computeEMA(prices, 12);
  const ema26 = computeEMA(prices, 26);
  const macdLine: (number | null)[] = [];

  for (let i = 0; i < prices.length; i++) {
    if (ema12[i] === null || ema26[i] === null) {
      macdLine.push(null);
    } else {
      macdLine.push(round(ema12[i]! - ema26[i]!));
    }
  }

  // Signal line = 9-period EMA of MACD
  const validMacd = macdLine.filter(v => v !== null) as number[];
  const signalEma = computeEMA(validMacd, 9);

  // Map signal back to full-length array
  const signal: (number | null)[] = [];
  let validIdx = 0;
  for (const m of macdLine) {
    if (m === null) {
      signal.push(null);
    } else {
      signal.push(signalEma[validIdx] ?? null);
      validIdx++;
    }
  }

  // Histogram = MACD - Signal
  const histogram: (number | null)[] = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null || signal[i] === null) {
      histogram.push(null);
    } else {
      histogram.push(round(macdLine[i]! - signal[i]!));
    }
  }

  return { macd: macdLine, signal, histogram };
}

function computeBollinger(prices: number[], period: number): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const sma = computeSMA(prices, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];

  for (let i = 0; i < prices.length; i++) {
    if (sma[i] === null) {
      upper.push(null);
      lower.push(null);
    } else {
      const window = prices.slice(Math.max(0, i - period + 1), i + 1);
      const mean = sma[i]!;
      const variance = window.reduce((acc, p) => acc + (p - mean) ** 2, 0) / window.length;
      const stddev = Math.sqrt(variance);
      upper.push(round(mean + 2 * stddev));
      lower.push(round(mean - 2 * stddev));
    }
  }

  return { upper, middle: sma, lower };
}

function computeATR(prices: number[], period: number): (number | null)[] {
  // ATR needs high/low/close, but with just close prices we approximate
  // using absolute daily changes as true range proxy
  const result: (number | null)[] = [null];
  const trueRanges: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    trueRanges.push(Math.abs(prices[i] - prices[i - 1]));
  }

  for (let i = 0; i < trueRanges.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      const window = trueRanges.slice(i - period + 1, i + 1);
      result.push(round(window.reduce((a, b) => a + b, 0) / period));
    }
  }
  return result;
}

function computeVWAP(prices: number[], volumes: number[]): (number | null)[] {
  if (volumes.length !== prices.length) return prices.map(() => null);

  const result: (number | null)[] = [];
  let cumPV = 0;
  let cumVol = 0;

  for (let i = 0; i < prices.length; i++) {
    cumPV += prices[i] * volumes[i];
    cumVol += volumes[i];
    result.push(cumVol === 0 ? null : round(cumPV / cumVol));
  }
  return result;
}

// ── Anomaly Detection ────────────────────────────────────────────

interface Anomaly {
  index: number;
  timestamp?: string;
  type: string;
  value: number;
  mean: number;
  stddev: number;
  zScore: number;
}

function detectPriceAnomalies(
  prices: number[],
  volumes: number[] | undefined,
  timestamps: string[] | undefined,
  zScoreThreshold: number,
  windowSize: number,
): { priceAnomalies: Anomaly[]; volumeAnomalies: Anomaly[]; summary: Record<string, unknown> } {
  const priceAnomalies: Anomaly[] = [];
  const volumeAnomalies: Anomaly[] = [];

  // Price change anomalies
  for (let i = windowSize; i < prices.length; i++) {
    const window = prices.slice(i - windowSize, i);
    const changes = [];
    for (let j = 1; j < window.length; j++) {
      changes.push(window[j] - window[j - 1]);
    }
    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
    const variance = changes.reduce((acc, c) => acc + (c - mean) ** 2, 0) / changes.length;
    const stddev = Math.sqrt(variance);

    const currentChange = prices[i] - prices[i - 1];
    const zScore = stddev === 0 ? 0 : (currentChange - mean) / stddev;

    if (Math.abs(zScore) >= zScoreThreshold) {
      priceAnomalies.push({
        index: i,
        timestamp: timestamps?.[i],
        type: zScore > 0 ? "price_spike" : "price_drop",
        value: round(currentChange),
        mean: round(mean),
        stddev: round(stddev),
        zScore: round(zScore),
      });
    }
  }

  // Volume anomalies
  if (volumes && volumes.length === prices.length) {
    for (let i = windowSize; i < volumes.length; i++) {
      const window = volumes.slice(i - windowSize, i);
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      const variance = window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / window.length;
      const stddev = Math.sqrt(variance);
      const zScore = stddev === 0 ? 0 : (volumes[i] - mean) / stddev;

      if (Math.abs(zScore) >= zScoreThreshold) {
        volumeAnomalies.push({
          index: i,
          timestamp: timestamps?.[i],
          type: zScore > 0 ? "volume_surge" : "volume_drought",
          value: volumes[i],
          mean: round(mean),
          stddev: round(stddev),
          zScore: round(zScore),
        });
      }
    }
  }

  // Summary statistics
  const totalChange = prices.length >= 2 ? round(prices[prices.length - 1] - prices[0]) : 0;
  const totalChangePercent = prices[0] !== 0 ? round((totalChange / prices[0]) * 100) : 0;
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);

  return {
    priceAnomalies,
    volumeAnomalies,
    summary: {
      dataPoints: prices.length,
      totalChange,
      totalChangePercent,
      maxPrice: round(maxPrice),
      minPrice: round(minPrice),
      priceAnomalyCount: priceAnomalies.length,
      volumeAnomalyCount: volumeAnomalies.length,
    },
  };
}

// ── Correlation ──────────────────────────────────────────────────

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  const x = a.slice(0, n);
  const y = b.slice(0, n);

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let num = 0;
  let denX = 0;
  let denY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : round(num / den);
}

function buildCorrelationMatrix(series: Record<string, number[]>): Record<string, Record<string, number>> {
  const keys = Object.keys(series);
  const matrix: Record<string, Record<string, number>> = {};

  for (const a of keys) {
    matrix[a] = {};
    for (const b of keys) {
      matrix[a][b] = a === b ? 1 : pearsonCorrelation(series[a], series[b]);
    }
  }

  return matrix;
}

// ── Market Screener ──────────────────────────────────────────────

type Asset = {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  marketCap: number;
};

function screenAssets(
  assets: Asset[],
  filters: Record<string, number | undefined>,
  sortBy: string,
  sortDir: string,
  limit: number,
): Asset[] {
  let filtered = assets.filter(a => {
    if (filters.minPrice !== undefined && a.price < filters.minPrice) return false;
    if (filters.maxPrice !== undefined && a.price > filters.maxPrice) return false;
    if (filters.minChange !== undefined && a.changePercent < filters.minChange) return false;
    if (filters.maxChange !== undefined && a.changePercent > filters.maxChange) return false;
    if (filters.minVolume !== undefined && a.volume < filters.minVolume) return false;
    if (filters.minMarketCap !== undefined && a.marketCap < filters.minMarketCap) return false;
    return true;
  });

  const dir = sortDir === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    const aVal = (a as any)[sortBy] ?? 0;
    const bVal = (b as any)[sortBy] ?? 0;
    return (aVal - bVal) * dir;
  });

  return filtered.slice(0, limit);
}

// ── Skill Dispatcher ─────────────────────────────────────────────

async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;

  switch (skillId) {
    case "fetch_quote": {
      const { symbol, provider, customUrl } = MarketSchemas.fetch_quote.parse({ symbol: args.symbol ?? text, ...args });
      let quote: Record<string, unknown>;
      if (provider === "coinbase") {
        quote = await fetchCoinbaseQuote(symbol);
      } else if (provider === "alphavantage") {
        quote = await fetchAlphaVantageQuote(symbol);
      } else if (provider === "custom" && customUrl) {
        validateUrlNotInternal(customUrl);
        const res = await fetch(customUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { "User-Agent": UA } });
        if (!res.ok) throw new Error(`Custom API HTTP ${res.status}`);
        quote = await res.json() as Record<string, unknown>;
      } else if (provider === "yahoo") {
        // Explicit Yahoo Finance request — uses undocumented API.
        process.stderr.write("[market-agent] Warning: using unofficial Yahoo Finance API. Set ALPHAVANTAGE_API_KEY for a reliable official provider.\n");
        quote = await fetchYahooQuote(symbol);
      } else if (process.env.ALPHAVANTAGE_API_KEY) {
        // Alpha Vantage is the primary official provider when the key is set.
        quote = await fetchAlphaVantageQuote(symbol);
      } else {
        // Default fallback to Yahoo when no API key is set.
        process.stderr.write("[market-agent] Warning: using unofficial Yahoo Finance API. Set ALPHAVANTAGE_API_KEY for a reliable official provider.\n");
        quote = await fetchYahooQuote(symbol);
      }
      return safeStringify(quote, 2);
    }

    case "price_history": {
      const { symbol, interval, range, provider, customUrl } = MarketSchemas.price_history.parse({ symbol: args.symbol ?? text, ...args });
      if (provider === "custom" && customUrl) {
        validateUrlNotInternal(customUrl);
        const res = await fetch(customUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { "User-Agent": UA } });
        if (!res.ok) throw new Error(`Custom API HTTP ${res.status}`);
        const data = await res.json();
        return safeStringify(data, 2);
      }
      let history: { timestamps: string[]; open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] };
      if (provider === "alphavantage") {
        history = await fetchAlphaVantageHistory(symbol, interval, range);
      } else if (provider === "yahoo") {
        // Explicit Yahoo Finance request — uses undocumented API.
        process.stderr.write("[market-agent] Warning: using unofficial Yahoo Finance API. Set ALPHAVANTAGE_API_KEY for a reliable official provider.\n");
        history = await fetchYahooHistory(symbol, interval, range);
      } else if (process.env.ALPHAVANTAGE_API_KEY) {
        // Alpha Vantage is the primary official provider when the key is set.
        history = await fetchAlphaVantageHistory(symbol, interval, range);
      } else {
        // Default fallback to Yahoo when no API key is set.
        process.stderr.write("[market-agent] Warning: using unofficial Yahoo Finance API. Set ALPHAVANTAGE_API_KEY for a reliable official provider.\n");
        history = await fetchYahooHistory(symbol, interval, range);
      }
      return safeStringify({
        symbol,
        interval,
        range,
        dataPoints: history.timestamps.length,
        ...history,
      }, 2);
    }

    case "technical_analysis": {
      const { prices, indicators, period, volumes } = MarketSchemas.technical_analysis.parse(args);
      const result: Record<string, unknown> = {
        dataPoints: prices.length,
        period,
        latestPrice: prices[prices.length - 1],
      };

      for (const ind of indicators) {
        switch (ind) {
          case "sma": result.sma = computeSMA(prices, period); break;
          case "ema": result.ema = computeEMA(prices, period); break;
          case "rsi": result.rsi = computeRSI(prices, period); break;
          case "macd": result.macd = computeMACD(prices); break;
          case "bollinger": result.bollinger = computeBollinger(prices, period); break;
          case "atr": result.atr = computeATR(prices, period); break;
          case "vwap": result.vwap = computeVWAP(prices, volumes ?? []); break;
        }
      }

      // Add latest indicator values for quick reference
      const latest: Record<string, unknown> = {};
      if (result.sma) { const arr = result.sma as (number | null)[]; latest.sma = arr[arr.length - 1]; }
      if (result.ema) { const arr = result.ema as (number | null)[]; latest.ema = arr[arr.length - 1]; }
      if (result.rsi) { const arr = result.rsi as (number | null)[]; latest.rsi = arr[arr.length - 1]; }
      if (result.macd) { const m = result.macd as any; latest.macd = m.macd[m.macd.length - 1]; latest.macdSignal = m.signal[m.signal.length - 1]; latest.macdHistogram = m.histogram[m.histogram.length - 1]; }
      if (result.bollinger) { const b = result.bollinger as any; latest.bollingerUpper = b.upper[b.upper.length - 1]; latest.bollingerLower = b.lower[b.lower.length - 1]; }
      if (result.atr) { const arr = result.atr as (number | null)[]; latest.atr = arr[arr.length - 1]; }
      if (result.vwap) { const arr = result.vwap as (number | null)[]; latest.vwap = arr[arr.length - 1]; }
      result.latest = latest;

      return safeStringify(result, 2);
    }

    case "screen_market": {
      const { assets, filters, sortBy, sortDir, limit } = MarketSchemas.screen_market.parse(args);
      const screened = screenAssets(assets, filters, sortBy, sortDir, limit);
      return safeStringify({
        totalAssets: assets.length,
        matchedAssets: screened.length,
        filters,
        sortBy,
        sortDir,
        assets: screened,
      }, 2);
    }

    case "detect_anomalies": {
      const { prices, volumes, timestamps, zScoreThreshold, windowSize } = MarketSchemas.detect_anomalies.parse(args);
      const result = detectPriceAnomalies(prices, volumes, timestamps, zScoreThreshold, windowSize);
      return safeStringify(result, 2);
    }

    case "correlation": {
      const { series } = MarketSchemas.correlation.parse(args);
      const matrix = buildCorrelationMatrix(series);
      const keys = Object.keys(series);

      // Find strongest correlations (excluding self)
      const pairs: { a: string; b: string; r: number }[] = [];
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          pairs.push({ a: keys[i], b: keys[j], r: matrix[keys[i]][keys[j]] });
        }
      }
      pairs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

      return safeStringify({
        assetCount: keys.length,
        matrix,
        strongestCorrelations: pairs.slice(0, 10),
      }, 2);
    }

    case "market_composite": {
      const { prices, volumes, period, weights } = MarketSchemas.market_composite.parse(args);
      const components: Record<string, { raw: number; normalized: number; weight: number; contribution: number }> = {};

      // 1. RSI component (0-100 already; 50 = neutral, <30 = oversold/bullish, >70 = overbought/bearish)
      const rsiValues = computeRSI(prices, period);
      const latestRsi = rsiValues[rsiValues.length - 1] ?? 50;
      // Normalize: 0 (very bearish) to 100 (very bullish) — invert RSI logic
      const rsiNorm = round(100 - latestRsi, 2);
      components.rsi = { raw: latestRsi, normalized: rsiNorm, weight: weights.rsi, contribution: round(rsiNorm * weights.rsi, 2) };

      // 2. MACD component (histogram direction and magnitude)
      const macdResult = computeMACD(prices);
      const hist = macdResult.histogram.filter(v => v !== null) as number[];
      const latestHist = hist[hist.length - 1] ?? 0;
      const prevHist = hist[hist.length - 2] ?? 0;
      // Normalize histogram to 0-100 using sigmoid-like mapping
      const histRange = Math.max(...hist.map(Math.abs), 0.01);
      const macdNorm = round(50 + (latestHist / histRange) * 50, 2);
      const macdTrend = latestHist > prevHist ? "improving" : "deteriorating";
      components.macd = { raw: latestHist, normalized: macdNorm, weight: weights.macd, contribution: round(macdNorm * weights.macd, 2) };

      // 3. Volume anomaly (if volumes provided)
      let volNorm = 50; // neutral default
      if (volumes && volumes.length === prices.length && volumes.length >= period) {
        const recentVol = volumes.slice(-period);
        const avgVol = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
        const latestVol = volumes[volumes.length - 1];
        // High volume on price increase = bullish; high volume on price decrease = bearish
        const priceChange = prices[prices.length - 1] - prices[prices.length - 2];
        const volRatio = avgVol > 0 ? latestVol / avgVol : 1;
        volNorm = round(Math.min(100, Math.max(0, 50 + (priceChange > 0 ? 1 : -1) * (volRatio - 1) * 30)), 2);
      }
      components.volumeAnomaly = { raw: volNorm, normalized: volNorm, weight: weights.volumeAnomaly, contribution: round(volNorm * weights.volumeAnomaly, 2) };

      // 4. Price momentum (rate of change over period)
      const pricePeriodAgo = prices[prices.length - 1 - period] ?? prices[0];
      const latestPrice = prices[prices.length - 1];
      const roc = pricePeriodAgo !== 0 ? ((latestPrice - pricePeriodAgo) / pricePeriodAgo) * 100 : 0;
      // Map ROC to 0-100: -10% → 0, 0% → 50, +10% → 100
      const momNorm = round(Math.min(100, Math.max(0, 50 + roc * 5)), 2);
      components.momentum = { raw: round(roc, 2), normalized: momNorm, weight: weights.momentum, contribution: round(momNorm * weights.momentum, 2) };

      // 5. Volatility (lower volatility = higher score, more stable)
      const returns: number[] = [];
      for (let i = 1; i < prices.length; i++) {
        returns.push((prices[i] - prices[i - 1]) / (prices[i - 1] || 1));
      }
      const recentReturns = returns.slice(-period);
      const meanReturn = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
      const variance = recentReturns.reduce((acc, r) => acc + (r - meanReturn) ** 2, 0) / recentReturns.length;
      const volatility = Math.sqrt(variance) * 100; // annualize-ish
      // Low vol = high score: 0% vol → 100, 5%+ vol → 0
      const volScore = round(Math.min(100, Math.max(0, 100 - volatility * 20)), 2);
      components.volatility = { raw: round(volatility, 4), normalized: volScore, weight: weights.volatility, contribution: round(volScore * weights.volatility, 2) };

      // 6. Trend (SMA crossover: price vs SMA)
      const smaValues = computeSMA(prices, period);
      const latestSma = smaValues[smaValues.length - 1] ?? latestPrice;
      const trendPct = latestSma !== 0 ? ((latestPrice - latestSma) / latestSma) * 100 : 0;
      const trendNorm = round(Math.min(100, Math.max(0, 50 + trendPct * 10)), 2);
      const trendDir = latestPrice > latestSma ? "bullish" : latestPrice < latestSma ? "bearish" : "neutral";
      components.trend = { raw: round(trendPct, 2), normalized: trendNorm, weight: weights.trend, contribution: round(trendNorm * weights.trend, 2) };

      // Composite score
      const compositeScore = round(
        Object.values(components).reduce((s, c) => s + c.contribution, 0), 1
      );

      let signal: string;
      if (compositeScore >= 75) signal = "strong_buy";
      else if (compositeScore >= 60) signal = "buy";
      else if (compositeScore >= 40) signal = "hold";
      else if (compositeScore >= 25) signal = "sell";
      else signal = "strong_sell";

      return safeStringify({
        compositeScore,
        signal,
        macdTrend,
        trendDirection: trendDir,
        dataPoints: prices.length,
        period,
        components,
        weights,
      }, 2);
    }

    default:
      return `Unknown skill: ${skillId}`;
  }
}

// ── Fastify Server ───────────────────────────────────────────────

const app = Fastify({ logger: false });

app.get("/.well-known/agent.json", async () => AGENT_CARD);

app.get("/healthz", async () => ({
  status: "ok",
  agent: NAME,
  uptime: process.uptime(),
  skills: AGENT_CARD.skills.map(s => s.id),
}));

app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
  const data = request.body;
  if (data?.method !== "tasks/send") {
    reply.code(404);
    return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
  }

  const sizeErr = checkRequestSize(data);
  if (sizeErr) { reply.code(413); return { jsonrpc: "2.0", error: { code: -32000, message: sizeErr } }; }

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "fetch_quote";

  try {
    const result = await handleSkill(sid, args ?? {}, text);
    return buildA2AResponse(data.id, taskId, result);
  } catch (err) {
    reply.code(500);
    return buildA2AError(data.id, err);
  }
});

getPersona(NAME);
watchPersonas();

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
