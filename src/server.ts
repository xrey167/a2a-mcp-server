import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Fastify from "fastify";
import { SKILLS, SKILL_MAP } from "./skills.js";

// ── MCP Server ───────────────────────────────────────────────────
const server = new Server(
  { name: "a2a-mcp-bridge", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ── A2A Agent Card (auto-generated from skill registry) ──────────
const AGENT_CARD = {
  name: "Local A2A Agent",
  description: "MCP + A2A server with system, web, Claude and data skills",
  url: "http://localhost:8080",
  version: "2.0.0",
  capabilities: { streaming: false },
  skills: SKILLS.map(({ id, name, description }) => ({ id, name, description })),
};

// ── MCP: expose all skills as tools ─────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: SKILLS.map((skill) => ({
    name: skill.id,
    description: skill.description,
    inputSchema: skill.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const skill = SKILL_MAP.get(name);
  if (!skill) throw new Error(`Unknown tool: ${name}`);
  const result = await skill.run(args ?? {});
  return { content: [{ type: "text", text: result }] };
});

// ── A2A HTTP Server ──────────────────────────────────────────────
async function startHttpServer() {
  const app = Fastify({ logger: false });

  app.get("/.well-known/agent.json", async () => AGENT_CARD);

  app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
    const data = request.body;

    if (data?.method !== "tasks/send") {
      reply.code(404);
      return {
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found" },
      };
    }

    const { skillId, args, message, id: taskId } = data.params ?? {};
    const text: string = message?.parts?.[0]?.text ?? "";

    let resultText: string;

    if (skillId) {
      const skill = SKILL_MAP.get(skillId);
      if (!skill) {
        reply.code(404);
        return {
          jsonrpc: "2.0",
          id: data.id,
          error: { code: -32601, message: `Skill not found: ${skillId}` },
        };
      }
      resultText = await skill.run(args ?? { prompt: text, command: text, url: text });
    } else {
      resultText = `Echo: ${text}`;
    }

    return {
      jsonrpc: "2.0",
      id: data.id,
      result: {
        id: taskId,
        status: { state: "completed" },
        artifacts: [{ parts: [{ text: resultText }] }],
      },
    };
  });

  await app.listen({ port: 8080, host: "localhost" });
  process.stderr.write(`A2A HTTP server running on http://localhost:8080\n`);
  process.stderr.write(
    `Skills: ${SKILLS.map((s) => s.id).join(", ")}\n`
  );
}

// ── Start ────────────────────────────────────────────────────────
async function main() {
  await startHttpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
