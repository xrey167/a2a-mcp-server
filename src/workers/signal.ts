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
import { round, haversineKm } from "../worker-utils.js";

const PORT = 8091;
const NAME = "signal-agent";
const FETCH_TIMEOUT = 20_000;
const UA_SIGNAL = "A2A-Signal-Agent/1.0";

// ── Canonical Signal Types ───────────────────────────────────────

/**
 * 12 canonical signal domains. The first 8 map directly to instability_index
 * indicators; the remaining 4 (nuclear, maritime, unrest, logistics) are
 * tracked for correlation patterns but don't have dedicated instability weights.
 */
const CANONICAL_SIGNAL_TYPES = [
  "conflict", "military", "cyber", "infrastructure", "economic",
  "climate", "displacement", "news",
  "nuclear", "maritime", "unrest", "logistics",
] as const;

type CanonicalSignalType = typeof CANONICAL_SIGNAL_TYPES[number];

/** Maps the 12 signal domains → instability_index indicator names (null = no direct mapping) */
const SIGNAL_TO_INSTABILITY: Record<CanonicalSignalType, string | null> = {
  conflict: "conflictEvents",
  military: "militaryActivity",
  unrest: "civilUnrest",
  cyber: "cyberThreats",
  economic: "economicStress",
  displacement: "displacement",
  climate: "naturalDisasters",
  news: "mediaCoverage",
  infrastructure: null, // contributes to cascade analysis, not instability index
  nuclear: null,        // tracked via dual-use correlation pattern
  maritime: null,       // tracked via supply chain stress pattern
  logistics: null,      // tracked via military buildup pattern
};

/** Normalize a free-form signal type string to a canonical domain */
function normalizeSignalType(type: string): CanonicalSignalType | string {
  const t = type.toLowerCase().trim();
  // Direct match
  if ((CANONICAL_SIGNAL_TYPES as readonly string[]).includes(t)) return t as CanonicalSignalType;
  // Common aliases
  const aliases: Record<string, CanonicalSignalType> = {
    war: "conflict", attack: "conflict", combat: "conflict", strike: "conflict",
    troops: "military", deployment: "military", exercise: "military", naval: "military",
    hack: "cyber", breach: "cyber", malware: "cyber", ransomware: "cyber",
    pipeline: "infrastructure", cable: "infrastructure", port: "infrastructure", power: "infrastructure",
    market: "economic", trade: "economic", finance: "economic", gdp: "economic",
    earthquake: "climate", flood: "climate", wildfire: "climate", hurricane: "climate", disaster: "climate",
    refugee: "displacement", migration: "displacement", asylum: "displacement",
    media: "news", press: "news", report: "news", coverage: "news",
    radiation: "nuclear", enrichment: "nuclear", warhead: "nuclear",
    vessel: "maritime", shipping: "maritime", tanker: "maritime",
    protest: "unrest", riot: "unrest", demonstration: "unrest", coup: "unrest",
    supply: "logistics", transport: "logistics", cargo: "logistics",
  };
  return aliases[t] ?? t;
}

// ── Zod Schemas ──────────────────────────────────────────────────

const SignalSchemas = {
  aggregate_signals: z.looseObject({
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
  }),

  classify_threat: z.looseObject({
    events: z.array(z.object({
      title: z.string(),
      description: z.string().optional().default(""),
      source: z.string().optional().default(""),
      type: z.string().optional().default(""),
    })).min(1),
  }),

  detect_convergence: z.looseObject({
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
  }),

  baseline_compare: z.looseObject({
    series: z.array(z.object({
      timestamp: z.string(),
      value: z.number(),
      label: z.string().optional().default(""),
    })).min(2),
    baselineHours: z.number().positive().optional().default(48),
    zScoreThreshold: z.number().positive().optional().default(2),
  }),

  instability_index: z.looseObject({
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
    /** Geopolitical risk framework overlay */
    framework: z.enum(["standard", "grand_chessboard", "prisoners_of_geography"]).optional().default("standard"),
  }),

  // ── Live Cyber Threat Feed Skills ────────────────────────────────
  fetch_cyber_c2: z.looseObject({
    limit: z.number().int().positive().optional().default(100),
  }),

  fetch_malicious_urls: z.looseObject({
    limit: z.number().int().positive().optional().default(100),
  }),

  fetch_outages: z.looseObject({
    country: z.string().optional(),
    days: z.number().int().positive().optional().default(7),
  }),

  correlate_signals: z.looseObject({
    signals: z.array(z.object({
      type: z.string(),
      source: z.string().optional().default(""),
      title: z.string().optional().default(""),
      description: z.string().optional().default(""),
      severity: z.enum(["critical", "high", "medium", "low", "info"]).optional().default("info"),
      country: z.string().optional().default(""),
      timestamp: z.string().optional().default(""),
      value: z.number().optional(),
      metadata: z.record(z.unknown()).optional().default({}),
    })).min(1),
    windowHours: z.number().positive().optional().default(24),
    minConfidence: z.number().min(0).max(1).optional().default(0.3),
  }),
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
    { id: "correlate_signals", name: "Correlate Signals", description: "Detect 14 cross-domain correlation patterns (Silent Divergence, Conflict Escalation, Cyber-Infrastructure, etc.)" },
    { id: "fetch_cyber_c2", name: "Fetch Cyber C2", description: "Fetch live botnet C2 server data from Feodo Tracker (abuse.ch)" },
    { id: "fetch_malicious_urls", name: "Fetch Malicious URLs", description: "Fetch recent malicious URLs from URLhaus (abuse.ch)" },
    { id: "fetch_outages", name: "Fetch Outages", description: "Fetch internet outage signals from IODA (Internet Outage Detection and Analysis)" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

// round() and haversineKm() imported from ../worker-utils.js

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
  normalizedDensity: number; // signals per 100k km² (geo-normalized)
  centroidLat: number | null;
  centroidLon: number | null;
  typeDistribution: Record<string, number>;
  sourceDiversity: number;
  signals: Array<{ type: string; title: string; severity: string; source: string }>;
}

// Country land area in 1000 km² for geo-normalization (top ~60 countries + regions)
const COUNTRY_AREA_K: Record<string, number> = {
  russia: 17098, canada: 9985, china: 9597, "united states": 9834, usa: 9834, us: 9834,
  brazil: 8516, australia: 7692, india: 3287, argentina: 2780, kazakhstan: 2725,
  algeria: 2382, "dr congo": 2345, "saudi arabia": 2150, mexico: 1964, indonesia: 1905,
  sudan: 1886, libya: 1760, iran: 1648, mongolia: 1564, peru: 1285,
  chad: 1284, niger: 1267, angola: 1247, mali: 1240, "south africa": 1221,
  colombia: 1142, ethiopia: 1104, bolivia: 1099, mauritania: 1031, egypt: 1002,
  tanzania: 945, nigeria: 924, venezuela: 912, pakistan: 882, namibia: 824,
  mozambique: 801, turkey: 784, chile: 756, zambia: 753, myanmar: 677,
  afghanistan: 652, "south sudan": 644, france: 640, somalia: 638, ukraine: 604,
  madagascar: 587, kenya: 580, yemen: 528, thailand: 513, spain: 506,
  turkmenistan: 488, cameroon: 475, papua: 463, sweden: 450, uzbekistan: 447,
  morocco: 447, iraq: 438, japan: 378, germany: 357, philippines: 300,
  uk: 243, "united kingdom": 243, italy: 301, poland: 313, finland: 338,
  vietnam: 331, malaysia: 330, norway: 324, "ivory coast": 322, romania: 238,
  ghana: 239, laos: 237, guyana: 215, belarus: 208, kyrgyzstan: 200,
  syria: 185, cambodia: 181, uruguay: 176, tunisia: 164, nepal: 147,
  bangladesh: 148, tajikistan: 143, greece: 132, nicaragua: 130, north_korea: 121,
  south_korea: 100, korea: 100, iceland: 103, hungary: 93, portugal: 92,
  jordan: 89, serbia: 88, azerbaijan: 87, austria: 84, uae: 84,
  czech: 79, panama: 75, ireland: 70, georgia: 70, sri_lanka: 66,
  lithuania: 65, latvia: 65, croatia: 57, "bosnia": 51, slovakia: 49,
  estonia: 45, denmark: 43, netherlands: 42, switzerland: 41, taiwan: 36,
  belgium: 31, israel: 22, slovenia: 20, qatar: 12, lebanon: 10,
  kuwait: 18, bahrain: 1, singapore: 1, luxembourg: 3, malta: 0.3,
};

function aggregateSignals(signals: Signal[], windowHours: number, dedup: boolean): {
  clusters: AggregatedCluster[];
  typeCounts: Record<string, number>;
  severityCounts: Record<string, number>;
  totalSignals: number;
  uniqueCountries: number;
  normalizedTypeCounts: Record<string, number>;
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
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country)!.push(s);
  }

  // Build clusters with geo-normalization
  const clusters: AggregatedCluster[] = [];
  for (const [country, sigs] of byCountry) {
    const typeDistribution: Record<string, number> = {};
    const sources = new Set<string>();
    let severityScore = 0;
    let latSum = 0, lonSum = 0, geoCount = 0;

    for (const s of sigs) {
      typeDistribution[s.type] = (typeDistribution[s.type] ?? 0) + 1;
      sources.add(s.source);
      severityScore += SEVERITY_SCORE[s.severity] ?? 1;
      if (s.lat !== undefined && s.lon !== undefined) {
        latSum += s.lat;
        lonSum += s.lon;
        geoCount++;
      }
    }

    // Geo-normalization: signal density per 100k km²
    const countryKey = country.toLowerCase().replace(/[^a-z\s_]/g, "").trim();
    const areaK = COUNTRY_AREA_K[countryKey] ?? 0;
    const normalizedDensity = areaK > 0 ? round((sigs.length / areaK) * 100, 2) : 0;

    clusters.push({
      country,
      signalCount: sigs.length,
      severityScore,
      avgSeverity: round(severityScore / sigs.length, 2),
      normalizedDensity,
      centroidLat: geoCount > 0 ? round(latSum / geoCount) : null,
      centroidLon: geoCount > 0 ? round(lonSum / geoCount) : null,
      typeDistribution,
      sourceDiversity: sources.size,
      signals: sigs.map(s => ({ type: s.type, title: s.title, severity: s.severity, source: s.source })).slice(0, 20),
    });
  }

  // Sort by severity score descending
  clusters.sort((a, b) => b.severityScore - a.severityScore);

  // Global counts (raw + normalized)
  const typeCounts: Record<string, number> = {};
  const normalizedTypeCounts: Record<string, number> = {};
  const severityCounts: Record<string, number> = {};
  for (const s of filtered) {
    typeCounts[s.type] = (typeCounts[s.type] ?? 0) + 1;
    const norm = normalizeSignalType(s.type);
    normalizedTypeCounts[norm] = (normalizedTypeCounts[norm] ?? 0) + 1;
    severityCounts[s.severity] = (severityCounts[s.severity] ?? 0) + 1;
  }

  return {
    clusters,
    typeCounts,
    normalizedTypeCounts,
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

const THREAT_ESCALATION_TERMS: Record<"critical" | "high" | "medium", string[]> = {
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

  // Coarse grid-based spatial hash (~50km cells) to avoid O(n²) full comparison.
  // Only signals in the same or adjacent cells need haversine checks.
  const cellSizeKm = 50;
  const cellSizeDeg = cellSizeKm / 111; // ~0.45 degrees

  const grid = new Map<string, number[]>();
  for (let i = 0; i < signals.length; i++) {
    const cellX = Math.floor(signals[i]!.lon / cellSizeDeg);
    const cellY = Math.floor(signals[i]!.lat / cellSizeDeg);
    const key = `${cellX},${cellY}`;
    if (!grid.has(key)) grid.set(key, []);
    (grid.get(key) ?? []).push(i);
  }

  // How many adjacent cells to check based on radius vs cell size
  const cellRadius = Math.ceil(radiusKm / cellSizeKm);

  /** Get all signal indices in the same or adjacent grid cells */
  function getNearbyCandidates(sig: GeoSignal): number[] {
    const cx = Math.floor(sig.lon / cellSizeDeg);
    const cy = Math.floor(sig.lat / cellSizeDeg);
    const candidates: number[] = [];
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dy = -cellRadius; dy <= cellRadius; dy++) {
        const nearby = grid.get(`${cx + dx},${cy + dy}`);
        if (nearby) candidates.push(...nearby);
      }
    }
    return candidates;
  }

  for (let i = 0; i < signals.length; i++) {
    if (assigned.has(i)) continue;

    const cluster: Array<{ signal: GeoSignal; index: number; distance: number }> = [
      { signal: signals[i]!, index: i, distance: 0 },
    ];

    // Find all signals within radius using spatial hash
    const candidates = getNearbyCandidates(signals[i]!);
    for (const j of candidates) {
      if (j <= i || assigned.has(j)) continue;
      const dist = haversineKm(signals[i]!.lat, signals[i]!.lon, signals[j]!.lat, signals[j]!.lon);
      if (dist <= radiusKm) {
        cluster.push({ signal: signals[j]!, index: j, distance: dist });
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
    for (let i = 0; i < splitIdx; i++) baselineValues.push(series[i]!.value);
    recentPoints.length = 0;
    for (let i = splitIdx; i < series.length; i++) recentPoints.push(series[i]!);
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

// ── Geopolitical Framework Overlays ──────────────────────────────

/** Grand Chessboard (Brzezinski): Eurasian pivot states get boosted military/geopolitical weights */
const GRAND_CHESSBOARD_COUNTRIES = new Set([
  "ukraine", "georgia", "azerbaijan", "turkey", "iran", "afghanistan",
  "kazakhstan", "uzbekistan", "turkmenistan", "pakistan", "india", "china",
  "russia", "poland", "germany", "france", "japan", "south korea",
]);

/** Prisoners of Geography (Marshall): Geographically constrained nations */
const PRISONERS_OF_GEOGRAPHY_COUNTRIES = new Set([
  "russia", "china", "india", "pakistan", "iran", "turkey", "israel",
  "egypt", "ethiopia", "nigeria", "brazil", "mexico", "japan",
  "south korea", "north korea", "afghanistan", "iraq", "syria",
]);

function applyFrameworkWeights(
  country: string,
  baseWeights: Record<string, number>,
  framework: string,
): Record<string, number> {
  if (framework === "standard") return baseWeights;

  const countryLower = country.toLowerCase();
  const weights = { ...baseWeights };

  if (framework === "grand_chessboard") {
    if (GRAND_CHESSBOARD_COUNTRIES.has(countryLower)) {
      // Boost military and conflict weights for Eurasian pivot states
      weights.militaryActivity = (weights.militaryActivity ?? 0.20) * 1.4;
      weights.conflictEvents = (weights.conflictEvents ?? 0.25) * 1.3;
      weights.cyberThreats = (weights.cyberThreats ?? 0.10) * 1.2;
      // Reduce climate/media weights as less geopolitically relevant
      weights.naturalDisasters = (weights.naturalDisasters ?? 0.05) * 0.7;
      weights.mediaCoverage = (weights.mediaCoverage ?? 0.05) * 0.8;
    }
  } else if (framework === "prisoners_of_geography") {
    if (PRISONERS_OF_GEOGRAPHY_COUNTRIES.has(countryLower)) {
      // Boost infrastructure and climate for geographically constrained nations
      weights.economicStress = (weights.economicStress ?? 0.10) * 1.3;
      weights.naturalDisasters = (weights.naturalDisasters ?? 0.05) * 1.5;
      weights.displacement = (weights.displacement ?? 0.10) * 1.3;
      // Boost conflict for contested border nations
      weights.conflictEvents = (weights.conflictEvents ?? 0.25) * 1.2;
    }
  }

  // Renormalize weights to sum to 1.0
  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  if (total > 0) {
    for (const [key, val] of Object.entries(weights)) {
      weights[key] = round(val / total, 4);
    }
  }

  return weights;
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

// ── Cross-Domain Correlation Patterns ─────────────────────────────

/** Signal types recognized for pattern matching */
const SIGNAL_TYPES = {
  conflict: ["conflict", "attack", "war", "combat", "strike"],
  military: ["military", "troops", "deployment", "exercise", "naval"],
  cyber: ["cyber", "hack", "breach", "malware", "ransomware"],
  infrastructure: ["infrastructure", "pipeline", "cable", "port", "power"],
  economic: ["economic", "market", "trade", "finance", "gdp"],
  climate: ["climate", "earthquake", "flood", "wildfire", "hurricane", "disaster"],
  displacement: ["displacement", "refugee", "migration", "asylum"],
  news: ["news", "media", "press", "report", "coverage"],
  nuclear: ["nuclear", "radiation", "enrichment", "warhead"],
  maritime: ["maritime", "vessel", "shipping", "tanker", "naval"],
  unrest: ["unrest", "protest", "riot", "demonstration", "coup"],
  logistics: ["logistics", "supply", "transport", "cargo"],
} as const;

interface CorrelationSignal {
  type: string;
  source: string;
  title: string;
  description: string;
  severity: string;
  country: string;
  timestamp: string;
  value?: number;
  metadata: Record<string, unknown>;
}

interface PatternMatch {
  pattern: string;
  id: number;
  detected: boolean;
  confidence: number;
  evidence: string[];
  countries: string[];
}

function classifySignalDomain(sig: CorrelationSignal): string[] {
  const text = `${sig.type} ${sig.title} ${sig.description}`.toLowerCase();
  const domains: string[] = [];
  for (const [domain, keywords] of Object.entries(SIGNAL_TYPES)) {
    if (keywords.some(kw => text.includes(kw))) domains.push(domain);
  }
  return domains.length > 0 ? domains : [sig.type.toLowerCase()];
}

function detectCorrelationPatterns(
  signals: CorrelationSignal[],
  windowHours: number,
  minConfidence: number,
): { patterns: PatternMatch[]; summary: { detected: number; total: number; highConfidence: number } } {
  // Filter by time window
  const now = Date.now();
  const cutoff = now - windowHours * 60 * 60 * 1000;
  const filtered = signals.filter(s => {
    if (!s.timestamp) return true;
    const ts = new Date(s.timestamp).getTime();
    return isNaN(ts) || ts >= cutoff;
  });

  // Pre-classify all signals into domains
  const byDomain = new Map<string, CorrelationSignal[]>();
  const byCountry = new Map<string, CorrelationSignal[]>();

  for (const sig of filtered) {
    const domains = classifySignalDomain(sig);
    for (const d of domains) {
      if (!byDomain.has(d)) byDomain.set(d, []);
      (byDomain.get(d) ?? []).push(sig);
    }
    const country = sig.country || "unknown";
    if (!byCountry.has(country)) byCountry.set(country, []);
    (byCountry.get(country) ?? []).push(sig);
  }

  const domainCount = (d: string) => (byDomain.get(d) ?? []).length;
  const domainSeverity = (d: string) => {
    const sigs = byDomain.get(d) ?? [];
    return sigs.reduce((s, sig) => s + (SEVERITY_SCORE[sig.severity] ?? 1), 0);
  };
  const countriesFor = (d: string) => [...new Set((byDomain.get(d) ?? []).map(s => s.country).filter(Boolean))];
  const evidenceFor = (d: string, limit = 3) => (byDomain.get(d) ?? []).map(s => s.title).filter(Boolean).slice(0, limit);

  const patterns: PatternMatch[] = [];

  // Pattern 1: Silent Divergence — market/economic signals without news coverage
  {
    const market = domainCount("economic");
    const news = domainCount("news");
    const detected = market >= 2 && news === 0;
    const confidence = detected ? Math.min(0.9, 0.5 + market * 0.1) : market >= 1 && news === 0 ? 0.3 : 0;
    patterns.push({ pattern: "Silent Divergence", id: 1, detected, confidence: round(confidence, 2),
      evidence: detected ? [`${market} economic signals, 0 news signals`, ...evidenceFor("economic")] : [],
      countries: detected ? countriesFor("economic") : [] });
  }

  // Pattern 2: News Flood — high news volume without market reaction
  {
    const news = domainCount("news");
    const market = domainCount("economic");
    const detected = news >= 5 && market === 0;
    const confidence = detected ? Math.min(0.9, 0.4 + news * 0.05) : 0;
    patterns.push({ pattern: "News Flood", id: 2, detected, confidence: round(confidence, 2),
      evidence: detected ? [`${news} news signals, 0 market signals`, ...evidenceFor("news")] : [],
      countries: detected ? countriesFor("news") : [] });
  }

  // Pattern 3: Conflict Escalation — rising conflict + military in same country
  {
    const conflictCountries = new Set(countriesFor("conflict"));
    const militaryCountries = new Set(countriesFor("military"));
    const overlap = [...conflictCountries].filter(c => militaryCountries.has(c) && c !== "unknown");
    const detected = overlap.length > 0;
    const severity = domainSeverity("conflict") + domainSeverity("military");
    const confidence = detected ? Math.min(0.95, 0.5 + severity * 0.02) : 0;
    patterns.push({ pattern: "Conflict Escalation", id: 3, detected, confidence: round(confidence, 2),
      evidence: detected ? [`Conflict+military overlap in: ${overlap.join(", ")}`, ...evidenceFor("conflict"), ...evidenceFor("military")] : [],
      countries: overlap });
  }

  // Pattern 4: Cyber-Infrastructure — cyber threats coinciding with infrastructure signals
  {
    const cyber = domainCount("cyber");
    const infra = domainCount("infrastructure");
    const detected = cyber >= 1 && infra >= 1;
    const confidence = detected ? Math.min(0.9, 0.4 + (cyber + infra) * 0.08) : 0;
    patterns.push({ pattern: "Cyber-Infrastructure", id: 4, detected, confidence: round(confidence, 2),
      evidence: detected ? [`${cyber} cyber + ${infra} infrastructure signals`, ...evidenceFor("cyber"), ...evidenceFor("infrastructure")] : [],
      countries: detected ? [...new Set([...countriesFor("cyber"), ...countriesFor("infrastructure")])] : [] });
  }

  // Pattern 5: Economic Cascade — economic stress + displacement together
  {
    const econ = domainCount("economic");
    const disp = domainCount("displacement");
    const detected = econ >= 1 && disp >= 1;
    const confidence = detected ? Math.min(0.85, 0.4 + (econ + disp) * 0.1) : 0;
    patterns.push({ pattern: "Economic Cascade", id: 5, detected, confidence: round(confidence, 2),
      evidence: detected ? [`${econ} economic + ${disp} displacement signals`, ...evidenceFor("economic"), ...evidenceFor("displacement")] : [],
      countries: detected ? [...new Set([...countriesFor("economic"), ...countriesFor("displacement")])] : [] });
  }

  // Pattern 6: Climate-Conflict — natural disaster signals near conflict zones
  {
    const climateCountries = new Set(countriesFor("climate"));
    const conflictCountries = new Set(countriesFor("conflict"));
    const overlap = [...climateCountries].filter(c => conflictCountries.has(c) && c !== "unknown");
    const detected = overlap.length > 0;
    const confidence = detected ? Math.min(0.85, 0.5 + overlap.length * 0.1) : 0;
    patterns.push({ pattern: "Climate-Conflict", id: 6, detected, confidence: round(confidence, 2),
      evidence: detected ? [`Climate+conflict overlap in: ${overlap.join(", ")}`, ...evidenceFor("climate"), ...evidenceFor("conflict")] : [],
      countries: overlap });
  }

  // Pattern 7: Military Buildup — military + logistics signals increasing together
  {
    const mil = domainCount("military");
    const log = domainCount("logistics");
    const detected = mil >= 2 && log >= 1;
    const confidence = detected ? Math.min(0.9, 0.45 + (mil + log) * 0.08) : 0;
    patterns.push({ pattern: "Military Buildup", id: 7, detected, confidence: round(confidence, 2),
      evidence: detected ? [`${mil} military + ${log} logistics signals`, ...evidenceFor("military"), ...evidenceFor("logistics")] : [],
      countries: detected ? [...new Set([...countriesFor("military"), ...countriesFor("logistics")])] : [] });
  }

  // Pattern 8: Media Blackout — signals present but no media coverage
  {
    const totalNonNews = filtered.filter(s => !classifySignalDomain(s).includes("news")).length;
    const news = domainCount("news");
    const detected = totalNonNews >= 5 && news === 0;
    const confidence = detected ? Math.min(0.85, 0.4 + totalNonNews * 0.04) : 0;
    patterns.push({ pattern: "Media Blackout", id: 8, detected, confidence: round(confidence, 2),
      evidence: detected ? [`${totalNonNews} signals with 0 media coverage`] : [],
      countries: detected ? [...new Set(filtered.map(s => s.country).filter(Boolean))] : [] });
  }

  // Pattern 9: Humanitarian Crisis — displacement + conflict + climate converging
  {
    const disp = domainCount("displacement");
    const conf = domainCount("conflict");
    const clim = domainCount("climate");
    const detected = disp >= 1 && conf >= 1 && clim >= 1;
    const allCountries = [...new Set([...countriesFor("displacement"), ...countriesFor("conflict"), ...countriesFor("climate")])];
    const confidence = detected ? Math.min(0.95, 0.5 + (disp + conf + clim) * 0.05) : 0;
    patterns.push({ pattern: "Humanitarian Crisis", id: 9, detected, confidence: round(confidence, 2),
      evidence: detected ? [`${disp} displacement + ${conf} conflict + ${clim} climate signals`, ...evidenceFor("displacement")] : [],
      countries: detected ? allCountries : [] });
  }

  // Pattern 10: Supply Chain Stress — infrastructure + economic + maritime signals
  {
    const infra = domainCount("infrastructure");
    const econ = domainCount("economic");
    const mar = domainCount("maritime");
    const present = (infra >= 1 ? 1 : 0) + (econ >= 1 ? 1 : 0) + (mar >= 1 ? 1 : 0);
    const detected = present >= 2;
    const confidence = detected ? Math.min(0.85, 0.35 + present * 0.15 + (infra + econ + mar) * 0.03) : 0;
    patterns.push({ pattern: "Supply Chain Stress", id: 10, detected, confidence: round(confidence, 2),
      evidence: detected ? [`${infra} infra + ${econ} economic + ${mar} maritime signals`] : [],
      countries: detected ? [...new Set([...countriesFor("infrastructure"), ...countriesFor("economic"), ...countriesFor("maritime")])] : [] });
  }

  // Pattern 11: Political Instability — civil unrest + media coverage spike
  {
    const unrest = domainCount("unrest");
    const news = domainCount("news");
    const detected = unrest >= 1 && news >= 2;
    const confidence = detected ? Math.min(0.85, 0.4 + (unrest + news) * 0.07) : 0;
    patterns.push({ pattern: "Political Instability", id: 11, detected, confidence: round(confidence, 2),
      evidence: detected ? [`${unrest} unrest + ${news} media signals`, ...evidenceFor("unrest")] : [],
      countries: detected ? countriesFor("unrest") : [] });
  }

  // Pattern 12: Cross-Border Spillover — same signal type in multiple countries
  {
    const typeCountries = new Map<string, Set<string>>();
    for (const sig of filtered) {
      if (!sig.country || sig.country === "unknown") continue;
      const domains = classifySignalDomain(sig);
      for (const d of domains) {
        if (!typeCountries.has(d)) typeCountries.set(d, new Set());
        (typeCountries.get(d) ?? new Set()).add(sig.country);
      }
    }
    const spillovers: string[] = [];
    const spilloverCountries = new Set<string>();
    for (const [type, countries] of typeCountries) {
      if (countries.size >= 3) {
        spillovers.push(`${type}: ${[...countries].join(", ")}`);
        for (const c of countries) spilloverCountries.add(c);
      }
    }
    const detected = spillovers.length > 0;
    const confidence = detected ? Math.min(0.9, 0.4 + spillovers.length * 0.15) : 0;
    patterns.push({ pattern: "Cross-Border Spillover", id: 12, detected, confidence: round(confidence, 2),
      evidence: detected ? spillovers : [],
      countries: [...spilloverCountries] });
  }

  // Pattern 13: Dual-Use Concern — nuclear/cyber + military signals
  {
    const nuc = domainCount("nuclear");
    const cyber = domainCount("cyber");
    const mil = domainCount("military");
    const dualUse = nuc + cyber;
    const detected = dualUse >= 1 && mil >= 1;
    const confidence = detected ? Math.min(0.9, 0.5 + dualUse * 0.1 + mil * 0.05) : 0;
    patterns.push({ pattern: "Dual-Use Concern", id: 13, detected, confidence: round(confidence, 2),
      evidence: detected ? [`${nuc} nuclear + ${cyber} cyber + ${mil} military signals`, ...evidenceFor("nuclear"), ...evidenceFor("cyber")] : [],
      countries: detected ? [...new Set([...countriesFor("nuclear"), ...countriesFor("cyber"), ...countriesFor("military")])] : [] });
  }

  // Pattern 14: Momentum Shift — severity trend change across signal types
  {
    // Sort by timestamp and check for severity trend reversal
    const withTs = filtered
      .filter(s => s.timestamp)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const halfIdx = Math.floor(withTs.length / 2);
    const firstHalf = withTs.slice(0, halfIdx);
    const secondHalf = withTs.slice(halfIdx);
    const avgFirst = firstHalf.length > 0 ? firstHalf.reduce((s, sig) => s + (SEVERITY_SCORE[sig.severity] ?? 1), 0) / firstHalf.length : 0;
    const avgSecond = secondHalf.length > 0 ? secondHalf.reduce((s, sig) => s + (SEVERITY_SCORE[sig.severity] ?? 1), 0) / secondHalf.length : 0;
    const shift = avgSecond - avgFirst;
    const detected = Math.abs(shift) >= 1 && withTs.length >= 4;
    const confidence = detected ? Math.min(0.8, 0.3 + Math.abs(shift) * 0.15) : 0;
    const direction = shift > 0 ? "escalating" : "de-escalating";
    patterns.push({ pattern: "Momentum Shift", id: 14, detected, confidence: round(confidence, 2),
      evidence: detected ? [`Severity trend ${direction}: ${round(avgFirst, 1)} → ${round(avgSecond, 1)}`] : [],
      countries: detected ? [...new Set(withTs.map(s => s.country).filter(Boolean))] : [] });
  }

  // Filter by minConfidence
  const detectedPatterns = patterns.filter(p => p.detected && p.confidence >= minConfidence);

  return {
    patterns: detectedPatterns,
    summary: {
      detected: detectedPatterns.length,
      total: 14,
      highConfidence: detectedPatterns.filter(p => p.confidence >= 0.7).length,
    },
  };
}

// ── Skill Dispatcher ─────────────────────────────────────────────

// ── Live Cyber Threat Feeds ───────────────────────────────────────

async function fetchFeodoC2(limit: number): Promise<Record<string, unknown>> {
  const url = "https://feodotracker.abuse.ch/downloads/ipblocklist_aggressive.csv";
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { "User-Agent": UA_SIGNAL } });
  if (!res.ok) throw new Error(`Feodo Tracker HTTP ${res.status}: ${res.statusText}`);
  const text = await res.text();
  const lines = text.split("\n").filter(l => l && !l.startsWith("#"));

  const entries: Array<{ ip: string; port?: number; status?: string; firstSeen?: string }> = [];
  for (const line of lines.slice(0, limit)) {
    const parts = line.split(",").map(s => s.trim());
    if (parts[0]) {
      entries.push({
        ip: parts[0],
        port: parts[1] ? parseInt(parts[1], 10) : undefined,
        status: parts[2] || undefined,
        firstSeen: parts[3] || undefined,
      });
    }
  }

  return {
    source: "feodo_tracker",
    description: "Active botnet C2 servers (Feodo Tracker)",
    totalEntries: entries.length,
    entries,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchUrlhaus(limit: number): Promise<Record<string, unknown>> {
  const url = "https://urlhaus-api.abuse.ch/v1/urls/recent/";
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { "User-Agent": UA_SIGNAL, "Content-Type": "application/x-www-form-urlencoded" },
    body: `limit=${limit}`,
  });
  if (!res.ok) throw new Error(`URLhaus HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json() as any;
  const urls = (data?.urls ?? []).slice(0, limit);

  const entries = urls.map((u: any) => ({
    url: u.url ?? "",
    urlStatus: u.url_status ?? "",
    threat: u.threat ?? "",
    tags: u.tags ?? [],
    dateAdded: u.date_added ?? "",
    reporter: u.reporter ?? "",
  }));

  const threatCounts: Record<string, number> = {};
  for (const e of entries) {
    if (e.threat) threatCounts[e.threat] = (threatCounts[e.threat] ?? 0) + 1;
  }

  return {
    source: "urlhaus",
    description: "Recent malicious URLs (URLhaus)",
    totalEntries: entries.length,
    threatBreakdown: threatCounts,
    entries,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchIodaOutages(country?: string, days: number = 7): Promise<Record<string, unknown>> {
  // IODA API for internet outage detection
  const until = Math.floor(Date.now() / 1000);
  const from = until - days * 86400;
  let url = `https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/country?from=${from}&until=${until}`;
  if (country) url += `&entityCode=${encodeURIComponent(country.toUpperCase())}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { "User-Agent": UA_SIGNAL } });
    if (!res.ok) throw new Error(`IODA HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json() as any;

    const signals = Array.isArray(data?.data) ? data.data : [];
    const entries = signals.slice(0, 50).map((s: any) => ({
      entityType: s.entityType ?? "",
      entityCode: s.entityCode ?? "",
      entityName: s.entityName ?? "",
      datasource: s.datasource ?? "",
      from: s.from ? new Date(s.from * 1000).toISOString() : "",
      until: s.until ? new Date(s.until * 1000).toISOString() : "",
      level: s.level ?? "",
    }));

    return {
      source: "ioda",
      description: "Internet outage signals (IODA)",
      country: country ?? "global",
      days,
      totalEntries: entries.length,
      entries,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    // IODA API may be unreliable; return graceful degradation
    process.stderr.write(`[${NAME}] fetch_outages: IODA request failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return {
      source: "ioda",
      description: "Internet outage signals (IODA)",
      error: err instanceof Error ? err.message : String(err),
      country: country ?? "global",
      days,
      totalEntries: 0,
      entries: [],
      fetchedAt: new Date().toISOString(),
    };
  }
}

async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string> {
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
      const { country, indicators, weights, framework } = SignalSchemas.instability_index.parse(args);
      const adjustedWeights = applyFrameworkWeights(country, weights, framework);
      const result = computeInstabilityIndex(country, indicators, adjustedWeights);
      return safeStringify({ ...result, framework }, 2);
    }

    case "fetch_cyber_c2": {
      const { limit } = SignalSchemas.fetch_cyber_c2.parse(args);
      const c2Data = await fetchFeodoC2(limit);
      return safeStringify(c2Data, 2);
    }

    case "fetch_malicious_urls": {
      const { limit } = SignalSchemas.fetch_malicious_urls.parse(args);
      const urlData = await fetchUrlhaus(limit);
      return safeStringify(urlData, 2);
    }

    case "fetch_outages": {
      const { country, days } = SignalSchemas.fetch_outages.parse(args);
      const outageData = await fetchIodaOutages(country, days);
      return safeStringify(outageData, 2);
    }

    case "correlate_signals": {
      const { signals, windowHours, minConfidence } = SignalSchemas.correlate_signals.parse(args);
      const result = detectCorrelationPatterns(signals, windowHours, minConfidence);
      return safeStringify({
        totalSignals: signals.length,
        ...result,
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
  const sid = skillId ?? "aggregate_signals";

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
