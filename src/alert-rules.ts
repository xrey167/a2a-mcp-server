// src/alert-rules.ts
// Persistent alert rules engine — evaluates event bus events against configurable
// rules and routes matching alerts to notification channels.
// Stored in SQLite at ~/.a2a-mcp/alerts.db.

import Database from "bun:sqlite";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { subscribe, unsubscribe, type AgentEvent } from "./event-bus.js";
import { notify } from "./notifications.js";

// ── Types ────────────────────────────────────────────────────────

export interface AlertCondition {
  /** Dot-path to the field in event data */
  field: string;
  /** Comparison operator */
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "exists";
  /** Value to compare against (not needed for "exists") */
  value?: string | number | boolean;
}

export interface AlertRule {
  id: string;
  name: string;
  /** Event bus topic pattern to match (supports wildcards) */
  topicPattern: string;
  /** Conditions that must ALL match (AND logic) */
  conditions: AlertCondition[];
  /** Notification channels to deliver to */
  channels: string[];
  /** Minimum ms between firings of this rule (default: 1h) */
  cooldownMs: number;
  /** Whether the rule is active */
  enabled: boolean;
  /** Custom message template (supports {{field}} placeholders) */
  messageTemplate?: string;
  /** Severity override */
  severity?: string;
  /** Created timestamp */
  createdAt: string;
  /** Last time this rule fired */
  lastFiredAt?: string;
  /** Total number of times fired */
  fireCount: number;
}

export type AlertRuleInput = Pick<AlertRule, "name" | "topicPattern" | "conditions" | "channels"> & {
  cooldownMs?: number;
  messageTemplate?: string;
  severity?: string;
  enabled?: boolean;
};

// ── Database ────────────────────────────────────────────────────

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  const dbPath = process.env.A2A_ALERTS_DB ?? join(process.env.HOME ?? homedir(), ".a2a-mcp", "alerts.db");
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  db = new Database(dbPath);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      topic_pattern TEXT NOT NULL,
      conditions TEXT NOT NULL,
      channels TEXT NOT NULL,
      cooldown_ms INTEGER NOT NULL DEFAULT 3600000,
      enabled INTEGER NOT NULL DEFAULT 1,
      message_template TEXT,
      severity TEXT,
      created_at TEXT NOT NULL,
      last_fired_at TEXT,
      fire_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS alert_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      event_topic TEXT NOT NULL,
      event_id TEXT NOT NULL,
      channels_notified TEXT NOT NULL,
      message TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alert_history_rule ON alert_history(rule_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alert_history_ts ON alert_history(timestamp)`);
  return db;
}

// ── Subscription Management ──────────────────────────────────────

const activeSubscriptions = new Map<string, string>(); // ruleId → subscriptionId

// ── Public API ───────────────────────────────────────────────────

/** Create a new alert rule. */
export function createAlertRule(input: AlertRuleInput): AlertRule {
  const d = getDb();
  const rule: AlertRule = {
    id: randomUUID().slice(0, 8),
    name: input.name,
    topicPattern: input.topicPattern,
    conditions: input.conditions,
    channels: input.channels,
    cooldownMs: input.cooldownMs ?? 3_600_000,
    enabled: input.enabled ?? true,
    messageTemplate: input.messageTemplate,
    severity: input.severity,
    createdAt: new Date().toISOString(),
    fireCount: 0,
  };

  d.run(
    `INSERT INTO alert_rules (id, name, topic_pattern, conditions, channels, cooldown_ms, enabled, message_template, severity, created_at, fire_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      rule.id, rule.name, rule.topicPattern,
      JSON.stringify(rule.conditions), JSON.stringify(rule.channels),
      rule.cooldownMs, rule.enabled ? 1 : 0,
      rule.messageTemplate ?? null, rule.severity ?? null,
      rule.createdAt,
    ],
  );

  if (rule.enabled) {
    activateRule(rule);
  }

  process.stderr.write(`[alert-rules] created rule: ${rule.id} (${rule.name})\n`);
  return rule;
}

/** Delete an alert rule. */
export function deleteAlertRule(id: string): boolean {
  deactivateRule(id);
  const d = getDb();
  const result = d.run(`DELETE FROM alert_rules WHERE id = ?`, [id]);
  return result.changes > 0;
}

/** Toggle a rule on/off. */
export function toggleAlertRule(id: string, enabled: boolean): AlertRule | null {
  const d = getDb();
  d.run(`UPDATE alert_rules SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]);

  const rule = getAlertRule(id);
  if (!rule) return null;

  if (enabled) {
    activateRule(rule);
  } else {
    deactivateRule(id);
  }

  return rule;
}

/** Get a single alert rule. */
export function getAlertRule(id: string): AlertRule | null {
  const d = getDb();
  const row = d.query<RuleRow, [string]>(
    `SELECT * FROM alert_rules WHERE id = ?`,
  ).get(id);
  return row ? rowToRule(row) : null;
}

/** List all alert rules. */
export function listAlertRules(): AlertRule[] {
  const d = getDb();
  const rows = d.query<RuleRow, []>(
    `SELECT * FROM alert_rules ORDER BY created_at DESC`,
  ).all();
  return rows.map(rowToRule);
}

/** Get alert history. */
export function getAlertHistory(opts?: { ruleId?: string; limit?: number }): Array<{
  ruleId: string;
  timestamp: string;
  eventTopic: string;
  eventId: string;
  channelsNotified: string[];
  message?: string;
}> {
  const d = getDb();
  const limit = opts?.limit ?? 50;

  const query = opts?.ruleId
    ? d.query<HistoryRow, [string, number]>(`SELECT * FROM alert_history WHERE rule_id = ? ORDER BY id DESC LIMIT ?`)
    : d.query<HistoryRow, [number]>(`SELECT * FROM alert_history ORDER BY id DESC LIMIT ?`);

  const rows = opts?.ruleId
    ? (query as ReturnType<typeof d.query<HistoryRow, [string, number]>>).all(opts.ruleId, limit)
    : (query as ReturnType<typeof d.query<HistoryRow, [number]>>).all(limit);

  return rows.map(r => ({
    ruleId: r.rule_id,
    timestamp: r.timestamp,
    eventTopic: r.event_topic,
    eventId: r.event_id,
    channelsNotified: JSON.parse(r.channels_notified),
    message: r.message ?? undefined,
  }));
}

/** Initialize all enabled rules (call on startup). */
export function initAlertRules(): void {
  const rules = listAlertRules();
  let activated = 0;
  for (const rule of rules) {
    if (rule.enabled) {
      activateRule(rule);
      activated++;
    }
  }
  process.stderr.write(`[alert-rules] initialized ${activated} active rules\n`);
}

/** Stop all rule subscriptions. */
export function stopAlertRules(): void {
  for (const [ruleId] of activeSubscriptions) {
    deactivateRule(ruleId);
  }
}

/** Close database. */
export function closeAlertRulesDb(): void {
  if (db) { db.close(); db = null; }
}

// ── Internal ─────────────────────────────────────────────────────

type RuleRow = {
  id: string; name: string; topic_pattern: string; conditions: string;
  channels: string; cooldown_ms: number; enabled: number;
  message_template: string | null; severity: string | null;
  created_at: string; last_fired_at: string | null; fire_count: number;
};

type HistoryRow = {
  id: number; rule_id: string; timestamp: string; event_topic: string;
  event_id: string; channels_notified: string; message: string | null;
};

function rowToRule(row: RuleRow): AlertRule {
  return {
    id: row.id,
    name: row.name,
    topicPattern: row.topic_pattern,
    conditions: JSON.parse(row.conditions),
    channels: JSON.parse(row.channels),
    cooldownMs: row.cooldown_ms,
    enabled: Boolean(row.enabled),
    messageTemplate: row.message_template ?? undefined,
    severity: row.severity ?? undefined,
    createdAt: row.created_at,
    lastFiredAt: row.last_fired_at ?? undefined,
    fireCount: row.fire_count,
  };
}

function activateRule(rule: AlertRule): void {
  // Don't double-subscribe
  if (activeSubscriptions.has(rule.id)) return;

  const subId = subscribe(rule.topicPattern, async (event: AgentEvent) => {
    await evaluateRule(rule.id, event);
  }, { name: `alert-rule-${rule.id}` });

  activeSubscriptions.set(rule.id, subId);
}

function deactivateRule(ruleId: string): void {
  const subId = activeSubscriptions.get(ruleId);
  if (subId) {
    unsubscribe(subId);
    activeSubscriptions.delete(ruleId);
  }
}

async function evaluateRule(ruleId: string, event: AgentEvent): Promise<void> {
  // Re-fetch from DB to get latest state (fire count, last fired, etc.)
  const rule = getAlertRule(ruleId);
  if (!rule || !rule.enabled) return;

  // Check cooldown
  if (rule.lastFiredAt) {
    const elapsed = Date.now() - new Date(rule.lastFiredAt).getTime();
    if (elapsed < rule.cooldownMs) return;
  }

  // Evaluate conditions
  if (!evaluateConditions(rule.conditions, event)) return;

  // Build message
  const message = rule.messageTemplate
    ? resolveTemplate(rule.messageTemplate, event)
    : formatDefaultMessage(rule, event);

  // Fire notification
  const result = await notify(message, {
    title: rule.name,
    severity: rule.severity ?? extractEventSeverity(event),
    channels: rule.channels,
    eventId: event.id,
    topic: event.topic,
  });

  // Update rule state
  const d = getDb();
  const now = new Date().toISOString();
  d.run(
    `UPDATE alert_rules SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?`,
    [now, ruleId],
  );

  // Log to history
  d.run(
    `INSERT INTO alert_history (rule_id, event_topic, event_id, channels_notified, message) VALUES (?, ?, ?, ?, ?)`,
    [ruleId, event.topic, event.id, JSON.stringify(result.sent), message],
  );

  // Prune history (keep last 1000 per rule)
  d.run(
    `DELETE FROM alert_history WHERE rule_id = ? AND id NOT IN (
      SELECT id FROM alert_history WHERE rule_id = ? ORDER BY id DESC LIMIT 1000
    )`,
    [ruleId, ruleId],
  );

  process.stderr.write(`[alert-rules] rule ${ruleId} fired → sent to: ${result.sent.join(", ")}\n`);
}

function evaluateConditions(conditions: AlertCondition[], event: AgentEvent): boolean {
  for (const cond of conditions) {
    const value = getNestedValue(event, cond.field);

    switch (cond.op) {
      case "exists":
        if (value === undefined || value === null) return false;
        break;
      case "eq":
        if (value !== cond.value) return false;
        break;
      case "neq":
        if (value === cond.value) return false;
        break;
      case "gt":
        if (typeof value !== "number" || typeof cond.value !== "number" || value <= cond.value) return false;
        break;
      case "gte":
        if (typeof value !== "number" || typeof cond.value !== "number" || value < cond.value) return false;
        break;
      case "lt":
        if (typeof value !== "number" || typeof cond.value !== "number" || value >= cond.value) return false;
        break;
      case "lte":
        if (typeof value !== "number" || typeof cond.value !== "number" || value > cond.value) return false;
        break;
      case "contains":
        if (typeof value !== "string" || typeof cond.value !== "string" || !value.includes(cond.value)) return false;
        break;
    }
  }
  return true;
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveTemplate(template: string, event: AgentEvent): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const value = getNestedValue(event, path.trim());
    return value !== undefined ? String(value) : `<${path.trim()}>`;
  });
}

function formatDefaultMessage(rule: AlertRule, event: AgentEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  const parts = [`Alert: ${rule.name}`, `Topic: ${event.topic}`, `Source: ${event.source}`, `Time: ${event.timestamp}`];

  if (data) {
    const preview = Object.entries(data)
      .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .slice(0, 10)
      .map(([k, v]) => `${k}: ${v}`);
    if (preview.length > 0) parts.push("", ...preview);
  }

  return parts.join("\n");
}

function extractEventSeverity(event: AgentEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  if (data?.severity && typeof data.severity === "string") return data.severity;
  if (event.topic.includes("critical")) return "critical";
  if (event.topic.includes("high")) return "high";
  return "medium";
}
