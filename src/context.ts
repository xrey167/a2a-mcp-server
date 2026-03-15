/**
 * Project Context — shared context injected into all agent delegate calls.
 *
 * Storage:
 *   - Obsidian: ~/Documents/Obsidian/a2a-knowledge/_context/project.md  (persistent)
 *   - JSON cache: ~/.a2a-project-context.json  (fast reads)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

const VAULT = process.env.OBSIDIAN_VAULT ?? join(homedir(), "Documents/Obsidian/a2a-knowledge");
const OBSIDIAN_FILE = join(VAULT, "_context/project.md");
const CACHE_FILE = join(homedir(), ".a2a-project-context.json");

interface ProjectContext {
  summary: string;           // 1-3 sentence project summary injected into every delegate call
  goals: string[];           // current sprint goals / objectives
  stack: string[];           // tech stack tags (e.g. "TypeScript", "Bun", "MCP")
  notes: string;             // freeform context (architecture decisions, constraints, etc.)
  updatedAt: string;
}

const DEFAULT_CONTEXT: ProjectContext = {
  summary: "",
  goals: [],
  stack: [],
  notes: "",
  updatedAt: new Date().toISOString(),
};

// ── Read ─────────────────────────────────────────────────────────

export function getProjectContext(): ProjectContext {
  // Try cache first
  try {
    const raw = readFileSync(CACHE_FILE, "utf-8");
    return JSON.parse(raw) as ProjectContext;
  } catch {}

  // Fall back to Obsidian note
  try {
    const md = readFileSync(OBSIDIAN_FILE, "utf-8");
    return parseMarkdown(md);
  } catch {}

  return { ...DEFAULT_CONTEXT };
}

/** Returns a short string suitable for prepending to delegate messages. */
export function getContextPreamble(): string {
  const ctx = getProjectContext();
  if (!ctx.summary) return "";

  const parts: string[] = [`[Project Context] ${ctx.summary}`];
  if (ctx.goals.length > 0) {
    parts.push(`Goals: ${ctx.goals.join("; ")}`);
  }
  if (ctx.stack.length > 0) {
    parts.push(`Stack: ${ctx.stack.join(", ")}`);
  }
  if (ctx.notes) {
    parts.push(`Notes: ${ctx.notes}`);
  }
  return parts.join(" | ");
}

// ── Write ────────────────────────────────────────────────────────

export function setProjectContext(update: Partial<ProjectContext>): ProjectContext {
  const current = getProjectContext();
  const updated: ProjectContext = {
    ...current,
    ...update,
    updatedAt: new Date().toISOString(),
  };

  // Write cache
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(updated, null, 2));
  } catch (e) { process.stderr.write(`[context] cache write failed: ${e}\n`); }

  // Write Obsidian note
  try {
    mkdirSync(dirname(OBSIDIAN_FILE), { recursive: true });
    writeFileSync(OBSIDIAN_FILE, toMarkdown(updated));
  } catch (e) { process.stderr.write(`[context] Obsidian write failed: ${e}\n`); }

  return updated;
}

// ── Markdown serialization ───────────────────────────────────────

function toMarkdown(ctx: ProjectContext): string {
  const goalLines = ctx.goals.map(g => `- ${g}`).join("\n") || "- (none)";
  const stackLine = ctx.stack.length > 0 ? ctx.stack.join(", ") : "(none)";

  return `# Project Context

> Last updated: ${ctx.updatedAt}

## Summary

${ctx.summary || "(not set)"}

## Goals

${goalLines}

## Stack

${stackLine}

## Notes

${ctx.notes || "(none)"}
`;
}

function parseMarkdown(md: string): ProjectContext {
  const ctx: ProjectContext = { ...DEFAULT_CONTEXT };

  // Extract sections by heading
  const summaryMatch = md.match(/## Summary\s*\n+([\s\S]*?)(?=\n## |\n*$)/);
  if (summaryMatch) ctx.summary = summaryMatch[1].trim().replace(/^\(not set\)$/, "");

  const goalsMatch = md.match(/## Goals\s*\n+([\s\S]*?)(?=\n## |\n*$)/);
  if (goalsMatch) {
    ctx.goals = goalsMatch[1]
      .split("\n")
      .map(l => l.replace(/^- /, "").trim())
      .filter(l => l && l !== "(none)");
  }

  const stackMatch = md.match(/## Stack\s*\n+([\s\S]*?)(?=\n## |\n*$)/);
  if (stackMatch) {
    const line = stackMatch[1].trim();
    ctx.stack = line && line !== "(none)" ? line.split(",").map(s => s.trim()) : [];
  }

  const notesMatch = md.match(/## Notes\s*\n+([\s\S]*?)(?=\n## |\n*$)/);
  if (notesMatch) ctx.notes = notesMatch[1]!.trim().replace(/^\(none\)$/, "");

  const updatedMatch = md.match(/Last updated: ([^\n]+)/);
  if (updatedMatch) ctx.updatedAt = updatedMatch[1]!.trim();

  return ctx;
}
