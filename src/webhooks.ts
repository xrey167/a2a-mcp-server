/**
 * Webhook Ingestion — accept incoming webhooks from external services
 * and trigger A2A tasks automatically.
 *
 * Webhooks are registered with a unique ID, a secret for HMAC validation,
 * and a mapping that describes which skill to invoke and how to transform
 * the webhook payload into skill arguments.
 *
 * Supports:
 *   - HMAC-SHA256 signature verification (X-Hub-Signature-256 header)
 *   - Payload transformation via simple field mappings
 *   - Automatic task creation with async execution
 *   - Webhook registration/unregistration via orchestrator skills
 */

import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { createLogger } from "./logger.js";

// ── Helpers ──────────────────────────────────────────────────────

const log = createLogger("webhooks");

function safeJsonParse(s: string, fallback: unknown = {}): unknown {
  try {
    const parsed: unknown = JSON.parse(s);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      log.warn("corrupted JSON in DB row (expected object)", { type: Array.isArray(parsed) ? "array" : typeof parsed, raw: s.slice(0, 100) });
      return fallback;
    }
    return parsed;
  } catch (err) {
    log.warn("corrupted JSON in DB row", { raw: s.slice(0, 100), error: String(err) });
    return fallback;
  }
}

// ── Types ────────────────────────────────────────────────────────

export interface WebhookConfig {
  id: string;
  /** Human-readable name */
  name: string;
  /** Secret for HMAC signature verification (optional) */
  secret?: string;
  /** Skill to invoke when webhook fires */
  skillId: string;
  /** Static args merged with transformed payload */
  staticArgs?: Record<string, unknown>;
  /** Field mappings: { targetField: "payload.path.to.value" } */
  fieldMappings?: Record<string, string>;
  /** Whether to run the task asynchronously (default: true) */
  async?: boolean;
  /** Created timestamp */
  createdAt: string;
  /** Whether this webhook is active */
  enabled: boolean;
}

/** Input type for registerWebhook — secret is mandatory to enforce HMAC authentication */
export type RegisterWebhookInput = Omit<WebhookConfig, "id" | "createdAt" | "enabled"> & { secret: string };

// ── Storage (SQLite) ─────────────────────────────────────────────

const dbPath = join(homedir(), ".a2a-webhooks.db");
const db = new Database(dbPath);
db.run("PRAGMA journal_mode=WAL");
db.run(`CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret TEXT,
  skill_id TEXT NOT NULL,
  static_args TEXT DEFAULT '{}',
  field_mappings TEXT DEFAULT '{}',
  async INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  enabled INTEGER DEFAULT 1
)`);

db.run(`CREATE TABLE IF NOT EXISTS webhook_log (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT,
  error TEXT,
  payload_size INTEGER DEFAULT 0
)`);

// ── CRUD ─────────────────────────────────────────────────────────

export function registerWebhook(config: RegisterWebhookInput): WebhookConfig {
  const id = randomUUID().slice(0, 8);
  const createdAt = new Date().toISOString();
  const webhook: WebhookConfig = {
    id,
    ...config,
    createdAt,
    enabled: true,
  };

  db.run(
    `INSERT INTO webhooks (id, name, secret, skill_id, static_args, field_mappings, async, created_at, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      webhook.id,
      webhook.name,
      webhook.secret ?? null,
      webhook.skillId,
      JSON.stringify(webhook.staticArgs ?? {}),
      JSON.stringify(webhook.fieldMappings ?? {}),
      webhook.async !== false ? 1 : 0,
      webhook.createdAt,
      1,
    ],
  );

  return webhook;
}

export function unregisterWebhook(id: string): boolean {
  const result = db.run(`DELETE FROM webhooks WHERE id = ?`, [id]);
  return result.changes > 0;
}

export function getWebhook(id: string): WebhookConfig | null {
  const row = db.query<{
    id: string; name: string; secret: string | null; skill_id: string;
    static_args: string; field_mappings: string; async: number;
    created_at: string; enabled: number;
  }, [string]>(`SELECT * FROM webhooks WHERE id = ?`).get(id);

  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    secret: row.secret ?? undefined,
    skillId: row.skill_id,
    staticArgs: safeJsonParse(row.static_args) as Record<string, unknown>,
    fieldMappings: safeJsonParse(row.field_mappings) as Record<string, string>,
    async: row.async === 1,
    createdAt: row.created_at,
    enabled: row.enabled === 1,
  };
}

export function listWebhooks(): WebhookConfig[] {
  const rows = db.query<{
    id: string; name: string; secret: string | null; skill_id: string;
    static_args: string; field_mappings: string; async: number;
    created_at: string; enabled: number;
  }, []>(`SELECT * FROM webhooks ORDER BY created_at DESC`).all();

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    secret: row.secret ?? undefined,
    skillId: row.skill_id,
    staticArgs: safeJsonParse(row.static_args) as Record<string, unknown>,
    fieldMappings: safeJsonParse(row.field_mappings) as Record<string, string>,
    async: row.async === 1,
    createdAt: row.created_at,
    enabled: row.enabled === 1,
  }));
}

export function toggleWebhook(id: string, enabled: boolean): boolean {
  const result = db.run(`UPDATE webhooks SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
  return result.changes > 0;
}

// ── Signature Verification ───────────────────────────────────────

export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  // Use crypto.timingSafeEqual for proper constant-time comparison
  const expectedBuf = Buffer.from(expected, "utf-8");
  const signatureBuf = Buffer.from(signature, "utf-8");
  if (expectedBuf.length !== signatureBuf.length) return false;
  return timingSafeEqual(expectedBuf, signatureBuf);
}

// ── Payload Transformation ───────────────────────────────────────

export function transformPayload(
  payload: unknown,
  fieldMappings: Record<string, string>,
  staticArgs: Record<string, unknown>,
): Record<string, unknown> {
  const args = { ...staticArgs };

  for (const [targetField, sourcePath] of Object.entries(fieldMappings)) {
    args[targetField] = getNestedValue(payload, sourcePath);
  }

  return args;
}

function getNestedValue(obj: unknown, path: string): unknown {
  const MAX_PATH_DEPTH = 10;
  const parts = path.split(".");
  if (parts.length > MAX_PATH_DEPTH) return undefined;
  let current = obj;
  for (const part of parts) {
    if (FORBIDDEN_KEYS.has(part)) return undefined;  // prevent prototype pollution via path
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

// ── Webhook Log ──────────────────────────────────────────────────

export function logWebhookCall(
  webhookId: string,
  status: "success" | "error" | "rejected",
  taskId?: string,
  error?: string,
  payloadSize?: number,
): void {
  db.run(
    `INSERT INTO webhook_log (id, webhook_id, received_at, status, task_id, error, payload_size) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), webhookId, new Date().toISOString(), status, taskId ?? null, error ?? null, payloadSize ?? 0],
  );

  // Prune old logs (keep last 1000 per webhook)
  db.run(
    `DELETE FROM webhook_log WHERE webhook_id = ? AND id NOT IN (
      SELECT id FROM webhook_log WHERE webhook_id = ? ORDER BY received_at DESC LIMIT 1000
    )`,
    [webhookId, webhookId],
  );
}

export function getWebhookLog(webhookId: string, limit = 20): Array<{
  id: string;
  receivedAt: string;
  status: string;
  taskId: string | null;
  error: string | null;
}> {
  return db.query<{
    id: string; received_at: string; status: string; task_id: string | null; error: string | null;
  }, [string, number]>(
    `SELECT id, received_at, status, task_id, error FROM webhook_log WHERE webhook_id = ? ORDER BY received_at DESC LIMIT ?`,
  ).all(webhookId, limit).map(r => ({
    id: r.id,
    receivedAt: r.received_at,
    status: r.status,
    taskId: r.task_id,
    error: r.error,
  }));
}
