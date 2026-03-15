/**
 * Capability Negotiation — version-aware skill routing with SemVer matching.
 *
 * When multiple agents can handle the same skill, this module picks the best
 * one based on version compatibility, load, health, and declared capabilities.
 *
 * Features:
 *   - SemVer-compatible skill versioning
 *   - Capability requirements and matching
 *   - Load-aware routing (prefer less busy agents)
 *   - Health-aware routing (avoid unhealthy agents)
 *   - Feature flag support for gradual rollouts
 *
 * No other A2A project offers capability negotiation for skill routing.
 *
 * Usage:
 *   registerCapability("ask_claude", "ai-agent", {
 *     version: "2.1.0",
 *     features: ["streaming", "function_calling"],
 *     maxConcurrency: 5,
 *   });
 *   const best = negotiate("ask_claude", { minVersion: "2.0.0", requiredFeatures: ["streaming"] });
 */

// ── Types ────────────────────────────────────────────────────────

export interface AgentCapability {
  /** Skill ID */
  skillId: string;
  /** Agent name */
  agentName: string;
  /** Agent URL */
  agentUrl: string;
  /** SemVer version of this skill implementation */
  version: string;
  /** Feature flags this implementation supports */
  features: string[];
  /** Maximum concurrent calls this agent can handle for this skill */
  maxConcurrency: number;
  /** Current active call count */
  activeCalls: number;
  /** Priority (higher = preferred, default: 0) */
  priority: number;
  /** Whether this capability is enabled */
  enabled: boolean;
  /** Metadata */
  meta?: Record<string, unknown>;
  /** Last updated */
  updatedAt: number;
}

export interface NegotiationQuery {
  /** Minimum acceptable version (SemVer) */
  minVersion?: string;
  /** Maximum acceptable version (SemVer) */
  maxVersion?: string;
  /** Required features */
  requiredFeatures?: string[];
  /** Preferred features (used for scoring, not filtering) */
  preferredFeatures?: string[];
  /** Whether to consider agent health */
  healthAware?: boolean;
  /** Whether to consider agent load */
  loadAware?: boolean;
}

export interface NegotiationResult {
  /** Best matching capability */
  best: AgentCapability | null;
  /** All matching capabilities ranked by score */
  candidates: Array<{
    capability: AgentCapability;
    score: number;
    reasons: string[];
  }>;
  /** Why the best was chosen */
  reason: string;
}

// ── State ────────────────────────────────────────────────────────

// skillId → agentName → capability
const capabilities = new Map<string, Map<string, AgentCapability>>();
// agentName → healthy?
const healthStatus = new Map<string, boolean>();

// ── SemVer Utilities ─────────────────────────────────────────────

function parseSemVer(version: string): { major: number; minor: number; patch: number } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  if (!match[1] || !match[2] || !match[3]) return null;
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10), patch: parseInt(match[3], 10) };
}

function compareSemVer(a: string, b: string): number {
  const va = parseSemVer(a);
  const vb = parseSemVer(b);
  if (!va || !vb) return 0;
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  return va.patch - vb.patch;
}

function satisfiesVersion(version: string, minVersion?: string, maxVersion?: string): boolean {
  if (minVersion && compareSemVer(version, minVersion) < 0) return false;
  if (maxVersion && compareSemVer(version, maxVersion) > 0) return false;
  return true;
}

// ── Public API ───────────────────────────────────────────────────

/** Register a capability for an agent. */
export function registerCapability(
  skillId: string,
  agentName: string,
  opts: {
    agentUrl: string;
    version?: string;
    features?: string[];
    maxConcurrency?: number;
    priority?: number;
    meta?: Record<string, unknown>;
  },
): AgentCapability {
  let skillMap = capabilities.get(skillId);
  if (!skillMap) {
    skillMap = new Map();
    capabilities.set(skillId, skillMap);
  }

  const cap: AgentCapability = {
    skillId,
    agentName,
    agentUrl: opts.agentUrl,
    version: opts.version ?? "1.0.0",
    features: opts.features ?? [],
    maxConcurrency: opts.maxConcurrency ?? 10,
    activeCalls: 0,
    priority: opts.priority ?? 0,
    enabled: true,
    meta: opts.meta,
    updatedAt: Date.now(),
  };

  skillMap.set(agentName, cap);

  // Size guard: cap at 50 agents per skill to prevent unbounded Map growth
  if (skillMap.size > 50) {
    const oldest = skillMap.keys().next().value;
    if (oldest !== undefined) {
      skillMap.delete(oldest);
      process.stderr.write(`[capability] evicted oldest entry "${oldest}" for skill "${skillId}" (size cap 50)\n`);
    }
  }

  process.stderr.write(`[capability] registered ${agentName}:${skillId} v${cap.version} (features: ${cap.features.join(",")})\n`);
  return cap;
}

/** Update agent health status. */
export function updateAgentHealth(agentName: string, healthy: boolean): void {
  healthStatus.set(agentName, healthy);
}

/** Increment active call count for a capability. */
export function incrementActive(skillId: string, agentName: string): void {
  const cap = capabilities.get(skillId)?.get(agentName);
  if (cap) cap.activeCalls++;
}

/** Decrement active call count for a capability. */
export function decrementActive(skillId: string, agentName: string): void {
  const cap = capabilities.get(skillId)?.get(agentName);
  if (cap && cap.activeCalls > 0) cap.activeCalls--;
}

/** Enable or disable a capability. */
export function setCapabilityEnabled(skillId: string, agentName: string, enabled: boolean): boolean {
  const cap = capabilities.get(skillId)?.get(agentName);
  if (!cap) return false;
  cap.enabled = enabled;
  return true;
}

/** Negotiate the best agent for a skill. */
export function negotiate(skillId: string, query?: NegotiationQuery): NegotiationResult {
  const skillMap = capabilities.get(skillId);
  if (!skillMap || skillMap.size === 0) {
    return { best: null, candidates: [], reason: `No capabilities registered for skill: ${skillId}` };
  }

  const q = query ?? {};
  const candidates: NegotiationResult["candidates"] = [];

  for (const [, cap] of skillMap) {
    if (!cap.enabled) continue;

    const reasons: string[] = [];
    let score = 0;

    // Version check
    if (!satisfiesVersion(cap.version, q.minVersion, q.maxVersion)) {
      continue; // hard filter
    }
    // Higher version gets a small bonus
    const ver = parseSemVer(cap.version);
    if (ver) {
      score += ver.major * 10 + ver.minor * 1 + ver.patch * 0.1;
      reasons.push(`version ${cap.version}`);
    }

    // Required features check
    if (q.requiredFeatures) {
      const missing = q.requiredFeatures.filter(f => !cap.features.includes(f));
      if (missing.length > 0) continue; // hard filter
      score += q.requiredFeatures.length * 5;
      reasons.push(`has required features`);
    }

    // Preferred features (bonus, not filter)
    if (q.preferredFeatures) {
      const matched = q.preferredFeatures.filter(f => cap.features.includes(f));
      score += matched.length * 3;
      if (matched.length > 0) reasons.push(`${matched.length} preferred features`);
    }

    // Health check
    if (q.healthAware !== false) {
      const healthy = healthStatus.get(cap.agentName) ?? true;
      if (!healthy) {
        score -= 100;
        reasons.push("unhealthy");
      } else {
        score += 10;
        reasons.push("healthy");
      }
    }

    // Load check
    if (q.loadAware !== false) {
      const loadFactor = cap.maxConcurrency > 0 ? cap.activeCalls / cap.maxConcurrency : 0;
      if (loadFactor >= 1) {
        score -= 50;
        reasons.push("at capacity");
      } else {
        score += (1 - loadFactor) * 20;
        reasons.push(`load ${(loadFactor * 100).toFixed(0)}%`);
      }
    }

    // Priority bonus
    score += cap.priority * 10;
    if (cap.priority > 0) reasons.push(`priority ${cap.priority}`);

    candidates.push({ capability: cap, score, reasons });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const best = top?.capability ?? null;
  const reason = best && top
    ? `Selected ${best.agentName} (score: ${top.score.toFixed(1)}, ${top.reasons.join(", ")})`
    : "No matching capabilities found";

  return { best, candidates, reason };
}

/** List all registered capabilities. */
export function listCapabilities(skillId?: string): AgentCapability[] {
  const result: AgentCapability[] = [];

  if (skillId) {
    const skillMap = capabilities.get(skillId);
    if (skillMap) {
      for (const cap of skillMap.values()) result.push(cap);
    }
  } else {
    for (const [, skillMap] of capabilities) {
      for (const cap of skillMap.values()) result.push(cap);
    }
  }

  return result;
}

/** Get capability negotiation stats. */
export function getCapabilityStats(): {
  totalSkills: number;
  totalCapabilities: number;
  agentsWithCapabilities: number;
  skillsWithMultipleProviders: number;
} {
  const agents = new Set<string>();
  let totalCaps = 0;
  let multiProvider = 0;

  for (const [, skillMap] of capabilities) {
    totalCaps += skillMap.size;
    if (skillMap.size > 1) multiProvider++;
    for (const cap of skillMap.values()) {
      agents.add(cap.agentName);
    }
  }

  return {
    totalSkills: capabilities.size,
    totalCapabilities: totalCaps,
    agentsWithCapabilities: agents.size,
    skillsWithMultipleProviders: multiProvider,
  };
}

/**
 * Prune capabilities: remove any skill entry where ALL registered agents have enabled: false.
 * Call this after each bulk discovery cycle to keep the Map tidy.
 */
export function pruneCapabilities(): void {
  for (const [skillId, skillMap] of capabilities) {
    const allDisabled = [...skillMap.values()].every(cap => !cap.enabled);
    if (allDisabled) {
      capabilities.delete(skillId);
      process.stderr.write(`[capability] pruned skill "${skillId}" — all agents disabled\n`);
    }
  }
}

/** Reset all capabilities (for testing). */
export function resetCapabilities(): void {
  capabilities.clear();
  healthStatus.clear();
}
