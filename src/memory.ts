import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";

const VAULT = process.env.OBSIDIAN_VAULT ?? join(homedir(), "Documents/Obsidian/a2a-knowledge");
const MEMORY_DIR = join(VAULT, "_memory");

const db = new Database(join(homedir(), ".a2a-memory.db"));
db.run(`CREATE TABLE IF NOT EXISTS memory (
  agent TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (agent, key)
)`);

// ── FTS5 full-text search index ───────────────────────────────────
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  agent, key, value, content=memory, content_rowid=rowid
)`);

// Triggers to keep FTS in sync with the main table
db.run(`CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, agent, key, value) VALUES (NEW.rowid, NEW.agent, NEW.key, NEW.value);
END`);
db.run(`CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, agent, key, value) VALUES('delete', OLD.rowid, OLD.agent, OLD.key, OLD.value);
END`);
db.run(`CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, agent, key, value) VALUES('delete', OLD.rowid, OLD.agent, OLD.key, OLD.value);
  INSERT INTO memory_fts(rowid, agent, key, value) VALUES (NEW.rowid, NEW.agent, NEW.key, NEW.value);
END`);

// Rebuild FTS index from existing data (idempotent, fast for small tables)
try {
  db.run(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`);
} catch {}

/** Sanitize a path component to prevent directory traversal. */
function safeName(name: string): string {
  return name.replace(/[\/\\\.]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
}

function noteFile(agent: string, key: string) {
  const safeAgent = safeName(agent);
  const safeKey = safeName(key);
  const dir = join(MEMORY_DIR, safeAgent);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${safeKey}.md`);
  // Ensure the resolved path is still within MEMORY_DIR
  if (!filePath.startsWith(MEMORY_DIR)) {
    throw new Error(`Invalid memory path: ${filePath}`);
  }
  return filePath;
}

export const memory = {
  set(agent: string, key: string, value: string) {
    db.run(`INSERT OR REPLACE INTO memory VALUES (?,?,?,unixepoch())`, [agent, key, value]);
    try { writeFileSync(noteFile(agent, key), `# ${key}\n\n${value}\n`); } catch {}
  },
  get(agent: string, key: string): string | null {
    return (db.query<{value:string},[string,string]>(
      `SELECT value FROM memory WHERE agent=? AND key=?`
    ).get(agent, key))?.value ?? null;
  },
  all(agent: string): Record<string, string> {
    const rows = db.query<{key:string;value:string},[string]>(
      `SELECT key,value FROM memory WHERE agent=? ORDER BY ts DESC`
    ).all(agent);
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },
  forget(agent: string, key: string) {
    db.run(`DELETE FROM memory WHERE agent=? AND key=?`, [agent, key]);
    try { unlinkSync(noteFile(agent, key)); } catch {}
  },

  /** Full-text search across all memories. Optionally filter by agent. */
  search(query: string, agent?: string): Array<{ agent: string; key: string; value: string; rank: number }> {
    if (agent) {
      return db.query<{agent:string;key:string;value:string;rank:number},[string,string]>(
        `SELECT m.agent, m.key, m.value, f.rank
         FROM memory_fts f JOIN memory m ON f.rowid = m.rowid
         WHERE memory_fts MATCH ? AND m.agent = ?
         ORDER BY f.rank`
      ).all(query, agent);
    }
    return db.query<{agent:string;key:string;value:string;rank:number},[string]>(
      `SELECT m.agent, m.key, m.value, f.rank
       FROM memory_fts f JOIN memory m ON f.rowid = m.rowid
       WHERE memory_fts MATCH ?
       ORDER BY f.rank`
    ).all(query);
  },

  /** List all keys for an agent, optionally filtered by prefix. */
  listKeys(agent: string, prefix?: string): string[] {
    if (prefix) {
      return db.query<{key:string},[string,string]>(
        `SELECT key FROM memory WHERE agent=? AND key LIKE ? ORDER BY ts DESC`
      ).all(agent, `${prefix}%`).map(r => r.key);
    }
    return db.query<{key:string},[string]>(
      `SELECT key FROM memory WHERE agent=? ORDER BY ts DESC`
    ).all(agent).map(r => r.key);
  },

  /** Delete memories older than maxAgeDays. Returns count deleted. */
  cleanup(maxAgeDays: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - (maxAgeDays * 86400);
    const rows = db.query<{agent:string;key:string},[number]>(
      `SELECT agent, key FROM memory WHERE ts < ?`
    ).all(cutoff);

    if (rows.length === 0) return 0;

    db.run(`DELETE FROM memory WHERE ts < ?`, [cutoff]);
    // Clean up Obsidian files
    for (const r of rows) {
      try { unlinkSync(noteFile(r.agent, r.key)); } catch {}
    }
    return rows.length;
  },
};
