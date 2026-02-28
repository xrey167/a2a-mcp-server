import Fastify from "fastify";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, basename, resolve } from "path";
import { homedir } from "os";
import { Glob } from "bun";
import { handleMemorySkill } from "../worker-memory.js";
import { getPersona, watchPersonas } from "../persona-loader.js";

const PORT = 8085;
const NAME = "knowledge-agent";
const VAULT = resolve(process.env.OBSIDIAN_VAULT ?? join(homedir(), "Documents/Obsidian/a2a-knowledge"));

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
      const title = args.title as string;
      const content = args.content as string;
      const tags = args.tags as string[] | undefined;
      const path = notePath(title);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${buildFrontmatter(tags)}# ${title}\n\n${content}\n`, "utf-8");
      return `Created note: ${title}`;
    }
    case "read_note": {
      const title = (args.title as string) ?? text;
      const path = notePath(title);
      if (!existsSync(path)) return `Note not found: ${title}`;
      return readFileSync(path, "utf-8");
    }
    case "update_note": {
      const title = args.title as string;
      const content = args.content as string;
      const path = notePath(title);
      if (!existsSync(path)) return `Note not found: ${title}`;
      writeFileSync(path, content, "utf-8");
      return `Updated note: ${title}`;
    }
    case "search_notes": {
      const query = ((args.query as string) ?? text).toLowerCase();
      const glob = new Glob("**/*.md");
      const results: string[] = [];
      for await (const file of glob.scan(VAULT)) {
        const fullPath = join(VAULT, file);
        const content = readFileSync(fullPath, "utf-8");
        if (content.toLowerCase().includes(query)) {
          results.push(file);
        }
      }
      return results.length > 0 ? results.join("\n") : "No matching notes found";
    }
    case "list_notes": {
      const folder = (args.folder as string) ?? "";
      const scanDir = folder ? safeScanDir(folder) : VAULT;
      const glob = new Glob("**/*.md");
      const notes: string[] = [];
      for await (const file of glob.scan(scanDir)) {
        notes.push(file);
      }
      return notes.length > 0 ? notes.join("\n") : "No notes found";
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

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "search_notes";
  let resultText: string;
  try {
    resultText = await handleSkill(sid, args ?? { query: text }, text);
  } catch (err) {
    resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    jsonrpc: "2.0", id: data.id,
    result: { id: taskId, status: { state: "completed" },
      artifacts: [{ parts: [{ kind: "text" as const, text: resultText }] }] },
  };
});

getPersona(NAME);
watchPersonas();

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
