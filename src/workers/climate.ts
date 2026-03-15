/**
 * Climate Worker Agent — natural event monitoring, earthquake/wildfire/storm tracking,
 * environmental anomaly detection, and population exposure assessment.
 *
 * Port: 8094
 *
 * Inspired by World Monitor's EONET, USGS, NASA FIRMS, and climate modules.
 *
 * Skills:
 *   fetch_earthquakes   — Fetch recent earthquakes from USGS API
 *   fetch_wildfires     — Fetch active fire hotspots from NASA FIRMS
 *   fetch_natural_events — Fetch natural events from NASA EONET
 *   assess_exposure     — Assess population/infrastructure exposure to natural hazards
 *   climate_anomalies   — Detect climate anomalies from temperature/precipitation time series
 *   event_correlate     — Correlate natural events with infrastructure and conflict data
 *   remember/recall     — Shared persistent memory
 */

import Fastify from "fastify";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { buildA2AResponse, buildA2AError, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { round, haversineKm } from "../worker-utils.js";

const PORT = 8094;
const NAME = "climate-agent";

const FETCH_TIMEOUT = 20_000;
const UA = "A2A-Climate-Agent/1.0";

// ── Zod Schemas ──────────────────────────────────────────────────

const ClimateSchemas = {
  fetch_earthquakes: z.looseObject({
    minMagnitude: z.number().optional().default(4.0),
    maxResults: z.number().int().positive().optional().default(50),
    days: z.number().int().positive().optional().default(7),
    lat: z.number().optional(),
    lon: z.number().optional(),
    radiusKm: z.number().positive().optional(),
  }),

  fetch_wildfires: z.looseObject({
    source: z.enum(["VIIRS_SNPP_NRT", "MODIS_NRT"]).optional().default("VIIRS_SNPP_NRT"),
    days: z.number().int().min(1).max(10).optional().default(2),
    lat: z.number().optional(),
    lon: z.number().optional(),
    radiusKm: z.number().positive().optional(),
    minConfidence: z.number().min(0).max(100).optional().default(50),
  }),

  fetch_natural_events: z.looseObject({
    category: z.enum(["earthquakes", "volcanoes", "wildfires", "severeStorms", "floods", "drought", "landslides", "snow", "all"]).optional().default("all"),
    days: z.number().int().positive().optional().default(30),
    maxResults: z.number().int().positive().optional().default(50),
    status: z.enum(["open", "closed", "all"]).optional().default("open"),
  }),

  assess_exposure: z.looseObject({
    hazards: z.array(z.object({
      type: z.string(),
      lat: z.number(),
      lon: z.number(),
      magnitude: z.number().optional().default(0),
      radiusKm: z.number().positive().optional().default(50),
    })).min(1),
    assets: z.array(z.object({
      name: z.string(),
      type: z.enum(["city", "port", "pipeline", "powerplant", "military_base", "datacenter", "airport", "refinery", "other"]).optional().default("other"),
      lat: z.number(),
      lon: z.number(),
      population: z.number().optional().default(0),
      criticality: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
    })).min(1),
  }),

  climate_anomalies: z.looseObject({
    series: z.array(z.object({
      date: z.string(),
      temperature: z.number().optional(),
      precipitation: z.number().optional(),
      windSpeed: z.number().optional(),
      label: z.string().optional().default(""),
    })).min(5),
    baselinePeriod: z.number().int().positive().optional().default(30),
    zScoreThreshold: z.number().positive().optional().default(2),
  }),

  event_correlate: z.looseObject({
    naturalEvents: z.array(z.object({
      type: z.string(),
      lat: z.number(),
      lon: z.number(),
      magnitude: z.number().optional().default(0),
      date: z.string().optional().default(""),
    })).min(1),
    infrastructureAssets: z.array(z.object({
      name: z.string(),
      type: z.string(),
      lat: z.number(),
      lon: z.number(),
    })).optional().default([]),
    conflictZones: z.array(z.object({
      name: z.string(),
      lat: z.number(),
      lon: z.number(),
      radiusKm: z.number().optional().default(100),
    })).optional().default([]),
    correlationRadiusKm: z.number().positive().optional().default(200),
  }),
};

// ── Agent Card ───────────────────────────────────────────────────

const AGENT_CARD = {
  name: NAME,
  description: "Climate agent — earthquake/wildfire/storm monitoring via USGS and NASA APIs, population exposure assessment, climate anomaly detection, and event-infrastructure correlation",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "fetch_earthquakes", name: "Fetch Earthquakes", description: "Fetch recent earthquakes from USGS with magnitude, depth, and optional geo-filter" },
    { id: "fetch_wildfires", name: "Fetch Wildfires", description: "Fetch active fire hotspots from NASA FIRMS (VIIRS/MODIS) with confidence filtering" },
    { id: "fetch_natural_events", name: "Fetch Natural Events", description: "Fetch natural events from NASA EONET: volcanoes, storms, floods, wildfires, etc." },
    { id: "assess_exposure", name: "Assess Exposure", description: "Assess population and infrastructure exposure to natural hazards by proximity" },
    { id: "climate_anomalies", name: "Climate Anomalies", description: "Detect temperature, precipitation, and wind anomalies using z-score against baseline" },
    { id: "event_correlate", name: "Event Correlate", description: "Correlate natural events with infrastructure assets and conflict zones by proximity" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────

// round() and haversineKm() imported from ../worker-utils.js

/**
 * Parse a single CSV line handling quoted fields with embedded commas.
 * Fields wrapped in double quotes may contain commas and escaped quotes ("").
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ("")
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip next quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ── USGS Earthquake Fetcher ──────────────────────────────────────

interface Earthquake {
  id: string;
  magnitude: number;
  place: string;
  time: string;
  lat: number;
  lon: number;
  depth: number;
  tsunami: boolean;
  felt: number;
  significance: number;
  url: string;
}

async function fetchEarthquakes(
  minMag: number,
  maxResults: number,
  days: number,
  lat?: number,
  lon?: number,
  radiusKm?: number,
): Promise<Earthquake[]> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  let url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=${minMag}&starttime=${startDate.toISOString()}&endtime=${endDate.toISOString()}&limit=${maxResults}&orderby=magnitude`;

  if (lat !== undefined && lon !== undefined && radiusKm !== undefined) {
    url += `&latitude=${lat}&longitude=${lon}&maxradiuskm=${radiusKm}`;
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`USGS HTTP ${res.status}: ${res.statusText}`);

  const data = await res.json() as any;
  const features = data?.features ?? [];

  return features.map((f: any) => ({
    id: f.id,
    magnitude: f.properties?.mag ?? 0,
    place: f.properties?.place ?? "",
    time: new Date(f.properties?.time ?? 0).toISOString(),
    lat: f.geometry?.coordinates?.[1] ?? 0,
    lon: f.geometry?.coordinates?.[0] ?? 0,
    depth: round(f.geometry?.coordinates?.[2] ?? 0, 1),
    tsunami: (f.properties?.tsunami ?? 0) > 0,
    felt: f.properties?.felt ?? 0,
    significance: f.properties?.sig ?? 0,
    url: f.properties?.url ?? "",
  }));
}

// ── NASA FIRMS Wildfire Fetcher ──────────────────────────────────

interface FireHotspot {
  lat: number;
  lon: number;
  brightness: number;
  confidence: number | string;
  acqDate: string;
  acqTime: string;
  frp: number;
  satellite: string;
}

async function fetchWildfires(
  source: string,
  days: number,
  lat?: number,
  lon?: number,
  radiusKm?: number,
  minConfidence?: number,
): Promise<FireHotspot[]> {
  // NASA FIRMS CSV API — requires MAP_KEY env or falls back to FIRMS open data
  const mapKey = process.env.NASA_FIRMS_KEY ?? "OPEN";
  const area = lat !== undefined && lon !== undefined && radiusKm !== undefined
    ? (() => {
        const latRange = radiusKm / 111;
        const lonRange = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
        return `${lon - lonRange},${lat - latRange},${lon + lonRange},${lat + latRange}`;
      })()
    : "world";

  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${source}/${area}/${days}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { "User-Agent": UA },
  });

  if (!res.ok) {
    process.stderr.write(`[${NAME}] fetchWildfires: NASA FIRMS HTTP ${res.status}: ${res.statusText}\n`);
    return [];
  }

  const csv = await res.text();
  const lines = csv.split("\n").filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const latIdx = headers.indexOf("latitude");
  const lonIdx = headers.indexOf("longitude");
  const brightIdx = headers.indexOf("bright_ti4") >= 0 ? headers.indexOf("bright_ti4") : headers.indexOf("brightness");
  if (brightIdx < 0) return []; // skip entirely if no brightness column in CSV
  const confIdx = headers.indexOf("confidence");
  const dateIdx = headers.indexOf("acq_date");
  const timeIdx = headers.indexOf("acq_time");
  const frpIdx = headers.indexOf("frp");
  const satIdx = headers.indexOf("satellite");

  const hotspots: FireHotspot[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const confidence = confIdx >= 0 ? (isNaN(Number(cols[confIdx])) ? cols[confIdx]?.trim() ?? "" : Number(cols[confIdx])) : 0;

    // Filter by confidence
    const confNum = typeof confidence === "number" ? confidence : (confidence === "high" ? 90 : confidence === "nominal" ? 50 : 30);
    if (minConfidence !== undefined && confNum < minConfidence) continue;

    hotspots.push({
      lat: Number(cols[latIdx]) || 0,
      lon: Number(cols[lonIdx]) || 0,
      brightness: Number(cols[brightIdx]) || 0,
      confidence,
      acqDate: cols[dateIdx]?.trim() ?? "",
      acqTime: cols[timeIdx]?.trim() ?? "",
      frp: Number(cols[frpIdx]) || 0,
      satellite: cols[satIdx]?.trim() ?? "",
    });
  }

  // If geo filter provided, apply Haversine
  if (lat !== undefined && lon !== undefined && radiusKm !== undefined) {
    return hotspots.filter(h => haversineKm(lat, lon, h.lat, h.lon) <= radiusKm);
  }

  return hotspots;
}

// ── NASA EONET Natural Events ────────────────────────────────────

const EONET_CATEGORY_MAP: Record<string, string> = {
  earthquakes: "earthquakes",
  volcanoes: "volcanoes",
  wildfires: "wildfires",
  severeStorms: "severeStorms",
  floods: "floods",
  drought: "drought",
  landslides: "landslides",
  snow: "snow",
};

interface NaturalEvent {
  id: string;
  title: string;
  category: string;
  date: string;
  lat: number;
  lon: number;
  status: string;
  sources: string[];
}

async function fetchNaturalEvents(
  category: string,
  days: number,
  maxResults: number,
  status: string,
): Promise<NaturalEvent[]> {
  let url = `https://eonet.gsfc.nasa.gov/api/v3/events?limit=${maxResults}&days=${days}`;
  if (status !== "all") url += `&status=${status}`;
  if (category !== "all" && EONET_CATEGORY_MAP[category]) {
    url += `&category=${EONET_CATEGORY_MAP[category]}`;
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`EONET HTTP ${res.status}: ${res.statusText}`);

  const data = await res.json() as any;
  const events = data?.events ?? [];

  return events.map((e: any) => {
    const geo = e.geometry?.[0] ?? {};
    const coords = geo.coordinates ?? [0, 0];
    return {
      id: e.id ?? "",
      title: e.title ?? "",
      category: e.categories?.[0]?.title ?? "",
      date: geo.date ?? e.geometry?.[e.geometry.length - 1]?.date ?? "",
      lat: coords[1] ?? 0,
      lon: coords[0] ?? 0,
      status: e.closed ? "closed" : "open",
      sources: (e.sources ?? []).map((s: any) => s.id ?? ""),
    };
  });
}

// ── Exposure Assessment ──────────────────────────────────────────

const CRITICALITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

interface ExposureResult {
  assetName: string;
  assetType: string;
  population: number;
  criticality: string;
  exposedTo: Array<{
    hazardType: string;
    distanceKm: number;
    magnitude: number;
    exposureLevel: string;
  }>;
  maxExposureLevel: string;
  compositeRisk: number;
}

function assessExposure(
  hazards: Array<{ type: string; lat: number; lon: number; magnitude: number; radiusKm: number }>,
  assets: Array<{ name: string; type: string; lat: number; lon: number; population: number; criticality: string }>,
): { exposures: ExposureResult[]; summary: Record<string, unknown> } {
  const exposures: ExposureResult[] = [];
  let totalExposed = 0;
  let criticalExposures = 0;

  for (const asset of assets) {
    const exposedTo: ExposureResult["exposedTo"] = [];
    let maxLevel = "none";
    let compositeRisk = 0;

    for (const hazard of hazards) {
      const dist = haversineKm(asset.lat, asset.lon, hazard.lat, hazard.lon);
      if (dist > hazard.radiusKm) continue;

      // Exposure level based on distance ratio
      const ratio = dist / hazard.radiusKm;
      let level: string;
      if (ratio <= 0.2) level = "critical";
      else if (ratio <= 0.4) level = "high";
      else if (ratio <= 0.7) level = "medium";
      else level = "low";

      exposedTo.push({
        hazardType: hazard.type,
        distanceKm: round(dist, 1),
        magnitude: hazard.magnitude,
        exposureLevel: level,
      });

      // Update max level
      const levelOrder = ["none", "low", "medium", "high", "critical"];
      if (levelOrder.indexOf(level) > levelOrder.indexOf(maxLevel)) maxLevel = level;

      // Composite risk: severity * proximity * criticality
      const proxScore = 1 - ratio;
      const critWeight = CRITICALITY_WEIGHT[asset.criticality] ?? 2;
      const magFactor = hazard.magnitude > 0 ? Math.log10(hazard.magnitude + 1) : 1;
      compositeRisk += proxScore * critWeight * magFactor;
    }

    if (exposedTo.length > 0) {
      totalExposed++;
      if (maxLevel === "critical") criticalExposures++;

      exposures.push({
        assetName: asset.name,
        assetType: asset.type,
        population: asset.population,
        criticality: asset.criticality,
        exposedTo,
        maxExposureLevel: maxLevel,
        compositeRisk: round(compositeRisk, 2),
      });
    }
  }

  // Sort by composite risk descending
  exposures.sort((a, b) => b.compositeRisk - a.compositeRisk);

  const totalPopulationExposed = exposures.reduce((s, e) => s + e.population, 0);

  return {
    exposures,
    summary: {
      totalAssets: assets.length,
      exposedAssets: totalExposed,
      criticalExposures,
      totalPopulationExposed,
      hazardCount: hazards.length,
    },
  };
}

// ── Climate Anomaly Detection ────────────────────────────────────

interface ClimateDataPoint {
  date: string;
  temperature?: number;
  precipitation?: number;
  windSpeed?: number;
  label: string;
}

interface ClimateAnomaly {
  date: string;
  label: string;
  metric: string;
  value: number;
  baselineMean: number;
  baselineStddev: number;
  zScore: number;
  direction: string;
}

function detectClimateAnomalies(
  series: ClimateDataPoint[],
  baselinePeriod: number,
  zScoreThreshold: number,
): { anomalies: ClimateAnomaly[]; baselineStats: Record<string, unknown>; summary: Record<string, unknown> } {
  const metrics = ["temperature", "precipitation", "windSpeed"] as const;
  const anomalies: ClimateAnomaly[] = [];
  const baselineStats: Record<string, unknown> = {};

  // Split data: first `baselinePeriod` points = baseline, rest = evaluation
  const splitIdx = Math.min(baselinePeriod, Math.floor(series.length * 0.75));

  for (const metric of metrics) {
    // Pair values with their source data points to keep indices aligned
    const paired = series
      .map(d => ({ point: d, value: d[metric] }))
      .filter((p): p is { point: ClimateDataPoint; value: number } => p.value !== undefined && p.value !== null);
    if (paired.length < 3) continue;

    const baselineValues = paired.slice(0, splitIdx).map(p => p.value);
    const evalPaired = paired.slice(splitIdx);
    const evalValues = evalPaired.map(p => p.value);
    const evalPoints = evalPaired.map(p => p.point);

    if (baselineValues.length === 0 || evalValues.length === 0) continue;

    const mean = baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length;
    const variance = baselineValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / baselineValues.length;
    const stddev = Math.sqrt(variance);

    baselineStats[metric] = {
      mean: round(mean, 2),
      stddev: round(stddev, 2),
      min: round(Math.min(...baselineValues), 2),
      max: round(Math.max(...baselineValues), 2),
      count: baselineValues.length,
    };

    for (let i = 0; i < evalValues.length; i++) {
      const val = evalValues[i];
      const zScore = stddev === 0 ? 0 : (val - mean) / stddev;

      if (Math.abs(zScore) >= zScoreThreshold) {
        anomalies.push({
          date: evalPoints[i]?.date ?? "",
          label: evalPoints[i]?.label ?? "",
          metric,
          value: round(val),
          baselineMean: round(mean),
          baselineStddev: round(stddev),
          zScore: round(zScore),
          direction: zScore > 0 ? "above_normal" : "below_normal",
        });
      }
    }
  }

  // Sort by absolute z-score
  anomalies.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  const byMetric: Record<string, number> = {};
  for (const a of anomalies) byMetric[a.metric] = (byMetric[a.metric] ?? 0) + 1;

  return {
    anomalies,
    baselineStats,
    summary: {
      totalDataPoints: series.length,
      baselinePeriod: splitIdx,
      evaluationPeriod: series.length - splitIdx,
      anomalyCount: anomalies.length,
      byMetric,
    },
  };
}

// ── Event Correlation ────────────────────────────────────────────

interface CorrelationResult {
  naturalEvent: { type: string; lat: number; lon: number; magnitude: number };
  nearbyInfrastructure: Array<{ name: string; type: string; distanceKm: number }>;
  nearbyConflicts: Array<{ name: string; distanceKm: number }>;
  riskLevel: string;
  compoundRisk: boolean;
}

function correlateEvents(
  naturalEvents: Array<{ type: string; lat: number; lon: number; magnitude: number; date: string }>,
  infrastructure: Array<{ name: string; type: string; lat: number; lon: number }>,
  conflictZones: Array<{ name: string; lat: number; lon: number; radiusKm: number }>,
  radiusKm: number,
): { correlations: CorrelationResult[]; summary: Record<string, unknown> } {
  const correlations: CorrelationResult[] = [];
  let compoundRiskCount = 0;

  for (const event of naturalEvents) {
    const nearbyInfra = infrastructure
      .map(a => ({ name: a.name, type: a.type, distanceKm: round(haversineKm(event.lat, event.lon, a.lat, a.lon), 1) }))
      .filter(a => a.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    const nearbyConflicts = conflictZones
      .map(c => ({ name: c.name, distanceKm: round(haversineKm(event.lat, event.lon, c.lat, c.lon), 1) }))
      .filter(c => c.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    const compoundRisk = nearbyInfra.length > 0 && nearbyConflicts.length > 0;
    if (compoundRisk) compoundRiskCount++;

    // Risk level
    let riskLevel = "low";
    if (compoundRisk) riskLevel = "critical";
    else if (nearbyInfra.length >= 3 || nearbyConflicts.length > 0) riskLevel = "high";
    else if (nearbyInfra.length > 0) riskLevel = "medium";

    if (nearbyInfra.length > 0 || nearbyConflicts.length > 0) {
      correlations.push({
        naturalEvent: { type: event.type, lat: event.lat, lon: event.lon, magnitude: event.magnitude },
        nearbyInfrastructure: nearbyInfra.slice(0, 10),
        nearbyConflicts: nearbyConflicts.slice(0, 5),
        riskLevel,
        compoundRisk,
      });
    }
  }

  // Sort by risk level
  const riskOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  correlations.sort((a, b) => (riskOrder[a.riskLevel] ?? 4) - (riskOrder[b.riskLevel] ?? 4));

  return {
    correlations,
    summary: {
      naturalEvents: naturalEvents.length,
      correlatedEvents: correlations.length,
      compoundRiskEvents: compoundRiskCount,
      infrastructureAssetsChecked: infrastructure.length,
      conflictZonesChecked: conflictZones.length,
      correlationRadiusKm: radiusKm,
    },
  };
}

// ── Skill Dispatcher ─────────────────────────────────────────────

async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;

  switch (skillId) {
    case "fetch_earthquakes": {
      const { minMagnitude, maxResults, days, lat, lon, radiusKm } = ClimateSchemas.fetch_earthquakes.parse(args);
      const quakes = await fetchEarthquakes(minMagnitude, maxResults, days, lat, lon, radiusKm);
      const tsunamiCount = quakes.filter(q => q.tsunami).length;
      return safeStringify({
        earthquakeCount: quakes.length,
        minMagnitude,
        days,
        tsunamiAlerts: tsunamiCount,
        maxMagnitude: quakes.length > 0 ? Math.max(...quakes.map(q => q.magnitude)) : 0,
        earthquakes: quakes,
      }, 2);
    }

    case "fetch_wildfires": {
      const { source, days, lat, lon, radiusKm, minConfidence } = ClimateSchemas.fetch_wildfires.parse(args);
      const fires = await fetchWildfires(source, days, lat, lon, radiusKm, minConfidence);
      return safeStringify({
        hotspotCount: fires.length,
        source,
        days,
        minConfidence,
        avgBrightness: fires.length > 0 ? round(fires.reduce((s, f) => s + f.brightness, 0) / fires.length, 1) : 0,
        avgFRP: fires.length > 0 ? round(fires.reduce((s, f) => s + f.frp, 0) / fires.length, 1) : 0,
        hotspots: fires.slice(0, 200),
      }, 2);
    }

    case "fetch_natural_events": {
      const { category, days, maxResults, status } = ClimateSchemas.fetch_natural_events.parse(args);
      const events = await fetchNaturalEvents(category, days, maxResults, status);
      const byCategory: Record<string, number> = {};
      for (const e of events) byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
      return safeStringify({
        eventCount: events.length,
        category,
        days,
        byCategory,
        events,
      }, 2);
    }

    case "assess_exposure": {
      const { hazards, assets } = ClimateSchemas.assess_exposure.parse(args);
      const result = assessExposure(hazards, assets);
      return safeStringify(result, 2);
    }

    case "climate_anomalies": {
      const { series, baselinePeriod, zScoreThreshold } = ClimateSchemas.climate_anomalies.parse(args);
      const result = detectClimateAnomalies(series, baselinePeriod, zScoreThreshold);
      return safeStringify(result, 2);
    }

    case "event_correlate": {
      const { naturalEvents, infrastructureAssets, conflictZones, correlationRadiusKm } = ClimateSchemas.event_correlate.parse(args);
      const result = correlateEvents(naturalEvents, infrastructureAssets, conflictZones, correlationRadiusKm);
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
  const sid = skillId ?? "fetch_earthquakes";

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
