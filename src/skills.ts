import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { z } from "zod";
import { sendTask } from "./a2a.js";
import { runClaudeCLI } from "./claude-cli.js";
import { sanitizePath } from "./path-utils.js";
import { validateUrlNotInternal } from "./worker-utils.js";

// ── Helper Functions ───────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB

/** Read response body with a hard byte limit. Returns null if limit exceeded. */
async function readBodyWithLimit(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let chunks: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel();
        return null;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    // Flush decoder
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

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

// ── Zod Schemas ─────────────────────────────────────────────────

const RunShellSchema = z.object({
  command: z.string().min(1, "command is required"),
}).strict();

const ReadFileSchema = z.object({
  path: z.string().min(1, "path is required"),
}).strict();

const WriteFileSchema = z.object({
  path: z.string().min(1, "path is required"),
  content: z.string(),
}).strict();

const FetchUrlSchema = z.object({
  url: z.string().url("invalid URL"),
  format: z.enum(["text", "json"]).default("text"),
}).strict();

const CallApiSchema = z.object({
  url: z.string().url("invalid URL"),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  headers: z.record(z.string()).default({}),
  body: z.record(z.unknown()).optional(),
}).strict();

const AskClaudeSchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
  model: z.string().optional().default("claude-sonnet-4-6"),
}).strict();

const SearchFilesSchema = z.object({
  pattern: z.string().min(1, "pattern is required"),
  directory: z.string().optional().default("."),
}).strict();

const QuerySqliteSchema = z.object({
  database: z.string().min(1, "database path is required"),
  sql: z.string().min(1, "sql is required"),
}).strict();

const CallA2aAgentSchema = z.object({
  agent_url: z.string().url("invalid agent URL"),
  message: z.string().min(1, "message is required"),
  skill_id: z.string().optional(),
  args: z.record(z.unknown()).optional(),
}).strict();

// ── Helper: validate args with Zod schema ────────────────────────

function validate<T>(schema: z.ZodType<T>, args: SkillArgs): T {
  return schema.parse(args);
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
  run: async (raw) => {
    const { command } = validate(RunShellSchema, raw);
    const result = spawnSync(command, {
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
  run: async (raw) => {
    const { path } = validate(ReadFileSchema, raw);
    if (!existsSync(path)) return `File not found: ${path}`;
    return readFileSync(path, "utf-8");
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
  run: async (raw) => {
    const { path, content } = validate(WriteFileSchema, raw);
    const safePath = sanitizePath(path);
    writeFileSync(safePath, content, "utf-8");
    return `Written ${content.length} bytes to ${safePath}`;
  },
};

// ── Web / HTTP ────────────────────────────────────────────────────

/** Block private/internal hostnames to prevent SSRF in local skill fallbacks. */
function blockPrivateUrl(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    const h = hostname.toLowerCase();
    if (
      h === "localhost" || /^127\./.test(h) || /^10\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^192\.168\./.test(h) ||
      /^169\.254\./.test(h) || h === "::1" || /^fd[0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)
    ) return `Blocked: private/internal URLs are not allowed (${hostname})`;
    return null;
  } catch {
    return "Blocked: invalid URL";
  }
}

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
  run: async (raw) => {
    const { url, format } = validate(FetchUrlSchema, raw);
    // SSRF prevention
    try {
      validateUrlNotInternal(url);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
    if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;
    // Check content-length header
    const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
    if (contentLength > MAX_RESPONSE_BYTES) {
      return `Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`;
    }
    // Stream body with byte limit
    const body = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
    if (body === null) {
      return `Response too large: exceeded ${MAX_RESPONSE_BYTES} byte limit during streaming`;
    }
    return format === "json"
      ? JSON.stringify(JSON.parse(body), null, 2)
      : body;
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
      method: { type: "string", description: "HTTP method: GET, POST, PUT, DELETE, PATCH" },
      headers: { type: "object", description: "Optional request headers" },
      body: { type: "object", description: "Optional JSON request body" },
    },
    required: ["url", "method"],
  },
  run: async (raw) => {
    const { url, method, headers, body } = validate(CallApiSchema, raw);
    // SSRF prevention
    try {
      validateUrlNotInternal(url);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
    // Stream body with byte limit
    const responseBody = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
    if (responseBody === null) {
      return `HTTP ${res.status}\nResponse too large: exceeded ${MAX_RESPONSE_BYTES} byte limit`;
    }
    return `HTTP ${res.status}\n${responseBody}`;
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
  run: async (raw) => {
    const { prompt, model } = validate(AskClaudeSchema, raw);
    try {
      const client = new Anthropic();
      const message = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      if (message.content.length === 0) throw new Error("Anthropic returned empty content array");
      const block = message.content[0];
      if (!block) return "";
      if (block.type === "text") {
        if (!block.text) throw new Error("Anthropic returned empty text block");
        return block.text;
      }
      return JSON.stringify(block);
    } catch (err) {
      process.stderr.write('[ask_claude] Anthropic API failed, falling back to CLI: ' + (err instanceof Error ? err.message : String(err)) + '\n');
      return await runClaudeCLI(prompt, model);
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
  run: async (raw) => {
    const { pattern, directory } = validate(SearchFilesSchema, raw);
    const glob = new Glob(pattern);
    const matches: string[] = [];
    for await (const file of glob.scan(directory)) {
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
  run: async (raw) => {
    const { database, sql } = validate(QuerySqliteSchema, raw);
    if (!sql.trim().toUpperCase().startsWith("SELECT")) {
      return "Only SELECT queries are allowed";
    }
    const db = new Database(database, { readonly: true });
    try {
      const rows = db.query(sql).all();
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
  run: async (raw) => {
    const { agent_url, message, skill_id, args } = validate(CallA2aAgentSchema, raw);
    return sendTask(agent_url, {
      skillId: skill_id,
      args: args as Record<string, unknown> | undefined,
      message: { role: "user", parts: [{ kind: "text" as const, text: message }] },
    });
  },
};

// ── OSINT Skill Fallbacks ─────────────────────────────────────────
// Graceful degradation stubs: when a worker is down, these return a
// structured error instead of crashing the workflow. The delegate routing
// in server.ts tries the live worker first; these are last-resort fallbacks.

function osintFallback(skillId: string, workerName: string): Skill {
  return {
    id: skillId,
    name: skillId,
    description: `Fallback for ${skillId} (${workerName} worker unavailable)`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    run: async (args) => JSON.stringify({
      error: `${workerName} worker is unavailable`,
      skillId,
      fallback: true,
      message: `The ${workerName} worker (skill: ${skillId}) is not reachable. Start it or check its health.`,
      args: Object.keys(args),
    }),
  };
}

const OSINT_FALLBACK_SKILLS: Array<{ id: string; worker: string }> = [
  // news-agent (8089)
  { id: "fetch_rss", worker: "news" },
  { id: "aggregate_feeds", worker: "news" },
  { id: "classify_news", worker: "news" },
  { id: "cluster_news", worker: "news" },
  { id: "detect_signals", worker: "news" },
  // market-agent (8090)
  { id: "fetch_quote", worker: "market" },
  { id: "price_history", worker: "market" },
  { id: "technical_analysis", worker: "market" },
  { id: "screen_market", worker: "market" },
  { id: "detect_anomalies", worker: "market" },
  { id: "correlation", worker: "market" },
  // signal-agent (8091)
  { id: "aggregate_signals", worker: "signal" },
  { id: "classify_threat", worker: "signal" },
  { id: "detect_convergence", worker: "signal" },
  { id: "baseline_compare", worker: "signal" },
  { id: "instability_index", worker: "signal" },
  { id: "correlate_signals", worker: "signal" },
  // monitor-agent (8092)
  { id: "track_conflicts", worker: "monitor" },
  { id: "detect_surge", worker: "monitor" },
  { id: "theater_posture", worker: "monitor" },
  { id: "track_vessels", worker: "monitor" },
  { id: "check_freshness", worker: "monitor" },
  { id: "watchlist_check", worker: "monitor" },
  // infra-agent (8093)
  { id: "cascade_analysis", worker: "infra" },
  { id: "supply_chain_map", worker: "infra" },
  { id: "chokepoint_assess", worker: "infra" },
  { id: "redundancy_score", worker: "infra" },
  { id: "dependency_graph", worker: "infra" },
  // climate-agent (8094)
  { id: "fetch_earthquakes", worker: "climate" },
  { id: "fetch_wildfires", worker: "climate" },
  { id: "fetch_natural_events", worker: "climate" },
  { id: "assess_exposure", worker: "climate" },
  { id: "climate_anomalies", worker: "climate" },
  { id: "event_correlate", worker: "climate" },
];

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
  ...OSINT_FALLBACK_SKILLS.map(s => osintFallback(s.id, s.worker)),
];

export const SKILL_MAP = new Map(SKILLS.map((s) => [s.id, s]));
