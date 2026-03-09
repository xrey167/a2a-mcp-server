/**
 * Database schema and connection — SQLite via Bun's built-in driver.
 *
 * Tables are created on import. Add new tables by extending the
 * SCHEMA array and re-running the module.
 */

import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "../../data/{{name}}.db");

// Ensure data directory exists
import { mkdirSync } from "fs";
mkdirSync(join(import.meta.dir, "../../data"), { recursive: true });

export const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// ── Schema ──────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
];

for (const sql of SCHEMA) {
  db.exec(sql);
}

// ── Query helpers ───────────────────────────────────────────────

export interface Item {
  id: number;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export function listItems(limit = 50, offset = 0): Item[] {
  return db.query("SELECT * FROM items ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as Item[];
}

export function getItem(id: number): Item | null {
  return db.query("SELECT * FROM items WHERE id = ?").get(id) as Item | null;
}

export function createItem(name: string, description = ""): Item {
  const result = db.query("INSERT INTO items (name, description) VALUES (?, ?) RETURNING *")
    .get(name, description) as Item;
  return result;
}

export function updateItem(id: number, data: { name?: string; description?: string }): Item | null {
  const item = getItem(id);
  if (!item) return null;

  const name = data.name ?? item.name;
  const description = data.description ?? item.description;

  return db.query(
    "UPDATE items SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ? RETURNING *"
  ).get(name, description, id) as Item;
}

export function deleteItem(id: number): boolean {
  const result = db.query("DELETE FROM items WHERE id = ?").run(id);
  return result.changes > 0;
}
