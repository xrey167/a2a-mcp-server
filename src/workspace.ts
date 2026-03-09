// src/workspace.ts
// Team workspace support — shared configs, knowledge bases, and agent access.
// Workspaces live in ~/.a2a-mcp/workspaces/<id>/

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

const BASE_DIR = join(process.env.HOME ?? homedir(), ".a2a-mcp", "workspaces");

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

// ── File I/O ────────────────────────────────────────────────────

function workspaceDir(id: string): string {
  return join(BASE_DIR, id);
}

function workspaceFile(id: string): string {
  return join(workspaceDir(id), "workspace.json");
}

function ensureBaseDir(): void {
  if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });
}

function readWorkspace(id: string): Workspace | null {
  const file = workspaceFile(id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function writeWorkspace(ws: Workspace): void {
  const dir = workspaceDir(ws.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(workspaceFile(ws.id), JSON.stringify(ws, null, 2));
}

// ── Public API ──────────────────────────────────────────────────

export function createWorkspace(name: string, ownerKeyPrefix: string, ownerName: string, opts?: { description?: string; env?: Record<string, string> }): Workspace {
  ensureBaseDir();
  const id = `ws_${randomBytes(8).toString("hex")}`;
  const ws: Workspace = {
    id,
    name,
    description: opts?.description,
    createdAt: Date.now(),
    members: [{ keyPrefix: ownerKeyPrefix, name: ownerName, role: "owner", addedAt: Date.now() }],
    env: opts?.env,
  };
  writeWorkspace(ws);
  return ws;
}

export function getWorkspace(id: string): Workspace | null {
  return readWorkspace(id);
}

export function listWorkspaces(): Workspace[] {
  ensureBaseDir();
  const dirs = readdirSync(BASE_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
  const result: Workspace[] = [];
  for (const d of dirs) {
    const ws = readWorkspace(d.name);
    if (ws) result.push(ws);
  }
  return result;
}

export function addMember(workspaceId: string, keyPrefix: string, name: string, role: "member" | "readonly" = "member"): Workspace | null {
  const ws = readWorkspace(workspaceId);
  if (!ws) return null;
  if (ws.members.some(m => m.keyPrefix === keyPrefix)) return ws; // already a member
  ws.members.push({ keyPrefix, name, role, addedAt: Date.now() });
  writeWorkspace(ws);
  return ws;
}

export function removeMember(workspaceId: string, keyPrefix: string): Workspace | null {
  const ws = readWorkspace(workspaceId);
  if (!ws) return null;
  ws.members = ws.members.filter(m => m.keyPrefix !== keyPrefix);
  writeWorkspace(ws);
  return ws;
}

export function isMember(workspaceId: string, keyPrefix: string): WorkspaceMember | null {
  const ws = readWorkspace(workspaceId);
  if (!ws) return null;
  return ws.members.find(m => m.keyPrefix === keyPrefix) ?? null;
}

export function updateWorkspace(id: string, updates: Partial<Pick<Workspace, "name" | "description" | "env" | "allowedSkills" | "knowledgeTags">>): Workspace | null {
  const ws = readWorkspace(id);
  if (!ws) return null;
  Object.assign(ws, updates);
  writeWorkspace(ws);
  return ws;
}

/**
 * Get the shared knowledge directory for a workspace.
 */
export function getKnowledgeDir(workspaceId: string): string {
  const dir = join(workspaceDir(workspaceId), "knowledge");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
