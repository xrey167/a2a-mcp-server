// src/skill-tier.ts
// Open-core skill gating — free vs premium skill tiers.
// Premium skills require a valid license key or active subscription.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Types ────────────────────────────────────────────────────────

export type Tier = "free" | "pro" | "enterprise";

export interface LicenseInfo {
  tier: Tier;
  email?: string;
  expiresAt?: number;
  features?: string[];
}

// ── Skill tier map ──────────────────────────────────────────────
// Skills not listed here default to "free".

const SKILL_TIERS: Record<string, Tier> = {
  // Free tier — core orchestration
  delegate: "free",
  list_agents: "free",
  remember: "free",
  recall: "free",
  sandbox_execute: "free",
  sandbox_vars: "free",
  get_metrics: "free",
  cache_stats: "free",
  erp_connector_status: "free",
  erp_kpis: "free",
  erp_connector_kpis: "free",
  erp_connector_renewals: "free",
  erp_connector_renewals_export: "free",
  erp_connector_renewals_verify: "free",
  erp_connector_trust_report: "free",
  erp_connector_sales_packet: "free",
  erp_pilot_readiness: "free",
  erp_pilot_launches: "free",
  erp_onboarding_report: "free",
  erp_onboarding_list: "free",
  erp_commercial_kpis: "free",
  erp_workflow_sla_status: "free",
  erp_workflow_sla_incidents: "free",
  erp_q2o_pipeline: "free",
  erp_master_data_mappings: "free",
  erp_analytics_executive: "free",
  erp_analytics_ops: "free",
  erp_connector_renewals_snapshot: "pro",
  erp_launch_pilot: "pro",
  erp_onboarding_create: "pro",
  erp_onboarding_capture: "pro",
  erp_commercial_event_record: "pro",
  erp_workflow_sla_escalate: "pro",
  erp_workflow_sla_incident_update: "pro",
  erp_q2o_quote_sync: "pro",
  erp_q2o_order_sync: "pro",
  erp_q2o_approval_decision: "pro",
  erp_master_data_sync: "pro",
  erp_master_data_mapping_update: "pro",

  // Pro tier — advanced workflows & collaboration
  workflow_execute: "pro",
  compose_pipeline: "pro",
  execute_pipeline: "pro",
  collaborate: "pro",
  factory_workflow: "pro",
  event_publish: "pro",
  event_subscribe: "pro",
  event_replay: "pro",
  erp_connector_connect: "pro",
  erp_connector_sync: "pro",
  erp_connector_renew: "pro",
  erp_connector_renew_due: "pro",
  erp_workflow_run: "pro",

  // Pro tier — OSINT workers (news, market, signal, monitor, infra, climate)
  fetch_rss: "pro",
  aggregate_feeds: "pro",
  classify_news: "pro",
  cluster_news: "pro",
  detect_signals: "pro",
  fetch_quote: "pro",
  price_history: "pro",
  technical_analysis: "pro",
  screen_market: "pro",
  detect_anomalies: "pro",
  correlation: "pro",
  aggregate_signals: "pro",
  classify_threat: "pro",
  detect_convergence: "pro",
  baseline_compare: "pro",
  instability_index: "pro",
  track_conflicts: "pro",
  detect_surge: "pro",
  theater_posture: "pro",
  track_vessels: "pro",
  check_freshness: "pro",
  watchlist_check: "pro",
  cascade_analysis: "pro",
  supply_chain_map: "pro",
  chokepoint_assess: "pro",
  redundancy_score: "pro",
  dependency_graph: "pro",
  fetch_earthquakes: "pro",
  fetch_wildfires: "pro",
  fetch_natural_events: "pro",
  assess_exposure: "pro",
  climate_anomalies: "pro",
  event_correlate: "pro",

  // Enterprise tier — governance & observability
  register_webhook: "enterprise",
  negotiate_capability: "enterprise",
  list_traces: "enterprise",
  get_trace: "enterprise",
  search_traces: "enterprise",
  audit_query: "enterprise",
  audit_stats: "enterprise",
  workspace_manage: "enterprise",
};

const TIER_HIERARCHY: Record<Tier, number> = {
  free: 0,
  pro: 1,
  enterprise: 2,
};

// ── License loading ─────────────────────────────────────────────

const LICENSE_FILE = join(process.env.HOME ?? homedir(), ".a2a-mcp", "license.json");

const VALID_TIERS = new Set<string>(["free", "pro", "enterprise"]);

let cachedLicense: LicenseInfo | null = null;

function coerceLicense(raw: unknown): LicenseInfo {
  if (typeof raw !== "object" || raw === null) return { tier: "free" };
  const obj = raw as Record<string, unknown>;
  const tier: Tier = VALID_TIERS.has(String(obj.tier)) ? (obj.tier as Tier) : "free";
  if (tier !== obj.tier) {
    process.stderr.write(`[license] invalid tier "${String(obj.tier)}", defaulting to "free"\n`);
  }
  return {
    tier,
    ...(typeof obj.email === "string" && { email: obj.email }),
    ...(typeof obj.expiresAt === "number" && { expiresAt: obj.expiresAt }),
    ...(Array.isArray(obj.features) && (() => {
      const valid = obj.features.filter((f): f is string => typeof f === "string");
      if (valid.length !== obj.features.length) {
        process.stderr.write("[license] some feature entries were not strings and have been ignored\n");
      }
      return { features: valid };
    })()),
  };
}

export function loadLicense(): LicenseInfo {
  if (cachedLicense) return cachedLicense;

  // Environment variable override (for CI/Docker)
  if (process.env.A2A_LICENSE_KEY) {
    try {
      const decoded = JSON.parse(
        Buffer.from(process.env.A2A_LICENSE_KEY, "base64").toString("utf-8")
      );
      cachedLicense = coerceLicense(decoded);
      return cachedLicense;
    } catch {
      process.stderr.write("[license] invalid A2A_LICENSE_KEY format\n");
    }
  }

  // File-based license
  if (existsSync(LICENSE_FILE)) {
    try {
      cachedLicense = coerceLicense(JSON.parse(readFileSync(LICENSE_FILE, "utf-8")));
      return cachedLicense;
    } catch {
      process.stderr.write("[license] failed to parse license file\n");
    }
  }

  // Default: free tier
  cachedLicense = { tier: "free" };
  return cachedLicense;
}

/**
 * Check if the current license allows a skill.
 */
export function isSkillLicensed(skillId: string): boolean {
  const license = loadLicense();

  // Check expiry
  if (license.expiresAt && Date.now() > license.expiresAt) {
    return getSkillTier(skillId) === "free";
  }

  const requiredTier = getSkillTier(skillId);
  return TIER_HIERARCHY[license.tier] >= TIER_HIERARCHY[requiredTier];
}

/**
 * Get the tier required for a skill.
 */
export function getSkillTier(skillId: string): Tier {
  return SKILL_TIERS[skillId] ?? "free";
}

/**
 * Get all skills grouped by tier.
 */
export function getSkillsByTier(): Record<Tier, string[]> {
  const result: Record<Tier, string[]> = { free: [], pro: [], enterprise: [] };
  for (const [skill, tier] of Object.entries(SKILL_TIERS)) {
    result[tier].push(skill);
  }
  return result;
}

/**
 * Get the license info summary (safe for display).
 */
export function getLicenseInfo(): { tier: Tier; email?: string; expired: boolean; expiresAt?: string } {
  const license = loadLicense();
  return {
    tier: license.tier,
    email: license.email,
    expired: license.expiresAt ? Date.now() > license.expiresAt : false,
    expiresAt: license.expiresAt ? new Date(license.expiresAt).toISOString() : undefined,
  };
}

/**
 * Reset cached license (for testing).
 */
export function resetLicense(): void {
  cachedLicense = null;
}
