import Fastify from "fastify";
import { spawnSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { sanitizePath } from "../path-utils.js";
import { buildA2AResponse, checkRequestSize } from "../worker-harness.js";
import { stripAnsi, applyCommandFilter } from "../output-filter.js";
import { callPeer } from "../peer.js";
import { sanitizeUserInput } from "../prompt-sanitizer.js";
import { safeStringify } from "../safe-json.js";

const ShellSchemas = {
  run_shell: z.looseObject({ command: z.string().min(1) }),
  read_file: z.looseObject({ path: z.string().min(1) }),
  write_file: z.looseObject({ path: z.string().min(1), content: z.string() }),
  shell_brief: z.looseObject({
    /** Shell command to execute and explain */
    command: z.string().min(1),
    /** Optional context to help the AI interpret the output (e.g. "this is a git diff") */
    context: z.string().optional(),
    /** Timeout for the shell command in ms (default 15000, max 60000) */
    timeoutMs: z.number().int().positive().max(60_000).optional().default(15_000),
  }),
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
    { id: "shell_brief", name: "Shell Brief", description: "Execute a shell command and ask Claude to explain the output in plain language. Useful for interpreting git log, diff, ps, df, netstat, and other diagnostic commands." },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

/** Character limit for shell output sent to AI prompt — avoids token budget overrun.
 *  Char-based (not word-based) preserves column alignment in tabular output (ps, df, ls). */
const SHELL_BRIEF_CHAR_LIMIT = 30_000;

async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;
  switch (skillId) {
    case "run_shell": {
      const { command } = ShellSchemas.run_shell.parse({ command: args.command ?? text, ...args });
      // intentional: run_shell exists to execute arbitrary shell commands
      const result = spawnSync(command, { shell: true, timeout: 15_000, encoding: "utf-8" });
      if (result.error) return `Error: ${result.error.message}`;
      let out = result.stdout?.trim() ?? "";
      const err = result.stderr?.trim();
      if (result.status !== 0) {
        const raw = err || out;
        return `Exit ${result.status}: ${applyCommandFilter(raw, command, result.status ?? 1)}`;
      }
      // Apply worker-level output filtering (ANSI strip + command-aware)
      out = applyCommandFilter(out, command, 0);
      return out || "(no output)";
    }
    case "read_file": {
      const { path } = ShellSchemas.read_file.parse({ path: args.path ?? text, ...args });
      const safePath = sanitizePath(path);
      if (!existsSync(safePath)) return `File not found: ${safePath}`;
      return readFileSync(safePath, "utf-8");
    }
    case "write_file": {
      const { path, content } = ShellSchemas.write_file.parse(args);
      // Sanitize the path to prevent path traversal attacks
      const safePath = sanitizePath(path);
      writeFileSync(safePath, content, "utf-8");
      return `Written ${content.length} bytes to ${safePath}`;
    }
    case "shell_brief": {
      const { command, context, timeoutMs } = ShellSchemas.shell_brief.parse({ command: args.command ?? text, ...args });
      const result = spawnSync(command, { shell: true, timeout: timeoutMs, encoding: "utf-8" });
      if (result.error) {
        process.stderr.write(`[${NAME}] shell_brief: spawnSync failed for command: ${result.error.message}\n`);
        return `shell_brief: command execution failed — ${result.error.message}`;
      }

      const rawOut = stripAnsi((result.stdout ?? "").trim());
      const rawErr = stripAnsi((result.stderr ?? "").trim());
      const combined = rawOut + (rawErr ? `\n[stderr]\n${rawErr}` : "");

      if (combined.trim().length === 0) {
        process.stderr.write(`[${NAME}] shell_brief: command produced no output (exit ${result.status})\n`);
        return `shell_brief: command produced no output (exit ${result.status ?? 0})`;
      }

      // Truncate with char-based limit to preserve column alignment in tabular output
      const truncated = combined.length > SHELL_BRIEF_CHAR_LIMIT;
      const trimmedOutput = truncated
        ? combined.slice(0, SHELL_BRIEF_CHAR_LIMIT) + "\n... (output truncated)"
        : combined;

      const safeContext = context ? sanitizeUserInput(context, "context") : null;
      const safeCommand = sanitizeUserInput(command, "command");
      // Sanitize output before embedding in prompt — shell output is untrusted user-controlled data
      const safeOutput = sanitizeUserInput(trimmedOutput, "shell_output");

      const prompt = `You are a systems engineer explaining shell command output to a developer.

Command: ${safeCommand}
Exit code: ${result.status ?? 0}
${safeContext ? `Context: ${safeContext}\n` : ""}
Output:
${safeOutput}

Explain what this output means in 2–5 plain-language sentences. Focus on:
- What the command reported (status, counts, sizes, errors)
- Any warnings, failures, or anomalies
- What action (if any) a developer should take

Be specific about numbers and file names. Do not speculate beyond what the output shows.`;

      let brief: string;
      try {
        brief = await callPeer("ask_claude", { prompt }, prompt, 60_000);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] shell_brief: callPeer ask_claude failed: ${err instanceof Error ? err.stack : cause}\n`);
        return `shell_brief: AI explanation unavailable — ${cause}. Try again or use run_shell to view raw output.`;
      }

      return safeStringify({
        command: safeCommand,
        exitCode: result.status ?? 0,
        outputLines: combined.split("\n").length,
        dataQuality: truncated ? "partial" : "ok",
        brief,
      }, 2);
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
    resultText = await handleSkill(sid, args ?? { command: text }, text);
  } catch (err) {
    resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return buildA2AResponse(data.id, taskId, resultText);
});

// SSE streaming endpoint for run_shell
const STREAM_TIMEOUT_MS = 60_000; // 60s max for streaming commands
app.post<{ Body: Record<string, any> }>("/stream", async (request, reply) => {
  const data = request.body;

  const sizeErr = checkRequestSize(data);
  if (sizeErr) { reply.code(413); return { jsonrpc: "2.0", error: { code: -32000, message: sizeErr } }; }

  const { args, message } = data.params ?? data ?? {};
  const cmd = (args?.command as string) ?? message?.parts?.[0]?.text ?? "";

  if (!cmd) { reply.code(400); return { jsonrpc: "2.0", error: { code: -32602, message: "No command provided" } }; }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const child = spawn(cmd, { shell: true });

  // Kill child after timeout to prevent unbounded processes
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    sigkillTimer = setTimeout(() => {
      try {
        process.stderr.write('[shell] process did not exit after SIGTERM, sending SIGKILL\n');
        child.kill("SIGKILL");
      } catch (err) {
        process.stderr.write(`[shell] SIGKILL failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }, 5_000);
    reply.raw.write(`data: ${JSON.stringify({ type: "error", text: `Stream timeout after ${STREAM_TIMEOUT_MS}ms` })}\n\n`);
  }, STREAM_TIMEOUT_MS);

  child.stdout.on("data", (chunk: Buffer) => {
    reply.raw.write(`data: ${JSON.stringify({ type: "stdout", text: chunk.toString() })}\n\n`);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    reply.raw.write(`data: ${JSON.stringify({ type: "stderr", text: chunk.toString() })}\n\n`);
  });

  return new Promise<void>((resolve) => {
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      clearTimeout(sigkillTimer);
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
