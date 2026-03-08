/**
 * {{name}} — REST API server.
 *
 * Built with Fastify + Bun + SQLite.
 * Run: bun src/server.ts
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { itemRoutes } from "./routes/items.js";
import { healthRoutes } from "./routes/health.js";

const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT ?? 3000);

// ── Plugins ─────────────────────────────────────────────────────

const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
  : ["http://localhost:3000"];
await app.register(cors, { origin: ALLOWED_ORIGINS });

// ── Routes ──────────────────────────────────────────────────────

await app.register(healthRoutes);
await app.register(itemRoutes, { prefix: "/api" });

// ── Error handler ───────────────────────────────────────────────

app.setErrorHandler((error, request, reply) => {
  app.log.error(error);
  reply.code(error.statusCode ?? 500).send({
    error: error.message,
    statusCode: error.statusCode ?? 500,
  });
});

// ── Start ───────────────────────────────────────────────────────

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`{{name}} API listening on http://localhost:${PORT}`);
});
