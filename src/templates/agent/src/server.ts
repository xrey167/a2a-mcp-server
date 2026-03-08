/**
 * HTTP API server for {{name}}.
 *
 * POST /ask — run the agent with a user message
 * GET  /health — health check
 */

import Fastify from "fastify";
import { runAgent } from "./agent.js";

const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT ?? 3000);

// ── Routes ──────────────────────────────────────────────────────

app.post<{ Body: { message: string } }>("/ask", async (request, reply) => {
  const { message } = request.body ?? {};
  if (!message || typeof message !== "string") {
    reply.code(400);
    return { error: "Request body must include a 'message' string" };
  }

  try {
    const response = await runAgent(message);
    return { response };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reply.code(500);
    return { error: msg };
  }
});

app.get("/health", async () => ({
  status: "ok",
  agent: "{{name}}",
  uptime: process.uptime(),
}));

// ── Start ───────────────────────────────────────────────────────

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`{{name}} API listening on http://localhost:${PORT}`);
});
