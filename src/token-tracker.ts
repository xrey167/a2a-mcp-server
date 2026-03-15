// src/token-tracker.ts
// SQLite-backed token savings tracker — records per-skill token reduction
// from output filtering, inspired by RTK's gain tracking.

import Database from "bun:sqlite";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";

// ── Types ────────────────────────────────────────────────────────

export interface TokenSavingEntry {
  skillId: string;
  worker: string;
  command?: string;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  filtersApplied: string[];
}

export interface TokenStatsSnapshot {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSavedTokens: number;
  savingsRate: string;
  totalRecords: number;
  topSkills: Array<{ skillId: string; saved: number; count: number }>;
}

// ── Database ─────────────────────────────────────────────────────

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  const dbPath = process.env.A2A_TOKEN_DB ?? join(process.env.HOME ?? homedir(), ".a2a-mcp", "token-savings.db");
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  db = new Database(dbPath);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS token_savings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      skill_id TEXT NOT NULL,
      worker TEXT NOT NULL,
      command TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      saved_tokens INTEGER NOT NULL,
      filters_applied TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ts_timestamp ON token_savings(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ts_skill ON token_savings(skill_id)`);

  // Auto-prune old records on startup
  pruneTokenHistory();

  return db;
}

// ── Public API ───────────────────────────────────────────────────

export function recordTokenSaving(entry: TokenSavingEntry): void {
  if (entry.savedTokens <= 0) return;
  try {
    getDb().run(
      `INSERT INTO token_savings (skill_id, worker, command, input_tokens, output_tokens, saved_tokens, filters_applied)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.skillId,
        entry.worker,
        entry.command ?? null,
        entry.inputTokens,
        entry.outputTokens,
        entry.savedTokens,
        JSON.stringify(entry.filtersApplied),
      ]
    );
  } catch (e) {
    process.stderr.write(`[token-tracker] record error: ${e}\n`);
  }
}

export function getTokenStats(opts?: { since?: string; skillId?: string }): TokenStatsSnapshot {
  const d = getDb();
  let where = "1=1";
  const params: unknown[] = [];

  if (opts?.since) {
    where += " AND timestamp >= ?";
    params.push(opts.since);
  }
  if (opts?.skillId) {
    where += " AND skill_id = ?";
    params.push(opts.skillId);
  }

  const totals = d.query<{ input: number; output: number; saved: number; cnt: number }, unknown[]>(
    `SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output,
            COALESCE(SUM(saved_tokens),0) as saved, COUNT(*) as cnt
     FROM token_savings WHERE ${where}`
  ).get(...params) ?? { input: 0, output: 0, saved: 0, cnt: 0 };

  const topSkills = d.query<{ skill_id: string; saved: number; cnt: number }, unknown[]>(
    `SELECT skill_id, SUM(saved_tokens) as saved, COUNT(*) as cnt
     FROM token_savings WHERE ${where}
     GROUP BY skill_id ORDER BY saved DESC LIMIT 10`
  ).all(...params);

  return {
    totalInputTokens: totals.input,
    totalOutputTokens: totals.output,
    totalSavedTokens: totals.saved,
    savingsRate: totals.input > 0 ? `${((totals.saved / totals.input) * 100).toFixed(1)}%` : "0%",
    totalRecords: totals.cnt,
    topSkills: topSkills.map(r => ({ skillId: r.skill_id, saved: r.saved, count: r.cnt })),
  };
}

export function pruneTokenHistory(retentionDays: number = 90): number {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = getDb().run(
      `DELETE FROM token_savings WHERE timestamp < ?`,
      [cutoff]
    );
    return result.changes;
  } catch (e) {
    process.stderr.write(`[token-tracker] prune error: ${e}\n`);
    return 0;
  }
}
