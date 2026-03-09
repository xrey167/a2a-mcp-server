// src/audit.ts
// Enterprise audit logging — immutable, queryable log of all skill invocations.
// Stored in SQLite at ~/.a2a-mcp/audit.db.

import Database from "bun:sqlite";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";

// ── Types ────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  timestamp: string;
  /** API key prefix (or "anonymous" / "local") */
  actor: string;
  /** Role of the actor */
  role: string;
  /** Workspace ID if scoped */
  workspace?: string;
  /** Skill that was invoked */
  skillId: string;
  /** Target agent URL (if delegated) */
  agentUrl?: string;
  /** Whether the call succeeded */
  success: boolean;
  /** Duration in ms */
  durationMs?: number;
  /** Error message if failed */
  error?: string;
  /** Request args (truncated to 2KB for storage) */
  args?: string;
  /** Client IP (for HTTP requests) */
  clientIp?: string;
}

// ── Database ────────────────────────────────────────────────────

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  const dbPath = process.env.A2A_AUDIT_DB ?? join(process.env.HOME ?? homedir(), ".a2a-mcp", "audit.db");
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  db = new Database(dbPath);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      actor TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'unknown',
      workspace TEXT,
      skill_id TEXT NOT NULL,
      agent_url TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      duration_ms INTEGER,
      error TEXT,
      args TEXT,
      client_ip TEXT
    )
  `);
  // Migrate existing rows stored with SQLite's datetime() format ("YYYY-MM-DD HH:MM:SS")
  // to ISO-8601 UTC ("YYYY-MM-DDTHH:MM:SS.sssZ") so lexicographic comparisons are consistent.
  db.run(`
    UPDATE audit_log
    SET timestamp = strftime('%Y-%m-%dT%H:%M:%fZ', timestamp)
    WHERE timestamp NOT LIKE '%T%'
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_skill ON audit_log(skill_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_log(workspace)`);
  return db;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Log a skill invocation to the audit trail.
 */
export function auditLog(entry: Omit<AuditEntry, "id" | "timestamp">): void {
  try {
    const d = getDb();
    // Truncate args to 2KB
    const args = entry.args ? entry.args.slice(0, 2048) : null;
    // Always insert an explicit ISO-8601 UTC timestamp so that lexicographic
    // comparisons in auditQuery/auditStats/auditPrune work correctly.
    const timestamp = new Date().toISOString();
    d.run(
      `INSERT INTO audit_log (timestamp, actor, role, workspace, skill_id, agent_url, success, duration_ms, error, args, client_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        timestamp,
        entry.actor,
        entry.role,
        entry.workspace ?? null,
        entry.skillId,
        entry.agentUrl ?? null,
        entry.success ? 1 : 0,
        entry.durationMs ?? null,
        entry.error ?? null,
        args,
        entry.clientIp ?? null,
      ]
    );
  } catch (err) {
    process.stderr.write(`[audit] failed to write log: ${err}\n`);
  }
}

/**
 * Query audit logs with filters.
 */
export function auditQuery(filters: {
  actor?: string;
  skillId?: string;
  workspace?: string;
  since?: string;
  until?: string;
  success?: boolean;
  limit?: number;
  offset?: number;
}): AuditEntry[] {
  const d = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.actor) { conditions.push("actor = ?"); params.push(filters.actor); }
  if (filters.skillId) { conditions.push("skill_id = ?"); params.push(filters.skillId); }
  if (filters.workspace) { conditions.push("workspace = ?"); params.push(filters.workspace); }
  if (filters.since) { conditions.push("timestamp >= ?"); params.push(filters.since); }
  if (filters.until) { conditions.push("timestamp <= ?"); params.push(filters.until); }
  if (filters.success !== undefined) { conditions.push("success = ?"); params.push(filters.success ? 1 : 0); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters.limit ?? 100, 1000);
  const offset = filters.offset ?? 0;

  const rows = d.query(
    `SELECT id, timestamp, actor, role, workspace, skill_id as skillId, agent_url as agentUrl,
            success, duration_ms as durationMs, error, args, client_ip as clientIp
     FROM audit_log ${where}
     ORDER BY id DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as AuditEntry[];

  return rows.map(r => ({ ...r, success: Boolean(r.success) }));
}

/**
 * Get audit summary statistics.
 */
export function auditStats(since?: string): {
  totalCalls: number;
  successRate: number;
  topSkills: Array<{ skillId: string; count: number }>;
  topActors: Array<{ actor: string; count: number }>;
  avgDurationMs: number;
} {
  const d = getDb();
  const where = since ? "WHERE timestamp >= ?" : "";
  const params = since ? [since] : [];

  const total = d.query(`SELECT COUNT(*) as c FROM audit_log ${where}`).get(...params) as { c: number };
  const success = d.query(`SELECT COUNT(*) as c FROM audit_log ${where ? where + " AND" : "WHERE"} success = 1`).get(...params) as { c: number };
  const avgDur = d.query(`SELECT AVG(duration_ms) as avg FROM audit_log ${where}`).get(...params) as { avg: number | null };

  const topSkills = d.query(
    `SELECT skill_id as skillId, COUNT(*) as count FROM audit_log ${where} GROUP BY skill_id ORDER BY count DESC LIMIT 10`
  ).all(...params) as Array<{ skillId: string; count: number }>;

  const topActors = d.query(
    `SELECT actor, COUNT(*) as count FROM audit_log ${where} GROUP BY actor ORDER BY count DESC LIMIT 10`
  ).all(...params) as Array<{ actor: string; count: number }>;

  return {
    totalCalls: total.c,
    successRate: total.c > 0 ? success.c / total.c : 0,
    topSkills,
    topActors,
    avgDurationMs: avgDur.avg ?? 0,
  };
}

/**
 * Prune old audit entries (retention policy).
 */
export function auditPrune(olderThanDays: number = 90): number {
  const d = getDb();
  const result = d.run(
    `DELETE FROM audit_log WHERE timestamp < datetime('now', ?)`,
    [`-${olderThanDays} days`]
  );
  return result.changes;
}

/**
 * Close the database (for testing / shutdown).
 */
export function closeAuditDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
