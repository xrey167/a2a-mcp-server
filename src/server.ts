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
import { sendTask, discoverAgent, type AgentCard } from "./a2a.js";
import { initRegistry, listMcpServers, listMcpTools, callMcpTool, refreshManifest } from "./mcp-registry.js";
import { getProjectContext, setProjectContext, getContextPreamble } from "./context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Worker definitions ──────────────────────────────────────────
const WORKERS = [
  { name: "shell",     path: join(__dirname, "workers/shell.ts"),     port: 8081 },
  { name: "web",       path: join(__dirname, "workers/web.ts"),       port: 8082 },
  { name: "ai",        path: join(__dirname, "workers/ai.ts"),        port: 8083 },
  { name: "code",      path: join(__dirname, "workers/code.ts"),      port: 8084 },
  { name: "knowledge", path: join(__dirname, "workers/knowledge.ts"), port: 8085 },
];

const workerProcs: Array<ReturnType<typeof Bun.spawn>> = [];
let workerCards: AgentCard[] = [];

// ── Spawn workers ───────────────────────────────────────────────
function spawnWorkers() {
  for (const w of WORKERS) {
    const proc = Bun.spawn(["bun", w.path], {
      stderr: "inherit",
      stdout: "ignore",
    });
    workerProcs.push(proc);
    process.stderr.write(`[orchestrator] spawned ${w.name} (pid ${proc.pid})\n`);
  }
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

// ── Build skill-to-worker map ───────────────────────────────────
function buildSkillRouter(cards: AgentCard[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const card of cards) {
    for (const skill of card.skills) {
      map.set(skill.id, card.url);
    }
  }
  return map;
}

// ── Delegate skill ──────────────────────────────────────────────
async function delegate(args: Record<string, unknown>): Promise<string> {
  const agentUrl = args.agentUrl as string | undefined;
  const skillId = args.skillId as string | undefined;
  const message = (args.message as string) ?? "";
  const skillArgs = (args.args as Record<string, unknown>) ?? {};

  // Prepend project context if set
  const preamble = getContextPreamble();
  const enrichedMessage = preamble ? `${preamble}\n\n${message}` : message;
  const msgPayload = { role: "user", parts: [{ text: enrichedMessage }] };

  // 1. Direct URL
  if (agentUrl) {
    return sendTask(agentUrl, { skillId, args: skillArgs, message: msgPayload });
  }

  // 2. Route by skillId
  if (skillId) {
    const router = buildSkillRouter(workerCards);
    const url = router.get(skillId);
    if (url) {
      return sendTask(url, { skillId, args: skillArgs, message: msgPayload });
    }

    // Also check local skills (backwards compat)
    const localSkill = SKILL_MAP.get(skillId);
    if (localSkill) {
      return localSkill.run({ ...skillArgs, prompt: message, command: message, url: message });
    }

    return `No worker found with skill: ${skillId}`;
  }

  // 3. Auto-route via ask_claude
  const cardsJson = JSON.stringify(workerCards.map(c => ({
    name: c.name, url: c.url,
    skills: c.skills.map(s => s.id),
  })));
  const prompt = `Workers: ${cardsJson}. Task: ${message}. Reply JSON only: {"url":"...","skillId":"..."}`;

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
        return sendTask(parsed.url, { skillId: parsed.skillId, args: skillArgs, message: msgPayload });
      }
    } catch {}
    return response;
  }

  return "No AI worker available for auto-routing";
}

// ── Orchestrator skills (delegate + list_agents) ────────────────
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

// ── MCP Server ──────────────────────────────────────────────────
const server = new Server(
  { name: "a2a-mcp-bridge", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

// Gather all skills: existing local + delegate + list_agents + worker skills
function getAllToolDefs() {
  const tools = [
    // orchestrator tools
    { name: delegateSkill.id, description: delegateSkill.description, inputSchema: delegateSkill.inputSchema },
    { name: listAgentsSkill.id, description: listAgentsSkill.description, inputSchema: listAgentsSkill.inputSchema },
    { name: listMcpServersSkill.id, description: listMcpServersSkill.description, inputSchema: listMcpServersSkill.inputSchema },
    { name: useMcpToolSkill.id, description: useMcpToolSkill.description, inputSchema: useMcpToolSkill.inputSchema },
    { name: getProjectContextSkill.id, description: getProjectContextSkill.description, inputSchema: getProjectContextSkill.inputSchema },
    { name: setProjectContextSkill.id, description: setProjectContextSkill.description, inputSchema: setProjectContextSkill.inputSchema },
    // local skills from skills.ts (backwards compat)
    ...SKILLS.map(s => ({ name: s.id, description: s.description, inputSchema: s.inputSchema })),
  ];

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

  // delegate
  if (name === "delegate") {
    const result = await delegate(args ?? {});
    return { content: [{ type: "text", text: result }] };
  }

  // list_agents
  if (name === "list_agents") {
    return { content: [{ type: "text", text: JSON.stringify(workerCards, null, 2) }] };
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

  // local skill (backwards compat)
  const localSkill = SKILL_MAP.get(name);
  if (localSkill) {
    const result = await localSkill.run(args ?? {});
    return { content: [{ type: "text", text: result }] };
  }

  // route to worker by skill id
  const router = buildSkillRouter(workerCards);
  const workerUrl = router.get(name);
  if (workerUrl) {
    const message = (args as any)?.message ?? (args as any)?.prompt ?? (args as any)?.command ?? "";
    const result = await sendTask(workerUrl, {
      skillId: name,
      args: (args ?? {}) as Record<string, unknown>,
      message: { role: "user", parts: [{ text: String(message) }] },
    });
    return { content: [{ type: "text", text: result }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

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
      resultText = JSON.stringify(workerCards, null, 2);
    } else if (skillId) {
      // Try local first
      const localSkill = SKILL_MAP.get(skillId);
      if (localSkill) {
        resultText = await localSkill.run(args ?? { prompt: text, command: text, url: text });
      } else {
        // Route to worker
        const router = buildSkillRouter(workerCards);
        const url = router.get(skillId);
        if (url) {
          resultText = await sendTask(url, { skillId, args, message: { role: "user", parts: [{ text }] } });
        } else {
          resultText = `Unknown skill: ${skillId}`;
        }
      }
    } else {
      // Auto-delegate
      resultText = await delegate({ message: text });
    }

    return {
      jsonrpc: "2.0", id: data.id,
      result: { id: taskId, status: { state: "completed" },
        artifacts: [{ parts: [{ text: resultText }] }] },
    };
  });

  await app.listen({ port: 8080, host: "localhost" });
  process.stderr.write(`[orchestrator] A2A HTTP server on http://localhost:8080\n`);
}

// ── Start ───────────────────────────────────────────────────────
async function main() {
  // Init external MCP registry (reads ~/.claude.json, builds manifest, no connections yet)
  await initRegistry();

  // Spawn workers
  spawnWorkers();

  // Wait for workers to start
  await new Promise(r => setTimeout(r, 1500));

  // Discover worker cards
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
  for (const proc of workerProcs) proc.kill();
  process.exit(0);
});
process.on("SIGTERM", () => {
  for (const proc of workerProcs) proc.kill();
  process.exit(0);
});

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  for (const proc of workerProcs) proc.kill();
  process.exit(1);
});
