import Fastify from "fastify";
import { spawnSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { sanitizePath } from "../path-utils.js";
import { buildA2AResponse, checkRequestSize } from "../worker-harness.js";

const ShellSchemas = {
  run_shell: z.object({ command: z.string().min(1) }).passthrough(),
  read_file: z.object({ path: z.string().min(1) }).passthrough(),
  write_file: z.object({ path: z.string().min(1), content: z.string() }).passthrough(),
};

const PORT = 8081;
const NAME = "shell-agent";

const AGENT_CARD = {
  name: NAME,
  description: "Shell execution agent — run commands, read/write files, persistent memory",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: true },
  skills: [
    { id: "run_shell", name: "Run Shell", description: "Execute a shell command and return its output" },
    { id: "read_file", name: "Read File", description: "Read the contents of a file" },
    { id: "write_file", name: "Write File", description: "Write content to a file" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

function handleSkill(skillId: string, args: Record<string, unknown>, text: string): string {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;
  switch (skillId) {
    case "run_shell": {
      const { command } = ShellSchemas.run_shell.parse({ command: args.command ?? text, ...args });
      // intentional: run_shell exists to execute arbitrary shell commands
      const result = spawnSync(command, { shell: true, timeout: 15_000, encoding: "utf-8" });
      if (result.error) return `Error: ${result.error.message}`;
      const out = result.stdout?.trim();
      const err = result.stderr?.trim();
      if (result.status !== 0) return `Exit ${result.status}: ${err || out}`;
      return out || "(no output)";
    }
    case "read_file": {
      const { path } = ShellSchemas.read_file.parse({ path: args.path ?? text, ...args });
      if (!existsSync(path)) return `File not found: ${path}`;
      return readFileSync(path, "utf-8");
    }
    case "write_file": {
      const { path, content } = ShellSchemas.write_file.parse(args);
      // Sanitize the path to prevent path traversal attacks
      const safePath = sanitizePath(path);
      writeFileSync(safePath, content, "utf-8");
      return `Written ${content.length} bytes to ${safePath}`;
    }
    default:
      return `Unknown skill: ${skillId}`;
  }
}

const app = Fastify({ logger: false });

app.get("/.well-known/agent.json", async () => AGENT_CARD);

app.get("/healthz", async () => ({
  status: "ok",
  agent: NAME,
  uptime: process.uptime(),
  skills: AGENT_CARD.skills.map(s => s.id),
}));

app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
  const data = request.body;
  if (data?.method !== "tasks/send") {
    reply.code(404);
    return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
  }

  const sizeErr = checkRequestSize(data);
  if (sizeErr) { reply.code(413); return { jsonrpc: "2.0", error: { code: -32000, message: sizeErr } }; }

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "run_shell";
  let resultText: string;
  try {
    resultText = handleSkill(sid, args ?? { command: text }, text);
  } catch (err) {
    resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return buildA2AResponse(data.id, taskId, resultText);
});

// SSE streaming endpoint for run_shell
app.post<{ Body: Record<string, any> }>("/stream", async (request, reply) => {
  const data = request.body;
  const { args, message } = data.params ?? data ?? {};
  const cmd = (args?.command as string) ?? message?.parts?.[0]?.text ?? "";

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const child = spawn(cmd, { shell: true });

  child.stdout.on("data", (chunk: Buffer) => {
    reply.raw.write(`data: ${JSON.stringify({ type: "stdout", text: chunk.toString() })}\n\n`);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    reply.raw.write(`data: ${JSON.stringify({ type: "stderr", text: chunk.toString() })}\n\n`);
  });

  return new Promise<void>((resolve) => {
    child.on("close", (exitCode) => {
      reply.raw.write(`data: ${JSON.stringify({ type: "done", exitCode: exitCode ?? 0 })}\n\n`);
      reply.raw.end();
      resolve();
    });
  });
});

getPersona(NAME);
watchPersonas();

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
