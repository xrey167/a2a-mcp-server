// src/worker-loader.ts
// Discovers and loads user-space workers from ~/.a2a-mcp/workers/
// Each subdirectory should contain an index.ts with a Fastify server exporting AGENT_CARD.

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface UserWorker {
  name: string;
  path: string;
  port: number;
}

// User workers start at port 8095 to avoid clashing with built-in workers (8081-8094)
const USER_PORT_BASE = 8095;

function getWorkersDirectory(): string {
  return join(process.env.HOME ?? homedir(), ".a2a-mcp", "workers");
}

/**
 * Scan ~/.a2a-mcp/workers/ for user-defined worker directories.
 * Each directory must contain an index.ts that exports a Fastify server.
 * Port is assigned automatically starting from 8095 (or read from worker.json).
 */
export function discoverUserWorkers(): UserWorker[] {
  if (!existsSync(getWorkersDirectory())) return [];

  const entries = readdirSync(getWorkersDirectory()).filter(name => {
    const dir = join(getWorkersDirectory(), name);
    return statSync(dir).isDirectory() && existsSync(join(dir, "index.ts"));
  });

  return entries.map((name, i) => {
    const dir = join(getWorkersDirectory(), name);
    // Check for worker.json config
    let port = USER_PORT_BASE + i;
    const configPath = join(dir, "worker.json");
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const p = config.port;
      if (Number.isInteger(p) && p >= 1025 && p <= 65535 && (p < 8081 || p > 8094)) port = p;
    } catch (e: any) { if (e?.code !== "ENOENT") process.stderr.write(`[worker-loader] failed to parse ${configPath}: ${e}\n`); }
    return { name, path: join(dir, "index.ts"), port };
  });
}

/**
 * Scaffold a new worker in ~/.a2a-mcp/workers/<name>/
 */
export function scaffoldWorker(name: string, port?: number): string {
  const dir = join(getWorkersDirectory(), name);
  if (existsSync(dir)) {
    throw new Error(`Worker "${name}" already exists at ${dir}`);
  }

  mkdirSync(dir, { recursive: true });

  const assignedPort = port ?? USER_PORT_BASE;

  // worker.json
  writeFileSync(join(dir, "worker.json"), JSON.stringify({
    name,
    port: assignedPort,
    description: `Custom ${name} worker`,
  }, null, 2));

  // index.ts — minimal worker template
  writeFileSync(join(dir, "index.ts"), `import Fastify from "fastify";

const PORT = ${assignedPort};
const AGENT_CARD = {
  name: "${name}-agent",
  url: \`http://localhost:\${PORT}\`,
  description: "Custom ${name} worker",
  skills: [
    { id: "${name}_hello", name: "Hello", description: "A sample skill that echoes input" },
  ],
};

const app = Fastify({ logger: false });

// Agent card endpoint (required for discovery)
app.get("/.well-known/agent.json", async () => AGENT_CARD);

// Health check (required for monitoring)
app.get("/healthz", async () => ({ status: "ok", uptime: process.uptime() }));

// A2A task endpoint
app.post("/a2a", async (req) => {
  const body = req.body as any;
  const skillId = body?.params?.message?.parts?.[0]?.metadata?.skillId;
  const args = body?.params?.message?.parts?.[0]?.metadata?.args ?? {};
  const taskId = body?.params?.id ?? crypto.randomUUID();

  let result: string;
  switch (skillId) {
    case "${name}_hello":
      result = \`Hello from ${name}! You said: \${args.input ?? "(nothing)"}\`;
      break;
    default:
      result = \`Unknown skill: \${skillId}\`;
  }

  return {
    jsonrpc: "2.0",
    id: body.id,
    result: {
      id: taskId,
      status: { state: "completed" },
      artifacts: [{ parts: [{ type: "text", text: result }] }],
    },
  };
});

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  process.stderr.write(\`[${name}-agent] listening on :\${PORT}\\n\`);
}).catch((err) => {
  process.stderr.write(\`[${name}-agent] failed to listen: \${err}\\n\`);
  process.exit(1);
});
`);

  return dir;
}

export function getWorkersDir(): string {
  return getWorkersDirectory();
}

export function ensureWorkersDir(): void {
  if (!existsSync(getWorkersDirectory())) {
    mkdirSync(getWorkersDirectory(), { recursive: true });
  }
}
