// src/cloud.ts
// Cloud deployment helpers — health endpoints, graceful shutdown, readiness probes.
// Used by fly.io, Railway, or any container platform.

import type { FastifyInstance } from "fastify";

// ── Types ────────────────────────────────────────────────────────

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  workers: WorkerHealth[];
  timestamp: string;
}

export interface WorkerHealth {
  name: string;
  url: string;
  healthy: boolean;
  lastCheck?: number;
}

// ── State ────────────────────────────────────────────────────────

let startTime = Date.now();
let isReady = false;
let workerStatuses: Map<string, WorkerHealth> = new Map();
const shutdownCallbacks: Array<() => Promise<void>> = [];

export function markReady(): void {
  isReady = true;
}

export function markNotReady(): void {
  isReady = false;
}

export function updateWorkerHealth(name: string, url: string, healthy: boolean): void {
  workerStatuses.set(name, { name, url, healthy, lastCheck: Date.now() });
}

export function onShutdown(cb: () => Promise<void>): void {
  shutdownCallbacks.push(cb);
}

// ── Health check logic ──────────────────────────────────────────

export function getHealth(version: string): HealthStatus {
  const workers = Array.from(workerStatuses.values());
  const allHealthy = workers.length > 0 && workers.every(w => w.healthy);
  const anyHealthy = workers.some(w => w.healthy);

  return {
    status: allHealthy ? "healthy" : anyHealthy ? "degraded" : "unhealthy",
    version,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    workers,
    timestamp: new Date().toISOString(),
  };
}

// ── Fastify plugin ──────────────────────────────────────────────

export function registerHealthRoutes(app: FastifyInstance, version: string): void {
  // Liveness — always returns 200 if the process is running
  app.get("/healthz", async (_req, reply) => {
    reply.send({ status: "alive", timestamp: new Date().toISOString() });
  });

  // Readiness — returns 200 only when workers are discovered
  app.get("/readyz", async (_req, reply) => {
    if (!isReady) {
      reply.status(503).send({ status: "not_ready", timestamp: new Date().toISOString() });
      return;
    }
    reply.send({ status: "ready", timestamp: new Date().toISOString() });
  });

  // Detailed health — returns worker-level status
  app.get("/health", async (_req, reply) => {
    const health = getHealth(version);
    const code = health.status === "unhealthy" ? 503 : 200;
    reply.status(code).send(health);
  });
}

// ── Graceful shutdown ───────────────────────────────────────────

export async function gracefulShutdown(signal: string): Promise<void> {
  process.stderr.write(`[cloud] received ${signal}, starting graceful shutdown\n`);
  markNotReady();

  // Run shutdown callbacks (e.g., close DB connections, flush metrics)
  for (const cb of shutdownCallbacks) {
    try {
      await cb();
    } catch (err) {
      process.stderr.write(`[cloud] shutdown callback error: ${err}\n`);
    }
  }

  process.stderr.write(`[cloud] shutdown complete\n`);
  process.exit(0);
}

/**
 * Install signal handlers for graceful shutdown.
 */
export function installShutdownHandlers(): void {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

/**
 * Reset state (for testing).
 */
export function resetCloudState(): void {
  startTime = Date.now();
  isReady = false;
  workerStatuses = new Map();
}
