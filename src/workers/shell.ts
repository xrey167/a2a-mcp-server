import Fastify from "fastify";
import { spawnSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, lstatSync, realpathSync } from "fs";
import { resolve } from "path";
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
  list_dir: z.looseObject({ path: z.string().optional().default(".") }),
  shell_brief: z.looseObject({
    /** Shell command to execute and explain */
    command: z.string().min(1),
    /** Optional context to help the AI interpret the output (e.g. "this is a git diff") */
    context: z.string().optional(),
    /** Timeout for the shell command in ms (default 15000, max 60000) */
    timeoutMs: z.number().int().positive().max(60_000).optional().default(15_000),
  }),
  find_files: z.looseObject({
    /** Directory to search (default: ".") */
    path: z.string().optional().default("."),
    /** Glob pattern to match filenames — e.g. "*.ts", "*.json", "src/**" (default: "*") */
    pattern: z.string().optional().default("*"),
    /** Filter by entry type: "file", "dir", or "all" (default: "file") */
    type: z.enum(["file", "dir", "all"]).optional().default("file"),
    /** Maximum recursion depth (default 5, max 20) */
    maxDepth: z.number().int().min(1).max(20).optional().default(5),
    /** Maximum number of results to return (default 200, max 1000) */
    maxResults: z.number().int().min(1).max(1000).optional().default(200),
  }),
  tail_file: z.looseObject({
    /** Absolute or relative path to the file */
    path: z.string().min(1),
    /** Number of lines to return from the end of the file (default 100, max 10000) */
    lines: z.number().int().min(1).max(10_000).optional().default(100),
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
    { id: "shell_brief", name: "Shell Brief", description: "Execute a shell command and ask Claude to explain the output in plain language. Useful for interpreting git log, diff, ps, df, netstat, and other diagnostic commands." },
    { id: "find_files", name: "Find Files", description: "Recursively search a directory for files or directories matching a glob pattern (e.g. '*.ts', 'src/**'). Returns structured JSON with path, type, sizeBytes, and modifiedAt. Skips symlinks to prevent loops. Supports depth and result-count limits." },
    { id: "tail_file", name: "Tail File", description: "Read the last N lines of a text file (default 100, max 10 000). Ideal for inspecting log files and build output. Returns structured JSON with totalLines, returnedLines, and content." },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

/** Character limit for shell output sent to AI prompt — avoids token budget overrun.
 *  Char-based (not word-based) preserves column alignment in tabular output (ps, df, ls). */
const SHELL_BRIEF_CHAR_LIMIT = 30_000;

/** Convert a glob pattern to a predicate function.
 *  Supports: * (non-slash wildcard), double-star-slash (optional dir prefix), double-star (any), ? (single char), literals.
 *  Throws SyntaxError if the resulting regex is invalid — callers must try-catch. */
function globToMatcher(pattern: string): (name: string) => boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials (not * or ?)
    .replace(/\*\*/g, "\x00")             // temporarily mark ** to avoid collision
    .replace(/\*/g, "[^/]*")              // * → any non-slash sequence
    .replace(/\?/g, "[^/]")              // ? → any single non-slash char
    .replace(/\x00\//g, "(.*/)?")         // **/ → optional directory prefix (matches root-level too)
    .replace(/\x00/g, ".*");              // remaining ** → any sequence including /
  const regex = new RegExp(`^${regexStr}$`);
  return (name: string) => regex.test(name);
}

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

    case "list_dir": {
      const { path } = ShellSchemas.list_dir.parse({ path: (args.path ?? text) || ".", ...args });
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
    case "shell_brief": {
      const { command, context, timeoutMs } = ShellSchemas.shell_brief.parse({ command: args.command ?? text, ...args });
      // Sanitize user inputs early — safeCommand used in both prompt and response
      const safeCommand = sanitizeUserInput(command, "command");
      const safeContext = context ? sanitizeUserInput(context, "context") : null;

      const result = spawnSync(command, { shell: true, timeout: timeoutMs, encoding: "utf-8" });
      if (result.error) {
        const isTimeout = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
        process.stderr.write(`[${NAME}] shell_brief: spawnSync error (${result.error.message}) for command: ${command}\n`);
        return isTimeout
          ? `shell_brief: command timed out after ${timeoutMs}ms — increase timeoutMs (max 60000) or use run_shell for long-running commands`
          : `shell_brief: command execution failed — ${result.error.message}`;
      }

      const rawOut = stripAnsi((result.stdout ?? "").trim());
      const rawErr = stripAnsi((result.stderr ?? "").trim());
      const combined = rawOut + (rawErr ? `\n[stderr]\n${rawErr}` : "");
      const exitCode = result.status ?? 0;
      const commandFailed = exitCode !== 0;

      if (combined.trim().length === 0) {
        process.stderr.write(`[${NAME}] shell_brief: command produced no output (exit ${exitCode})\n`);
        return `shell_brief: command produced no output (exit ${exitCode})`;
      }

      // Truncate with char-based limit to preserve column alignment in tabular output
      const truncated = combined.length > SHELL_BRIEF_CHAR_LIMIT;
      const trimmedOutput = truncated
        ? combined.slice(0, SHELL_BRIEF_CHAR_LIMIT) + "\n... (output truncated)"
        : combined;

      // Sanitize output before embedding in prompt — shell output is untrusted user-controlled data
      const safeOutput = sanitizeUserInput(trimmedOutput, "shell_output");

      const prompt = `You are a systems engineer explaining shell command output to a developer.

Command: ${safeCommand}
Exit code: ${exitCode}
${safeContext ? `Context: ${safeContext}\n` : ""}
Output:
${safeOutput}

Explain what this output means in 2–5 plain-language sentences. Focus on:
- What the command reported (status, counts, sizes, errors)
- Any warnings, failures, or anomalies
- What action (if any) a developer should take

Be specific about numbers and file names. Do not speculate beyond what the output shows.`;

      const outputLines = combined.split("\n").length;
      const dataQuality = truncated ? "partial" : commandFailed ? "error" : "ok";

      if (commandFailed) {
        process.stderr.write(`[${NAME}] shell_brief: command exited ${exitCode}: ${command}\n`);
      }

      let brief: string;
      try {
        brief = await callPeer("ask_claude", { prompt }, prompt, 60_000);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] shell_brief: callPeer ask_claude failed: ${err instanceof Error ? err.stack : cause}\n`);
        // Return structured JSON on failure to match success contract
        return safeStringify({ command: safeCommand, exitCode, outputLines, dataQuality, brief: null, error: `AI explanation unavailable — ${cause}. Try again or use run_shell to view raw output.` }, 2);
      }

      // Guard against empty narrative — callPeer can return "" without throwing
      if (!brief || !brief.trim()) {
        process.stderr.write(`[${NAME}] shell_brief: ask_claude returned empty brief for command: ${command}\n`);
        return safeStringify({ command: safeCommand, exitCode, outputLines, dataQuality, brief: null, error: "AI explanation unavailable — the model returned an empty response. Try again or use run_shell to view raw output." }, 2);
      }

      return safeStringify({ command: safeCommand, exitCode, outputLines, dataQuality, brief }, 2);
    }
    case "find_files": {
      let parsed: ReturnType<typeof ShellSchemas.find_files.parse>;
      try {
        parsed = ShellSchemas.find_files.parse({ path: (args.path ?? text) || ".", ...args });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] find_files: Zod parse error: ${msg}\n`);
        return `find_files: invalid arguments — ${msg}`;
      }
      const { path: rootPath, pattern, type: typeFilter, maxDepth, maxResults } = parsed;

      let safeRoot: string;
      try {
        // Resolve to absolute so relative paths (e.g. "src") work consistently and
        // relPath computation below is correct regardless of CWD at call time
        safeRoot = resolve(sanitizePath(rootPath));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] find_files: rejected unsafe path "${rootPath}": ${msg}\n`);
        return `find_files: unsafe path rejected — ${msg}`;
      }

      // Single statSync — TOCTOU-safe directory existence check
      let rootStat: ReturnType<typeof statSync>;
      try {
        rootStat = statSync(safeRoot);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] find_files: cannot access root "${safeRoot}": ${msg}\n`);
        return code === "ENOENT" ? `find_files: directory not found: ${safeRoot}` : `find_files: cannot access path — ${msg}`;
      }
      if (!rootStat.isDirectory()) {
        process.stderr.write(`[${NAME}] find_files: root is not a directory: ${safeRoot}\n`);
        return `find_files: ${safeRoot} is not a directory`;
      }

      // Validate and compile glob pattern — wrap in try-catch in case regex compilation fails
      let matchesPattern: (name: string) => boolean;
      try {
        matchesPattern = globToMatcher(pattern);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] find_files: invalid glob pattern "${pattern}": ${msg}\n`);
        return `find_files: invalid glob pattern — ${msg}`;
      }
      // Match against relative path (from root) if pattern contains "/", otherwise basename only
      const matchByRelPath = pattern.includes("/");

      type FileEntry = { path: string; type: string; sizeBytes: number; modifiedAt: string };
      const results: FileEntry[] = [];
      let truncated = false;
      let scanned = 0;
      let skippedCount = 0;
      let skippedDirs = 0;

      function walk(dir: string, depth: number): void {
        if (truncated) return;
        if (depth > maxDepth) return;

        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
          process.stderr.write(`[${NAME}] find_files: readdirSync failed for ${dir} (${code}): ${err instanceof Error ? err.message : String(err)}\n`);
          skippedDirs++;
          return;
        }

        for (const name of entries) {
          if (truncated) break;
          const fullPath = `${dir}/${name}`;

          let st: ReturnType<typeof lstatSync>;
          try {
            st = lstatSync(fullPath); // lstatSync: does NOT follow symlinks
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
            process.stderr.write(`[${NAME}] find_files: lstatSync skipped "${fullPath}" (${code}): ${err instanceof Error ? err.message : String(err)}\n`);
            skippedCount++;
            continue;
          }
          scanned++; // count only successfully stat'd entries

          // Skip symlinks to prevent infinite loops and out-of-scope traversal
          if (st.isSymbolicLink()) {
            process.stderr.write(`[${NAME}] find_files: skipping symlink: ${fullPath}\n`);
            skippedCount++;
            continue;
          }

          const isDir = st.isDirectory();
          const isFile = st.isFile();
          const entryType = isDir ? "dir" : "file";

          const typeMatch =
            typeFilter === "all" ||
            (typeFilter === "file" && isFile) ||
            (typeFilter === "dir" && isDir);

          // Build the match target: relative path from root or basename
          const relPath = fullPath.startsWith(safeRoot + "/")
            ? fullPath.slice(safeRoot.length + 1)
            : fullPath;
          const matchTarget = matchByRelPath ? relPath : name;
          const patternMatch = matchesPattern(matchTarget);

          if (typeMatch && patternMatch) {
            results.push({
              path: fullPath,
              type: entryType,
              sizeBytes: isFile ? st.size : 0,
              modifiedAt: st.mtime.toISOString(),
            });
            if (results.length >= maxResults) {
              truncated = true;
              break;
            }
          }

          if (isDir) {
            walk(fullPath, depth + 1);
          }
        }
      }

      walk(safeRoot, 1);
      results.sort((a, b) => a.path.localeCompare(b.path));

      const payload: Record<string, unknown> = {
        root: safeRoot,
        pattern,
        typeFilter,
        resultCount: results.length,
        scanned,
        truncated: truncated ? true : undefined,
        skippedCount: skippedCount > 0 ? skippedCount : undefined,
        skippedDirs: skippedDirs > 0 ? skippedDirs : undefined,
        results,
      };
      try {
        return safeStringify(payload, 2);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] find_files: safeStringify failed: ${msg}\n`);
        return `find_files: result serialization failed — ${msg}. Try reducing maxResults or maxDepth.`;
      }
    }
    case "tail_file": {
      let parsed: ReturnType<typeof ShellSchemas.tail_file.parse>;
      try {
        parsed = ShellSchemas.tail_file.parse({ path: args.path ?? text, ...args });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] tail_file: Zod parse error: ${msg}\n`);
        return `tail_file: invalid arguments — ${msg}`;
      }
      const { path, lines } = parsed;
      // NEW-4: explicit guard before Zod (args may omit path when text is empty)
      if (!path) {
        process.stderr.write(`[${NAME}] tail_file: called with no path argument\n`);
        return "tail_file: missing required argument — provide a file path";
      }
      // Fix #5: wrap sanitizePath to log traversal probes and return a clean string
      let safePath: string;
      try {
        safePath = sanitizePath(path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] tail_file: rejected unsafe path "${path}": ${msg}\n`);
        return `tail_file: unsafe path rejected — ${msg}`;
      }
      // NEW-1: single statSync in try-catch eliminates TOCTOU race (no existsSync pre-check)
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(safePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] tail_file: statSync failed for ${safePath}: ${msg}\n`);
        const isNotFound = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
        return isNotFound ? `File not found: ${safePath}` : `tail_file: cannot access file — ${msg}`;
      }
      // Fix #1: reject directories, device files, FIFOs, sockets
      if (!stat.isFile()) {
        const kind = stat.isDirectory() ? "directory" : stat.isBlockDevice() || stat.isCharacterDevice() ? "device file" : "non-regular file";
        process.stderr.write(`[${NAME}] tail_file: path is a ${kind}, not a regular file: ${safePath}\n`);
        return `tail_file: ${safePath} is a ${kind}, not a regular file`;
      }
      // NEW-3: resolve symlinks so isFile() on a symlink→/etc/passwd is caught
      let realPath: string;
      try {
        realPath = realpathSync(safePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] tail_file: realpathSync failed for ${safePath}: ${msg}\n`);
        return `tail_file: cannot resolve file path — ${msg}`;
      }
      if (realPath !== safePath) {
        // Reject symlinks — the resolved target may escape any path boundary the caller intended
        process.stderr.write(`[${NAME}] tail_file: symlink detected and rejected: ${safePath} -> ${realPath}\n`);
        return `tail_file: ${safePath} is a symbolic link — provide the resolved path directly: ${realPath}`;
      }
      // Fix #2: size guard — reject files larger than 100 MB to avoid OOM
      const MAX_TAIL_BYTES = 100 * 1024 * 1024;
      if (stat.size > MAX_TAIL_BYTES) {
        process.stderr.write(`[${NAME}] tail_file: file too large (${stat.size} bytes) for ${safePath}; use run_shell with tail -n\n`);
        return `tail_file: file too large (${stat.size} bytes, max ${MAX_TAIL_BYTES}); use run_shell with "tail -n ${lines} ${safePath}"`;
      }
      let content: string;
      try {
        content = readFileSync(realPath, "utf-8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] tail_file: readFileSync failed for ${realPath}: ${msg}\n`);
        return `tail_file: could not read file — ${msg}`;
      }
      // Fix #4: binary file guard — null bytes indicate non-text content
      if (content.includes("\x00")) {
        process.stderr.write(`[${NAME}] tail_file: binary file detected at ${realPath}; use run_shell with xxd or file\n`);
        return `tail_file: ${realPath} appears to be a binary file; use run_shell with "xxd ${realPath} | head" or "file ${realPath}"`;
      }
      // Fix #3: strip trailing newline before splitting to avoid phantom empty last line
      const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
      const allLines = normalized.length === 0 ? [] : normalized.split("\n");
      const tail = allLines.slice(-lines);
      const totalLines = allLines.length;
      // NEW-2: output size cap before serialization to avoid downstream DoS
      const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
      const joinedContent = tail.join("\n");
      if (Buffer.byteLength(joinedContent, "utf-8") > MAX_RESPONSE_BYTES) {
        process.stderr.write(`[${NAME}] tail_file: response too large (>${MAX_RESPONSE_BYTES} bytes) for ${realPath}\n`);
        return `tail_file: the requested ${lines} lines exceed the 2 MB response limit; use run_shell with "tail -n ${lines} ${realPath}" or request fewer lines`;
      }
      try {
        return safeStringify({ path: realPath, totalLines, returnedLines: tail.length, content: joinedContent }, 2);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] tail_file: safeStringify failed for ${realPath}: ${msg}\n`);
        return `tail_file: failed to serialize response — ${msg}`;
      }
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
