/**
 * Monitor Worker Agent — geopolitical monitoring, conflict tracking, military surge
 * detection, data freshness monitoring, and theater posture assessment.
 *
 * Port: 8092
 *
 * Inspired by World Monitor's military-surge, data-freshness, military-vessels,
 * and theater posture modules.
 *
 * Skills:
 *   track_conflicts    — Track and score active conflicts with casualty/displacement data
 *   detect_surge       — Detect military activity surges via baseline-comparative analysis
 *   theater_posture    — Assess regional theater posture from multi-source activity data
 *   track_vessels      — Track and classify naval vessels by MMSI patterns and behavior
 *   check_freshness    — Monitor data source freshness and detect stale/missing feeds
 *   watchlist_check    — Check entities against configurable watchlists
 *   remember/recall    — Shared persistent memory
 */

import Fastify from "fastify";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { buildA2AResponse, buildA2AError, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { round, haversineKm } from "../worker-utils.js";

const PORT = 8092;
const NAME = "monitor-agent";
const FETCH_TIMEOUT = 20_000;
const UA = "A2A-Monitor-Agent/1.0";
const MAX_OPENSKY_STATES = 10_000;

// ── Zod Schemas ──────────────────────────────────────────────────

const MonitorSchemas = {
  track_conflicts: z.looseObject({
    conflicts: z.array(z.object({
      name: z.string(),
      region: z.string().optional().default(""),
      country: z.string().optional().default(""),
      parties: z.array(z.string()).optional().default([]),
      startDate: z.string().optional().default(""),
      status: z.enum(["active", "ceasefire", "frozen", "escalating", "de-escalating"]).optional().default("active"),
      casualties: z.number().optional().default(0),
      displaced: z.number().optional().default(0),
      events: z.array(z.object({
        date: z.string(),
        type: z.string(),
        description: z.string().optional().default(""),
        severity: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
      })).optional().default([]),
    })).min(1),
  }),

  detect_surge: z.looseObject({
    activities: z.array(z.object({
      theater: z.string(),
      type: z.enum(["transport", "fighter", "bomber", "tanker", "recon", "naval", "ground", "cyber", "other"]).optional().default("other"),
      count: z.number().int().nonnegative(),
      timestamp: z.string(),
      operator: z.string().optional().default(""),
      lat: z.number().optional(),
      lon: z.number().optional(),
    })).min(1),
    baselineHours: z.number().positive().optional().default(48),
    surgeMultiplier: z.number().positive().optional().default(2),
    minCount: z.number().int().positive().optional().default(5),
  }),

  theater_posture: z.looseObject({
    theater: z.string(),
    activities: z.object({
      airSorties: z.number().optional().default(0),
      navalMovements: z.number().optional().default(0),
      groundDeployments: z.number().optional().default(0),
      cyberIncidents: z.number().optional().default(0),
      reconFlights: z.number().optional().default(0),
      logisticsMovements: z.number().optional().default(0),
    }),
    baseline: z.object({
      airSorties: z.number().optional().default(0),
      navalMovements: z.number().optional().default(0),
      groundDeployments: z.number().optional().default(0),
      cyberIncidents: z.number().optional().default(0),
      reconFlights: z.number().optional().default(0),
      logisticsMovements: z.number().optional().default(0),
    }).optional(),
    foreignOperators: z.array(z.object({
      operator: z.string(),
      count: z.number(),
      isNative: z.boolean().optional().default(true),
    })).optional().default([]),
    conflictProximity: z.boolean().optional().default(false),
  }),

  track_vessels: z.looseObject({
    vessels: z.array(z.object({
      mmsi: z.string(),
      name: z.string().optional().default(""),
      shipType: z.number().optional().default(0),
      lat: z.number(),
      lon: z.number(),
      speed: z.number().optional().default(0),
      course: z.number().optional().default(0),
      timestamp: z.string().optional().default(""),
      destination: z.string().optional().default(""),
    })).min(1),
    darkShipThresholdMin: z.number().positive().optional().default(60),
    clusterRadiusKm: z.number().positive().optional().default(20),
  }),

  check_freshness: z.looseObject({
    sources: z.array(z.object({
      name: z.string(),
      lastUpdate: z.string(),
      essential: z.boolean().optional().default(false),
      expectedIntervalMin: z.number().positive().optional().default(60),
    })).min(1),
    freshThresholdMin: z.number().positive().optional().default(15),
    staleThresholdMin: z.number().positive().optional().default(120),
    veryStaleThresholdMin: z.number().positive().optional().default(360),
  }),

  watchlist_check: z.looseObject({
    entities: z.array(z.string()).min(1),
    watchlists: z.record(z.array(z.string())).optional().default({}),
    fuzzyMatch: z.boolean().optional().default(true),
  }),

  // ── Live Data Ingestion Skills ──────────────────────────────────
  fetch_conflicts: z.looseObject({
    source: z.enum(["acled", "gdelt"]).optional().default("gdelt"),
    region: z.string().optional(),
    country: z.string().optional(),
    days: z.number().int().positive().optional().default(30),
    limit: z.number().int().positive().optional().default(100),
  }),

  fetch_flights: z.looseObject({
    /** Bounding box: min lat, max lat, min lon, max lon */
    lamin: z.number().optional(),
    lamax: z.number().optional(),
    lomin: z.number().optional(),
    lomax: z.number().optional(),
    /** Filter military aircraft only */
    militaryOnly: z.boolean().optional().default(false),
  }),
};

// ── Agent Card ───────────────────────────────────────────────────

const AGENT_CARD = {
  name: NAME,
  description: "Monitor agent — conflict tracking, military surge detection, theater posture assessment, naval vessel tracking, data freshness monitoring, and watchlist screening",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "track_conflicts", name: "Track Conflicts", description: "Track and score active conflicts with event timelines, casualties, and displacement data" },
    { id: "detect_surge", name: "Detect Surge", description: "Detect military activity surges by comparing current counts against rolling baseline per theater" },
    { id: "theater_posture", name: "Theater Posture", description: "Assess regional theater posture from air/naval/ground/cyber activity with foreign operator detection" },
    { id: "track_vessels", name: "Track Vessels", description: "Classify naval vessels by MMSI, detect dark ships, and identify vessel clusters" },
    { id: "check_freshness", name: "Check Freshness", description: "Monitor data source freshness: fresh, stale, very_stale, no_data status with essential source alerts" },
    { id: "watchlist_check", name: "Watchlist Check", description: "Screen entities against configurable watchlists with optional fuzzy matching" },
    { id: "fetch_conflicts", name: "Fetch Conflicts", description: "Fetch live conflict data from GDELT or ACLED APIs with region/country filtering" },
    { id: "fetch_flights", name: "Fetch Flights", description: "Fetch live ADS-B flight data from OpenSky Network with bounding box and military filtering" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────

// round() and haversineKm() imported from ../worker-utils.js

// ── Conflict Tracking ────────────────────────────────────────────

interface Conflict {
  name: string;
  region: string;
  country: string;
  parties: string[];
  startDate: string;
  status: string;
  casualties: number;
  displaced: number;
  events: Array<{ date: string; type: string; description: string; severity: string }>;
}

const SEVERITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

interface ConflictScore {
  name: string;
  region: string;
  country: string;
  status: string;
  intensityScore: number;
  escalationTrend: string;
  recentEvents: number;
  casualties: number;
  displaced: number;
  parties: string[];
  topEvents: Array<{ date: string; type: string; severity: string }>;
}

function scoreConflicts(conflicts: Conflict[]): ConflictScore[] {
  return conflicts.map(c => {
    // Intensity score based on event severity, casualties, displacement
    let eventScore = 0;
    const now = Date.now();
    const recentCutoff = now - 7 * 24 * 60 * 60 * 1000; // 7 days
    let recentCount = 0;
    let olderCount = 0;

    for (const e of c.events) {
      const w = SEVERITY_WEIGHT[e.severity] ?? 1;
      eventScore += w;
      const ts = new Date(e.date).getTime();
      if (!isNaN(ts) && ts >= recentCutoff) recentCount++;
      else olderCount++;
    }

    // Casualty/displacement contribution (log dampened)
    const casualtyScore = c.casualties > 0 ? Math.log10(c.casualties + 1) * 5 : 0;
    const displacementScore = c.displaced > 0 ? Math.log10(c.displaced + 1) * 3 : 0;

    // Status multiplier
    const statusMult: Record<string, number> = { escalating: 1.5, active: 1.0, ceasefire: 0.5, "de-escalating": 0.4, frozen: 0.3 };
    const mult = statusMult[c.status] ?? 1;

    const intensityScore = round((eventScore + casualtyScore + displacementScore) * mult, 1);

    // Escalation trend
    let escalationTrend = "stable";
    if (recentCount > olderCount * 1.5 && recentCount >= 2) escalationTrend = "escalating";
    else if (olderCount > recentCount * 2) escalationTrend = "de-escalating";

    // Top events sorted by severity
    const topEvents = [...c.events]
      .sort((a, b) => (SEVERITY_WEIGHT[b.severity] ?? 1) - (SEVERITY_WEIGHT[a.severity] ?? 1))
      .slice(0, 5)
      .map(e => ({ date: e.date, type: e.type, severity: e.severity }));

    return {
      name: c.name,
      region: c.region,
      country: c.country,
      status: c.status,
      intensityScore,
      escalationTrend,
      recentEvents: recentCount,
      casualties: c.casualties,
      displaced: c.displaced,
      parties: c.parties,
      topEvents,
    };
  }).sort((a, b) => b.intensityScore - a.intensityScore);
}

// ── Surge Detection ──────────────────────────────────────────────

interface Activity {
  theater: string;
  type: string;
  count: number;
  timestamp: string;
  operator: string;
  lat?: number;
  lon?: number;
}

interface SurgeAlert {
  theater: string;
  type: string;
  currentCount: number;
  baselineAvg: number;
  multiplier: number;
  surgeDetected: boolean;
  foreignOperators: string[];
}

interface ProximityCluster {
  centroidLat: number;
  centroidLon: number;
  radiusKm: number;
  theater: string;
  types: string[];
  totalCount: number;
  activities: Array<{ type: string; count: number; operator: string; distanceKm: number }>;
}

function detectSurges(
  activities: Activity[],
  baselineHours: number,
  surgeMultiplier: number,
  minCount: number,
): { alerts: SurgeAlert[]; theaterSummary: Record<string, { totalActivity: number; surgeCount: number }>; proximityCorrelations: ProximityCluster[] } {
  const now = Date.now();
  const baselineCutoff = now - baselineHours * 60 * 60 * 1000;
  const recentCutoff = now - (baselineHours / 4) * 60 * 60 * 1000;

  // Group by theater + type
  const groups = new Map<string, { baseline: number[]; recent: number[]; foreignOps: Set<string> }>();

  for (const a of activities) {
    const key = `${a.theater}::${a.type}`;
    if (!groups.has(key)) groups.set(key, { baseline: [], recent: [], foreignOps: new Set() });
    const g = groups.get(key)!;

    const ts = new Date(a.timestamp).getTime();
    if (!isNaN(ts) && ts >= recentCutoff) {
      g.recent.push(a.count);
    } else if (!isNaN(ts) && ts >= baselineCutoff) {
      g.baseline.push(a.count);
    } else {
      g.baseline.push(a.count);
    }

    if (a.operator) g.foreignOps.add(a.operator);
  }

  const alerts: SurgeAlert[] = [];
  const theaterSummary: Record<string, { totalActivity: number; surgeCount: number }> = {};

  for (const [key, g] of groups) {
    const [theater, type] = key.split("::");
    const recentSum = g.recent.reduce((a, b) => a + b, 0);
    const baselineAvg = g.baseline.length > 0
      ? g.baseline.reduce((a, b) => a + b, 0) / g.baseline.length
      : 0;

    const effectiveBaseline = Math.max(baselineAvg, 1);
    const multiplier = recentSum / effectiveBaseline;
    const surgeDetected = multiplier >= surgeMultiplier && recentSum >= minCount;

    alerts.push({
      theater,
      type,
      currentCount: recentSum,
      baselineAvg: round(baselineAvg, 2),
      multiplier: round(multiplier, 2),
      surgeDetected,
      foreignOperators: [...g.foreignOps],
    });

    if (!theaterSummary[theater]) theaterSummary[theater] = { totalActivity: 0, surgeCount: 0 };
    theaterSummary[theater].totalActivity += recentSum;
    if (surgeDetected) theaterSummary[theater].surgeCount++;
  }

  // Sort: surges first, then by multiplier
  alerts.sort((a, b) => {
    if (a.surgeDetected !== b.surgeDetected) return a.surgeDetected ? -1 : 1;
    return b.multiplier - a.multiplier;
  });

  // ── Proximity Correlation (Haversine 150km) ──────────────────
  // Cluster geographically close activities across types
  const PROXIMITY_KM = 150;
  const geoActivities = activities.filter(a => a.lat !== undefined && a.lon !== undefined);
  const assigned = new Set<number>();
  const proxClusters: ProximityCluster[] = [];

  for (let i = 0; i < geoActivities.length; i++) {
    if (assigned.has(i)) continue;
    const cluster: Array<{ activity: Activity; index: number; distance: number }> = [
      { activity: geoActivities[i], index: i, distance: 0 },
    ];
    assigned.add(i);

    for (let j = i + 1; j < geoActivities.length; j++) {
      if (assigned.has(j)) continue;
      const dist = haversineKm(
        geoActivities[i].lat!, geoActivities[i].lon!,
        geoActivities[j].lat!, geoActivities[j].lon!,
      );
      if (dist <= PROXIMITY_KM) {
        cluster.push({ activity: geoActivities[j], index: j, distance: dist });
        assigned.add(j);
      }
    }

    // Only report clusters with multiple activity types (cross-type correlation)
    const types = new Set(cluster.map(c => c.activity.type));
    if (types.size >= 2) {
      const centroidLat = round(cluster.reduce((s, c) => s + c.activity.lat!, 0) / cluster.length);
      const centroidLon = round(cluster.reduce((s, c) => s + c.activity.lon!, 0) / cluster.length);
      const maxDist = Math.max(...cluster.map(c => c.distance), 0);

      proxClusters.push({
        centroidLat,
        centroidLon,
        radiusKm: round(maxDist || PROXIMITY_KM, 1),
        theater: geoActivities[i].theater,
        types: [...types],
        totalCount: cluster.reduce((s, c) => s + c.activity.count, 0),
        activities: cluster.map(c => ({
          type: c.activity.type,
          count: c.activity.count,
          operator: c.activity.operator,
          distanceKm: round(c.distance, 1),
        })),
      });
    }
  }

  proxClusters.sort((a, b) => b.totalCount - a.totalCount);

  return { alerts, theaterSummary, proximityCorrelations: proxClusters };
}

// ── Theater Posture Assessment ───────────────────────────────────

interface PostureAssessment {
  theater: string;
  posture: string;
  score: number;
  breakdown: Record<string, { current: number; baseline: number; ratio: number }>;
  foreignPresence: { detected: boolean; operators: Array<{ operator: string; count: number; isNative: boolean }> };
  alerts: string[];
}

function assessTheaterPosture(
  theater: string,
  activities: Record<string, number>,
  baseline: Record<string, number> | undefined,
  foreignOperators: Array<{ operator: string; count: number; isNative: boolean }>,
  conflictProximity: boolean,
): PostureAssessment {
  const defaultBaseline: Record<string, number> = {
    airSorties: 10, navalMovements: 5, groundDeployments: 3,
    cyberIncidents: 2, reconFlights: 2, logisticsMovements: 5,
  };
  const base = baseline ?? defaultBaseline;

  const breakdown: Record<string, { current: number; baseline: number; ratio: number }> = {};
  let totalRatio = 0;
  let categoryCount = 0;

  for (const [key, current] of Object.entries(activities)) {
    const bl = (base as Record<string, number>)[key] ?? 1;
    const ratio = bl > 0 ? current / bl : current;
    breakdown[key] = { current, baseline: bl, ratio: round(ratio, 2) };
    totalRatio += ratio;
    categoryCount++;
  }

  const avgRatio = categoryCount > 0 ? totalRatio / categoryCount : 0;

  // Foreign operator analysis
  const foreignNonNative = foreignOperators.filter(o => !o.isNative);
  const foreignPresence = {
    detected: foreignNonNative.length > 0,
    operators: foreignOperators,
  };

  // Score: 0-100
  let score = Math.min(100, avgRatio * 20);
  if (foreignNonNative.length > 0) score = Math.min(100, score + foreignNonNative.length * 5);
  if (conflictProximity) score = Math.min(100, score * 1.3);
  score = round(score, 1);

  // Posture level
  let posture: string;
  if (score >= 80) posture = "critical";
  else if (score >= 60) posture = "elevated";
  else if (score >= 40) posture = "heightened";
  else if (score >= 20) posture = "guarded";
  else posture = "normal";

  // Generate alerts
  const alerts: string[] = [];
  for (const [key, data] of Object.entries(breakdown)) {
    if (data.ratio >= 3) alerts.push(`${key}: ${data.ratio}x above baseline`);
  }
  if (foreignNonNative.length > 0) {
    alerts.push(`Foreign operators detected: ${foreignNonNative.map(o => `${o.operator}(${o.count})`).join(", ")}`);
  }
  if (conflictProximity) alerts.push("Theater is in proximity to active conflict zone");

  return { theater, posture, score, breakdown, foreignPresence, alerts };
}

// ── Vessel Tracking ──────────────────────────────────────────────

/** MMSI Maritime Identification Digit ranges for naval vessels */
const NAVAL_MID_PREFIXES = [
  { prefix: "111", operator: "US Navy" },
  { prefix: "211", operator: "German Navy" },
  { prefix: "226", operator: "French Navy" },
  { prefix: "232", operator: "Royal Navy" },
  { prefix: "273", operator: "Russian Navy" },
  { prefix: "412", operator: "PLA Navy" },
  { prefix: "431", operator: "JMSDF" },
  { prefix: "440", operator: "ROK Navy" },
  { prefix: "503", operator: "Australian Navy" },
  { prefix: "316", operator: "Royal Canadian Navy" },
];

/** AIS ship type codes indicating military/government */
const MILITARY_SHIP_TYPES = new Set([35, 50, 51, 52, 53, 54, 55]);

interface Vessel {
  mmsi: string;
  name: string;
  shipType: number;
  lat: number;
  lon: number;
  speed: number;
  course: number;
  timestamp: string;
  destination: string;
}

interface VesselAnalysis {
  mmsi: string;
  name: string;
  classification: string;
  operator: string;
  isMilitary: boolean;
  isDark: boolean;
  speed: number;
  position: { lat: number; lon: number };
  clusterId: number;
}

function analyzeVessels(
  vessels: Vessel[],
  darkThresholdMin: number,
  clusterRadiusKm: number,
): { vessels: VesselAnalysis[]; clusters: Array<{ id: number; center: { lat: number; lon: number }; vesselCount: number; militaryCount: number }>; darkShips: number; militaryVessels: number } {
  const now = Date.now();

  // Classify each vessel
  const analyzed: VesselAnalysis[] = vessels.map(v => {
    // Check MMSI prefix for navy
    let operator = "";
    let isMilitary = false;
    for (const np of NAVAL_MID_PREFIXES) {
      if (v.mmsi.startsWith(np.prefix)) {
        operator = np.operator;
        isMilitary = true;
        break;
      }
    }
    if (!isMilitary && MILITARY_SHIP_TYPES.has(v.shipType)) {
      isMilitary = true;
      operator = "military/government";
    }

    // Dark ship detection
    const ts = v.timestamp ? new Date(v.timestamp).getTime() : 0;
    const silenceMin = ts > 0 ? (now - ts) / 60000 : 0;
    const isDark = silenceMin >= darkThresholdMin;

    // Classification
    let classification = "commercial";
    if (isMilitary) classification = "military";
    else if (isDark) classification = "dark";
    else if (v.shipType >= 70 && v.shipType <= 79) classification = "cargo";
    else if (v.shipType >= 80 && v.shipType <= 89) classification = "tanker";
    else if (v.shipType >= 60 && v.shipType <= 69) classification = "passenger";
    else if (v.shipType >= 30 && v.shipType <= 39) classification = "fishing";

    return {
      mmsi: v.mmsi,
      name: v.name,
      classification,
      operator,
      isMilitary,
      isDark,
      speed: v.speed,
      position: { lat: v.lat, lon: v.lon },
      clusterId: -1,
    };
  });

  // Cluster vessels by proximity
  const assigned = new Set<number>();
  const clusters: Array<{ id: number; center: { lat: number; lon: number }; vesselCount: number; militaryCount: number }> = [];

  for (let i = 0; i < analyzed.length; i++) {
    if (assigned.has(i)) continue;
    const members = [i];
    assigned.add(i);

    for (let j = i + 1; j < analyzed.length; j++) {
      if (assigned.has(j)) continue;
      const dist = haversineKm(
        analyzed[i].position.lat, analyzed[i].position.lon,
        analyzed[j].position.lat, analyzed[j].position.lon,
      );
      if (dist <= clusterRadiusKm) {
        members.push(j);
        assigned.add(j);
      }
    }

    if (members.length >= 2) {
      const cid = clusters.length;
      const centerLat = round(members.reduce((s, m) => s + analyzed[m].position.lat, 0) / members.length, 4);
      const centerLon = round(members.reduce((s, m) => s + analyzed[m].position.lon, 0) / members.length, 4);
      const militaryCount = members.filter(m => analyzed[m].isMilitary).length;

      for (const m of members) analyzed[m].clusterId = cid;
      clusters.push({ id: cid, center: { lat: centerLat, lon: centerLon }, vesselCount: members.length, militaryCount });
    }
  }

  return {
    vessels: analyzed,
    clusters: clusters.sort((a, b) => b.militaryCount - a.militaryCount),
    darkShips: analyzed.filter(v => v.isDark).length,
    militaryVessels: analyzed.filter(v => v.isMilitary).length,
  };
}

// ── Data Freshness Monitoring ────────────────────────────────────

interface SourceFreshness {
  name: string;
  status: string;
  lastUpdate: string;
  ageMin: number;
  essential: boolean;
  expectedIntervalMin: number;
}

function checkFreshness(
  sources: Array<{ name: string; lastUpdate: string; essential: boolean; expectedIntervalMin: number }>,
  freshMin: number,
  staleMin: number,
  veryStaleMin: number,
): { sources: SourceFreshness[]; summary: { fresh: number; stale: number; veryStale: number; noData: number; essentialDown: string[] } } {
  const now = Date.now();
  const result: SourceFreshness[] = [];
  let freshCount = 0, staleCount = 0, veryStaleCount = 0, noDataCount = 0;
  const essentialDown: string[] = [];

  for (const s of sources) {
    const ts = new Date(s.lastUpdate).getTime();
    let status: string;
    let ageMin = 0;

    if (isNaN(ts) || ts <= 0) {
      status = "no_data";
      noDataCount++;
      if (s.essential) essentialDown.push(s.name);
    } else {
      ageMin = round((now - ts) / 60000, 1);
      if (ageMin <= freshMin) {
        status = "fresh";
        freshCount++;
      } else if (ageMin <= staleMin) {
        status = "stale";
        staleCount++;
        if (s.essential) essentialDown.push(s.name);
      } else if (ageMin <= veryStaleMin) {
        status = "very_stale";
        veryStaleCount++;
        if (s.essential) essentialDown.push(s.name);
      } else {
        status = "no_data";
        noDataCount++;
        if (s.essential) essentialDown.push(s.name);
      }
    }

    result.push({
      name: s.name,
      status,
      lastUpdate: s.lastUpdate,
      ageMin,
      essential: s.essential,
      expectedIntervalMin: s.expectedIntervalMin,
    });
  }

  // Sort: essential first, then by staleness
  const statusOrder: Record<string, number> = { no_data: 0, very_stale: 1, stale: 2, fresh: 3 };
  result.sort((a, b) => {
    if (a.essential !== b.essential) return a.essential ? -1 : 1;
    return (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4);
  });

  return {
    sources: result,
    summary: { fresh: freshCount, stale: staleCount, veryStale: veryStaleCount, noData: noDataCount, essentialDown },
  };
}

// ── Watchlist Screening ──────────────────────────────────────────

function normalizeEntity(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function fuzzyContains(haystack: string, needle: string): boolean {
  const h = normalizeEntity(haystack);
  const n = normalizeEntity(needle);
  if (!n) return false; // empty needle would trivially match everything via includes("")
  if (h.includes(n) || n.includes(h)) return true;
  // Simple token overlap check
  const hTokens = new Set(h.split(" "));
  const nTokens = n.split(" ").filter(t => t.length > 0);
  if (nTokens.length === 0) return false;
  const overlap = nTokens.filter(t => hTokens.has(t)).length;
  return overlap >= Math.ceil(nTokens.length * 0.7);
}

interface WatchlistHit {
  entity: string;
  watchlist: string;
  matchedEntry: string;
  matchType: string;
}

function screenWatchlists(
  entities: string[],
  watchlists: Record<string, string[]>,
  fuzzyMatch: boolean,
): { hits: WatchlistHit[]; cleanEntities: string[]; hitCount: number } {
  const hits: WatchlistHit[] = [];
  const hitEntities = new Set<string>();

  for (const entity of entities) {
    for (const [listName, entries] of Object.entries(watchlists)) {
      for (const entry of entries) {
        let matched = false;
        let matchType = "";

        if (normalizeEntity(entity) === normalizeEntity(entry)) {
          matched = true;
          matchType = "exact";
        } else if (fuzzyMatch && fuzzyContains(entity, entry)) {
          matched = true;
          matchType = "fuzzy";
        }

        if (matched) {
          hits.push({ entity, watchlist: listName, matchedEntry: entry, matchType });
          hitEntities.add(entity);
        }
      }
    }
  }

  const cleanEntities = entities.filter(e => !hitEntities.has(e));
  return { hits, cleanEntities, hitCount: hits.length };
}

// ── Live Conflict Data (GDELT / ACLED) ──────────────────────────

async function fetchGdeltConflicts(region?: string, country?: string, days: number = 30, limit: number = 100): Promise<Conflict[]> {
  const query = country ?? region ?? "conflict";
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}%20sourcelang:eng&mode=ArtList&maxrecords=${limit}&format=json&timespan=${days}d`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json() as any;
  const articles = data?.articles ?? [];

  // Group by domain/title keyword → synthesize conflicts
  const conflictMap = new Map<string, Conflict>();
  for (const art of articles) {
    const title = (art.title ?? "").slice(0, 100);
    const source = art.domain ?? "unknown";
    const dateStr = art.seendate ?? new Date().toISOString();
    // Extract country from URL or title
    const artCountry = country ?? (art.sourcecountry ?? "").slice(0, 50);

    let severity: "critical" | "high" | "medium" | "low" = "medium";
    const lowerTitle = title.toLowerCase();
    if (/kill|dead|bomb|strike|attack|massacre/i.test(lowerTitle)) severity = "critical";
    else if (/escalat|troops|deploy|missile|offensive/i.test(lowerTitle)) severity = "high";
    else if (/tension|sanction|threat|warning/i.test(lowerTitle)) severity = "medium";
    else severity = "low";

    const key = artCountry || title.split(/\s+/).slice(0, 3).join(" ");
    if (!conflictMap.has(key)) {
      conflictMap.set(key, {
        name: key,
        region: region ?? "",
        country: artCountry,
        parties: [],
        startDate: dateStr,
        status: "active",
        casualties: 0,
        displaced: 0,
        events: [],
      });
    }
    conflictMap.get(key)!.events.push({
      date: dateStr,
      type: source,
      description: title,
      severity,
    });
  }

  return [...conflictMap.values()].slice(0, limit);
}

async function fetchAcledConflicts(region?: string, country?: string, days: number = 30, limit: number = 100): Promise<Conflict[]> {
  const apiKey = process.env.ACLED_API_KEY;
  const email = process.env.ACLED_EMAIL;
  if (!apiKey || !email) {
    process.stderr.write(`[${NAME}] ACLED requires ACLED_API_KEY and ACLED_EMAIL env vars. Falling back to GDELT.\n`);
    return fetchGdeltConflicts(region, country, days, limit);
  }

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let url = `https://api.acleddata.com/acled/read?key=${apiKey}&email=${encodeURIComponent(email)}&event_date=${since}|&event_date_where=BETWEEN&limit=${limit}`;
  if (country) url += `&country=${encodeURIComponent(country)}`;
  if (region) url += `&region_name=${encodeURIComponent(region)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`ACLED HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json() as any;
  const events = data?.data ?? [];

  const conflictMap = new Map<string, Conflict>();
  for (const ev of events) {
    const key = ev.country ?? "Unknown";
    if (!conflictMap.has(key)) {
      conflictMap.set(key, {
        name: ev.event_type ?? key,
        region: ev.region ?? "",
        country: ev.country ?? "",
        parties: [ev.actor1 ?? "", ev.actor2 ?? ""].filter(Boolean),
        startDate: ev.event_date ?? "",
        status: "active",
        casualties: ev.fatalities ?? 0,
        displaced: 0,
        events: [],
      });
    }
    const c = conflictMap.get(key)!;
    c.casualties += ev.fatalities ?? 0;
    const severity = (ev.fatalities ?? 0) > 10 ? "critical" : (ev.fatalities ?? 0) > 0 ? "high" : "medium";
    c.events.push({
      date: ev.event_date ?? "",
      type: ev.event_type ?? "",
      description: ev.notes ?? "",
      severity,
    });
  }

  return [...conflictMap.values()];
}

// ── Live ADS-B Flight Tracking (OpenSky Network) ────────────────

/** ICAO24 hex address prefixes for known military operators */
const MILITARY_ICAO_PREFIXES: Array<{ prefix: string; operator: string }> = [
  { prefix: "ae", operator: "US Military" },
  { prefix: "af", operator: "US Military" },
  { prefix: "43c", operator: "UK Military" },
  { prefix: "3f", operator: "German Military" },
  { prefix: "3e8", operator: "French Military" },
  { prefix: "300", operator: "French Military" },
  { prefix: "500", operator: "Australian Military" },
  { prefix: "c0", operator: "Canadian Military" },
  { prefix: "7c", operator: "Australian Military" },
];

interface FlightState {
  icao24: string;
  callsign: string;
  originCountry: string;
  lat: number;
  lon: number;
  altitude: number;
  velocity: number;
  heading: number;
  onGround: boolean;
  squawk: string;
  isMilitary: boolean;
  operator: string;
  timestamp: string;
}

async function fetchOpenSkyFlights(
  lamin?: number, lamax?: number, lomin?: number, lomax?: number,
  militaryOnly: boolean = false,
): Promise<FlightState[]> {
  let url = "https://opensky-network.org/api/states/all";
  const params: string[] = [];
  if (lamin !== undefined) params.push(`lamin=${lamin}`);
  if (lamax !== undefined) params.push(`lamax=${lamax}`);
  if (lomin !== undefined) params.push(`lomin=${lomin}`);
  if (lomax !== undefined) params.push(`lomax=${lomax}`);
  if (params.length > 0) url += `?${params.join("&")}`;

  const headers: Record<string, string> = { "User-Agent": UA };
  const user = process.env.OPENSKY_USER;
  const pass = process.env.OPENSKY_PASS;
  if (user && pass) {
    headers["Authorization"] = `Basic ${btoa(`${user}:${pass}`)}`;
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers });
  if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json() as any;
  const states: any[] = (data?.states ?? []).slice(0, MAX_OPENSKY_STATES);

  const flights: FlightState[] = [];
  for (const s of states) {
    if (!s[6] || !s[5]) continue; // skip if no lat/lon

    const icao24 = (s[0] ?? "").toLowerCase();
    let isMilitary = false;
    let operator = "";
    for (const mp of MILITARY_ICAO_PREFIXES) {
      if (icao24.startsWith(mp.prefix)) {
        isMilitary = true;
        operator = mp.operator;
        break;
      }
    }
    // Also check squawk codes for military
    const squawk = s[14] ?? "";
    if (squawk === "7777" || squawk === "7600") isMilitary = true;

    if (militaryOnly && !isMilitary) continue;

    flights.push({
      icao24,
      callsign: (s[1] ?? "").trim(),
      originCountry: s[2] ?? "",
      lat: s[6],
      lon: s[5],
      altitude: s[7] ?? 0,
      velocity: s[9] ?? 0,
      heading: s[10] ?? 0,
      onGround: s[8] ?? false,
      squawk,
      isMilitary,
      operator,
      timestamp: new Date((data?.time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    });
  }

  return flights;
}

// ── Skill Dispatcher ─────────────────────────────────────────────

async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;

  switch (skillId) {
    case "track_conflicts": {
      const { conflicts } = MonitorSchemas.track_conflicts.parse(args);
      const scored = scoreConflicts(conflicts);
      const byStatus: Record<string, number> = {};
      for (const c of scored) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
      return safeStringify({
        totalConflicts: scored.length,
        byStatus,
        escalatingCount: scored.filter(c => c.escalationTrend === "escalating").length,
        totalCasualties: scored.reduce((s, c) => s + c.casualties, 0),
        totalDisplaced: scored.reduce((s, c) => s + c.displaced, 0),
        conflicts: scored,
      }, 2);
    }

    case "detect_surge": {
      const { activities, baselineHours, surgeMultiplier, minCount } = MonitorSchemas.detect_surge.parse(args);
      const result = detectSurges(activities, baselineHours, surgeMultiplier, minCount);
      return safeStringify({
        totalActivities: activities.length,
        surgeAlerts: result.alerts.filter(a => a.surgeDetected).length,
        proximityClusterCount: result.proximityCorrelations.length,
        ...result,
      }, 2);
    }

    case "theater_posture": {
      const { theater, activities, baseline, foreignOperators, conflictProximity } = MonitorSchemas.theater_posture.parse(args);
      const assessment = assessTheaterPosture(theater, activities, baseline, foreignOperators, conflictProximity);
      return safeStringify(assessment, 2);
    }

    case "track_vessels": {
      const { vessels, darkShipThresholdMin, clusterRadiusKm } = MonitorSchemas.track_vessels.parse(args);
      const result = analyzeVessels(vessels, darkShipThresholdMin, clusterRadiusKm);
      return safeStringify({
        totalVessels: vessels.length,
        militaryVessels: result.militaryVessels,
        darkShips: result.darkShips,
        clusterCount: result.clusters.length,
        clusters: result.clusters,
        vessels: result.vessels,
      }, 2);
    }

    case "check_freshness": {
      const { sources, freshThresholdMin, staleThresholdMin, veryStaleThresholdMin } = MonitorSchemas.check_freshness.parse(args);
      const result = checkFreshness(sources, freshThresholdMin, staleThresholdMin, veryStaleThresholdMin);
      return safeStringify({
        totalSources: sources.length,
        ...result,
      }, 2);
    }

    case "watchlist_check": {
      const { entities, watchlists, fuzzyMatch } = MonitorSchemas.watchlist_check.parse(args);
      const result = screenWatchlists(entities, watchlists, fuzzyMatch);
      return safeStringify({
        totalEntities: entities.length,
        ...result,
      }, 2);
    }

    case "fetch_conflicts": {
      const { source, region, country, days, limit } = MonitorSchemas.fetch_conflicts.parse(args);
      let conflicts: Conflict[];
      if (source === "acled") {
        conflicts = await fetchAcledConflicts(region, country, days, limit);
      } else {
        conflicts = await fetchGdeltConflicts(region, country, days, limit);
      }
      const scored = scoreConflicts(conflicts);
      return safeStringify({
        source,
        totalConflicts: scored.length,
        escalatingCount: scored.filter(c => c.escalationTrend === "escalating").length,
        conflicts: scored,
      }, 2);
    }

    case "fetch_flights": {
      const { lamin, lamax, lomin, lomax, militaryOnly } = MonitorSchemas.fetch_flights.parse(args);
      const flights = await fetchOpenSkyFlights(lamin, lamax, lomin, lomax, militaryOnly);
      const militaryCount = flights.filter(f => f.isMilitary).length;
      const byCountry: Record<string, number> = {};
      for (const f of flights) {
        byCountry[f.originCountry] = (byCountry[f.originCountry] ?? 0) + 1;
      }
      return safeStringify({
        totalFlights: flights.length,
        militaryFlights: militaryCount,
        byCountry,
        flights: flights.slice(0, 200), // Limit response size
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
  const sid = skillId ?? "track_conflicts";

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
