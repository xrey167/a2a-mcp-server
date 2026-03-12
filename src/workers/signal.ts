/**
 * Signal Worker Agent — multi-source signal aggregation, threat classification,
 * geo-convergence detection, temporal baseline analysis, and instability scoring.
 *
 * Port: 8091
 *
 * Inspired by World Monitor's signal-aggregator, threat-classifier, military-surge,
 * and country-intel modules.
 *
 * Skills:
 *   aggregate_signals   — Fuse heterogeneous signals with dedup, scoring, and country mapping
 *   classify_threat     — Classify events by threat level and category using keyword cascading
 *   detect_convergence  — Detect geographic convergence of multiple signal types
 *   baseline_compare    — Temporal baseline analysis: z-score deviations in rolling windows
 *   instability_index   — Compute composite instability score for a region/country
 *   remember/recall     — Shared persistent memory
 */

import Fastify from "fastify";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { buildA2AResponse, buildA2AError, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";
import { getPersona, watchPersonas } from "../persona-loader.js";

const PORT = 8091;
const NAME = "signal-agent";

// ── Zod Schemas ──────────────────────────────────────────────────

const SignalSchemas = {
  aggregate_signals: z.object({
    signals: z.array(z.object({
      id: z.string().optional(),
      type: z.string(),
      source: z.string(),
      title: z.string().optional().default(""),
      description: z.string().optional().default(""),
      severity: z.enum(["critical", "high", "medium", "low", "info"]).optional().default("info"),
      lat: z.number().optional(),
      lon: z.number().optional(),
      country: z.string().optional().default(""),
      timestamp: z.string().optional().default(""),
      metadata: z.record(z.unknown()).optional().default({}),
    })).min(1),
    windowHours: z.number().positive().optional().default(24),
    dedup: z.boolean().optional().default(true),
  }).passthrough(),

  classify_threat: z.object({
    events: z.array(z.object({
      title: z.string(),
      description: z.string().optional().default(""),
      source: z.string().optional().default(""),
      type: z.string().optional().default(""),
    })).min(1),
  }).passthrough(),

  detect_convergence: z.object({
    signals: z.array(z.object({
      type: z.string(),
      lat: z.number(),
      lon: z.number(),
      severity: z.enum(["critical", "high", "medium", "low", "info"]).optional().default("info"),
      title: z.string().optional().default(""),
      timestamp: z.string().optional().default(""),
    })).min(1),
    radiusKm: z.number().positive().optional().default(150),
    minTypes: z.number().int().positive().optional().default(2),
  }).passthrough(),

  baseline_compare: z.object({
    series: z.array(z.object({
      timestamp: z.string(),
      value: z.number(),
      label: z.string().optional().default(""),
    })).min(2),
    baselineHours: z.number().positive().optional().default(48),
    zScoreThreshold: z.number().positive().optional().default(2),
  }).passthrough(),

  instability_index: z.object({
    country: z.string().min(1),
    indicators: z.object({
      conflictEvents: z.number().optional().default(0),
      militaryActivity: z.number().optional().default(0),
      civilUnrest: z.number().optional().default(0),
      cyberThreats: z.number().optional().default(0),
      economicStress: z.number().optional().default(0),
      displacement: z.number().optional().default(0),
      naturalDisasters: z.number().optional().default(0),
      mediaCoverage: z.number().optional().default(0),
    }),
    weights: z.object({
      conflictEvents: z.number().optional().default(0.25),
      militaryActivity: z.number().optional().default(0.20),
      civilUnrest: z.number().optional().default(0.15),
      cyberThreats: z.number().optional().default(0.10),
      economicStress: z.number().optional().default(0.10),
      displacement: z.number().optional().default(0.10),
      naturalDisasters: z.number().optional().default(0.05),
      mediaCoverage: z.number().optional().default(0.05),
    }).optional().default({}),
  }).passthrough(),
};

// ── Agent Card ───────────────────────────────────────────────────

const AGENT_CARD = {
  name: NAME,
  description: "Signal agent — multi-source signal aggregation, threat classification, geo-convergence detection, temporal baseline analysis, and instability indexing",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "aggregate_signals", name: "Aggregate Signals", description: "Fuse signals from multiple sources with dedup, severity scoring, and country-level clustering" },
    { id: "classify_threat", name: "Classify Threat", description: "Classify events by threat level (critical/high/medium/low) and category (conflict, cyber, climate, etc.)" },
    { id: "detect_convergence", name: "Detect Convergence", description: "Detect geographic convergence where multiple signal types cluster within a radius" },
    { id: "baseline_compare", name: "Baseline Compare", description: "Temporal baseline analysis: compare recent values against rolling baseline via z-score" },
    { id: "instability_index", name: "Instability Index", description: "Compute composite Country Instability Index from weighted multi-stream indicators" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

// ── Haversine Distance ───────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function round(n: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ── Signal Aggregation ───────────────────────────────────────────

const SEVERITY_SCORE: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

interface Signal {
  id?: string;
  type: string;
  source: string;
  title: string;
  description: string;
  severity: string;
  lat?: number;
  lon?: number;
  country: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

interface AggregatedCluster {
  country: string;
  signalCount: number;
  severityScore: number;
  avgSeverity: number;
  typeDistribution: Record<string, number>;
  sourceDiversity: number;
  signals: Array<{ type: string; title: string; severity: string; source: string }>;
}

function aggregateSignals(signals: Signal[], windowHours: number, dedup: boolean): {
  clusters: AggregatedCluster[];
  typeCounts: Record<string, number>;
  severityCounts: Record<string, number>;
  totalSignals: number;
  uniqueCountries: number;
} {
  const now = Date.now();
  const cutoff = now - windowHours * 60 * 60 * 1000;

  // Filter by time window
  let filtered = signals.filter(s => {
    if (!s.timestamp) return true; // include signals without timestamp
    const ts = new Date(s.timestamp).getTime();
    return isNaN(ts) || ts >= cutoff;
  });

  // Deduplicate by title similarity
  if (dedup) {
    const seen = new Set<string>();
    filtered = filtered.filter(s => {
      const key = s.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
      if (key.length > 5 && seen.has(key)) return false;
      if (key.length > 5) seen.add(key);
      return true;
    });
  }

  // Group by country
  const byCountry = new Map<string, Signal[]>();
  for (const s of filtered) {
    const country = s.country || "unknown";
    (byCountry.get(country) ?? (byCountry.set(country, []), byCountry.get(country))!).push(s);
  }

  // Build clusters
  const clusters: AggregatedCluster[] = [];
  for (const [country, sigs] of byCountry) {
    const typeDistribution: Record<string, number> = {};
    const sources = new Set<string>();
    let severityScore = 0;

    for (const s of sigs) {
      typeDistribution[s.type] = (typeDistribution[s.type] ?? 0) + 1;
      sources.add(s.source);
      severityScore += SEVERITY_SCORE[s.severity] ?? 1;
    }

    clusters.push({
      country,
      signalCount: sigs.length,
      severityScore,
      avgSeverity: round(severityScore / sigs.length, 2),
      typeDistribution,
      sourceDiversity: sources.size,
      signals: sigs.map(s => ({ type: s.type, title: s.title, severity: s.severity, source: s.source })).slice(0, 20),
    });
  }

  // Sort by severity score descending
  clusters.sort((a, b) => b.severityScore - a.severityScore);

  // Global counts
  const typeCounts: Record<string, number> = {};
  const severityCounts: Record<string, number> = {};
  for (const s of filtered) {
    typeCounts[s.type] = (typeCounts[s.type] ?? 0) + 1;
    severityCounts[s.severity] = (severityCounts[s.severity] ?? 0) + 1;
  }

  return {
    clusters,
    typeCounts,
    severityCounts,
    totalSignals: filtered.length,
    uniqueCountries: byCountry.size,
  };
}

// ── Threat Classification ────────────────────────────────────────

const THREAT_CATEGORIES: Record<string, string[]> = {
  conflict: ["war", "attack", "strike", "missile", "bomb", "airstrike", "artillery", "combat", "frontline", "casualties", "killed", "offensive", "shelling", "insurgent"],
  military: ["troops", "deploy", "military", "naval", "fighter jet", "exercise", "mobiliz", "base", "patrol", "reconnaissance", "nato", "defense"],
  terrorism: ["terror", "ied", "suicide bomb", "extremist", "militant", "isis", "al-qaeda", "hostage", "kidnap"],
  cyber: ["hack", "breach", "ransomware", "malware", "cyber", "vulnerability", "phishing", "ddos", "apt", "zero-day", "exploit"],
  civil_unrest: ["protest", "riot", "demonstration", "unrest", "uprising", "revolution", "coup", "martial law", "curfew", "crackdown"],
  geopolitical: ["sanction", "diplomat", "summit", "treaty", "embargo", "bilateral", "alliance", "territorial", "sovereignty", "annexation"],
  economic: ["market crash", "recession", "inflation", "bank run", "default", "debt crisis", "currency", "trade war", "tariff"],
  climate: ["earthquake", "hurricane", "flood", "wildfire", "tsunami", "volcano", "drought", "tornado", "cyclone", "typhoon"],
  health: ["pandemic", "outbreak", "epidemic", "virus", "quarantine", "vaccination", "who ", "disease", "pathogen"],
  infrastructure: ["pipeline", "blackout", "power outage", "cable cut", "port closure", "bridge collapse", "dam", "derail"],
  nuclear: ["nuclear", "radiation", "warhead", "enrichment", "plutonium", "uranium", "icbm", "nonproliferation"],
  maritime: ["vessel", "shipping", "blockade", "piracy", "seized", "tanker", "naval mine", "strait"],
  space: ["satellite", "launch", "orbit", "debris", "space station", "rocket", "gps jamming"],
  humanitarian: ["refugee", "displacement", "famine", "humanitarian", "aid", "crisis", "migration", "asylum"],
};

const THREAT_ESCALATION_TERMS: Record<string, string[]> = {
  critical: ["breaking", "urgent", "imminent", "nuclear strike", "mass casualty", "war declared", "coup underway", "invasion begun", "chemical weapon"],
  high: ["escalat", "mobiliz", "surge", "critical", "emergency", "alert", "threat level", "evacuate", "martial law", "sanctions imposed"],
  medium: ["tension", "concern", "increased", "reported", "incident", "warning", "monitor", "elevated"],
};

interface ThreatClassification {
  title: string;
  category: string;
  subcategories: string[];
  threatLevel: string;
  confidence: number;
  keywords: string[];
}

function classifyThreat(title: string, description: string, source: string, type: string): ThreatClassification {
  const text = `${title} ${description} ${type}`.toLowerCase();

  // Category detection — find all matching categories ranked by match count
  const catScores: Array<{ cat: string; score: number; keywords: string[] }> = [];
  for (const [cat, keywords] of Object.entries(THREAT_CATEGORIES)) {
    const matched = keywords.filter(kw => text.includes(kw));
    if (matched.length > 0) {
      catScores.push({ cat, score: matched.length, keywords: matched });
    }
  }
  catScores.sort((a, b) => b.score - a.score);

  const bestCat = catScores[0]?.cat ?? "unclassified";
  const subcategories = catScores.slice(1, 4).map(c => c.cat);
  const allKeywords = catScores.flatMap(c => c.keywords).slice(0, 10);

  // Threat level — cascading: check critical first, then high, then medium
  let threatLevel = "low";
  let confidence = 0.3;

  for (const term of THREAT_ESCALATION_TERMS.critical) {
    if (text.includes(term)) { threatLevel = "critical"; confidence = 0.9; break; }
  }
  if (threatLevel === "low") {
    for (const term of THREAT_ESCALATION_TERMS.high) {
      if (text.includes(term)) { threatLevel = "high"; confidence = 0.7; break; }
    }
  }
  if (threatLevel === "low") {
    for (const term of THREAT_ESCALATION_TERMS.medium) {
      if (text.includes(term)) { threatLevel = "medium"; confidence = 0.5; break; }
    }
  }

  // Boost confidence based on category keyword density
  if (catScores[0]?.score >= 3) confidence = Math.min(confidence + 0.15, 1);
  if (catScores[0]?.score >= 5) confidence = Math.min(confidence + 0.1, 1);

  return {
    title,
    category: bestCat,
    subcategories,
    threatLevel,
    confidence: round(confidence, 2),
    keywords: allKeywords,
  };
}

// ── Geo-Convergence Detection ────────────────────────────────────

interface GeoSignal {
  type: string;
  lat: number;
  lon: number;
  severity: string;
  title: string;
  timestamp: string;
}

interface ConvergenceZone {
  centroidLat: number;
  centroidLon: number;
  radiusKm: number;
  signalTypes: string[];
  typeDiversity: number;
  severityScore: number;
  signalCount: number;
  signals: Array<{ type: string; title: string; severity: string; distanceKm: number }>;
}

function detectConvergence(signals: GeoSignal[], radiusKm: number, minTypes: number): ConvergenceZone[] {
  const zones: ConvergenceZone[] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < signals.length; i++) {
    if (assigned.has(i)) continue;

    const cluster: Array<{ signal: GeoSignal; index: number; distance: number }> = [
      { signal: signals[i], index: i, distance: 0 },
    ];

    // Find all signals within radius
    for (let j = i + 1; j < signals.length; j++) {
      if (assigned.has(j)) continue;
      const dist = haversineKm(signals[i].lat, signals[i].lon, signals[j].lat, signals[j].lon);
      if (dist <= radiusKm) {
        cluster.push({ signal: signals[j], index: j, distance: dist });
      }
    }

    // Check type diversity
    const types = new Set(cluster.map(c => c.signal.type));
    if (types.size >= minTypes) {
      // Mark all as assigned
      for (const c of cluster) assigned.add(c.index);

      // Compute centroid
      const centroidLat = round(cluster.reduce((s, c) => s + c.signal.lat, 0) / cluster.length);
      const centroidLon = round(cluster.reduce((s, c) => s + c.signal.lon, 0) / cluster.length);

      // Severity score
      let severityScore = 0;
      for (const c of cluster) {
        severityScore += SEVERITY_SCORE[c.signal.severity] ?? 1;
      }

      // Recalculate distances from centroid
      const signalsWithDist = cluster.map(c => ({
        type: c.signal.type,
        title: c.signal.title,
        severity: c.signal.severity,
        distanceKm: round(haversineKm(centroidLat, centroidLon, c.signal.lat, c.signal.lon), 1),
      }));

      const maxDist = Math.max(...signalsWithDist.map(s => s.distanceKm), 0);

      zones.push({
        centroidLat,
        centroidLon,
        radiusKm: maxDist || radiusKm,
        signalTypes: [...types],
        typeDiversity: types.size,
        severityScore,
        signalCount: cluster.length,
        signals: signalsWithDist,
      });
    }
  }

  // Sort by severity score * type diversity
  zones.sort((a, b) => (b.severityScore * b.typeDiversity) - (a.severityScore * a.typeDiversity));
  return zones;
}

// ── Temporal Baseline Analysis ───────────────────────────────────

interface DataPoint {
  timestamp: string;
  value: number;
  label: string;
}

interface BaselineAnomaly {
  timestamp: string;
  label: string;
  value: number;
  baselineMean: number;
  baselineStddev: number;
  zScore: number;
  percentChange: number;
  direction: string;
}

function baselineCompare(series: DataPoint[], baselineHours: number, zScoreThreshold: number): {
  anomalies: BaselineAnomaly[];
  baselineStats: { mean: number; stddev: number; min: number; max: number; count: number };
  recentStats: { mean: number; count: number };
} {
  const now = Date.now();
  const baselineCutoff = now - baselineHours * 60 * 60 * 1000;
  const recentCutoff = now - (baselineHours / 4) * 60 * 60 * 1000;

  // Split into baseline and recent
  const baselineValues: number[] = [];
  const recentPoints: DataPoint[] = [];

  for (const dp of series) {
    const ts = dp.timestamp ? new Date(dp.timestamp).getTime() : 0;
    if (ts > recentCutoff) {
      recentPoints.push(dp);
    } else if (ts > baselineCutoff || isNaN(ts)) {
      baselineValues.push(dp.value);
    }
  }

  // If not enough baseline data, use first 75% of series
  if (baselineValues.length < 3) {
    const splitIdx = Math.floor(series.length * 0.75);
    baselineValues.length = 0;
    for (let i = 0; i < splitIdx; i++) baselineValues.push(series[i].value);
    recentPoints.length = 0;
    for (let i = splitIdx; i < series.length; i++) recentPoints.push(series[i]);
  }

  // Baseline statistics
  const mean = baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length;
  const variance = baselineValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / baselineValues.length;
  const stddev = Math.sqrt(variance);

  // Detect anomalies in recent window
  const anomalies: BaselineAnomaly[] = [];
  for (const dp of recentPoints) {
    const zScore = stddev === 0 ? 0 : (dp.value - mean) / stddev;
    if (Math.abs(zScore) >= zScoreThreshold) {
      const percentChange = mean !== 0 ? ((dp.value - mean) / mean) * 100 : 0;
      anomalies.push({
        timestamp: dp.timestamp,
        label: dp.label,
        value: dp.value,
        baselineMean: round(mean, 2),
        baselineStddev: round(stddev, 2),
        zScore: round(zScore, 2),
        percentChange: round(percentChange, 2),
        direction: zScore > 0 ? "above_baseline" : "below_baseline",
      });
    }
  }

  anomalies.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return {
    anomalies,
    baselineStats: {
      mean: round(mean, 2),
      stddev: round(stddev, 2),
      min: baselineValues.length > 0 ? Math.min(...baselineValues) : 0,
      max: baselineValues.length > 0 ? Math.max(...baselineValues) : 0,
      count: baselineValues.length,
    },
    recentStats: {
      mean: recentPoints.length > 0 ? round(recentPoints.reduce((a, b) => a + b.value, 0) / recentPoints.length, 2) : 0,
      count: recentPoints.length,
    },
  };
}

// ── Instability Index (CII-style) ───────────────────────────────

interface InstabilityResult {
  country: string;
  index: number;
  level: string;
  breakdown: Record<string, { raw: number; weighted: number; weight: number }>;
  dominantFactors: string[];
}

function computeInstabilityIndex(
  country: string,
  indicators: Record<string, number>,
  weights: Record<string, number>,
): InstabilityResult {
  const breakdown: Record<string, { raw: number; weighted: number; weight: number }> = {};
  let totalWeightedScore = 0;
  let totalWeight = 0;

  for (const [key, raw] of Object.entries(indicators)) {
    const weight = weights[key] ?? 0.05;
    // Normalize raw to 0-10 scale using log dampening for high values
    const normalized = Math.min(10, raw === 0 ? 0 : Math.log2(raw + 1) * 2);
    const weighted = normalized * weight;
    breakdown[key] = { raw, weighted: round(weighted, 3), weight };
    totalWeightedScore += weighted;
    totalWeight += weight;
  }

  // Normalize to 0-100 scale
  const index = totalWeight > 0 ? round(Math.min(100, (totalWeightedScore / totalWeight) * 10), 1) : 0;

  // Determine level
  let level: string;
  if (index >= 80) level = "critical";
  else if (index >= 60) level = "high";
  else if (index >= 40) level = "elevated";
  else if (index >= 20) level = "moderate";
  else level = "low";

  // Dominant factors (top 3 by weighted score)
  const dominantFactors = Object.entries(breakdown)
    .sort((a, b) => b[1].weighted - a[1].weighted)
    .slice(0, 3)
    .map(([k]) => k);

  return { country, index, level, breakdown, dominantFactors };
}

// ── Skill Dispatcher ─────────────────────────────────────────────

function handleSkill(skillId: string, args: Record<string, unknown>, text: string): string {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;

  switch (skillId) {
    case "aggregate_signals": {
      const { signals, windowHours, dedup } = SignalSchemas.aggregate_signals.parse(args);
      const result = aggregateSignals(signals, windowHours, dedup);
      return safeStringify(result, 2);
    }

    case "classify_threat": {
      const { events } = SignalSchemas.classify_threat.parse(args);
      const classified = events.map(e => classifyThreat(e.title, e.description, e.source, e.type));

      // Summary
      const byCat: Record<string, number> = {};
      const byLevel: Record<string, number> = {};
      for (const c of classified) {
        byCat[c.category] = (byCat[c.category] ?? 0) + 1;
        byLevel[c.threatLevel] = (byLevel[c.threatLevel] ?? 0) + 1;
      }

      return safeStringify({
        totalEvents: classified.length,
        byCategory: byCat,
        byThreatLevel: byLevel,
        events: classified,
      }, 2);
    }

    case "detect_convergence": {
      const { signals, radiusKm, minTypes } = SignalSchemas.detect_convergence.parse(args);
      const zones = detectConvergence(signals, radiusKm, minTypes);
      return safeStringify({
        totalSignals: signals.length,
        convergenceZones: zones.length,
        zones,
      }, 2);
    }

    case "baseline_compare": {
      const { series, baselineHours, zScoreThreshold } = SignalSchemas.baseline_compare.parse(args);
      const result = baselineCompare(series, baselineHours, zScoreThreshold);
      return safeStringify({
        dataPoints: series.length,
        anomalyCount: result.anomalies.length,
        ...result,
      }, 2);
    }

    case "instability_index": {
      const { country, indicators, weights } = SignalSchemas.instability_index.parse(args);
      const result = computeInstabilityIndex(country, indicators, weights);
      return safeStringify(result, 2);
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
  const sid = skillId ?? "aggregate_signals";

  try {
    const result = handleSkill(sid, args ?? {}, text);
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
