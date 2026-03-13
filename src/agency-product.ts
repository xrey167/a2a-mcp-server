import { auditQuery, auditStats, type AuditEntry } from "./audit.js";
import { getTokenStats } from "./token-tracker.js";

interface AgencyWorkflowTemplate {
  id: string;
  name: string;
  outcome: string;
  notes: string[];
  workflow: {
    id: string;
    name: string;
    description: string;
    maxConcurrency: number;
    steps: Array<{
      id: string;
      skillId: string;
      label: string;
      args?: Record<string, unknown>;
      dependsOn?: string[];
      onError?: "fail" | "skip" | "retry";
      maxRetries?: number;
    }>;
  };
}

const AGENCY_WORKFLOW_TEMPLATES: AgencyWorkflowTemplate[] = [
  {
    id: "client-reporting",
    name: "Client Reporting Workflow",
    outcome: "Collect source data, analyze it, and draft a client-ready status update with KPIs.",
    notes: [
      "Set your own URLs, SQL, and report schema in the step args.",
      "Run through workflow_execute with these steps as a starting point.",
    ],
    workflow: {
      id: "client-reporting-template",
      name: "Client Reporting",
      description: "Recurring client reporting flow with data pull, analysis, and narrative generation.",
      maxConcurrency: 4,
      steps: [
        {
          id: "fetch_metrics",
          skillId: "fetch_url",
          label: "Fetch source metrics",
          args: { url: "https://example.com/client/metrics.json", format: "json" },
          onError: "retry",
          maxRetries: 2,
        },
        {
          id: "shape_metrics",
          skillId: "sandbox_execute",
          label: "Normalize metrics payload",
          dependsOn: ["fetch_metrics"],
          args: {
            code: "const payload = JSON.parse(String(await skill('fetch_url', { url: 'https://example.com/client/metrics.json', format: 'json' }))); return { total: payload.length ?? 0, sample: payload.slice?.(0, 5) ?? payload };",
          },
        },
        {
          id: "draft_report",
          skillId: "ask_claude",
          label: "Draft client report summary",
          dependsOn: ["shape_metrics"],
          args: {
            prompt: "Create a concise weekly client report from this data: {{shape_metrics.result}}. Include wins, risks, and next actions.",
          },
        },
      ],
    },
  },
  {
    id: "client-approval-gate",
    name: "Client Approval Gate Workflow",
    outcome: "Create deliverable draft, publish for approval, and track status with full auditability.",
    notes: [
      "Approval step is represented as a webhook handoff in this template.",
      "Pair with register_webhook + audit_query for explicit approval trails.",
    ],
    workflow: {
      id: "client-approval-template",
      name: "Client Approval Gate",
      description: "Prepare a deliverable and emit approval request event before handoff.",
      maxConcurrency: 3,
      steps: [
        {
          id: "generate_deliverable",
          skillId: "ask_claude",
          label: "Generate draft deliverable",
          args: {
            prompt: "Draft a client deliverable update using this scope: weekly campaign status, blockers, and next-week plan.",
          },
        },
        {
          id: "publish_approval_event",
          skillId: "event_publish",
          label: "Publish approval request event",
          dependsOn: ["generate_deliverable"],
          args: {
            topic: "user.approval.requested",
            data: {
              workflow: "client-approval-template",
              approver: "client-ops@example.com",
              content: "{{generate_deliverable.result}}",
            },
          },
        },
        {
          id: "record_audit_checkpoint",
          skillId: "audit_stats",
          label: "Record current audit stats snapshot",
          dependsOn: ["publish_approval_event"],
          onError: "skip",
        },
      ],
    },
  },
  {
    id: "client-handoff",
    name: "Client Handoff Workflow",
    outcome: "Package approved output, log handoff artifacts, and notify stakeholders.",
    notes: [
      "Use workspace_manage and knowledge skills for per-client artifact storage.",
      "This template focuses on traceable final handoff status.",
    ],
    workflow: {
      id: "client-handoff-template",
      name: "Client Handoff",
      description: "Bundle final output, store handoff note, and notify stakeholders.",
      maxConcurrency: 3,
      steps: [
        {
          id: "summarize_final_output",
          skillId: "ask_claude",
          label: "Summarize final output",
          args: {
            prompt: "Summarize final deliverable for client handoff. Include scope, outcomes, and follow-up tasks.",
          },
        },
        {
          id: "store_handoff_note",
          skillId: "create_note",
          label: "Store handoff note",
          dependsOn: ["summarize_final_output"],
          args: {
            title: "Client Handoff - {{summarize_final_output.result}}",
            content: "{{summarize_final_output.result}}",
          },
        },
        {
          id: "emit_handoff_event",
          skillId: "event_publish",
          label: "Emit handoff completed event",
          dependsOn: ["store_handoff_note"],
          args: {
            topic: "user.handoff.completed",
            data: {
              workflow: "client-handoff-template",
              status: "completed",
              artifactRef: "{{store_handoff_note.result}}",
            },
          },
        },
      ],
    },
  },
  // ── OSINT Agency Templates ─────────────────────────────────────
  {
    id: "osint-daily-brief",
    name: "OSINT Daily Intelligence Brief",
    outcome: "Automated daily intelligence brief aggregating news, threats, market anomalies, and climate events.",
    notes: [
      "Orchestrates all 6 OSINT workers in parallel, then synthesizes findings with AI.",
      "Use osint_brief tool directly or run this template via workflow_execute.",
      "Customize region and sources in step args for client-specific briefs.",
    ],
    workflow: {
      id: "osint-daily-brief-template",
      name: "Daily Intelligence Brief",
      description: "Multi-source OSINT collection and synthesis for daily delivery.",
      maxConcurrency: 6,
      steps: [
        {
          id: "news_signals",
          skillId: "detect_signals",
          label: "Detect news signals",
          args: { articles: [] },
          onError: "skip" as const,
        },
        {
          id: "market_screen",
          skillId: "screen_market",
          label: "Screen market anomalies",
          args: { assets: [] },
          onError: "skip" as const,
        },
        {
          id: "signal_agg",
          skillId: "aggregate_signals",
          label: "Aggregate multi-source signals",
          args: { signals: [] },
          onError: "skip" as const,
        },
        {
          id: "conflicts",
          skillId: "track_conflicts",
          label: "Track active conflicts",
          args: {},
          onError: "skip" as const,
        },
        {
          id: "infra_risk",
          skillId: "redundancy_score",
          label: "Score infrastructure redundancy",
          args: { categories: ["cables", "ports", "power", "pipelines"] },
          onError: "skip" as const,
        },
        {
          id: "climate_events",
          skillId: "fetch_natural_events",
          label: "Fetch natural events",
          args: { limit: 20 },
          onError: "skip" as const,
        },
        {
          id: "synthesize",
          skillId: "ask_claude",
          label: "Synthesize daily brief",
          dependsOn: ["news_signals", "market_screen", "signal_agg", "conflicts", "infra_risk", "climate_events"],
          args: {
            prompt: "Synthesize a daily intelligence brief from: news={{news_signals.result}}, market={{market_screen.result}}, signals={{signal_agg.result}}, conflicts={{conflicts.result}}, infra={{infra_risk.result}}, climate={{climate_events.result}}. Structure: Executive Summary, Key Threats, Market Signals, Infrastructure Risk, Climate Events, Recommended Actions.",
          },
        },
      ],
    },
  },
  {
    id: "osint-threat-monitor",
    name: "OSINT Threat Monitoring Workflow",
    outcome: "Continuous threat monitoring with alert generation and convergence detection.",
    notes: [
      "Monitors signals, conflicts, and military activity for a region.",
      "Detects convergence where multiple threat types cluster geographically.",
      "Use with event_subscribe to trigger alerts on high-severity findings.",
    ],
    workflow: {
      id: "osint-threat-monitor-template",
      name: "Threat Monitor",
      description: "Regional threat monitoring with convergence detection and instability scoring.",
      maxConcurrency: 4,
      steps: [
        {
          id: "signals",
          skillId: "aggregate_signals",
          label: "Aggregate threat signals",
          args: { signals: [] },
          onError: "skip" as const,
        },
        {
          id: "conflicts",
          skillId: "track_conflicts",
          label: "Track active conflicts",
          args: {},
          onError: "skip" as const,
        },
        {
          id: "surge",
          skillId: "detect_surge",
          label: "Detect military surges",
          args: { theater: "", current: {}, baseline: {} },
          onError: "skip" as const,
        },
        {
          id: "convergence",
          skillId: "detect_convergence",
          label: "Detect signal convergence",
          dependsOn: ["signals", "conflicts", "surge"],
          args: { signals: [], radiusKm: 300 },
        },
        {
          id: "alert",
          skillId: "event_publish",
          label: "Publish threat alert event",
          dependsOn: ["convergence"],
          args: {
            topic: "osint.threat.detected",
            data: {
              convergence: "{{convergence.result}}",
              timestamp: new Date().toISOString(),
            },
          },
          onError: "skip" as const,
        },
      ],
    },
  },
  {
    id: "osint-supply-chain-risk",
    name: "OSINT Supply Chain Risk Assessment",
    outcome: "Assess supply chain vulnerability across market, infrastructure, and climate dimensions.",
    notes: [
      "Cross-references market anomalies with chokepoints and climate exposure.",
      "Configure supply chain routes in the supply_chain_map step args.",
      "Score redundancy after aggregating all risk factors.",
    ],
    workflow: {
      id: "osint-supply-chain-risk-template",
      name: "Supply Chain Risk Assessment",
      description: "Multi-dimensional supply chain risk scoring with market, infrastructure, and climate factors.",
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
          label: "Assess chokepoint risk",
          args: { chokepoints: [] },
          onError: "skip" as const,
        },
        {
          id: "climate_exposure",
          skillId: "assess_exposure",
          label: "Assess climate exposure",
          dependsOn: ["supply_chain"],
          args: { events: [], assets: [] },
          onError: "skip" as const,
        },
        {
          id: "risk_score",
          skillId: "redundancy_score",
          label: "Score redundancy",
          dependsOn: ["supply_chain", "chokepoints", "climate_exposure"],
          args: { categories: ["cables", "ports", "power", "pipelines"] },
        },
      ],
    },
  },
];

function parseSavingsRate(value: string): number {
  const n = Number(value.replace("%", ""));
  return Number.isFinite(n) ? n : 0;
}

function countRuns(entries: AuditEntry[]): { runsCompleted: number; runsFailed: number } {
  const trackedSkills = new Set(["workflow_execute", "execute_pipeline", "factory_workflow"]);
  let runsCompleted = 0;
  let runsFailed = 0;
  for (const e of entries) {
    if (!trackedSkills.has(e.skillId)) continue;
    if (e.success) runsCompleted++;
    else runsFailed++;
  }
  return { runsCompleted, runsFailed };
}

export function getAgencyWorkflowTemplates(): AgencyWorkflowTemplate[] {
  return AGENCY_WORKFLOW_TEMPLATES;
}

export function getAgencyProductSummary(): {
  positioning: string;
  coreJobToBeDone: string;
  offer: { package: string; targetPriceMonthly: string; setupFee: string };
  pilot: { duration: string; successCriteria: string[] };
} {
  return {
    positioning: "Cut recurring client-delivery ops time in 30 days.",
    coreJobToBeDone: "Recurring client delivery automation with traceable execution and approvals.",
    offer: {
      package: "Managed onboarding + managed cloud + weekly optimization",
      targetPriceMonthly: "EUR 1.5k-EUR 3k",
      setupFee: "One-time onboarding/setup fee",
    },
    pilot: {
      duration: "6 weeks",
      successCriteria: [
        "A non-technical ops lead launches one template workflow",
        "Every run is traceable (who, what, when, result)",
        "Workspace isolation prevents cross-client access",
      ],
    },
  };
}

export function getAgencyRoiSnapshot(input?: {
  since?: string;
  assumedMinutesSavedPerSuccessfulRun?: number;
  assumedManualStepsRemovedPerRun?: number;
}): Record<string, unknown> {
  const since = input?.since;
  const minutesSaved = input?.assumedMinutesSavedPerSuccessfulRun ?? 20;
  const stepsRemoved = input?.assumedManualStepsRemovedPerRun ?? 4;

  const entries = auditQuery({ since, limit: 1000 });
  const stats = auditStats(since);
  const token = getTokenStats({ since });
  const { runsCompleted, runsFailed } = countRuns(entries);
  const totalRuns = runsCompleted + runsFailed;
  const failureRate = totalRuns > 0 ? Number(((runsFailed / totalRuns) * 100).toFixed(1)) : 0;
  const estimatedHoursSaved = Number(((runsCompleted * minutesSaved) / 60).toFixed(1));
  const manualStepsRemoved = runsCompleted * stepsRemoved;

  return {
    timeframe: since ? { since } : { since: "all_time" },
    outcomes: {
      runsCompleted,
      runsFailed,
      failureRatePct: failureRate,
      manualStepsRemoved,
      estimatedHoursSaved,
    },
    operations: {
      successRatePct: Number((stats.successRate * 100).toFixed(1)),
      avgDurationMs: Math.round(stats.avgDurationMs),
      topSkills: stats.topSkills.slice(0, 5),
    },
    tokenSavings: {
      totalSavedTokens: token.totalSavedTokens,
      savingsRatePct: parseSavingsRate(token.savingsRate),
      topSkills: token.topSkills.slice(0, 5),
    },
    assumptions: {
      assumedMinutesSavedPerSuccessfulRun: minutesSaved,
      assumedManualStepsRemovedPerRun: stepsRemoved,
    },
  };
}
