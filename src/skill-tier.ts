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

  // Pro tier — advanced workflows & collaboration
  workflow_execute: "pro",
  compose_pipeline: "pro",
  execute_pipeline: "pro",
  collaborate: "pro",
  factory_workflow: "pro",
  event_publish: "pro",
  event_subscribe: "pro",
  event_replay: "pro",

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
