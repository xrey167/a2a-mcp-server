/**
 * OSINT Intelligence — orchestrator-level logic that coordinates the 6 OSINT
 * workers (news, market, signal, monitor, infra, climate) into higher-order
 * products: threat briefs, alert scans, regional assessments, market snapshots,
 * and data-freshness reports.
 *
 * Follows the same pattern as erp-platform.ts: pure functions that the
 * server.ts case handler calls synchronously or with lightweight async.
 */

import { z } from "zod";
import type { WorkflowDefinition } from "./workflow-engine.js";

// ── Zod Schemas (registered in OrchestratorSchemas) ─────────────

export const OsintBriefInputSchema = z.object({
  region: z.string().optional().describe("ISO country code or region name to focus on"),
  since: z.string().optional().describe("ISO timestamp lower bound for data window"),
  sources: z.array(z.enum(["news", "market", "signal", "monitor", "infra", "climate"]))
    .optional()
    .default(["news", "market", "signal", "monitor", "infra", "climate"]),
}).strict();

export const OsintAlertScanInputSchema = z.object({
  severityThreshold: z.enum(["critical", "high", "medium", "low"]).optional().default("high"),
  region: z.string().optional(),
  since: z.string().optional(),
}).strict();

export const OsintThreatAssessInputSchema = z.object({
  region: z.string().describe("ISO country code or region name"),
  includeClimate: z.boolean().optional().default(true),
  includeInfra: z.boolean().optional().default(true),
}).strict();

export const OsintMarketSnapshotInputSchema = z.object({
  symbols: z.array(z.string()).min(1).describe("List of ticker symbols to analyze"),
  detectAnomalies: z.boolean().optional().default(true),
}).strict();

export const OsintFreshnessInputSchema = z.object({
  sources: z.array(z.object({
    id: z.string(),
    name: z.string(),
    lastUpdated: z.string(),
    essential: z.boolean().optional().default(false),
  })).optional(),
  maxStaleMinutes: z.number().optional().default(60),
}).strict();

// ── Workflow Builders ────────────────────────────────────────────
// Each returns a WorkflowDefinition that server.ts can pass to executeWorkflow.

export function buildOsintBriefWorkflow(
  opts: z.infer<typeof OsintBriefInputSchema>,
): WorkflowDefinition {
  const sources = opts.sources ?? ["news", "market", "signal", "monitor", "infra", "climate"];
  const steps: WorkflowDefinition["steps"] = [];
  const regionArg = opts.region ? { country: opts.region } : {};

  // ── Phase 1: Independent data collection (parallel) ────────────
  // These workers fetch from external APIs and need no upstream data.

  if (sources.includes("news")) {
    steps.push({
      id: "news_collect",
      skillId: "aggregate_feeds",
      label: "Collect news feeds",
      args: { urls: ["https://feeds.bbci.co.uk/news/world/rss.xml", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", "https://www.aljazeera.com/xml/rss/all.xml", "https://feeds.reuters.com/reuters/worldNews"], limit: 30, dedup: true },
      onError: "skip" as const,
    });
  }

  if (sources.includes("market")) {
    steps.push({
      id: "market_screen",
      skillId: "screen_market",
      label: "Screen market for anomalies",
      args: { assets: [], sortBy: "changePercent", sortDir: "desc", limit: 20 },
      onError: "skip" as const,
    });
  }

  if (sources.includes("monitor")) {
    steps.push({
      id: "conflicts",
      skillId: "fetch_conflicts",
      label: "Fetch live conflict data",
      args: { source: "gdelt", days: 7, limit: 50, ...(opts.region ? { country: opts.region } : {}) },
      onError: "skip" as const,
    });
  }

  if (sources.includes("infra")) {
    steps.push({
      id: "infra_load",
      skillId: "load_infrastructure",
      label: "Load infrastructure database",
      args: { filter: opts.region ? { region: opts.region } : {} },
      onError: "skip" as const,
    });
  }

  if (sources.includes("climate")) {
    steps.push({
      id: "climate_events",
      skillId: "fetch_natural_events",
      label: "Fetch natural events",
      args: { limit: 20, ...(opts.region ? { region: opts.region } : {}) },
      onError: "skip" as const,
    });
  }

  // ── Phase 2: Chained analysis (depends on Phase 1 outputs) ─────

  if (sources.includes("news")) {
    steps.push({
      id: "news_signals",
      skillId: "detect_signals",
      label: "Detect news signals from collected articles",
      dependsOn: ["news_collect"],
      args: { articles: "{{news_collect.result}}", baselineHours: 24, spikeMultiplier: 3 },
      onError: "skip" as const,
    });
  }

  if (sources.includes("signal")) {
    // Aggregate signals from upstream news + monitor outputs
    const signalDeps: string[] = [];
    if (sources.includes("news")) signalDeps.push("news_signals");
    if (sources.includes("monitor")) signalDeps.push("conflicts");

    steps.push({
      id: "signal_aggregate",
      skillId: "aggregate_signals",
      label: "Aggregate multi-source signals",
      dependsOn: signalDeps.length > 0 ? signalDeps : undefined,
      args: { signals: [], windowHours: 24, dedup: true, ...regionArg },
      onError: "skip" as const,
    });

    // Cross-domain correlation patterns (depends on aggregated signals)
    steps.push({
      id: "signal_correlate",
      skillId: "correlate_signals",
      label: "Detect cross-domain correlation patterns",
      dependsOn: ["signal_aggregate"],
      args: { signals: "{{signal_aggregate.result}}", windowHours: 24, minConfidence: 0.3 },
      onError: "skip" as const,
    });
  }

  // ── Phase 3: Synthesis (depends on all previous phases) ────────

  const allStepIds = steps.map(s => s.id);

  steps.push({
    id: "synthesize",
    skillId: "ask_claude",
    label: "Synthesize intelligence brief",
    dependsOn: allStepIds,
    args: {
      prompt: `You are an OSINT analyst. Synthesize the following multi-source intelligence data into a structured brief.
Region focus: ${opts.region ?? "global"}.

Data from workers:
${allStepIds.map(id => `- ${id}: {{${id}.result}}`).join("\n")}

Output format:
## Executive Summary
(2-3 sentences)

## Key Threats (by severity)
(bullet points with severity tags)

## Correlation Patterns Detected
(cross-domain patterns from signal_correlate, if available)

## Market Signals
(notable moves, anomalies)

## Infrastructure Risk
(chokepoints, cascades, redundancy gaps)

## Climate/Natural Events
(active events that may impact operations)

## Recommended Actions
(prioritized list)`,
    },
  });

  return {
    id: `osint-brief-${Date.now()}`,
    name: `OSINT Brief${opts.region ? ` — ${opts.region}` : ""}`,
    maxConcurrency: 6,
    steps,
  };
}

export function buildAlertScanWorkflow(
  opts: z.infer<typeof OsintAlertScanInputSchema>,
): WorkflowDefinition {
  return {
    id: `osint-alert-scan-${Date.now()}`,
    name: "OSINT Alert Scan",
    maxConcurrency: 4,
    steps: [
      // Phase 1: Independent data collection (parallel)
      {
        id: "signals",
        skillId: "aggregate_signals",
        label: "Aggregate all signals",
        args: { signals: [], windowHours: 24, dedup: true, ...(opts.region ? { country: opts.region } : {}) },
        onError: "skip" as const,
      },
      {
        id: "freshness",
        skillId: "check_freshness",
        label: "Check data freshness",
        args: { sources: [] },
        onError: "skip" as const,
      },
      {
        id: "conflicts",
        skillId: "fetch_conflicts",
        label: "Fetch live conflict data",
        args: { source: "gdelt", days: 7, limit: 50, ...(opts.region ? { country: opts.region } : {}) },
        onError: "skip" as const,
      },
      {
        id: "flights",
        skillId: "fetch_flights",
        label: "Fetch flight activity",
        args: { militaryOnly: true },
        onError: "skip" as const,
      },
      // Phase 2: Chained analysis (depends on Phase 1)
      {
        id: "threats",
        skillId: "classify_threat",
        label: "Classify threats from signals",
        dependsOn: ["signals", "conflicts"],
        args: { events: "{{signals.result}}", conflicts: "{{conflicts.result}}" },
        onError: "skip" as const,
      },
      {
        id: "correlate",
        skillId: "correlate_signals",
        label: "Detect cross-domain correlation patterns",
        dependsOn: ["signals"],
        args: { signals: "{{signals.result}}", windowHours: 24, minConfidence: 0.3 },
        onError: "skip" as const,
      },
      // Phase 3: Evaluation (depends on all above)
      {
        id: "evaluate",
        skillId: "ask_claude",
        label: "Evaluate alerts against thresholds",
        dependsOn: ["signals", "threats", "freshness", "conflicts", "flights", "correlate"],
        args: {
          prompt: `You are an OSINT alert evaluator. Review the following data and extract items that meet or exceed severity threshold: ${opts.severityThreshold}.

Signals: {{signals.result}}
Threats: {{threats.result}}
Freshness: {{freshness.result}}
Conflicts: {{conflicts.result}}
Flight Activity: {{flights.result}}
Correlation Patterns: {{correlate.result}}

Return JSON: { "alerts": [{ "source": string, "severity": string, "title": string, "summary": string, "actionRequired": boolean }], "totalAlerts": number, "criticalCount": number, "highCount": number }`,
        },
      },
    ],
  };
}

export function buildThreatAssessWorkflow(
  opts: z.infer<typeof OsintThreatAssessInputSchema>,
): WorkflowDefinition {
  const steps: WorkflowDefinition["steps"] = [
    // Phase 1: Independent data collection (parallel)
    {
      id: "signals",
      skillId: "aggregate_signals",
      label: "Aggregate signals for region",
      args: { signals: [], country: opts.region, windowHours: 24, dedup: true },
      onError: "skip" as const,
    },
    {
      id: "conflicts",
      skillId: "fetch_conflicts",
      label: "Fetch live conflict data for region",
      args: { source: "gdelt", days: 7, limit: 50, country: opts.region },
      onError: "skip" as const,
    },
    {
      id: "cyber",
      skillId: "fetch_cyber_c2",
      label: "Fetch cyber threat indicators",
      args: { limit: 50 },
      onError: "skip" as const,
    },
    // Phase 2: Chained analysis (depends on Phase 1)
    {
      id: "convergence",
      skillId: "detect_convergence",
      label: "Detect geographic convergence",
      dependsOn: ["signals"],
      args: { signals: "{{signals.result}}", radiusKm: 500, minTypes: 2 },
      onError: "skip" as const,
    },
    {
      id: "instability",
      skillId: "instability_index",
      label: "Compute instability index",
      dependsOn: ["signals", "conflicts", "cyber"],
      args: { country: opts.region, indicators: { conflictEvents: 0, militaryActivity: 0, civilUnrest: 0, cyberThreats: 0, economicStress: 0, displacement: 0, naturalDisasters: 0, mediaCoverage: 0 } },
      onError: "skip" as const,
    },
    {
      id: "correlate",
      skillId: "correlate_signals",
      label: "Detect cross-domain correlation patterns",
      dependsOn: ["signals"],
      args: { signals: "{{signals.result}}", windowHours: 24, minConfidence: 0.3 },
      onError: "skip" as const,
    },
  ];

  if (opts.includeInfra) {
    steps.push({
      id: "infra_load",
      skillId: "load_infrastructure",
      label: "Load infrastructure database",
      args: { filter: { region: opts.region } },
      onError: "skip" as const,
    });
  }

  if (opts.includeClimate) {
    steps.push({
      id: "earthquakes",
      skillId: "fetch_earthquakes",
      label: "Fetch earthquakes near region",
      args: { minMagnitude: 4.0, limit: 10 },
      onError: "skip" as const,
    });
    steps.push({
      id: "exposure",
      skillId: "assess_exposure",
      label: "Assess hazard exposure",
      dependsOn: ["earthquakes"],
      args: { events: "{{earthquakes.result}}", assets: [] },
      onError: "skip" as const,
    });
  }

  const depIds = steps.map(s => s.id);

  steps.push({
    id: "assess",
    skillId: "ask_claude",
    label: "Produce threat assessment",
    dependsOn: depIds,
    args: {
      prompt: `You are a threat analyst. Produce a structured regional threat assessment for: ${opts.region}.

Data:
${depIds.map(id => `- ${id}: {{${id}.result}}`).join("\n")}

Output format:
## Threat Level: [CRITICAL|HIGH|MODERATE|LOW]

## Summary
(2-3 sentences)

## Active Threats
(table: threat, severity, trend, confidence)

## Convergence Zones
(areas where multiple threat types overlap)

## Infrastructure Vulnerabilities
(if included)

## Climate Hazards
(if included)

## Assessment Confidence
(data quality notes)`,
    },
  });

  return {
    id: `osint-threat-assess-${Date.now()}`,
    name: `Threat Assessment — ${opts.region}`,
    maxConcurrency: 6,
    steps,
  };
}

export function buildMarketSnapshotWorkflow(
  opts: z.infer<typeof OsintMarketSnapshotInputSchema>,
): WorkflowDefinition {
  const steps: WorkflowDefinition["steps"] = [];

  // Fetch quotes in parallel
  for (const symbol of opts.symbols.slice(0, 10)) {
    steps.push({
      id: `quote_${symbol.replace(/[^a-zA-Z0-9]/g, "_")}`,
      skillId: "fetch_quote",
      label: `Fetch quote: ${symbol}`,
      args: { symbol },
      onError: "skip" as const,
    });
  }

  const quoteStepIds = opts.symbols.slice(0, 10).map(s => `quote_${s.replace(/[^a-zA-Z0-9]/g, "_")}`);

  if (opts.detectAnomalies) {
    steps.push({
      id: "anomalies",
      skillId: "detect_anomalies",
      label: "Detect market anomalies",
      args: {
        assets: opts.symbols.map((s, i) => ({
          symbol: s,
          quote: `{{${quoteStepIds[i]}.result}}`,
        })),
      },
      dependsOn: quoteStepIds,
      onError: "skip" as const,
    });
  }

  if (opts.symbols.length >= 2) {
    steps.push({
      id: "correlation",
      skillId: "correlation",
      label: "Compute correlation matrix",
      args: {
        series: opts.symbols.map((s, i) => ({
          symbol: s,
          quote: `{{${quoteStepIds[i]}.result}}`,
        })),
      },
      dependsOn: quoteStepIds,
      onError: "skip" as const,
    });

    // Cross-reference with news signals for market-news divergence detection
    steps.push({
      id: "news_check",
      skillId: "detect_signals",
      label: "Check news signals for market context",
      args: { articles: [], baselineHours: 24, spikeMultiplier: 3, symbols: opts.symbols },
      onError: "skip" as const,
    });
  }

  const depIds = steps.map(s => s.id);

  steps.push({
    id: "summarize",
    skillId: "ask_claude",
    label: "Summarize market snapshot",
    dependsOn: depIds,
    args: {
      prompt: `You are a market analyst. Summarize the following market data into a concise snapshot.

Symbols: ${opts.symbols.join(", ")}
${depIds.map(id => `- ${id}: {{${id}.result}}`).join("\n")}

Output format:
## Market Snapshot
| Symbol | Price | Change | Signal |
|--------|-------|--------|--------|
(table rows)

## Anomalies Detected
(if any)

## Correlations
(notable pairs)

## Key Takeaways
(2-3 bullet points)`,
    },
  });

  return {
    id: `osint-market-snapshot-${Date.now()}`,
    name: `Market Snapshot — ${opts.symbols.join(", ")}`,
    maxConcurrency: 10,
    steps,
  };
}

export function buildFreshnessReport(
  opts: z.infer<typeof OsintFreshnessInputSchema>,
): { status: string; sources: Array<{ id: string; name: string; lastUpdated: string; ageMinutes: number; status: string; essential: boolean }>; staleCount: number; essentialStaleCount: number } {
  const now = Date.now();
  const maxMs = (opts.maxStaleMinutes ?? 60) * 60_000;

  // Default OSINT sources if none provided
  const defaultSources = [
    { id: "news-rss", name: "News RSS Feeds", lastUpdated: new Date(now - 15 * 60_000).toISOString(), essential: true },
    { id: "market-quotes", name: "Market Quotes", lastUpdated: new Date(now - 5 * 60_000).toISOString(), essential: true },
    { id: "usgs-earthquakes", name: "USGS Earthquakes", lastUpdated: new Date(now - 30 * 60_000).toISOString(), essential: false },
    { id: "nasa-firms", name: "NASA FIRMS Wildfires", lastUpdated: new Date(now - 45 * 60_000).toISOString(), essential: false },
    { id: "acled-conflicts", name: "ACLED Conflicts", lastUpdated: new Date(now - 120 * 60_000).toISOString(), essential: true },
    { id: "ais-vessels", name: "AIS Vessel Tracking", lastUpdated: new Date(now - 10 * 60_000).toISOString(), essential: false },
  ];

  const sources = (opts.sources && opts.sources.length > 0 ? opts.sources : defaultSources).map(s => {
    const ageMs = now - new Date(s.lastUpdated).getTime();
    const ageMinutes = Math.round(ageMs / 60_000);
    let status: string;
    if (ageMs <= maxMs) status = "fresh";
    else if (ageMs <= maxMs * 3) status = "stale";
    else status = "very_stale";
    return {
      id: s.id,
      name: s.name,
      lastUpdated: s.lastUpdated,
      ageMinutes,
      status,
      essential: s.essential ?? false,
    };
  });

  const staleCount = sources.filter(s => s.status !== "fresh").length;
  const essentialStaleCount = sources.filter(s => s.essential && s.status !== "fresh").length;
  const overallStatus = essentialStaleCount > 0 ? "degraded" : staleCount > 0 ? "warning" : "healthy";

  return { status: overallStatus, sources, staleCount, essentialStaleCount };
}

// ── Dashboard Snapshot (for resource) ────────────────────────────

export function getOsintDashboard(): Record<string, unknown> {
  const freshness = buildFreshnessReport({});
  return {
    timestamp: new Date().toISOString(),
    overallStatus: freshness.status,
    dataFreshness: {
      status: freshness.status,
      staleCount: freshness.staleCount,
      essentialStaleCount: freshness.essentialStaleCount,
      sources: freshness.sources,
    },
    workers: {
      news: { port: 8089, skills: ["fetch_rss", "aggregate_feeds", "classify_news", "cluster_news", "detect_signals"] },
      market: { port: 8090, skills: ["fetch_quote", "price_history", "technical_analysis", "screen_market", "detect_anomalies", "correlation", "market_composite"] },
      signal: { port: 8091, skills: ["aggregate_signals", "classify_threat", "detect_convergence", "baseline_compare", "instability_index", "correlate_signals", "fetch_cyber_c2", "fetch_malicious_urls", "fetch_outages"] },
      monitor: { port: 8092, skills: ["track_conflicts", "detect_surge", "theater_posture", "track_vessels", "check_freshness", "watchlist_check", "fetch_conflicts", "fetch_flights"] },
      infra: { port: 8093, skills: ["cascade_analysis", "supply_chain_map", "chokepoint_assess", "redundancy_score", "dependency_graph", "load_infrastructure"] },
      climate: { port: 8094, skills: ["fetch_earthquakes", "fetch_wildfires", "fetch_natural_events", "assess_exposure", "climate_anomalies", "event_correlate"] },
    },
    availableTools: [
      "osint_brief",
      "osint_alert_scan",
      "osint_threat_assess",
      "osint_market_snapshot",
      "osint_freshness",
    ],
  };
}

// ── Workflow Templates (for agency-product) ──────────────────────

export interface OsintWorkflowTemplate {
  id: string;
  name: string;
  outcome: string;
  notes: string[];
  workflow: WorkflowDefinition;
}

export function getOsintWorkflowTemplates(): OsintWorkflowTemplate[] {
  return [
    {
      id: "osint-intelligence-gather",
      name: "OSINT Intelligence Gathering",
      outcome: "Aggregate news, market data, and signals into a classified threat assessment.",
      notes: [
        "Runs news, market, and signal workers in parallel, then classifies threats.",
        "Customize the RSS feeds and symbols in step args for your use case.",
      ],
      workflow: {
        id: "osint-intelligence-gather-template",
        name: "Intelligence Gathering",
        description: "Multi-source OSINT collection with signal aggregation and threat classification.",
        maxConcurrency: 4,
        steps: [
          {
            id: "news_collect",
            skillId: "aggregate_feeds",
            label: "Aggregate news feeds",
            args: { feeds: ["https://feeds.bbci.co.uk/news/world/rss.xml"], limit: 20 },
            onError: "skip" as const,
          },
          {
            id: "market_screen",
            skillId: "screen_market",
            label: "Screen market for moves",
            args: { assets: [] },
            onError: "skip" as const,
          },
          {
            id: "signal_agg",
            skillId: "aggregate_signals",
            label: "Aggregate signals",
            args: { signals: [] },
            onError: "skip" as const,
          },
          {
            id: "classify",
            skillId: "classify_threat",
            label: "Classify threats from aggregated data",
            dependsOn: ["news_collect", "market_screen", "signal_agg"],
            args: { events: "{{signal_agg.result}}", news: "{{news_collect.result}}", market: "{{market_screen.result}}" },
          },
        ],
      },
    },
    {
      id: "osint-regional-monitor",
      name: "OSINT Regional Monitor",
      outcome: "Continuous regional monitoring combining conflict tracking, infrastructure risk, and natural events.",
      notes: [
        "Set the region in step args to focus on a specific area.",
        "Runs monitor, infra, and climate workers in parallel, then detects convergence.",
      ],
      workflow: {
        id: "osint-regional-monitor-template",
        name: "Regional Monitor",
        description: "Track conflicts, infrastructure risk, and climate events in a region, then detect convergence.",
        maxConcurrency: 4,
        steps: [
          {
            id: "conflicts",
            skillId: "track_conflicts",
            label: "Track active conflicts",
            args: {},
            onError: "skip" as const,
          },
          {
            id: "cascade",
            skillId: "cascade_analysis",
            label: "Analyze infrastructure cascade risk",
            args: { nodes: [], edges: [], failNodeId: "" },
            onError: "skip" as const,
          },
          {
            id: "events",
            skillId: "fetch_natural_events",
            label: "Fetch natural events",
            args: { limit: 15 },
            onError: "skip" as const,
          },
          {
            id: "convergence",
            skillId: "detect_convergence",
            label: "Detect signal convergence",
            dependsOn: ["conflicts", "cascade", "events"],
            args: { signals: "{{conflicts.result}}", cascadeData: "{{cascade.result}}", events: "{{events.result}}", radiusKm: 300, minTypes: 2 },
          },
        ],
      },
    },
    {
      id: "osint-supply-chain-risk",
      name: "OSINT Supply Chain Risk Assessment",
      outcome: "Assess supply chain vulnerability by combining market anomalies, chokepoint analysis, and climate exposure.",
      notes: [
        "Configure supply chain routes and chokepoints in step args.",
        "Useful for logistics and procurement risk management.",
      ],
      workflow: {
        id: "osint-supply-chain-risk-template",
        name: "Supply Chain Risk",
        description: "Cross-reference market anomalies with supply chain chokepoints and climate hazard exposure.",
        maxConcurrency: 4,
        steps: [
          {
            id: "anomalies",
            skillId: "detect_anomalies",
            label: "Detect market anomalies",
            args: { assets: [] },
            onError: "skip" as const,
          },
          {
            id: "supply_chain",
            skillId: "supply_chain_map",
            label: "Map supply chain routes",
            args: { routes: [] },
            onError: "skip" as const,
          },
          {
            id: "chokepoints",
            skillId: "chokepoint_assess",
            label: "Assess chokepoint vulnerability",
            args: { chokepoints: [] },
            onError: "skip" as const,
          },
          {
            id: "exposure",
            skillId: "assess_exposure",
            label: "Assess climate exposure",
            dependsOn: ["supply_chain"],
            args: { events: [], assets: "{{supply_chain.result}}" },
            onError: "skip" as const,
          },
          {
            id: "risk_score",
            skillId: "redundancy_score",
            label: "Score redundancy",
            dependsOn: ["supply_chain", "chokepoints", "exposure"],
            args: { supplyChain: "{{supply_chain.result}}", chokepoints: "{{chokepoints.result}}", exposure: "{{exposure.result}}", categories: ["cables", "ports", "power", "pipelines"] },
          },
        ],
      },
    },
  ];
}
