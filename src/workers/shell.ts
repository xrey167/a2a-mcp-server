import Fastify from "fastify";
import { spawnSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { memory } from "../memory.js";
import { randomUUID } from "crypto";

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
  switch (skillId) {
    case "run_shell": {
      const cmd = (args.command as string) ?? text;
      // intentional: run_shell exists to execute arbitrary shell commands
      const result = spawnSync(cmd, { shell: true, timeout: 15_000, encoding: "utf-8" });
      if (result.error) return `Error: ${result.error.message}`;
      const out = result.stdout?.trim();
      const err = result.stderr?.trim();
      if (result.status !== 0) return `Exit ${result.status}: ${err || out}`;
      return out || "(no output)";
    }
    case "read_file": {
      const path = (args.path as string) ?? text;
      if (!existsSync(path)) return `File not found: ${path}`;
      return readFileSync(path, "utf-8");
    }
    case "write_file": {
      const path = args.path as string;
      const content = args.content as string;
      writeFileSync(path, content, "utf-8");
      return `Written ${content.length} bytes to ${path}`;
    }
    case "remember": {
      const key = args.key as string;
      const value = args.value as string;
      memory.set(NAME, key, value);
      return `Remembered: ${key}`;
    }
    case "recall": {
      const key = args.key as string | undefined;
      if (key) return memory.get(NAME, key) ?? `No memory found for key: ${key}`;
      return JSON.stringify(memory.all(NAME), null, 2);
    }
    default:
      return `Unknown skill: ${skillId}`;
  }
}

const app = Fastify({ logger: false });

app.get("/.well-known/agent.json", async () => AGENT_CARD);

app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
  const data = request.body;
  if (data?.method !== "tasks/send") {
    reply.code(404);
    return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
  }

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "run_shell";
  const resultText = handleSkill(sid, args ?? { command: text }, text);

  return {
    jsonrpc: "2.0", id: data.id,
    result: { id: taskId, status: { state: "completed" },
      artifacts: [{ parts: [{ text: resultText }] }] },
  };
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

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
