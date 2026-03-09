// src/adapters/README.md is NOT created (per CLAUDE.md rules).
// src/adapters/langchain.ts
// Adapter that wraps a LangGraph graph or LangChain runnable as an A2A worker.
// Usage:
//   import { createLangChainWorker } from "./adapters/langchain.js";
//   const worker = createLangChainWorker({
//     name: "my-langgraph-agent",
//     port: 8090,
//     skills: [{ id: "run_graph", name: "Run Graph", description: "Execute the LangGraph graph" }],
//     handler: async (skillId, args, message) => {
//       const graph = createReactAgent(...);
//       const result = await graph.invoke({ messages: [{ role: "user", content: message }] });
//       return result.messages.at(-1).content;
//     },
//   });
//   worker.start();

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AgentCard, AgentSkill } from "../types.js";

export interface FrameworkWorkerConfig {
  /** Worker name (used in agent card) */
  name: string;
  /** Port to listen on */
  port: number;
  /** Description for the agent card */
  description?: string;
  /** Skills this adapter exposes */
  skills: AgentSkill[];
  /** Handler that maps (skillId, args, messageText) → result string */
  handler: (skillId: string, args: Record<string, unknown>, message: string) => Promise<string>;
  /** Optional: custom health check */
  healthCheck?: () => Promise<Record<string, unknown>>;
}

export interface FrameworkWorker {
  app: FastifyInstance;
  card: AgentCard;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Create an A2A-compatible worker that wraps any framework (LangGraph, CrewAI, AutoGen, etc.).
 * The handler function translates between A2A task format and framework-specific invocation.
 */
export function createFrameworkWorker(config: FrameworkWorkerConfig): FrameworkWorker {
  const { name, port, description, skills, handler, healthCheck } = config;

  const card: AgentCard = {
    name: `${name}-agent`,
    url: `http://localhost:${port}`,
    description: description ?? `${name} framework adapter`,
    version: "1.0.0",
    capabilities: { streaming: false },
    skills,
  };

  const app = Fastify({ logger: false, bodyLimit: 100 * 1024 });

  // Agent card discovery
  app.get("/.well-known/agent.json", async () => card);

  // Health check
  app.get("/healthz", async () => {
    const extra = healthCheck ? await healthCheck() : {};
    return { status: "ok", agent: card.name, uptime: process.uptime(), ...extra };
  });

  // A2A task endpoint
  app.post("/", async (req, reply) => {
    const body = req.body as any;
    const taskId = body?.params?.id ?? crypto.randomUUID();

    try {
      // Extract skill ID and args from the A2A message
      const parts = body?.params?.message?.parts ?? [];
      const firstPart = parts[0] ?? {};
      const skillId = firstPart?.metadata?.skillId ?? body?.params?.skillId ?? skills[0]?.id;
      const args = firstPart?.metadata?.args ?? body?.params?.args ?? {};
      const messageText = firstPart?.text ?? firstPart?.kind === "text" ? firstPart.text : JSON.stringify(firstPart);

      const result = await handler(skillId, args, messageText ?? "");

      return {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          id: taskId,
          status: { state: "completed" },
          artifacts: [{ parts: [{ kind: "text", text: result }] }],
        },
      };
    } catch (err: any) {
      process.stderr.write(`[${name}] error: ${err.message}\n`);
      return {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          id: taskId,
          status: { state: "failed", message: { role: "agent", parts: [{ kind: "text", text: err.message }] } },
          artifacts: [],
        },
      };
    }
  });

  return {
    app,
    card,
    start: async () => {
      await app.listen({ port, host: "0.0.0.0" });
      process.stderr.write(`[${name}] listening on :${port}\n`);
    },
    stop: async () => {
      await app.close();
    },
  };
}

/**
 * Convenience alias for LangGraph/LangChain users.
 */
export const createLangChainWorker = createFrameworkWorker;

/**
 * Convenience alias for CrewAI users.
 */
export const createCrewAIWorker = createFrameworkWorker;
