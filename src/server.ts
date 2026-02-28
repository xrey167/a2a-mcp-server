import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Fastify from "fastify";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SKILLS, SKILL_MAP } from "./skills.js";
import { sendTask, discoverAgent, fetchWithTimeout, type AgentCard } from "./a2a.js";
import { initRegistry, listMcpServers, listMcpTools, callMcpTool } from "./mcp-registry.js";
import { getProjectContext, setProjectContext, getContextPreamble } from "./context.js";
import { initPlugins, watchPlugins, pluginSkills } from "./skill-loader.js";
import { getPersona, watchPersonas } from "./persona-loader.js";
import { memory } from "./memory.js";
import { createTask, completeTask, failTask, getTask, pruneStale } from "./task-store.js";
import { initAgentRegistry, registerAgent, unregisterAgent, getExternalCards, getRegistryEntries } from "./agent-registry.js";

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
const respawning = new Set<string>();
let workerCards: AgentCard[] = [];

// ── Spawn workers (with auto-respawn) ───────────────────────────
function spawnWorker(w: typeof WORKERS[number]) {
  respawning.delete(w.name);
  const proc = Bun.spawn(["bun", w.path], {
    stderr: "inherit",
    stdout: "ignore",
  });
  workerProcs.set(w.name, proc);
  process.stderr.write(`[orchestrator] spawned ${w.name} (pid ${proc.pid})\n`);
  // Auto-respawn on exit — guard against double-scheduling
  proc.exited.then(() => {
    if (respawning.has(w.name)) return;
    respawning.add(w.name);
    process.stderr.write(`[orchestrator] ${w.name} exited — respawning in 2s\n`);
    setTimeout(() => spawnWorker(w), 2000);
  });
}

function spawnWorkers() {
  for (const w of WORKERS) spawnWorker(w);
}

async function discoverWorkers(): Promise<AgentCard[]> {
  const cards: AgentCard[] = [];
  for (const w of WORKERS) {
    let card: AgentCard | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        card = await discoverAgent(`http://localhost:${w.port}`);
        break;
      } catch {
        if (attempt < 4) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    if (card) {
      cards.push(card);
    } else {
      process.stderr.write(`[orchestrator] failed to discover ${w.name} after 5 attempts\n`);
    }
  }
  return cards;
}

// ── Build skill-to-worker map ───────────────────────────────────
// External cards added first; built-in overwrites on collision → built-in always wins
function buildSkillRouter(builtinCards: AgentCard[], externalCards: AgentCard[] = []): Map<string, string> {
  const map = new Map<string, string>();
  for (const card of [...externalCards, ...builtinCards]) {
    for (const skill of card.skills) {
      map.set(skill.id, card.url);
    }
  }
  return map;
}

// ── Session continuity ──────────────────────────────────────────
const SESSION_AGENT = "sessions";
const MAX_TURNS = 20;

interface SessionMessage { role: "user" | "assistant"; text: string; ts: number; skillId?: string; }

function loadSessionHistory(sessionId: string): SessionMessage[] {
  const raw = memory.get(SESSION_AGENT, sessionId);
  if (!raw) return [];
  try { return JSON.parse(raw) as SessionMessage[]; } catch { return []; }
}

function saveSessionHistory(sessionId: string, history: SessionMessage[]): void {
  memory.set(SESSION_AGENT, sessionId, JSON.stringify(history.slice(-(MAX_TURNS * 2))));
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function pruneStaleSessionsImpl(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, value] of Object.entries(memory.all(SESSION_AGENT))) {
    try {
      const hist = JSON.parse(value) as SessionMessage[];
      const lastTs = hist[hist.length - 1]?.ts ?? 0;
      if (lastTs < cutoff) memory.forget(SESSION_AGENT, sessionId);
    } catch {
      memory.forget(SESSION_AGENT, sessionId);
    }
  }
}

// ── Delegate skill ──────────────────────────────────────────────
async function delegate(args: Record<string, unknown>): Promise<string> {
  const agentUrl = args.agentUrl as string | undefined;
  const skillId = args.skillId as string | undefined;
  const message = (args.message as string) ?? "";
  const skillArgs = (args.args as Record<string, unknown>) ?? {};
  const sessionId = args.sessionId as string | undefined;

  // Build session history prefix
  let historyPrefix = "";
  if (sessionId) {
    const history = loadSessionHistory(sessionId);
    if (history.length > 0) {
      const historyText = history
        .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
        .join("\n");
      historyPrefix = `[Session history]\n${historyText}\n\n[Current message]\n`;
    }
  }

  // Prepend project context if set
  const preamble = getContextPreamble();
  const enrichedMessage = preamble
    ? `${preamble}\n\n${historyPrefix}${message}`
    : historyPrefix ? `${historyPrefix}${message}` : message;
  const msgPayload = { role: "user" as const, parts: [{ kind: "text" as const, text: enrichedMessage }] };

  let result: string;

  // 1. Direct URL
  if (agentUrl) {
    result = await sendTask(agentUrl, { skillId, args: skillArgs, message: msgPayload });
  }
  // 2. Route by skillId
  else if (skillId) {
    const router = buildSkillRouter(workerCards, getExternalCards());
    const url = router.get(skillId);
    if (url) {
      result = await sendTask(url, { skillId, args: skillArgs, message: msgPayload });
    } else {
      // Also check local skills (backwards compat)
      const localSkill = SKILL_MAP.get(skillId);
      if (localSkill) {
        result = await localSkill.run({ ...skillArgs, prompt: message, command: message, url: message });
      } else {
        result = `No worker found with skill: ${skillId}`;
      }
    }
  }
  // 3. Auto-route via ask_claude (using orchestrator persona)
  else {
    const orchestratorPersona = getPersona("orchestrator");
    const cardsJson = JSON.stringify(workerCards.map(c => ({
      name: c.name, url: c.url,
      skills: c.skills.map(s => s.id),
    })));
    const prompt = `${orchestratorPersona.systemPrompt}\n\nWorkers: ${cardsJson}. Task: ${message}. Reply JSON only: {"url":"...","skillId":"..."}`;

    const aiUrl = workerCards.find(c => c.name === "ai-agent")?.url;
    if (aiUrl) {
      const response = await sendTask(aiUrl, {
        skillId: "ask_claude",
        args: { prompt },
        message: { role: "user" as const, parts: [{ kind: "text" as const, text: prompt }] },
      });
      try {
        const parsed = JSON.parse(response);
        if (parsed.url && parsed.skillId) {
          result = await sendTask(parsed.url, { skillId: parsed.skillId, args: skillArgs, message: msgPayload });
        } else {
          result = response;
        }
      } catch {
        result = response;
      }
    } else {
      result = "No AI worker available for auto-routing";
    }
  }

  // Persist session history
  if (sessionId) {
    const history = loadSessionHistory(sessionId);
    history.push({ role: "user", text: message, ts: Date.now(), skillId });
    history.push({ role: "assistant", text: result, ts: Date.now(), skillId });
    saveSessionHistory(sessionId, history);
  }

  return result;
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
      sessionId: { type: "string", description: "Session ID for conversation continuity (optional)" },
    },
    required: ["message"],
  },
};

const delegateAsyncSkill = {
  id: "delegate_async",
  name: "Delegate Async",
  description: "Fire-and-forget delegate — returns a taskId immediately. Poll with get_task_result.",
  inputSchema: {
    type: "object" as const,
    properties: {
      agentUrl: { type: "string", description: "Direct URL of the target agent (optional)" },
      skillId: { type: "string", description: "Skill ID to route to (optional)" },
      message: { type: "string", description: "Task message" },
      args: { type: "object", description: "Arguments for the target skill" },
      sessionId: { type: "string", description: "Session ID for conversation continuity (optional)" },
    },
    required: ["message"],
  },
};

const getTaskResultSkill = {
  id: "get_task_result",
  name: "Get Task Result",
  description: "Poll the result of a task started with delegate_async",
  inputSchema: {
    type: "object" as const,
    properties: {
      taskId: { type: "string", description: "Task ID returned by delegate_async" },
    },
    required: ["taskId"],
  },
};

const getSessionHistorySkill = {
  id: "get_session_history",
  name: "Get Session History",
  description: "Return the conversation history for a session",
  inputSchema: {
    type: "object" as const,
    properties: {
      sessionId: { type: "string", description: "Session ID" },
    },
    required: ["sessionId"],
  },
};

const clearSessionSkill = {
  id: "clear_session",
  name: "Clear Session",
  description: "Clear the conversation history for a session",
  inputSchema: {
    type: "object" as const,
    properties: {
      sessionId: { type: "string", description: "Session ID to clear" },
    },
    required: ["sessionId"],
  },
};

const registerAgentSkill = {
  id: "register_agent",
  name: "Register Agent",
  description: "Register an external A2A agent by URL — discovers its card and persists it",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "Base URL of the agent (e.g. http://host:8080)" },
    },
    required: ["url"],
  },
};

const unregisterAgentSkill = {
  id: "unregister_agent",
  name: "Unregister Agent",
  description: "Remove an external agent from the registry",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "Base URL of the agent to remove" },
    },
    required: ["url"],
  },
};

const runShellStreamSkill = {
  id: "run_shell_stream",
  name: "Run Shell Stream",
  description: "Execute a shell command with real-time stdout/stderr streamed as MCP progress notifications. Returns complete output when done.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "Shell command to run" },
      timeoutMs: { type: "number", description: "Timeout in milliseconds (default 120000)" },
    },
    required: ["command"],
  },
};

const listAgentsSkill = {
  id: "list_agents",
  name: "List Agents",
  description: "Return JSON of all worker agent cards (builtin + external) and their skills",
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

// ── MCP Server ──────────────────────────────────────────────────
const server = new Server(
  { name: "a2a-mcp-bridge", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

function getAllToolDefs() {
  const tools = [
    { name: delegateSkill.id, description: delegateSkill.description, inputSchema: delegateSkill.inputSchema },
    { name: delegateAsyncSkill.id, description: delegateAsyncSkill.description, inputSchema: delegateAsyncSkill.inputSchema },
    { name: getTaskResultSkill.id, description: getTaskResultSkill.description, inputSchema: getTaskResultSkill.inputSchema },
    { name: getSessionHistorySkill.id, description: getSessionHistorySkill.description, inputSchema: getSessionHistorySkill.inputSchema },
    { name: clearSessionSkill.id, description: clearSessionSkill.description, inputSchema: clearSessionSkill.inputSchema },
    { name: registerAgentSkill.id, description: registerAgentSkill.description, inputSchema: registerAgentSkill.inputSchema },
    { name: unregisterAgentSkill.id, description: unregisterAgentSkill.description, inputSchema: unregisterAgentSkill.inputSchema },
    { name: runShellStreamSkill.id, description: runShellStreamSkill.description, inputSchema: runShellStreamSkill.inputSchema },
    { name: listAgentsSkill.id, description: listAgentsSkill.description, inputSchema: listAgentsSkill.inputSchema },
    { name: listMcpServersSkill.id, description: listMcpServersSkill.description, inputSchema: listMcpServersSkill.inputSchema },
    { name: useMcpToolSkill.id, description: useMcpToolSkill.description, inputSchema: useMcpToolSkill.inputSchema },
    { name: getProjectContextSkill.id, description: getProjectContextSkill.description, inputSchema: getProjectContextSkill.inputSchema },
    { name: setProjectContextSkill.id, description: setProjectContextSkill.description, inputSchema: setProjectContextSkill.inputSchema },
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

  // run_shell_stream — handled first to access _meta.progressToken
  if (name === "run_shell_stream") {
    const command = (args as any)?.command as string;
    if (!command) throw new Error("run_shell_stream requires command");
    const timeoutMs = ((args as any)?.timeoutMs as number) ?? 120_000;
    const progressToken = (request.params as any)._meta?.progressToken;

    const res = await fetchWithTimeout("http://localhost:8081/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: { args: { command } } }),
    }, timeoutMs);

    if (!res.ok) throw new Error(`Shell stream error: HTTP ${res.status}`);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let chunkIndex = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const raw = decoder.decode(value);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "stdout" || event.type === "stderr") {
            accumulated += event.text;
            if (progressToken !== undefined) {
              await server.notification({
                method: "notifications/progress",
                params: { progressToken, progress: ++chunkIndex, message: event.text },
              });
            }
          }
        } catch {}
      }
    }

    return { content: [{ type: "text", text: accumulated || "(no output)" }] };
  }

  // delegate
  if (name === "delegate") {
    const result = await delegate(args ?? {});
    return { content: [{ type: "text", text: result }] };
  }

  // delegate_async
  if (name === "delegate_async") {
    const sessionId = (args as any)?.sessionId as string | undefined;
    const skillId = (args as any)?.skillId as string | undefined;
    const agentUrl = (args as any)?.agentUrl as string | undefined;
    const taskId = createTask({ sessionId, skillId, agentUrl });
    delegate(args ?? {})
      .then(result => completeTask(taskId, result))
      .catch(err => failTask(taskId, String(err)));
    return { content: [{ type: "text", text: JSON.stringify({ taskId }) }] };
  }

  // get_task_result
  if (name === "get_task_result") {
    pruneStale();
    const taskId = (args as any)?.taskId as string;
    if (!taskId) throw new Error("get_task_result requires taskId");
    const record = getTask(taskId);
    if (!record) return { content: [{ type: "text", text: JSON.stringify({ status: "not_found" }) }] };
    if (record.state === "pending") return { content: [{ type: "text", text: JSON.stringify({ status: "pending" }) }] };
    if (record.state === "completed") return { content: [{ type: "text", text: JSON.stringify({ status: "completed", result: record.result }) }] };
    return { content: [{ type: "text", text: JSON.stringify({ status: "failed", error: record.error }) }] };
  }

  // get_session_history
  if (name === "get_session_history") {
    pruneStaleSessionsImpl(); // lazy GC
    const sessionId = (args as any)?.sessionId as string;
    if (!sessionId) throw new Error("get_session_history requires sessionId");
    return { content: [{ type: "text", text: JSON.stringify(loadSessionHistory(sessionId), null, 2) }] };
  }

  // clear_session
  if (name === "clear_session") {
    const sessionId = (args as any)?.sessionId as string;
    if (!sessionId) throw new Error("clear_session requires sessionId");
    memory.forget(SESSION_AGENT, sessionId);
    return { content: [{ type: "text", text: `Session ${sessionId} cleared` }] };
  }

  // register_agent
  if (name === "register_agent") {
    const url = (args as any)?.url as string;
    if (!url) throw new Error("register_agent requires url");
    const card = await registerAgent(url);
    return { content: [{ type: "text", text: JSON.stringify(card, null, 2) }] };
  }

  // unregister_agent
  if (name === "unregister_agent") {
    const url = (args as any)?.url as string;
    if (!url) throw new Error("unregister_agent requires url");
    const existed = unregisterAgent(url);
    return { content: [{ type: "text", text: existed ? `Unregistered: ${url}` : `Not found: ${url}` }] };
  }

  // list_agents
  if (name === "list_agents") {
    const builtin = workerCards.map(c => ({ ...c, source: "builtin" }));
    const external = getRegistryEntries().map(e => ({ ...e.card, source: "external", registeredAt: e.registeredAt, lastSeenAt: e.lastSeenAt }));
    return { content: [{ type: "text", text: JSON.stringify([...builtin, ...external], null, 2) }] };
  }

  // list_mcp_servers
  if (name === "list_mcp_servers") {
    const servers = listMcpServers();
    const tools = listMcpTools();
    return { content: [{ type: "text", text: JSON.stringify({ servers, tools }, null, 2) }] };
  }

  // use_mcp_tool
  if (name === "use_mcp_tool") {
    const toolName = (args as any)?.toolName as string;
    const toolArgs = ((args as any)?.args ?? {}) as Record<string, unknown>;
    if (!toolName) throw new Error("use_mcp_tool requires toolName");
    const result = await callMcpTool(toolName, toolArgs);
    return { content: [{ type: "text", text: result }] };
  }

  // get_project_context
  if (name === "get_project_context") {
    return { content: [{ type: "text", text: JSON.stringify(getProjectContext(), null, 2) }] };
  }

  // set_project_context
  if (name === "set_project_context") {
    const updated = setProjectContext(args as any ?? {});
    return { content: [{ type: "text", text: `Project context updated:\n${JSON.stringify(updated, null, 2)}` }] };
  }

  // plugin skill
  const pluginSkill = pluginSkills.get(name);
  if (pluginSkill) {
    const result = await pluginSkill.run(args ?? {});
    return { content: [{ type: "text", text: result }] };
  }

  // local skill (backwards compat)
  const localSkill = SKILL_MAP.get(name);
  if (localSkill) {
    const result = await localSkill.run(args ?? {});
    return { content: [{ type: "text", text: result }] };
  }

  // route to worker by skill id
  const router = buildSkillRouter(workerCards, getExternalCards());
  const workerUrl = router.get(name);
  if (workerUrl) {
    const message = (args as any)?.message ?? (args as any)?.prompt ?? (args as any)?.command ?? "";
    const result = await sendTask(workerUrl, {
      skillId: name,
      args: (args ?? {}) as Record<string, unknown>,
      message: { role: "user" as const, parts: [{ kind: "text" as const, text: String(message) }] },
    });
    return { content: [{ type: "text", text: result }] };
  }

  throw new Error(`Unknown tool: ${name}`);
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
      version: "3.0.0",
      capabilities: { streaming: false },
      skills: allSkills,
    };
  });

  app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
    if (!checkAuth(request as any)) {
      reply.code(401);
      return { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized — set Authorization: Bearer <A2A_API_KEY>" } };
    }

    const data = request.body;
    if (data?.method !== "tasks/send") {
      reply.code(404);
      return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
    }

    const { skillId, args, message, id: taskId } = data.params ?? {};
    const text: string = message?.parts?.[0]?.text ?? "";

    let resultText: string;

    if (skillId === "delegate") {
      resultText = await delegate({ ...args, message: text });
    } else if (skillId === "list_agents") {
      const builtin = workerCards.map(c => ({ ...c, source: "builtin" }));
      const external = getRegistryEntries().map(e => ({ ...e.card, source: "external", registeredAt: e.registeredAt, lastSeenAt: e.lastSeenAt }));
      resultText = JSON.stringify([...builtin, ...external], null, 2);
    } else if (skillId === "list_mcp_servers") {
      resultText = JSON.stringify({ servers: listMcpServers(), tools: listMcpTools() }, null, 2);
    } else if (skillId === "use_mcp_tool") {
      const toolName = (args?.toolName as string);
      if (!toolName) { resultText = "use_mcp_tool requires toolName"; }
      else { resultText = await callMcpTool(toolName, (args?.args ?? {}) as Record<string, unknown>); }
    } else if (skillId === "get_project_context") {
      resultText = JSON.stringify(getProjectContext(), null, 2);
    } else if (skillId === "set_project_context") {
      resultText = JSON.stringify(setProjectContext(args ?? {}), null, 2);
    } else if (skillId) {
      // Check plugin skills first (hot-loaded)
      const pluginSkill = pluginSkills.get(skillId);
      if (pluginSkill) {
        resultText = await pluginSkill.run(args ?? {});
      } else {
        // Try local skill
        const localSkill = SKILL_MAP.get(skillId);
        if (localSkill) {
          resultText = await localSkill.run(args ?? { prompt: text, command: text, url: text });
        } else {
          // Route to worker (check external registry too)
          const router = buildSkillRouter(workerCards, getExternalCards());
          const url = router.get(skillId);
          if (url) {
            resultText = await sendTask(url, { skillId, args, message: { role: "user" as const, parts: [{ kind: "text" as const, text }] } });
          } else {
            resultText = `Unknown skill: ${skillId}`;
          }
        }
      }
    } else {
      // Auto-delegate
      resultText = await delegate({ message: text });
    }

    return {
      jsonrpc: "2.0", id: data.id,
      result: { id: taskId, status: { state: "completed" },
        artifacts: [{ parts: [{ kind: "text", text: resultText }] }] },
    };
  });

  await app.listen({ port: 8080, host: "0.0.0.0" });
  const authStatus = A2A_API_KEY ? `auth: Bearer required for remote` : `auth: none (set A2A_API_KEY to enable)`;
  process.stderr.write(`[orchestrator] A2A HTTP server on http://localhost:8080 — ${authStatus}\n`);
}

// ── Start ───────────────────────────────────────────────────────
async function main() {
  // Init external MCP registry (reads ~/.claude.json, builds manifest, no connections yet)
  await initRegistry();

  // Init external agent registry (synchronous, no delay needed)
  initAgentRegistry();

  // Init personas + plugin skills with hot-reload
  getPersona("orchestrator"); // warm cache
  watchPersonas();
  await initPlugins();
  watchPlugins(() => {
    process.stderr.write(`[orchestrator] plugin skills reloaded: ${pluginSkills.size} total\n`);
  });

  // Spawn workers and discover with retry (no fixed sleep needed)
  spawnWorkers();
  workerCards = await discoverWorkers();
  process.stderr.write(`[orchestrator] discovered ${workerCards.length} workers\n`);
  for (const card of workerCards) {
    process.stderr.write(`  - ${card.name}: ${card.skills.map(s => s.id).join(", ")}\n`);
  }

  // Start HTTP + MCP
  await startHttpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Cleanup on exit
process.on("SIGINT", () => {
  for (const proc of workerProcs.values()) proc.kill();
  process.exit(0);
});
process.on("SIGTERM", () => {
  for (const proc of workerProcs.values()) proc.kill();
  process.exit(0);
});

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  for (const proc of workerProcs.values()) proc.kill();
  process.exit(1);
});
