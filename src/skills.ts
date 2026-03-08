import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { sendTask } from "./a2a.js";
import { runClaudeCLI } from "./claude-cli.js";
import { sanitizePath } from "./path-utils.js";

export interface SkillArgs {
  [key: string]: unknown;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  inputSchema: object;
  run: (args: SkillArgs) => Promise<string>;
}

// ── System Tools ─────────────────────────────────────────────────

const runShell: Skill = {
  id: "run_shell",
  name: "Run Shell",
  description: "Execute a shell command and return its output",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
    },
    required: ["command"],
  },
  // intentional: run_shell exists to execute arbitrary shell commands,
  // so the shell flag is required (pipes, redirects, etc.)
  run: async ({ command }) => {
    const result = spawnSync(command as string, {
      shell: true,
      timeout: 15_000,
      encoding: "utf-8",
    });
    if (result.error) return `Error: ${result.error.message}`;
    const out = result.stdout?.trim();
    const err = result.stderr?.trim();
    if (result.status !== 0) return `Exit ${result.status}: ${err || out}`;
    return out || "(no output)";
  },
};

const readFile: Skill = {
  id: "read_file",
  name: "Read File",
  description: "Read the contents of a file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
    },
    required: ["path"],
  },
  run: async ({ path }) => {
    if (!existsSync(path as string)) return `File not found: ${path}`;
    return readFileSync(path as string, "utf-8");
  },
};

const writeFile: Skill = {
  id: "write_file",
  name: "Write File",
  description: "Write content to a file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write to" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  run: async ({ path, content }) => {
    // Sanitize the path to prevent path traversal attacks
    const safePath = sanitizePath(path as string);
    writeFileSync(safePath, content as string, "utf-8");
    return `Written ${(content as string).length} bytes to ${safePath}`;
  },
};

// ── Web / HTTP ────────────────────────────────────────────────────

const fetchUrl: Skill = {
  id: "fetch_url",
  name: "Fetch URL",
  description: "Fetch content from a URL (text or JSON)",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      format: { type: "string", description: "'text' (default) or 'json'" },
    },
    required: ["url"],
  },
  run: async ({ url, format = "text" }) => {
    const res = await fetch(url as string);
    if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;
    return format === "json"
      ? JSON.stringify(await res.json(), null, 2)
      : await res.text();
  },
};

const callApi: Skill = {
  id: "call_api",
  name: "Call API",
  description: "Make an HTTP request to an external API",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "API endpoint URL" },
      method: { type: "string", description: "HTTP method: GET, POST, PUT, DELETE" },
      headers: { type: "object", description: "Optional request headers" },
      body: { type: "object", description: "Optional JSON request body" },
    },
    required: ["url", "method"],
  },
  run: async ({ url, method, headers = {}, body }) => {
    const res = await fetch(url as string, {
      method: method as string,
      headers: { "Content-Type": "application/json", ...(headers as object) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return `HTTP ${res.status}\n${await res.text()}`;
  },
};

// ── Claude API ────────────────────────────────────────────────────

const askClaude: Skill = {
  id: "ask_claude",
  name: "Ask Claude",
  description: "Send a prompt to Claude and return the response",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The prompt to send to Claude" },
      model: {
        type: "string",
        description: "Model ID (default: claude-sonnet-4-6)",
      },
    },
    required: ["prompt"],
  },
  run: async ({ prompt, model = "claude-sonnet-4-6" }) => {
    try {
      const client = new Anthropic();
      const message = await client.messages.create({
        model: model as string,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt as string }],
      });
      const block = message.content[0];
      return block.type === "text" ? block.text : JSON.stringify(block);
    } catch {
      return await runClaudeCLI(prompt as string, model as string);
    }
  },
};

// ── Data / Search ─────────────────────────────────────────────────

const searchFiles: Skill = {
  id: "search_files",
  name: "Search Files",
  description: "Find files matching a glob pattern",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. src/**/*.ts" },
      directory: { type: "string", description: "Base directory (default: .)" },
    },
    required: ["pattern"],
  },
  run: async ({ pattern, directory = "." }) => {
    const glob = new Glob(pattern as string);
    const matches: string[] = [];
    for await (const file of glob.scan(directory as string)) {
      matches.push(file);
    }
    return matches.length > 0 ? matches.join("\n") : "No files found";
  },
};

const querySqlite: Skill = {
  id: "query_sqlite",
  name: "Query SQLite",
  description: "Run a read-only SQL query against a SQLite database file",
  inputSchema: {
    type: "object",
    properties: {
      database: { type: "string", description: "Path to SQLite .db file" },
      sql: { type: "string", description: "SQL SELECT query to run" },
    },
    required: ["database", "sql"],
  },
  run: async ({ database, sql }) => {
    if (!(sql as string).trim().toUpperCase().startsWith("SELECT")) {
      return "Only SELECT queries are allowed";
    }
    const db = new Database(database as string, { readonly: true });
    try {
      const rows = db.query(sql as string).all();
      return JSON.stringify(rows, null, 2);
    } finally {
      db.close();
    }
  },
};

// ── A2A Bridge ────────────────────────────────────────────────────

const callA2aAgent: Skill = {
  id: "call_a2a_agent",
  name: "Call A2A Agent",
  description: "Send a task to another A2A agent via HTTP",
  inputSchema: {
    type: "object",
    properties: {
      agent_url: { type: "string", description: "Target A2A agent URL" },
      message: { type: "string", description: "Message to send" },
      skill_id: { type: "string", description: "Skill ID to invoke on the agent" },
      args: { type: "object", description: "Arguments for the remote skill" },
    },
    required: ["agent_url", "message"],
  },
  run: async ({ agent_url, message, skill_id, args }) => {
    return sendTask(agent_url as string, {
      skillId: skill_id as string | undefined,
      args: args as Record<string, unknown> | undefined,
      message: { role: "user", parts: [{ kind: "text" as const, text: message as string }] },
    });
  },
};

// ── Registry ──────────────────────────────────────────────────────

export const SKILLS: Skill[] = [
  runShell,
  readFile,
  writeFile,
  fetchUrl,
  callApi,
  askClaude,
  searchFiles,
  querySqlite,
  callA2aAgent,
];

export const SKILL_MAP = new Map(SKILLS.map((s) => [s.id, s]));
