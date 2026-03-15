// src/workspace.ts
// Team workspace support — shared configs, knowledge bases, and agent access.
// Workspace metadata is stored in SQLite at ~/.a2a-mcp/workspaces.db for
// concurrency-safe atomic reads and writes.  Knowledge directories remain on
// the filesystem at ~/.a2a-mcp/workspaces/<id>/knowledge/.

import Database from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

const HOME = process.env.HOME ?? homedir();
const DB_DIR = join(HOME, ".a2a-mcp");
const DB_PATH = join(DB_DIR, "workspaces.db");
/** Filesystem root for per-workspace knowledge directories (unchanged path). */
const KNOWLEDGE_BASE_DIR = join(HOME, ".a2a-mcp", "workspaces");

// ── Types ────────────────────────────────────────────────────────

export interface WorkspaceMember {
  /** API key prefix that identifies the member */
  keyPrefix: string;
  /** Display name */
  name: string;
  /** Role within this workspace */
  role: "owner" | "member" | "readonly";
  addedAt: number;
}

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  members: WorkspaceMember[];
  /** Shared environment variables for workers in this workspace */
  env?: Record<string, string>;
  /** Skill allowlist for the workspace (overrides member-level) */
  allowedSkills?: string[];
  /** Shared knowledge base tags */
  knowledgeTags?: string[];
}

// ── Database ────────────────────────────────────────────────────

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  // WAL mode gives concurrent readers without blocking writers.
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      created_at    INTEGER NOT NULL,
      members       TEXT NOT NULL DEFAULT '[]',
      env           TEXT,
      allowed_skills TEXT,
      knowledge_tags TEXT
    )
  `);
  return db;
}

function parseMembers(raw: unknown): WorkspaceMember[] {
  try {
    const parsed = JSON.parse(raw as string);
    if (Array.isArray(parsed)) return parsed as WorkspaceMember[];
  } catch { /* treat corrupt as empty */ }
  return [];
}

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    createdAt: row.created_at as number,
    members: parseMembers(row.members),
    env: (() => {
      if (!row.env) return undefined;
      try { return JSON.parse(row.env as string) as Record<string, string>; } catch { return {}; }
    })(),
    allowedSkills: (() => {
      if (!row.allowed_skills) return undefined;
      try { return JSON.parse(row.allowed_skills as string) as string[]; } catch { return []; }
    })(),
    knowledgeTags: (() => {
      if (!row.knowledge_tags) return undefined;
      try { return JSON.parse(row.knowledge_tags as string) as string[]; } catch { return []; }
    })(),
  };
}

// ── Public API ──────────────────────────────────────────────────

export function createWorkspace(
  name: string,
  ownerKeyPrefix: string,
  ownerName: string,
  opts?: { description?: string; env?: Record<string, string> },
): Workspace {
  const d = getDb();
  const id = `ws_${randomBytes(8).toString("hex")}`;
  const createdAt = Date.now();
  const members: WorkspaceMember[] = [
    { keyPrefix: ownerKeyPrefix, name: ownerName, role: "owner", addedAt: createdAt },
  ];
  d.run(
    `INSERT INTO workspaces (id, name, description, created_at, members, env, allowed_skills, knowledge_tags)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [
      id,
      name,
      opts?.description ?? null,
      createdAt,
      JSON.stringify(members),
      opts?.env ? JSON.stringify(opts.env) : null,
    ],
  );
  return { id, name, description: opts?.description, createdAt, members, env: opts?.env };
}

export function getWorkspace(id: string): Workspace | null {
  const d = getDb();
  const row = d.query(`SELECT * FROM workspaces WHERE id = ?`).get(id) as Record<string, unknown> | null;
  return row ? rowToWorkspace(row) : null;
}

export function listWorkspaces(): Workspace[] {
  const d = getDb();
  const rows = d.query(`SELECT * FROM workspaces ORDER BY created_at ASC`).all() as Record<string, unknown>[];
  return rows.map(rowToWorkspace);
}

export function addMember(
  workspaceId: string,
  keyPrefix: string,
  name: string,
  role: "member" | "readonly" = "member",
): Workspace | null {
  const d = getDb();
  return d.transaction((): Workspace | null => {
    const row = d.query(`SELECT * FROM workspaces WHERE id = ?`).get(workspaceId) as Record<string, unknown> | null;
    if (!row) return null;
    const ws = rowToWorkspace(row);
    if (ws.members.some(m => m.keyPrefix === keyPrefix)) return ws; // already a member
    ws.members.push({ keyPrefix, name, role, addedAt: Date.now() });
    d.run(`UPDATE workspaces SET members = ? WHERE id = ?`, [JSON.stringify(ws.members), workspaceId]);
    return ws;
  })();
}

export function removeMember(workspaceId: string, keyPrefix: string): Workspace | null {
  const d = getDb();
  return d.transaction((): Workspace | null => {
    const row = d.query(`SELECT * FROM workspaces WHERE id = ?`).get(workspaceId) as Record<string, unknown> | null;
    if (!row) return null;
    const ws = rowToWorkspace(row);
    ws.members = ws.members.filter(m => m.keyPrefix !== keyPrefix);
    d.run(`UPDATE workspaces SET members = ? WHERE id = ?`, [JSON.stringify(ws.members), workspaceId]);
    return ws;
  })();
}

export function isMember(workspaceId: string, keyPrefix: string): WorkspaceMember | null {
  const ws = getWorkspace(workspaceId);
  if (!ws) return null;
  return ws.members.find(m => m.keyPrefix === keyPrefix) ?? null;
}

export function updateWorkspace(
  id: string,
  updates: Partial<Pick<Workspace, "name" | "description" | "env" | "allowedSkills" | "knowledgeTags">>,
): Workspace | null {
  const d = getDb();
  return d.transaction((): Workspace | null => {
    const row = d.query(`SELECT * FROM workspaces WHERE id = ?`).get(id) as Record<string, unknown> | null;
    if (!row) return null;
    const ws = rowToWorkspace(row);
    const definedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined),
    );
    Object.assign(ws, definedUpdates);
    d.run(
      `UPDATE workspaces SET name = ?, description = ?, env = ?, allowed_skills = ?, knowledge_tags = ? WHERE id = ?`,
      [
        ws.name,
        ws.description ?? null,
        ws.env ? JSON.stringify(ws.env) : null,
        ws.allowedSkills ? JSON.stringify(ws.allowedSkills) : null,
        ws.knowledgeTags ? JSON.stringify(ws.knowledgeTags) : null,
        id,
      ],
    );
    return ws;
  })();
}

/**
 * Delete a workspace and its record from the database.
 * Does NOT remove the knowledge directory on disk — callers must clean that up
 * separately if needed.
 */
export function deleteWorkspace(id: string): boolean {
  const d = getDb();
  const result = d.run(`DELETE FROM workspaces WHERE id = ?`, [id]);
  return result.changes > 0;
}

/** Pattern that every valid workspace ID must match. */
const WORKSPACE_ID_RE = /^ws_[a-f0-9]+$/;

/**
 * Get the shared knowledge directory for a workspace.
 *
 * Validates `workspaceId` against a strict allowlist pattern before
 * constructing the path, preventing path-traversal attacks.
 */
export function getKnowledgeDir(workspaceId: string): string {
  if (!WORKSPACE_ID_RE.test(workspaceId)) {
    throw new Error(`Invalid workspace ID: "${workspaceId}"`);
  }
  const dir = join(KNOWLEDGE_BASE_DIR, workspaceId, "knowledge");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Close the database connection. Intended for tests and graceful shutdown.
 */
export function closeWorkspaceDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
