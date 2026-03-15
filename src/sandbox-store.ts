// src/sandbox-store.ts
// Enhanced sandbox variable store with dual FTS5 (Porter + trigram),
// content chunking, vocabulary extraction, and fuzzy search fallback.

import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { chunkContent, buildVocabulary, fuzzyCorrect, buildFtsQuery } from "./search.js";

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

// FTS5 index with Porter stemming for natural language search
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS sandbox_fts USING fts5(
  session, name, value, tokenize='porter unicode61'
)`);

// FTS5 trigram index for substring matching
try {
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS sandbox_fts_trigram USING fts5(
    session, name, value, tokenize='trigram'
  )`);
} catch {
  // Trigram tokenizer may not be available in all SQLite builds
  process.stderr.write("[sandbox-store] trigram FTS5 not available, falling back to porter only\n");
}

// Vocabulary table for fuzzy correction
db.run(`CREATE TABLE IF NOT EXISTS sandbox_vocabulary (
  session TEXT NOT NULL,
  name    TEXT NOT NULL,
  term    TEXT NOT NULL,
  freq    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session, name, term)
)`);

/** Check if trigram table exists */
function hasTrigramTable(): boolean {
  try {
    db.query("SELECT 1 FROM sandbox_fts_trigram LIMIT 0").get();
    return true;
  } catch {
    return false;
  }
}

const trigramAvailable = hasTrigramTable();

export const sandboxStore = {
  setVar(session: string, name: string, value: string): void {
    // Remove old FTS entries if they existed
    const existing = db.query<{ size: number }, [string, string]>(
      `SELECT size FROM sandbox_vars WHERE session=? AND name=?`
    ).get(session, name);
    if (existing && existing.size > INDEX_THRESHOLD) {
      db.run(`DELETE FROM sandbox_fts WHERE session=? AND name=?`, [session, name]);
      if (trigramAvailable) {
        db.run(`DELETE FROM sandbox_fts_trigram WHERE session=? AND name=?`, [session, name]);
      }
      db.run(`DELETE FROM sandbox_vocabulary WHERE session=? AND name=?`, [session, name]);
    }

    db.run(
      `INSERT OR REPLACE INTO sandbox_vars (session, name, value, size, ts) VALUES (?,?,?,?,unixepoch())`,
      [session, name, value, value.length]
    );

    // Auto-index large values with chunking
    if (value.length > INDEX_THRESHOLD) {
      this._indexValue(session, name, value);
    }
  },

  /** Index a value into FTS5 tables with chunking and vocabulary extraction. */
  _indexValue(session: string, name: string, value: string): void {
    const chunks = chunkContent(value, name);

    for (const chunk of chunks) {
      const text = `${chunk.title}\n${chunk.body}`;
      db.run(
        `INSERT INTO sandbox_fts (session, name, value) VALUES (?,?,?)`,
        [session, `${name}:${chunk.title}`, text]
      );
      if (trigramAvailable) {
        db.run(
          `INSERT INTO sandbox_fts_trigram (session, name, value) VALUES (?,?,?)`,
          [session, `${name}:${chunk.title}`, text]
        );
      }
    }

    // Build vocabulary for fuzzy correction — delete stale terms first to prevent unbounded growth
    db.run("DELETE FROM sandbox_vocabulary WHERE session = ? AND name = ?", [session, name]);
    const vocab = buildVocabulary(value);
    const insertVocab = db.prepare(
      `INSERT OR REPLACE INTO sandbox_vocabulary (session, name, term, freq) VALUES (?,?,?,1)`
    );
    const txn = db.transaction(() => {
      for (const term of vocab) {
        insertVocab.run(session, name, term);
      }
    });
    txn();
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
    if (trigramAvailable) {
      db.run(`DELETE FROM sandbox_fts_trigram WHERE session=? AND name=?`, [session, name]);
    }
    db.run(`DELETE FROM sandbox_vocabulary WHERE session=? AND name=?`, [session, name]);
    db.run(`DELETE FROM sandbox_vars WHERE session=? AND name=?`, [session, name]);
  },

  deleteSession(session: string): void {
    db.run(`DELETE FROM sandbox_fts WHERE session=?`, [session]);
    if (trigramAvailable) {
      db.run(`DELETE FROM sandbox_fts_trigram WHERE session=?`, [session]);
    }
    db.run(`DELETE FROM sandbox_vocabulary WHERE session=?`, [session]);
    db.run(`DELETE FROM sandbox_vars WHERE session=?`, [session]);
  },

  /**
   * Three-layer search fallback:
   * 1. Porter stemming (primary)
   * 2. Trigram substring (if Porter finds nothing)
   * 3. Fuzzy Levenshtein correction (if both above find nothing)
   */
  search(session: string, varName: string, query: string): Array<{ value: string; rank: number }> {
    const ftsQuery = buildFtsQuery(query);

    // Layer 1: Porter stemming search with BM25 ranking
    const porterResults = db.query<{ value: string; rank: number }, [string, string]>(
      `SELECT value, bm25(sandbox_fts, 1.0, 0.75, 1.0) as rank FROM sandbox_fts
       WHERE sandbox_fts MATCH ? AND session = ?
       ORDER BY rank LIMIT 50`
    ).all(ftsQuery, session);

    if (porterResults.length > 0) return porterResults;

    // Layer 2: Trigram substring matching
    if (trigramAvailable) {
      try {
        const trigramResults = db.query<{ value: string; rank: number }, [string, string]>(
          `SELECT value, rank FROM sandbox_fts_trigram
           WHERE sandbox_fts_trigram MATCH ? AND session = ?
           ORDER BY rank LIMIT 50`
        ).all(query, session);

        if (trigramResults.length > 0) return trigramResults;
      } catch {
        // Trigram query syntax may differ, fall through
      }
    }

    // Layer 3: Fuzzy correction — correct each term and re-search
    const vocabulary = db.query<{ term: string }, [string]>(
      `SELECT DISTINCT term FROM sandbox_vocabulary WHERE session=?`
    ).all(session).map(r => r.term);

    if (vocabulary.length > 0) {
      const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
      const corrected = terms.map(t => fuzzyCorrect(t, vocabulary));
      const correctedQuery = corrected.join(" ");

      // Only re-search if correction actually changed something
      if (correctedQuery !== terms.join(" ")) {
        const correctedFts = buildFtsQuery(correctedQuery);
        return db.query<{ value: string; rank: number }, [string, string]>(
          `SELECT value, bm25(sandbox_fts, 1.0, 0.75, 1.0) as rank FROM sandbox_fts
           WHERE sandbox_fts MATCH ? AND session = ?
           ORDER BY rank LIMIT 50`
        ).all(correctedFts, session);
      }
    }

    return [];
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
      if (trigramAvailable) {
        db.run(`DELETE FROM sandbox_fts_trigram WHERE session=?`, [session]);
      }
      db.run(`DELETE FROM sandbox_vocabulary WHERE session=?`, [session]);
    }
    db.run(`DELETE FROM sandbox_vars WHERE ts < ?`, [cutoff]);
    return rows.length;
  },
};
