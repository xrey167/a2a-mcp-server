import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Fastify from "fastify";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SKILLS, SKILL_MAP } from "./skills.js";
import { sendTask, discoverAgent, type AgentCard } from "./a2a.js";
import { initRegistry, listMcpServers, listMcpTools, callMcpTool, refreshManifest } from "./mcp-registry.js";
import { getProjectContext, setProjectContext, getContextPreamble } from "./context.js";
import { initPlugins, watchPlugins, pluginSkills } from "./skill-loader.js";
import { getPersona, watchPersonas } from "./persona-loader.js";
import { memory } from "./memory.js";
import { AgentError, SkillNotFoundError, WorkerUnavailableError, formatError, toStatusError } from "./errors.js";
import {
  createTask, markWorking, markCompleted, markFailed, markCanceled, emitProgress,
  getTask, listTasks, pruneTasks, toA2AResult, taskEvents,
  type Task, type TaskState,
} from "./task-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Worker definitions ──────────────────────────────────────────
const WORKERS = [
  { name: "shell",     path: join(__dirname, "workers/shell.ts"),     port: 8081 },
  { name: "web",       path: join(__dirname, "workers/web.ts"),       port: 8082 },
  { name: "ai",        path: join(__dirname, "workers/ai.ts"),        port: 8083 },
  { name: "code",      path: join(__dirname, "workers/code.ts"),      port: 8084 },
  { name: "knowledge", path: join(__dirname, "workers/knowledge.ts"), port: 8085 },
];

const workerProcs = new Map<string, ReturnType<typeof Bun.spawn>>();
let workerCards: AgentCard[] = [];

// Track worker health status
const workerHealth = new Map<string, { healthy: boolean; failCount: number; lastCheck: number }>();

// Cached skill router — rebuilt when worker cards change
let skillRouterCache: Map<string, string> | null = null;

// ── Spawn workers (with auto-respawn) ───────────────────────────
const respawning = new Set<string>();

function spawnWorker(w: typeof WORKERS[number]) {
  const proc = Bun.spawn(["bun", w.path], {
    stderr: "inherit",
    stdout: "ignore",
  });
  workerProcs.set(w.name, proc);
  process.stderr.write(`[orchestrator] spawned ${w.name} (pid ${proc.pid})\n`);
  // Auto-respawn on exit
  proc.exited.then(() => {
    if (respawning.has(w.name)) return; // prevent multiple respawn attempts
    respawning.add(w.name);
    process.stderr.write(`[orchestrator] ${w.name} exited — respawning in 2s\n`);
    workerHealth.set(w.name, { healthy: false, failCount: 0, lastCheck: Date.now() });
    invalidateSkillRouter();
    setTimeout(() => {
      spawnWorker(w);
      respawning.delete(w.name);
      // Re-discover after respawn
      setTimeout(async () => {
        try {
          const card = await discoverAgent(`http://localhost:${w.port}`);
          // Replace or add the card
          workerCards = workerCards.filter(c => c.url !== card.url);
          workerCards.push(card);
          workerHealth.set(w.name, { healthy: true, failCount: 0, lastCheck: Date.now() });
          invalidateSkillRouter();
          process.stderr.write(`[orchestrator] re-discovered ${w.name} after respawn\n`);
        } catch {
          process.stderr.write(`[orchestrator] failed to re-discover ${w.name} after respawn\n`);
        }
      }, 2000);
    }, 2000);
  });
}

function spawnWorkers() {
  for (const w of WORKERS) spawnWorker(w);
}

// ── Health-based readiness polling ──────────────────────────────
async function waitForWorker(w: typeof WORKERS[number], maxWaitMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`http://localhost:${w.port}/healthz`);
      if (res.ok) {
        workerHealth.set(w.name, { healthy: true, failCount: 0, lastCheck: Date.now() });
        return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  workerHealth.set(w.name, { healthy: false, failCount: 0, lastCheck: Date.now() });
  return false;
}

async function waitForAllWorkers(): Promise<void> {
  const results = await Promise.all(WORKERS.map(w => waitForWorker(w)));
  const readyCount = results.filter(Boolean).length;
  process.stderr.write(`[orchestrator] ${readyCount}/${WORKERS.length} workers ready\n`);
}

async function discoverWorkers(): Promise<AgentCard[]> {
  const cards: AgentCard[] = [];
  for (const w of WORKERS) {
    try {
      const card = await discoverAgent(`http://localhost:${w.port}`);
      cards.push(card);
    } catch (err) {
      process.stderr.write(`[orchestrator] failed to discover ${w.name}: ${err}\n`);
    }
  }
  return cards;
}

// Periodic liveness checks (every 30s)
function startHealthMonitor() {
  setInterval(async () => {
    for (const w of WORKERS) {
      try {
        const res = await fetch(`http://localhost:${w.port}/healthz`);
        if (res.ok) {
          workerHealth.set(w.name, { healthy: true, failCount: 0, lastCheck: Date.now() });
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch {
        const prev = workerHealth.get(w.name) ?? { healthy: true, failCount: 0, lastCheck: 0 };
        const failCount = prev.failCount + 1;
        const wasHealthy = prev.healthy;
        const nowHealthy = failCount < 3;
        workerHealth.set(w.name, { healthy: nowHealthy, failCount, lastCheck: Date.now() });
        if (wasHealthy && !nowHealthy) {
          process.stderr.write(`[orchestrator] ${w.name} marked unhealthy (3 consecutive failures)\n`);
          invalidateSkillRouter();
        }
      }
    }
  }, 30_000);
}

// ── Build skill-to-worker map (cached) ──────────────────────────
function invalidateSkillRouter() {
  skillRouterCache = null;
}

function buildSkillRouter(cards: AgentCard[]): Map<string, string> {
  if (skillRouterCache) return skillRouterCache;

  const map = new Map<string, string>();
  for (const card of cards) {
    // Skip unhealthy workers
    const wName = WORKERS.find(w => card.url.includes(`:${w.port}`))?.name;
    if (wName && workerHealth.get(wName)?.healthy === false) continue;

    for (const skill of card.skills) {
      map.set(skill.id, card.url);
    }
  }
  skillRouterCache = map;
  return map;
}

// ── URL validation (SSRF prevention) ────────────────────────────
/** Only allow HTTP URLs pointing to known localhost worker ports or the orchestrator. */
function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return false;
    const port = parseInt(parsed.port || "80", 10);
    const allowedPorts = new Set([8080, ...WORKERS.map(w => w.port)]);
    return allowedPorts.has(port);
  } catch {
    return false;
  }
}

// ── Delegate skill ──────────────────────────────────────────────
async function delegate(args: Record<string, unknown>): Promise<string> {
  const agentUrl = args.agentUrl as string | undefined;
  const skillId = args.skillId as string | undefined;
  const message = (args.message as string) ?? "";
  const skillArgs = (args.args as Record<string, unknown>) ?? {};

  const startTime = Date.now();

  // Prepend project context if set
  const preamble = getContextPreamble();
  const enrichedMessage = preamble ? `${preamble}\n\n${message}` : message;
  const msgPayload = { role: "user", parts: [{ text: enrichedMessage }] };

  try {
    // 1. Direct URL (validated against allowed worker URLs)
    if (agentUrl) {
      if (!isAllowedUrl(agentUrl)) {
        throw new AgentError("ROUTING_ERROR", `URL not allowed: ${agentUrl}. Only localhost worker URLs are permitted.`);
      }
      const result = await sendTask(agentUrl, { skillId, args: skillArgs, message: msgPayload });
      logRequest(skillId ?? "delegate", agentUrl, "completed", Date.now() - startTime);
      return result;
    }

    // 2. Route by skillId
    if (skillId) {
      const router = buildSkillRouter(workerCards);
      const url = router.get(skillId);
      if (url) {
        const result = await sendTask(url, { skillId, args: skillArgs, message: msgPayload });
        logRequest(skillId, url, "completed", Date.now() - startTime);
        return result;
      }

      // Also check local skills (backwards compat)
      const localSkill = SKILL_MAP.get(skillId);
      if (localSkill) {
        return localSkill.run({ ...skillArgs, prompt: message, command: message, url: message });
      }

      throw new SkillNotFoundError(skillId);
    }

    // 3. Auto-route via ask_claude (using orchestrator persona)
    const orchestratorPersona = getPersona("orchestrator");
    const cardsJson = JSON.stringify(workerCards.map(c => ({
      name: c.name, url: c.url,
      skills: c.skills.map(s => s.id),
    })));
    const prompt = `${orchestratorPersona.systemPrompt}\n\nWorkers: ${cardsJson}. Task: ${message}. Reply JSON only: {"url":"...","skillId":"..."}`;

    // Try to find ai worker
    const aiUrl = workerCards.find(c => c.name === "ai-agent")?.url;
    if (aiUrl) {
      const response = await sendTask(aiUrl, {
        skillId: "ask_claude",
        args: { prompt },
        message: { role: "user", parts: [{ text: prompt }] },
      });
      try {
        const parsed = JSON.parse(response);
        if (parsed.url && parsed.skillId) {
          // Validate AI-generated URL to prevent SSRF
          if (!isAllowedUrl(parsed.url)) {
            process.stderr.write(`[orchestrator] AI auto-route returned disallowed URL: ${parsed.url}\n`);
            return `Error: AI suggested a URL that is not a known worker: ${parsed.url}`;
          }
          const result = await sendTask(parsed.url, { skillId: parsed.skillId, args: skillArgs, message: msgPayload });
          logRequest(parsed.skillId, parsed.url, "completed", Date.now() - startTime);
          return result;
        }
      } catch {}
      return response;
    }

    throw new WorkerUnavailableError("ai-agent", "needed for auto-routing");
  } catch (err) {
    logRequest(skillId ?? "delegate", agentUrl ?? "unknown", "failed", Date.now() - startTime);
    throw err;
  }
}

function logRequest(skill: string, worker: string, status: string, durationMs: number) {
  process.stderr.write(`[orchestrator] skill=${skill} worker=${worker} → ${status} (${durationMs}ms)\n`);
}

// ── Centralized skill dispatch ──────────────────────────────────
/** Dispatch a skill by name with args and fallback text. Used by both MCP and A2A handlers. */
async function dispatchSkill(skillId: string | undefined, args: Record<string, unknown>, text: string): Promise<string> {
  if (skillId === "delegate") {
    return delegate({ ...args, message: text });
  }
  if (skillId === "list_agents") {
    return JSON.stringify(workerCards, null, 2);
  }
  if (skillId === "list_mcp_servers") {
    return JSON.stringify({ servers: listMcpServers(), tools: listMcpTools() }, null, 2);
  }
  if (skillId === "use_mcp_tool") {
    const toolName = (args?.toolName as string);
    if (!toolName) throw new AgentError("INVALID_ARGS", "use_mcp_tool requires toolName");
    return callMcpTool(toolName, (args?.args ?? {}) as Record<string, unknown>);
  }
  if (skillId === "get_project_context") {
    return JSON.stringify(getProjectContext(), null, 2);
  }
  if (skillId === "set_project_context") {
    return JSON.stringify(setProjectContext(args ?? {}), null, 2);
  }
  if (skillId === "memory_search") {
    const query = (args?.query as string) ?? text;
    const agent = args?.agent as string | undefined;
    if (!query) throw new AgentError("INVALID_ARGS", "memory_search requires query");
    return JSON.stringify(memory.search(query, agent), null, 2);
  }
  if (skillId === "memory_list") {
    const agent = (args?.agent as string) ?? "";
    const prefix = args?.prefix as string | undefined;
    if (!agent) throw new AgentError("INVALID_ARGS", "memory_list requires agent");
    return JSON.stringify(memory.listKeys(agent, prefix), null, 2);
  }
  if (skillId === "memory_cleanup") {
    const maxAgeDays = (args?.maxAgeDays as number) ?? 30;
    const count = memory.cleanup(maxAgeDays);
    return `Cleaned up ${count} memories older than ${maxAgeDays} days`;
  }
  if (skillId) {
    // Check plugin skills first (hot-loaded)
    const pluginSkill = pluginSkills.get(skillId);
    if (pluginSkill) return pluginSkill.run(args ?? {});

    // Try local skill (backwards compat)
    const localSkill = SKILL_MAP.get(skillId);
    if (localSkill) return localSkill.run(args ?? { prompt: text, command: text, url: text });

    // Route to worker
    const router = buildSkillRouter(workerCards);
    const url = router.get(skillId);
    if (url) return sendTask(url, { skillId, args, message: { role: "user", parts: [{ text }] } });

    throw new SkillNotFoundError(skillId);
  }
  // Auto-delegate
  return delegate({ message: text });
}

// ── Execute a task with full lifecycle ──────────────────────────
async function executeTask(
  task: Task,
  skillId: string | undefined,
  args: Record<string, unknown>,
  text: string,
): Promise<void> {
  markWorking(task.id);

  try {
    const resultText = await dispatchSkill(skillId, args, text);
    markCompleted(task.id, resultText);
  } catch (err) {
    markFailed(task.id, toStatusError(err));
    process.stderr.write(`[orchestrator] ${formatError(err, { taskId: task.id, skill: skillId })}\n`);
  }
}

// ── Orchestrator skill definitions ──────────────────────────────
const delegateSkill = {
  id: "delegate",
  name: "Delegate",
  description: "Route a task to the best worker agent. Provide agentUrl, skillId, or let AI pick.",
  inputSchema: {
    type: "object" as const,
    properties: {
      agentUrl: { type: "string", description: "Direct URL of the target agent (optional)" },
      skillId: { type: "string", description: "Skill ID to route to (optional)" },
      message: { type: "string", description: "Task message" },
      args: { type: "object", description: "Arguments for the target skill" },
    },
    required: ["message"],
  },
};

const listAgentsSkill = {
  id: "list_agents",
  name: "List Agents",
  description: "Return JSON of all worker agent cards and their skills",
  inputSchema: { type: "object" as const, properties: {} },
};

const listMcpServersSkill = {
  id: "list_mcp_servers",
  name: "List MCP Servers",
  description: "Return all external MCP servers registered in ~/.claude.json and their tool counts",
  inputSchema: { type: "object" as const, properties: {} },
};

const useMcpToolSkill = {
  id: "use_mcp_tool",
  name: "Use MCP Tool",
  description: "Call a tool on an external MCP server (lazy-connected on first use)",
  inputSchema: {
    type: "object" as const,
    properties: {
      toolName: { type: "string", description: "Name of the MCP tool to call" },
      args: { type: "object", description: "Arguments to pass to the tool" },
    },
    required: ["toolName"],
  },
};

const getProjectContextSkill = {
  id: "get_project_context",
  name: "Get Project Context",
  description: "Return the current project context (summary, goals, stack, notes)",
  inputSchema: { type: "object" as const, properties: {} },
};

const setProjectContextSkill = {
  id: "set_project_context",
  name: "Set Project Context",
  description: "Set or update the project context injected into all agent delegate calls",
  inputSchema: {
    type: "object" as const,
    properties: {
      summary: { type: "string", description: "1-3 sentence project summary" },
      goals: { type: "array", items: { type: "string" }, description: "Current sprint goals" },
      stack: { type: "array", items: { type: "string" }, description: "Tech stack tags" },
      notes: { type: "string", description: "Freeform context notes" },
    },
  },
};

const memorySearchSkill = {
  id: "memory_search",
  name: "Memory Search",
  description: "Full-text search across all agent memories",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query (FTS5 syntax supported)" },
      agent: { type: "string", description: "Filter by agent name (optional)" },
    },
    required: ["query"],
  },
};

const memoryListSkill = {
  id: "memory_list",
  name: "Memory List",
  description: "List all memory keys for an agent, optionally filtered by prefix",
  inputSchema: {
    type: "object" as const,
    properties: {
      agent: { type: "string", description: "Agent name" },
      prefix: { type: "string", description: "Key prefix filter (optional)" },
    },
    required: ["agent"],
  },
};

const memoryCleanupSkill = {
  id: "memory_cleanup",
  name: "Memory Cleanup",
  description: "Delete memories older than N days",
  inputSchema: {
    type: "object" as const,
    properties: {
      maxAgeDays: { type: "number", description: "Delete memories older than this many days (default: 30)" },
    },
  },
};

// ── MCP Server ──────────────────────────────────────────────────
const server = new Server(
  { name: "a2a-mcp-bridge", version: "4.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

// ── MCP Tools ───────────────────────────────────────────────────

function getAllToolDefs() {
  const tools = [
    // orchestrator tools
    { name: delegateSkill.id, description: delegateSkill.description, inputSchema: delegateSkill.inputSchema },
    { name: listAgentsSkill.id, description: listAgentsSkill.description, inputSchema: listAgentsSkill.inputSchema },
    { name: listMcpServersSkill.id, description: listMcpServersSkill.description, inputSchema: listMcpServersSkill.inputSchema },
    { name: useMcpToolSkill.id, description: useMcpToolSkill.description, inputSchema: useMcpToolSkill.inputSchema },
    { name: getProjectContextSkill.id, description: getProjectContextSkill.description, inputSchema: getProjectContextSkill.inputSchema },
    { name: setProjectContextSkill.id, description: setProjectContextSkill.description, inputSchema: setProjectContextSkill.inputSchema },
    // memory tools
    { name: memorySearchSkill.id, description: memorySearchSkill.description, inputSchema: memorySearchSkill.inputSchema },
    { name: memoryListSkill.id, description: memoryListSkill.description, inputSchema: memoryListSkill.inputSchema },
    { name: memoryCleanupSkill.id, description: memoryCleanupSkill.description, inputSchema: memoryCleanupSkill.inputSchema },
    // local skills from skills.ts (backwards compat)
    ...SKILLS.map(s => ({ name: s.id, description: s.description, inputSchema: s.inputSchema })),
  ];

  // Plugin skills (dynamically loaded from src/plugins/ and vault _plugins/)
  for (const skill of pluginSkills.values()) {
    if (tools.some(t => t.name === skill.id)) continue;
    tools.push({ name: skill.id, description: `[plugin] ${skill.description}`, inputSchema: skill.inputSchema });
  }

  // Also expose worker skills directly
  for (const card of workerCards) {
    for (const skill of card.skills) {
      // Skip if already registered (local skills take priority)
      if (tools.some(t => t.name === skill.id)) continue;
      tools.push({
        name: skill.id,
        description: `[${card.name}] ${skill.description}`,
        inputSchema: { type: "object" as const, properties: { message: { type: "string" } }, required: [] as string[] },
      });
    }
  }

  return tools;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getAllToolDefs(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const startTime = Date.now();
  const text = (args as any)?.message ?? (args as any)?.prompt ?? (args as any)?.command ?? "";

  try {
    const result = await dispatchSkill(name, (args ?? {}) as Record<string, unknown>, String(text));
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    const errMsg = err instanceof AgentError ? `[${err.code}] ${err.message}` : String(err);
    process.stderr.write(`[orchestrator] MCP tool=${name} → error (${Date.now() - startTime}ms): ${errMsg}\n`);
    return { content: [{ type: "text", text: `Error: ${errMsg}` }], isError: true };
  }
});

// ── MCP Resources ───────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources: Array<{ uri: string; name: string; description: string; mimeType: string }> = [];

  // Project context
  resources.push({
    uri: "a2a://context",
    name: "Project Context",
    description: "Current project context (summary, goals, stack, notes)",
    mimeType: "application/json",
  });

  // Worker agent cards
  for (const card of workerCards) {
    resources.push({
      uri: `a2a://workers/${encodeURIComponent(card.name)}/card`,
      name: `${card.name} Agent Card`,
      description: `Agent card for ${card.name}: ${card.description}`,
      mimeType: "application/json",
    });
  }

  // Worker health status
  resources.push({
    uri: "a2a://health",
    name: "Worker Health",
    description: "Health status of all worker agents",
    mimeType: "application/json",
  });

  // Task list
  resources.push({
    uri: "a2a://tasks",
    name: "Task List",
    description: "List of all active and recent tasks",
    mimeType: "application/json",
  });

  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "a2a://context") {
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(getProjectContext(), null, 2) }],
    };
  }

  if (uri === "a2a://health") {
    const health: Record<string, unknown> = {};
    for (const w of WORKERS) {
      health[w.name] = workerHealth.get(w.name) ?? { healthy: false, failCount: 0, lastCheck: 0 };
    }
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(health, null, 2) }],
    };
  }

  if (uri === "a2a://tasks") {
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(listTasks(), null, 2) }],
    };
  }

  const workerMatch = uri.match(/^a2a:\/\/workers\/([^/]+)\/card$/);
  if (workerMatch) {
    const name = decodeURIComponent(workerMatch[1]);
    const card = workerCards.find(c => c.name === name);
    if (!card) throw new AgentError("ROUTING_ERROR", `Worker not found: ${name}`);
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(card, null, 2) }],
    };
  }

  throw new AgentError("ROUTING_ERROR", `Resource not found: ${uri}`);
});

// ── MCP Prompts ─────────────────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  const prompts: Array<{ name: string; description: string; arguments?: Array<{ name: string; description: string; required?: boolean }> }> = [];

  // Persona-based prompts
  const personaNames = ["orchestrator", "shell-agent", "web-agent", "ai-agent", "code-agent", "knowledge-agent"];
  for (const name of personaNames) {
    const persona = getPersona(name);
    if (persona.systemPrompt) {
      prompts.push({
        name: `persona-${name}`,
        description: `System prompt for the ${name} persona`,
      });
    }
  }

  // Delegate with context prompt
  prompts.push({
    name: "delegate-task",
    description: "Delegate a task with project context automatically injected",
    arguments: [
      { name: "message", description: "The task message to delegate", required: true },
      { name: "skillId", description: "Optional skill ID to target", required: false },
    ],
  });

  return { prompts };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: promptArgs } = request.params;

  // Allowed persona names (prevents path traversal via persona-../../etc/passwd)
  const ALLOWED_PERSONAS = new Set(["orchestrator", "shell-agent", "web-agent", "ai-agent", "code-agent", "knowledge-agent"]);

  // Persona prompts
  if (name.startsWith("persona-")) {
    const personaName = name.replace("persona-", "");
    if (!ALLOWED_PERSONAS.has(personaName)) {
      throw new AgentError("INVALID_ARGS", `Unknown persona: ${personaName}`);
    }
    const persona = getPersona(personaName);
    return {
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: persona.systemPrompt || `(no system prompt configured for ${personaName})` },
      }],
    };
  }

  // Delegate-task prompt
  if (name === "delegate-task") {
    const message = (promptArgs as any)?.message ?? "";
    const skillId = (promptArgs as any)?.skillId;
    const preamble = getContextPreamble();
    const enriched = preamble ? `${preamble}\n\n${message}` : message;

    const parts: string[] = [`Task: ${enriched}`];
    if (skillId) parts.push(`Target skill: ${skillId}`);
    parts.push(`\nAvailable workers:\n${workerCards.map(c => `- ${c.name}: ${c.skills.map(s => s.id).join(", ")}`).join("\n")}`);

    return {
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: parts.join("\n") },
      }],
    };
  }

  throw new AgentError("ROUTING_ERROR", `Prompt not found: ${name}`);
});

// ── A2A HTTP auth ────────────────────────────────────────────────
// Set A2A_API_KEY env var to require Bearer auth from non-loopback callers.
// Loopback (127.0.0.1 / ::1) is always trusted so local plugins/workers work.
const A2A_API_KEY = process.env.A2A_API_KEY ?? undefined;

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function checkAuth(request: { ip: string; headers: Record<string, string | string[] | undefined> }): boolean {
  if (!A2A_API_KEY) return true;          // no key set → open (local-only mode)
  if (isLoopback(request.ip)) return true; // loopback always trusted
  const auth = request.headers["authorization"];
  const token = Array.isArray(auth) ? auth[0] : auth;
  return token === `Bearer ${A2A_API_KEY}`;
}

// ── A2A HTTP Server ─────────────────────────────────────────────
async function startHttpServer() {
  const app = Fastify({ logger: false });

  // Agent card: merge all worker skills
  app.get("/.well-known/agent.json", async () => {
    const allSkills: Array<{ id: string; name: string; description: string }> = [
      { id: "delegate", name: "Delegate", description: delegateSkill.description },
      { id: "list_agents", name: "List Agents", description: listAgentsSkill.description },
      { id: "memory_search", name: "Memory Search", description: memorySearchSkill.description },
      { id: "memory_list", name: "Memory List", description: memoryListSkill.description },
      { id: "memory_cleanup", name: "Memory Cleanup", description: memoryCleanupSkill.description },
      ...SKILLS.map(({ id, name, description }) => ({ id, name, description })),
    ];
    for (const card of workerCards) {
      for (const skill of card.skills) {
        if (!allSkills.some(s => s.id === skill.id)) {
          allSkills.push(skill);
        }
      }
    }
    return {
      name: "Local A2A Orchestrator",
      description: "MCP + A2A orchestrator with multi-agent workers",
      url: "http://localhost:8080",
      version: "4.0.0",
      capabilities: { streaming: true },
      skills: allSkills,
    };
  });

  // Health check for orchestrator itself
  app.get("/healthz", async (request) => {
    if (!checkAuth(request as any)) {
      return { error: "Unauthorized", status: "error" };
    }
    const workerStatus: Record<string, boolean> = {};
    for (const w of WORKERS) {
      workerStatus[w.name] = workerHealth.get(w.name)?.healthy ?? false;
    }
    return {
      status: "ok",
      uptime: process.uptime(),
      workers: workerStatus,
      tasks: { total: listTasks().length, active: listTasks("working").length },
    };
  });

  // tasks/send — create task, execute async, return immediately with status
  app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
    if (!checkAuth(request as any)) {
      reply.code(401);
      return { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized — set Authorization: Bearer <A2A_API_KEY>" } };
    }

    const data = request.body;
    const method = data?.method;

    // tasks/get — poll task status
    if (method === "tasks/get") {
      const taskId = data.params?.id;
      if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
        return { jsonrpc: "2.0", id: data.id, error: { code: -32602, message: "Invalid params: 'id' must be a non-empty string" } };
      }
      const task = getTask(taskId);
      if (!task) {
        return { jsonrpc: "2.0", id: data.id, error: { code: -32602, message: `Task not found: ${taskId}` } };
      }
      return { jsonrpc: "2.0", id: data.id, result: toA2AResult(task) };
    }

    // tasks/cancel
    if (method === "tasks/cancel") {
      const taskId = data.params?.id;
      if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
        return { jsonrpc: "2.0", id: data.id, error: { code: -32602, message: "Invalid params: 'id' must be a non-empty string" } };
      }
      const task = markCanceled(taskId);
      if (!task) {
        return { jsonrpc: "2.0", id: data.id, error: { code: -32602, message: `Task not found or already terminal: ${taskId}` } };
      }
      return { jsonrpc: "2.0", id: data.id, result: toA2AResult(task) };
    }

    if (method !== "tasks/send") {
      reply.code(404);
      return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
    }

    const { skillId, args, message, id: taskId } = data.params ?? {};
    const text: string = message?.parts?.[0]?.text ?? "";

    // Create task in store
    const task = createTask({ id: taskId, skillId });

    // Execute asynchronously (task lifecycle managed by executeTask)
    executeTask(task, skillId, args ?? {}, text).catch((err) => {
      process.stderr.write(`[orchestrator] unhandled executeTask error taskId=${task.id}: ${err}\n`);
    });

    // Return submitted status immediately
    return {
      jsonrpc: "2.0", id: data.id,
      result: toA2AResult(task),
    };
  });

  // SSE streaming endpoint — subscribe to task events
  app.get<{ Params: { taskId: string } }>("/stream/:taskId", async (request, reply) => {
    if (!checkAuth(request as any)) {
      reply.code(401);
      return { error: "Unauthorized — set Authorization: Bearer <A2A_API_KEY>" };
    }

    const { taskId } = request.params;
    const task = getTask(taskId);

    // Return 404 for non-existent tasks instead of subscribing indefinitely
    if (!task) {
      reply.code(404);
      return { error: "Task not found", taskId };
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    /** Safe write — catches errors from closed/broken connections */
    function safeWrite(data: string): boolean {
      try {
        reply.raw.write(data);
        return true;
      } catch {
        return false;
      }
    }

    // Send current state
    safeWrite(`data: ${JSON.stringify({ type: "state_change", taskId, state: task.state })}\n\n`);

    // If already terminal, send final state and close
    if (task.state === "completed" || task.state === "failed" || task.state === "canceled") {
      safeWrite(`data: ${JSON.stringify(toA2AResult(task))}\n\n`);
      reply.raw.end();
      return;
    }

    // Subscribe to task events
    const handler = (event: any) => {
      if (!safeWrite(`data: ${JSON.stringify(event)}\n\n`)) {
        taskEvents.removeListener(`task:${taskId}`, handler);
        return;
      }

      // Close stream on terminal state
      if (event.state === "completed" || event.state === "failed" || event.state === "canceled") {
        // Use event data directly to avoid race condition with pruning
        safeWrite(`data: ${JSON.stringify({ type: "final", taskId, state: event.state, result: event.result ?? event.error })}\n\n`);
        try { reply.raw.end(); } catch {}
        taskEvents.removeListener(`task:${taskId}`, handler);
      }
    };

    taskEvents.on(`task:${taskId}`, handler);

    // Cleanup on client disconnect
    request.raw.on("close", () => {
      taskEvents.removeListener(`task:${taskId}`, handler);
    });
  });

  // SSE streaming endpoint — subscribe to all task events
  app.get("/stream", async (request, reply) => {
    if (!checkAuth(request as any)) {
      reply.code(401);
      return { error: "Unauthorized — set Authorization: Bearer <A2A_API_KEY>" };
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const handler = (event: any) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client disconnected — remove listener
        taskEvents.removeListener("task", handler);
      }
    };

    taskEvents.on("task", handler);

    request.raw.on("close", () => {
      taskEvents.removeListener("task", handler);
    });
  });

  await app.listen({ port: 8080, host: "0.0.0.0" });
  const authStatus = A2A_API_KEY ? `auth: Bearer required for remote` : `auth: none (set A2A_API_KEY to enable)`;
  process.stderr.write(`[orchestrator] A2A HTTP server on http://localhost:8080 — ${authStatus}\n`);
}

// ── Start ───────────────────────────────────────────────────────
async function main() {
  // Init external MCP registry (reads ~/.claude.json, builds manifest, no connections yet)
  await initRegistry();

  // Init personas + plugin skills with hot-reload
  getPersona("orchestrator"); // warm cache
  watchPersonas();
  await initPlugins();
  watchPlugins(() => {
    process.stderr.write(`[orchestrator] plugin skills reloaded: ${pluginSkills.size} total\n`);
  });

  // Spawn workers
  spawnWorkers();

  // Wait for workers using health checks (replaces hardcoded 1.5s delay)
  await waitForAllWorkers();

  // Discover worker cards
  workerCards = await discoverWorkers();
  process.stderr.write(`[orchestrator] discovered ${workerCards.length} workers\n`);
  for (const card of workerCards) {
    process.stderr.write(`  - ${card.name}: ${card.skills.map(s => s.id).join(", ")}\n`);
  }

  // Start periodic health monitoring
  startHealthMonitor();

  // Prune old tasks periodically (configurable via TASK_RETENTION_HOURS, default: 1 hour)
  const retentionHours = parseFloat(process.env.TASK_RETENTION_HOURS ?? "1");
  if (!Number.isFinite(retentionHours) || retentionHours <= 0) {
    process.stderr.write(`[orchestrator] Invalid TASK_RETENTION_HOURS: ${process.env.TASK_RETENTION_HOURS}, using default 1 hour\n`);
  }
  const validRetentionHours = Number.isFinite(retentionHours) && retentionHours > 0 ? retentionHours : 1;
  const retentionMs = validRetentionHours * 60 * 60 * 1000;
  setInterval(() => {
    const pruned = pruneTasks(retentionMs);
    if (pruned > 0) process.stderr.write(`[orchestrator] pruned ${pruned} old tasks (retention: ${validRetentionHours}h)\n`);
  }, retentionMs);

  // Start HTTP + MCP
  await startHttpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Cleanup on exit
function killAllWorkers() {
  for (const proc of workerProcs.values()) proc.kill();
}

process.on("SIGINT", () => {
  killAllWorkers();
  process.exit(0);
});
process.on("SIGTERM", () => {
  killAllWorkers();
  process.exit(0);
});

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  killAllWorkers();
  process.exit(1);
});
