// src/auth.ts
// Role-based access control (RBAC) and API key management.
// Keys and roles are stored in ~/.a2a-mcp/auth.json (mode 0o600).

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes, createHash } from "crypto";

const AUTH_DIR = join(process.env.HOME ?? homedir(), ".a2a-mcp");
const AUTH_FILE = join(AUTH_DIR, "auth.json");

// ── Types ────────────────────────────────────────────────────────

export type Role = "admin" | "operator" | "viewer";

export interface ApiKeyEntry {
  /** Display name / description */
  name: string;
  /** SHA-256 hash of the key (we never store plaintext) */
  keyHash: string;
  /** Prefix for display (e.g. "a2a_k_abc1") */
  prefix: string;
  role: Role;
  /** Optional workspace scoping */
  workspace?: string;
  /** Skill allowlist — if set, only these skills can be called */
  allowedSkills?: string[];
  /** Skill denylist — these skills are blocked */
  deniedSkills?: string[];
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
}

export interface AuthStore {
  keys: ApiKeyEntry[];
}

// ── Role permissions ────────────────────────────────────────────

const ROLE_PERMISSIONS: Record<Role, Set<string>> = {
  admin: new Set(["*"]),
  operator: new Set([
    "delegate", "list_agents", "register_agent", "unregister_agent",
    "sandbox_execute", "sandbox_vars", "workflow_execute",
    "agency_workflow_templates", "agency_roi_snapshot",
    "erp_connector_connect", "erp_connector_sync", "erp_connector_status", "erp_connector_renew", "erp_connector_renew_due", "erp_workflow_run", "erp_kpis", "erp_connector_kpis", "erp_connector_renewals", "erp_connector_renewals_export", "erp_connector_renewals_snapshot", "erp_connector_renewals_verify", "erp_connector_trust_report", "erp_connector_sales_packet", "erp_pilot_readiness", "erp_launch_pilot", "erp_pilot_launches", "erp_onboarding_create", "erp_onboarding_capture", "erp_onboarding_report", "erp_onboarding_list", "erp_commercial_event_record", "erp_commercial_kpis", "erp_workflow_sla_status", "erp_workflow_sla_escalate", "erp_workflow_sla_incidents", "erp_workflow_sla_incident_update", "erp_q2o_quote_sync", "erp_q2o_order_sync", "erp_q2o_approval_decision", "erp_q2o_pipeline", "erp_master_data_sync", "erp_master_data_mappings", "erp_master_data_mapping_update", "erp_analytics_executive", "erp_analytics_ops",
    "compose_pipeline", "execute_pipeline", "list_pipelines",
    "collaborate", "event_publish", "event_subscribe", "event_replay",
    "cache_stats", "cache_invalidate", "cache_configure",
    "get_metrics", "list_traces", "get_trace", "search_traces",
    "negotiate_capability", "list_capabilities",
    "remember", "recall",
  ]),
  viewer: new Set([
    "delegate", "list_agents",
    "agency_workflow_templates", "agency_roi_snapshot",
    "erp_connector_status", "erp_kpis", "erp_connector_kpis", "erp_connector_renewals", "erp_connector_renewals_export", "erp_connector_renewals_verify", "erp_connector_trust_report", "erp_connector_sales_packet", "erp_pilot_readiness", "erp_pilot_launches", "erp_onboarding_report", "erp_onboarding_list", "erp_commercial_kpis", "erp_workflow_sla_status", "erp_workflow_sla_incidents", "erp_q2o_pipeline", "erp_master_data_mappings", "erp_analytics_executive", "erp_analytics_ops",
    "get_metrics", "list_traces", "get_trace", "search_traces",
    "cache_stats", "list_capabilities", "capability_stats",
    "recall",
  ]),
};

// ── File I/O ────────────────────────────────────────────────────

/** In-memory cache of the auth store — populated on first read, updated on every write. */
let authCache: AuthStore | null = null;
/** Last observed file signature for AUTH_FILE so we can detect out-of-process edits. */
let authCacheSignature: string | null = null;

function getAuthFileSignature(): string | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    const stat = statSync(AUTH_FILE);
    // Include inode so same-millisecond same-size edits are detected
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function readStore(): AuthStore {
  const diskSignature = getAuthFileSignature();
  if (authCache !== null) {
    // Detect external deletion (e.g., in tests or manual cleanup):
    // if the backing file was removed since last cache load, reset the cache.
    if (diskSignature === null) {
      authCache = { keys: [] };
      authCacheSignature = null;
      return authCache;
    }
    // Detect external modifications (e.g. CLI edits while server is running).
    if (authCacheSignature !== diskSignature) {
      try {
        authCache = JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as AuthStore;
      } catch (e) {
        process.stderr.write(`[auth] failed to parse key store on reload, resetting: ${e}\n`);
        authCache = { keys: [] };
      }
      authCacheSignature = diskSignature;
    }
    return authCache;
  }
  if (diskSignature === null) {
    authCache = { keys: [] };
    authCacheSignature = null;
    return authCache;
  }
  try {
    authCache = JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as AuthStore;
    authCacheSignature = diskSignature;
    return authCache;
  } catch (e) {
    process.stderr.write(`[auth] failed to read key store, resetting: ${e}\n`);
    authCache = { keys: [] };
    authCacheSignature = diskSignature;
    return authCache;
  }
}

function writeStore(store: AuthStore): void {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(AUTH_FILE, 0o600);
  authCache = store; // keep cache in sync after successful disk write
  authCacheSignature = getAuthFileSignature();
}

/**
 * Invalidate the in-memory auth cache (e.g. after an external edit to auth.json).
 * The next call to readStore() will re-read from disk.
 */
export function invalidateAuthCache(): void {
  authCache = null;
  authCacheSignature = null;
}

// ── Deferred lastUsedAt updates ─────────────────────────────────
// Accumulate lastUsedAt timestamps in memory and flush to disk periodically
// to avoid blocking the event loop with a synchronous write on every validation.

const pendingLastUsed = new Map<string, number>(); // keyHash → lastUsedAt
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 30_000; // flush at most once per 30 s

function scheduleDeferredFlush(): void {
  if (flushTimer !== null) return; // already scheduled
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPendingLastUsed();
  }, FLUSH_DELAY_MS);
  // Allow the process to exit even while the timer is pending.
  (flushTimer as { unref?: () => void }).unref?.();
}

/**
 * Flush all pending lastUsedAt updates to disk.
 * Called automatically on process "exit"; should also be called during
 * graceful shutdown so no usage data is lost.
 */
export function flushPendingLastUsed(): void {
  if (pendingLastUsed.size === 0) return;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const snapshot = new Map(pendingLastUsed);
  pendingLastUsed.clear();
  try {
    const store = readStore();
    let changed = false;
    for (const entry of store.keys) {
      const ts = snapshot.get(entry.keyHash);
      if (ts !== undefined) {
        entry.lastUsedAt = ts;
        changed = true;
      }
    }
    if (changed) writeStore(store);
  } catch (err: unknown) {
    // Best-effort: don't crash on flush errors, but surface them so operators can investigate.
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[auth] flushPendingLastUsed error: ${msg}\n`);
    // Re-queue the snapshot so that usage data is not lost and can be flushed later.
    for (const [keyHash, ts] of snapshot.entries()) {
      const existing = pendingLastUsed.get(keyHash);
      if (existing === undefined || ts > existing) {
        pendingLastUsed.set(keyHash, ts);
      }
    }
    // Schedule another deferred flush attempt.
    scheduleDeferredFlush();
  }
}

// Last-resort synchronous flush on normal process exit
process.on("exit", flushPendingLastUsed);

// ── Key helpers ─────────────────────────────────────────────────

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Generate a new API key. Returns the plaintext key (show once) and the entry.
 */
export function createApiKey(
  name: string,
  role: Role,
  opts?: { workspace?: string; allowedSkills?: string[]; deniedSkills?: string[]; ttlMs?: number }
): { key: string; entry: ApiKeyEntry } {
  const raw = randomBytes(32).toString("base64url");
  const key = `a2a_k_${raw}`;
  const entry: ApiKeyEntry = {
    name,
    keyHash: hashKey(key),
    prefix: key.slice(0, 12),
    role,
    workspace: opts?.workspace,
    allowedSkills: opts?.allowedSkills,
    deniedSkills: opts?.deniedSkills,
    createdAt: Date.now(),
    expiresAt: opts?.ttlMs ? Date.now() + opts.ttlMs : undefined,
  };
  const store = readStore();
  store.keys.push(entry);
  writeStore(store);
  return { key, entry };
}

/**
 * Look up an API key and return its entry if it exists and is not expired,
 * WITHOUT recording a lastUsedAt update. Use this for pure existence/validity
 * checks (e.g. auth middleware) to avoid double side-effects when the same
 * request later calls validateApiKey() to fetch the entry for RBAC purposes.
 */
export function lookupApiKey(key: string): ApiKeyEntry | null {
  const store = readStore();
  const hash = hashKey(key);
  const entry = store.keys.find(k => k.keyHash === hash);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) return null;
  return entry;
}

/**
 * Validate an API key and return its entry, or null if invalid/expired.
 * Also records a lastUsedAt update (deferred flush — no synchronous disk I/O).
 */
export function validateApiKey(key: string): ApiKeyEntry | null {
  const entry = lookupApiKey(key);
  if (!entry) return null;

  // Update lastUsedAt in memory and schedule a deferred flush to avoid
  // blocking the event loop with a synchronous file write on every call.
  const now = Date.now();
  entry.lastUsedAt = now;
  pendingLastUsed.set(entry.keyHash, now);
  scheduleDeferredFlush();
  return entry;
}

/**
 * Check if a role (or key entry) is allowed to invoke a given skill.
 */
export function isSkillAllowed(entry: ApiKeyEntry, skillId: string): boolean {
  // Admin can do everything
  if (entry.role === "admin") return true;

  // Check explicit deny list
  if (entry.deniedSkills?.includes(skillId)) return false;

  // Check explicit allow list (if set, acts as whitelist)
  if (entry.allowedSkills && entry.allowedSkills.length > 0) {
    return entry.allowedSkills.includes(skillId);
  }

  // Fall back to role permissions
  const perms = ROLE_PERMISSIONS[entry.role];
  return perms.has("*") || perms.has(skillId);
}

/**
 * Revoke an API key by prefix or name.
 */
export function revokeApiKey(prefixOrName: string): boolean {
  const store = readStore();
  const before = store.keys.length;
  store.keys = store.keys.filter(
    k => k.prefix !== prefixOrName && k.name !== prefixOrName
  );
  if (store.keys.length < before) {
    writeStore(store);
    return true;
  }
  return false;
}

/**
 * List all API keys (without hashes, for display).
 */
export function listApiKeys(): Array<Omit<ApiKeyEntry, "keyHash">> {
  const store = readStore();
  return store.keys.map(({ keyHash: _, ...rest }) => rest);
}

/**
 * Get the role permissions map (for introspection).
 */
export function getRolePermissions(): Record<Role, string[]> {
  const result: Record<string, string[]> = {};
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    result[role] = Array.from(perms);
  }
  return result as Record<Role, string[]>;
}
