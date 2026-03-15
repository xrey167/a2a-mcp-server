import Fastify from "fastify";
import { spawnSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { sanitizePath } from "../path-utils.js";
import { buildA2AResponse, checkRequestSize } from "../worker-harness.js";
import { stripAnsi, applyCommandFilter } from "../output-filter.js";

const ShellSchemas = {
  run_shell: z.looseObject({ command: z.string().min(1) }),
  read_file: z.looseObject({ path: z.string().min(1) }),
  write_file: z.looseObject({ path: z.string().min(1), content: z.string() }),
  list_dir: z.looseObject({ path: z.string().optional().default(".") }),
  diff_files: z.looseObject({
    /** Path to the original (old) file */
    pathA: z.string().min(1),
    /** Path to the modified (new) file */
    pathB: z.string().min(1),
    /** Number of context lines around each change (default 3, max 10) */
    context: z.number().int().min(0).max(10).optional().default(3),
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
    { id: "list_dir", name: "List Directory", description: "List files and subdirectories in a directory (non-recursive). Returns name and type (file/dir) for each entry." },
    { id: "diff_files", name: "Diff Files", description: "Compare two files and return a unified diff. Shows added/removed lines with configurable context. Useful for code review and change detection. Returns unified diff text or 'Files are identical' if no differences." },
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
    case "list_dir": {
      const { path } = ShellSchemas.list_dir.parse({ path: args.path ?? (text || "."), ...args });
      const safePath = sanitizePath(path);
      if (!existsSync(safePath)) return `Directory not found: ${safePath}`;
      const entries = readdirSync(safePath);
      const lines = entries.map(name => {
        try {
          const type = statSync(`${safePath}/${name}`).isDirectory() ? "dir" : "file";
          return `${type}\t${name}`;
        } catch {
          return `unknown\t${name}`;
        }
      });
      return lines.length > 0 ? lines.join("\n") : "(empty directory)";
    }
    case "diff_files": {
      let dfParsed: ReturnType<typeof ShellSchemas.diff_files.parse>;
      try {
        dfParsed = ShellSchemas.diff_files.parse(args);
      } catch (err) {
        process.stderr.write(`[${NAME}] diff_files: Zod parse error: ${err instanceof Error ? err.message : String(err)}\n`);
        throw err;
      }
      const { pathA, pathB, context: ctxLines } = dfParsed;

      const safeA = sanitizePath(pathA);
      const safeB = sanitizePath(pathB);

      if (!existsSync(safeA)) return `File not found: ${safeA}`;
      if (!existsSync(safeB)) return `File not found: ${safeB}`;

      const MAX_FILE_BYTES = 500_000; // 500 KB per file
      const MAX_LINES = 10_000;      // Guard against O(m*n) DP table OOM

      let statA: ReturnType<typeof statSync>;
      let statB: ReturnType<typeof statSync>;
      try { statA = statSync(safeA); } catch (err) {
        process.stderr.write(`[${NAME}] diff_files: stat failed for A (${safeA}): ${err instanceof Error ? err.message : String(err)}\n`);
        return `Error: cannot stat file A: ${safeA}`;
      }
      try { statB = statSync(safeB); } catch (err) {
        process.stderr.write(`[${NAME}] diff_files: stat failed for B (${safeB}): ${err instanceof Error ? err.message : String(err)}\n`);
        return `Error: cannot stat file B: ${safeB}`;
      }

      if (!statA.isFile()) return `Error: path A is not a regular file: ${safeA}`;
      if (!statB.isFile()) return `Error: path B is not a regular file: ${safeB}`;

      if (statA.size > MAX_FILE_BYTES) {
        process.stderr.write(`[${NAME}] diff_files: file A too large (${statA.size} bytes): ${safeA}\n`);
        return `Error: file A is ${statA.size} bytes — exceeds 500 KB limit for diff`;
      }
      if (statB.size > MAX_FILE_BYTES) {
        process.stderr.write(`[${NAME}] diff_files: file B too large (${statB.size} bytes): ${safeB}\n`);
        return `Error: file B is ${statB.size} bytes — exceeds 500 KB limit for diff`;
      }

      let linesA: string[];
      let linesB: string[];
      try { linesA = readFileSync(safeA, "utf-8").split("\n"); } catch (err) {
        process.stderr.write(`[${NAME}] diff_files: read failed for A (${safeA}): ${err instanceof Error ? err.message : String(err)}\n`);
        return `Error: cannot read file A: ${safeA}`;
      }
      try { linesB = readFileSync(safeB, "utf-8").split("\n"); } catch (err) {
        process.stderr.write(`[${NAME}] diff_files: read failed for B (${safeB}): ${err instanceof Error ? err.message : String(err)}\n`);
        return `Error: cannot read file B: ${safeB}`;
      }

      if (linesA.length > MAX_LINES || linesB.length > MAX_LINES) {
        process.stderr.write(`[${NAME}] diff_files: too many lines (A=${linesA.length}, B=${linesB.length}): ${safeA} vs ${safeB}\n`);
        return `Error: files exceed ${MAX_LINES}-line limit for diff (A=${linesA.length}, B=${linesB.length})`;
      }

      let diff: string;
      try {
        diff = computeUnifiedDiff(linesA, linesB, safeA, safeB, ctxLines);
      } catch (err) {
        process.stderr.write(`[${NAME}] diff_files: computeUnifiedDiff failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return `Error: diff computation failed — ${err instanceof Error ? err.message : String(err)}`;
      }
      return diff.trim().length === 0 ? "Files are identical" : diff;
    }
    default:
      return `Unknown skill: ${skillId}`;
  }
}

/**
 * Compute a unified diff between two line arrays using an LCS-based algorithm.
 * Returns unified diff text (with --- / +++ headers and @@ hunks).
 */
function computeUnifiedDiff(
  linesA: string[],
  linesB: string[],
  labelA: string,
  labelB: string,
  ctxLines: number,
): string {
  const m = linesA.length;
  const n = linesB.length;

  // Build LCS DP table (row-major flat array)
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp.push(new Array<number>(n + 1).fill(0));
  }
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const rowI = dp[i];
      const rowI1 = dp[i + 1];
      if (rowI && rowI1 && linesA[i] === linesB[j]) {
        rowI[j] = 1 + (rowI1[j + 1] ?? 0);
      } else if (rowI && rowI1) {
        rowI[j] = Math.max(rowI1[j] ?? 0, rowI[j + 1] ?? 0);
      }
    }
  }

  // Trace back to build edit list
  type Edit = { op: "=" | "+" | "-"; lineA: number; lineB: number; text: string };
  const edits: Edit[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    const rowI = dp[i];
    const rowI1 = dp[i + 1];
    const dpIJ1 = rowI ? (rowI[j + 1] ?? 0) : 0;
    const dpI1J = rowI1 ? (rowI1[j] ?? 0) : 0;
    if (i < m && j < n && linesA[i] === linesB[j]) {
      edits.push({ op: "=", lineA: i, lineB: j, text: linesA[i] ?? "" });
      i++; j++;
    } else if (i < m && (j >= n || dpI1J >= dpIJ1)) {
      // Prefer deletion before addition — unified diff convention: --- lines before +++ lines
      edits.push({ op: "-", lineA: i, lineB: j, text: linesA[i] ?? "" });
      i++;
    } else {
      edits.push({ op: "+", lineA: i, lineB: j, text: linesB[j] ?? "" });
      j++;
    }
  }

  // Find indices of all changed edits
  const changedIdx: number[] = [];
  for (let k = 0; k < edits.length; k++) {
    if (edits[k]?.op !== "=") changedIdx.push(k);
  }
  if (changedIdx.length === 0) return "";

  // Build hunk ranges: expand each change cluster by ctxLines and merge overlapping ranges
  const ranges: Array<[number, number]> = [];
  let rStart = Math.max(0, changedIdx[0]! - ctxLines);
  let rEnd = Math.min(edits.length, changedIdx[0]! + 1 + ctxLines);

  for (let ci = 1; ci < changedIdx.length; ci++) {
    const idx = changedIdx[ci]!;
    const expandedStart = Math.max(0, idx - ctxLines);
    if (expandedStart <= rEnd) {
      // Overlapping or adjacent — merge
      rEnd = Math.min(edits.length, idx + 1 + ctxLines);
    } else {
      ranges.push([rStart, rEnd]);
      rStart = expandedStart;
      rEnd = Math.min(edits.length, idx + 1 + ctxLines);
    }
  }
  ranges.push([rStart, rEnd]);

  // Render hunks
  const hunks: string[] = [];
  for (const [hs, he] of ranges) {
    const slice = edits.slice(hs, he);
    if (slice.length === 0) {
      process.stderr.write(`[${NAME}] diff_files: BUG: empty hunk slice for range [${hs}, ${he}) — skipping\n`);
      continue;
    }
    const first = slice[0];
    const aCount = slice.filter(e => e.op !== "+").length;
    const bCount = slice.filter(e => e.op !== "-").length;
    // Per unified diff spec: when count is 0, start line is 0 (not 1)
    const aStart = aCount === 0 ? 0 : (first?.lineA ?? 0) + 1;
    const bStart = bCount === 0 ? 0 : (first?.lineB ?? 0) + 1;
    const hunkLines = [`@@ -${aStart},${aCount} +${bStart},${bCount} @@`];
    for (const e of slice) {
      if (e.op === "=") hunkLines.push(` ${e.text}`);
      else if (e.op === "+") hunkLines.push(`+${e.text}`);
      else hunkLines.push(`-${e.text}`);
    }
    hunks.push(hunkLines.join("\n"));
  }

  return [`--- ${labelA}`, `+++ ${labelB}`, ...hunks].join("\n") + "\n";
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
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${NAME}] unhandled error in skill "${sid}": ${msg}\n`);
    resultText = `Error: ${msg}`;
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
