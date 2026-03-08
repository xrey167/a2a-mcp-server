// src/sandbox-store.ts
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";

const INDEX_THRESHOLD = 4096; // bytes — auto-index vars larger than this

const db = new Database(join(homedir(), ".a2a-sandbox.db"));
db.run("PRAGMA journal_mode=WAL");

// Main variable table
db.run(`CREATE TABLE IF NOT EXISTS sandbox_vars (
  session TEXT NOT NULL,
  name    TEXT NOT NULL,
  value   TEXT NOT NULL,
  size    INTEGER NOT NULL,
  ts      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (session, name)
)`);

// FTS5 index for large results (standalone, not content-linked)
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS sandbox_fts USING fts5(
  session, name, value
)`);

export const sandboxStore = {
  setVar(session: string, name: string, value: string): void {
    // Remove old FTS entry if it existed
    const existing = db.query<{ size: number }, [string, string]>(
      `SELECT size FROM sandbox_vars WHERE session=? AND name=?`
    ).get(session, name);
    if (existing && existing.size > INDEX_THRESHOLD) {
      db.run(`DELETE FROM sandbox_fts WHERE session=? AND name=?`, [session, name]);
    }

    db.run(
      `INSERT OR REPLACE INTO sandbox_vars (session, name, value, size, ts) VALUES (?,?,?,?,unixepoch())`,
      [session, name, value, value.length]
    );

    // Auto-index large values
    if (value.length > INDEX_THRESHOLD) {
      db.run(`INSERT INTO sandbox_fts (session, name, value) VALUES (?,?,?)`, [session, name, value]);
    }
  },

  getVar(session: string, name: string): string | null {
    return (db.query<{ value: string }, [string, string]>(
      `SELECT value FROM sandbox_vars WHERE session=? AND name=?`
    ).get(session, name))?.value ?? null;
  },

  listVars(session: string): Array<{ name: string; size: number; ts: number }> {
    return db.query<{ name: string; size: number; ts: number }, [string]>(
      `SELECT name, size, ts FROM sandbox_vars WHERE session=? ORDER BY ts DESC`
    ).all(session);
  },

  deleteVar(session: string, name: string): void {
    db.run(`DELETE FROM sandbox_fts WHERE session=? AND name=?`, [session, name]);
    db.run(`DELETE FROM sandbox_vars WHERE session=? AND name=?`, [session, name]);
  },

  deleteSession(session: string): void {
    db.run(`DELETE FROM sandbox_fts WHERE session=?`, [session]);
    db.run(`DELETE FROM sandbox_vars WHERE session=?`, [session]);
  },

  search(session: string, varName: string, query: string): Array<{ value: string; rank: number }> {
    return db.query<{ value: string; rank: number }, [string, string, string]>(
      `SELECT value, rank FROM sandbox_fts
       WHERE sandbox_fts MATCH ? AND session = ? AND name = ?
       ORDER BY rank LIMIT 50`
    ).all(query, session, varName);
  },

  getAllVars(session: string): Record<string, unknown> {
    const rows = db.query<{ name: string; value: string }, [string]>(
      `SELECT name, value FROM sandbox_vars WHERE session=?`
    ).all(session);
    const vars: Record<string, unknown> = {};
    for (const r of rows) {
      try { vars[r.name] = JSON.parse(r.value); } catch { vars[r.name] = r.value; }
    }
    return vars;
  },

  prune(maxAgeDays: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - (maxAgeDays * 86400);
    const rows = db.query<{ session: string }, [number]>(
      `SELECT DISTINCT session FROM sandbox_vars WHERE ts < ?`
    ).all(cutoff);
    if (rows.length === 0) return 0;
    // Clean up FTS entries for pruned sessions
    for (const { session } of rows) {
      db.run(`DELETE FROM sandbox_fts WHERE session=?`, [session]);
    }
    db.run(`DELETE FROM sandbox_vars WHERE ts < ?`, [cutoff]);
    return rows.length;
  },
};
