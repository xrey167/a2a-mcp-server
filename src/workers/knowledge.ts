import Fastify from "fastify";
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch } from "fs";
import { join, dirname, basename, resolve } from "path";
import { homedir } from "os";
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { callPeer } from "../peer.js";
import { sanitizeForPrompt } from "../prompt-sanitizer.js";
import { buildA2AResponse, checkRequestSize } from "../worker-harness.js";

const KnowledgeSchemas = {
  create_note: z.object({ title: z.string().min(1), content: z.string(), tags: z.array(z.string()).optional() }).passthrough(),
  read_note: z.object({ title: z.string().min(1) }).passthrough(),
  update_note: z.object({ title: z.string().min(1), content: z.string() }).passthrough(),
  search_notes: z.object({ query: z.string().min(1) }).passthrough(),
  list_notes: z.object({ folder: z.string().optional().default("") }).passthrough(),
  summarize_notes: z.object({ query: z.string().min(1), focus: z.string().optional() }).passthrough(),
};

const PORT = 8085;
const NAME = "knowledge-agent";
const VAULT = resolve(process.env.OBSIDIAN_VAULT ?? join(homedir(), "Documents/Obsidian/a2a-knowledge"));

// ── FTS5 Index for fast full-text search ─────────────────────────
const INDEX_DB_PATH = join(homedir(), ".a2a-knowledge-index.db");
const indexDb = new Database(INDEX_DB_PATH);
indexDb.exec("PRAGMA journal_mode=WAL");
indexDb.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    path TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
indexDb.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, content, content=notes, content_rowid=rowid,
    tokenize='porter unicode61'
  )
`);
// Keep FTS in sync via triggers
indexDb.exec(`
  CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
  END
`);
indexDb.exec(`
  CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
  END
`);
indexDb.exec(`
  CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
    INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
  END
`);

const upsertNote = indexDb.prepare(`INSERT OR REPLACE INTO notes (path, title, content, updated_at) VALUES (?, ?, ?, ?)`);
const searchNotesFts = indexDb.prepare(`
  SELECT n.path, highlight(notes_fts, 0, '**', '**') AS title_hl
  FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
  WHERE notes_fts MATCH ? ORDER BY rank LIMIT 50
`);
const deleteNote = indexDb.prepare(`DELETE FROM notes WHERE path = ?`);

/** Index all vault notes on startup */
async function buildIndex() {
  const glob = new Glob("**/*.md");
  let count = 0;
  const tx = indexDb.transaction(() => {
    for (const file of glob.scanSync(VAULT)) {
      try {
        const fullPath = join(VAULT, file);
        const content = readFileSync(fullPath, "utf-8");
        const title = file.replace(/\.md$/, "");
        upsertNote.run(file, title, content, Date.now());
        count++;
      } catch { /* skip unreadable files */ }
    }
  });
  tx();
  process.stderr.write(`[${NAME}] indexed ${count} notes\n`);
}

/** Update index for a single note */
function indexNote(relativePath: string, content: string) {
  const title = relativePath.replace(/\.md$/, "");
  upsertNote.run(relativePath, title, content, Date.now());
}

/** Watch vault for changes and update index */
function watchVault() {
  try {
    watch(VAULT, { recursive: true }, (event, filename) => {
      if (!filename || !filename.endsWith(".md")) return;
      const fullPath = join(VAULT, filename);
      if (existsSync(fullPath)) {
        try {
          const content = readFileSync(fullPath, "utf-8");
          indexNote(filename, content);
        } catch { /* ignore read errors during writes */ }
      } else {
        deleteNote.run(filename);
      }
    });
  } catch {
    process.stderr.write(`[${NAME}] vault file watching not available — index updates on write only\n`);
  }
}

const AGENT_CARD = {
  name: NAME,
  description: "Knowledge agent — Obsidian vault CRUD, search, persistent memory",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "create_note", name: "Create Note", description: "Create a new Obsidian note with optional tags" },
    { id: "read_note", name: "Read Note", description: "Read an Obsidian note by title" },
    { id: "update_note", name: "Update Note", description: "Update an existing Obsidian note" },
    { id: "search_notes", name: "Search Notes", description: "Search notes by content (case-insensitive)" },
    { id: "list_notes", name: "List Notes", description: "List all notes in the vault or a subfolder" },
    { id: "summarize_notes", name: "Summarize Notes", description: "Search notes by query then summarize findings via the ai worker (peer A2A call)" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

function notePath(title: string): string {
  const p = resolve(VAULT, `${title}.md`);
  if (!p.startsWith(VAULT + "/")) throw new Error(`Invalid note title: "${title}"`);
  return p;
}

function safeScanDir(folder: string): string {
  const p = resolve(VAULT, folder);
  if (!p.startsWith(VAULT + "/") && p !== VAULT) throw new Error(`Invalid folder: "${folder}"`);
  return p;
}

function buildFrontmatter(tags?: string[]): string {
  if (!tags || tags.length === 0) return "";
  return `---\ntags: [${tags.join(", ")}]\n---\n\n`;
}

async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;
  switch (skillId) {
    case "create_note": {
      const { title, content, tags } = KnowledgeSchemas.create_note.parse(args);
      const path = notePath(title);
      mkdirSync(dirname(path), { recursive: true });
      const fullContent = `${buildFrontmatter(tags)}# ${title}\n\n${content}\n`;
      writeFileSync(path, fullContent, "utf-8");
      indexNote(`${title}.md`, fullContent);
      return `Created note: ${title}`;
    }
    case "read_note": {
      const { title } = KnowledgeSchemas.read_note.parse({ title: args.title ?? text, ...args });
      const path = notePath(title);
      if (!existsSync(path)) return `Note not found: ${title}`;
      return readFileSync(path, "utf-8");
    }
    case "update_note": {
      const { title, content } = KnowledgeSchemas.update_note.parse(args);
      const path = notePath(title);
      if (!existsSync(path)) return `Note not found: ${title}`;
      writeFileSync(path, content, "utf-8");
      indexNote(`${title}.md`, content);
      return `Updated note: ${title}`;
    }
    case "search_notes": {
      const { query: rawQuery } = KnowledgeSchemas.search_notes.parse({ query: args.query ?? text, ...args });
      // Try FTS5 first, fall back to brute-force scan
      try {
        const ftsResults = searchNotesFts.all(rawQuery) as Array<{ path: string; title_hl: string }>;
        if (ftsResults.length > 0) {
          return ftsResults.map(r => r.path).join("\n");
        }
      } catch { /* FTS query syntax error — fall through to brute force */ }
      // Fallback: scan vault for substring match
      const query = rawQuery.toLowerCase();
      const glob = new Glob("**/*.md");
      const results: string[] = [];
      for await (const file of glob.scan(VAULT)) {
        const fullPath = join(VAULT, file);
        try {
          const content = readFileSync(fullPath, "utf-8");
          if (content.toLowerCase().includes(query)) {
            results.push(file);
          }
        } catch { /* skip unreadable files */ }
      }
      return results.length > 0 ? results.join("\n") : "No matching notes found";
    }
    case "list_notes": {
      const { folder } = KnowledgeSchemas.list_notes.parse(args);
      const scanDir = folder ? safeScanDir(folder) : VAULT;
      const glob = new Glob("**/*.md");
      const notes: string[] = [];
      for await (const file of glob.scan(scanDir)) {
        notes.push(file);
      }
      return notes.length > 0 ? notes.join("\n") : "No notes found";
    }
    case "summarize_notes": {
      // Step 1: full-text search for matching notes (local)
      const { query, focus } = KnowledgeSchemas.summarize_notes.parse({ query: args.query ?? text, ...args });
      const searchResult = await handleSkill("search_notes", { query }, query);
      if (searchResult === "No matching notes found") return searchResult;

      // Step 2: read up to 5 matching notes (local filesystem)
      const noteFiles = searchResult.split("\n").slice(0, 5);
      const noteContents = noteFiles.map(file => {
        try {
          const content = readFileSync(join(VAULT, file), "utf-8");
          return `## ${file.replace(/\.md$/, "")}\n${content}`;
        } catch {
          return `## ${file.replace(/\.md$/, "")}\n(unreadable)`;
        }
      });

      // Step 3: call ai-agent's ask_claude directly (peer A2A — no orchestrator hop)
      const focusSection = focus ? `\n\nFocus area:\n${sanitizeForPrompt(focus, "focus_area")}` : "";
      const prompt = `Summarize the following notes${focusSection ? " with attention to the specified focus area" : ""}:${focusSection}\n\n${noteContents.join("\n\n---\n\n")}`;
      return callPeer("ask_claude", { prompt }, prompt, 60_000);
    }

    default:
      return `Unknown skill: ${skillId}`;
  }
}

const app = Fastify({ logger: false });

app.get("/.well-known/agent.json", async () => AGENT_CARD);

app.get("/healthz", async () => ({
  status: "ok",
  agent: NAME,
  uptime: process.uptime(),
  skills: AGENT_CARD.skills.map(s => s.id),
}));

app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
  const data = request.body;
  if (data?.method !== "tasks/send") {
    reply.code(404);
    return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
  }

  const sizeErr = checkRequestSize(data);
  if (sizeErr) { reply.code(413); return { jsonrpc: "2.0", error: { code: -32000, message: sizeErr } }; }

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "search_notes";
  let resultText: string;
  try {
    resultText = await handleSkill(sid, args ?? { query: text }, text);
  } catch (err) {
    resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return buildA2AResponse(data.id, taskId, resultText);
});

getPersona(NAME);
watchPersonas();

// Build FTS5 index on startup, then watch for changes
buildIndex().then(() => watchVault());

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
