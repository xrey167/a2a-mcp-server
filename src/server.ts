import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Fastify from "fastify";
import { randomUUID } from "crypto";

// ── MCP Server ───────────────────────────────────────────────────
const server = new Server(
  { name: "a2a-mcp-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── A2A Agent Card ───────────────────────────────────────────────
const AGENT_CARD = {
  name: "Local A2A Agent",
  description: "Local MCP server with A2A support",
  url: "http://localhost:8080",
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [{ id: "echo", name: "Echo", description: "Echoes a message back" }],
};

// ── MCP Tools (Claude sieht diese) ──────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "call_a2a_agent",
      description: "Send a task to an A2A agent via HTTP",
      inputSchema: {
        type: "object",
        properties: {
          agent_url: { type: "string" },
          message: { type: "string" },
        },
        required: ["agent_url", "message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "call_a2a_agent") {
    const result = await sendA2ATask(
      args!.agent_url as string,
      args!.message as string
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
  throw new Error(`Unknown tool: ${name}`);
});

// ── A2A Client (ruft andere Agents auf) ─────────────────────────
async function sendA2ATask(agentUrl: string, message: string) {
  const response = await fetch(agentUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tasks/send",
      id: randomUUID(),
      params: {
        id: randomUUID(),
        message: { role: "user", parts: [{ text: message }] },
      },
    }),
  });
  return response.json();
}

// ── A2A HTTP Server (andere Agents können diesen aufrufen) ───────
async function startHttpServer() {
  const app = Fastify({ logger: false });

  app.get("/.well-known/agent.json", async () => AGENT_CARD);

  app.post("/", async (request, reply) => {
    const data = request.body as Record<string, any>;
    const method = data?.method;

    if (method === "tasks/send") {
      const msg = data.params.message.parts[0].text;
      return {
        jsonrpc: "2.0",
        id: data.id,
        result: {
          id: data.params.id,
          status: { state: "completed" },
          artifacts: [{ parts: [{ text: `Echo: ${msg}` }] }],
        },
      };
    }

    reply.code(404);
    return {
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found" },
    };
  });

  await app.listen({ port: 8080, host: "localhost" });
  process.stderr.write("A2A HTTP server running on http://localhost:8080\n");
}

// ── Beide Server gleichzeitig starten ────────────────────────────
async function main() {
  await startHttpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
