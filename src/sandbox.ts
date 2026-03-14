// src/sandbox.ts
import { randomUUID } from "crypto";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildPrelude, buildEpilogue } from "./sandbox-prelude.js";
import { sandboxStore } from "./sandbox-store.js";
import { smartTruncate } from "./truncate.js";
import { safeStringify } from "./safe-json.js";
import { filterEnvForSandbox } from "./env-filter.js";
import { getConfig } from "./config.js";

function getTimeout() { return getConfig().sandbox.timeout; }
function getMaxResultSize() { return getConfig().sandbox.maxResultSize; }
function getIndexThreshold() { return getConfig().sandbox.indexThreshold; }

// ── Adapter discovery helpers ─────────────────────────────
// These are injected by the orchestrator at wire-up time (Task 4)
let __adapterList: Array<{ id: string; description: string }> = [];
let __adapterSchemas: Map<string, any> = new Map();

export function setAdapters(
  list: Array<{ id: string; description: string }>,
  schemas: Map<string, any>,
): void {
  __adapterList = list;
  __adapterSchemas = schemas;
}

function getAdapterList(): Array<{ id: string; description: string }> {
  return __adapterList;
}

function getAdapterSchema(skillId: string): any {
  const schema = __adapterSchemas.get(skillId);
  if (!schema) throw new Error(`Unknown skill: ${skillId}`);
  return schema;
}

interface SandboxOptions {
  code: string;
  sessionId: string;
  dispatch: (skillId: string, args: Record<string, unknown>) => Promise<string>;
  timeout?: number;
}

interface SandboxResult {
  result: any;
  error?: string;
  vars: string[];
  indexed: string[];
}

export async function executeSandbox(opts: SandboxOptions): Promise<SandboxResult> {
  const { code, sessionId, dispatch, timeout = getTimeout() } = opts;

  // Load existing vars from SQLite
  const existingVars = sandboxStore.getAllVars(sessionId);

  // Build temp file: prelude + user code + epilogue
  const tmpFile = join(tmpdir(), `sandbox-${randomUUID()}.ts`);
  const fullCode = buildPrelude(existingVars, sessionId) + "\n" + code + "\n" + buildEpilogue();
  writeFileSync(tmpFile, fullCode, { encoding: "utf-8", mode: 0o600 });

  try {
    return await runSubprocess(tmpFile, sessionId, dispatch, timeout);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

async function runSubprocess(
  tmpFile: string,
  sessionId: string,
  dispatch: (skillId: string, args: Record<string, unknown>) => Promise<string>,
  timeout: number,
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    // Use absolute path to bun so sandbox works even with restricted PATH
    const bunPath = process.execPath;
    const proc = Bun.spawn([bunPath, "--smol", tmpFile], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: filterEnvForSandbox(),
    });

    let settled = false;
    const finish = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // Timeout handler
    const timer = setTimeout(() => {
      proc.kill();
      finish({ result: null, error: `Sandbox timed out after ${timeout}ms`, vars: [], indexed: [] });
    }, timeout);

    // Read stderr for debug
    const stderrChunks: string[] = [];
    const stderrReader = proc.stderr.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          stderrChunks.push(text);
          process.stderr.write(`[sandbox] ${text}`);
        }
      } catch {}
    })();

    // Read stdout line-by-line for IPC
    const stdoutReader = proc.stdout.getReader();
    let buffer = "";

    async function processLines() {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          buffer += new TextDecoder().decode(value);

          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;

            try {
              const msg = JSON.parse(line);
              await handleMessage(msg);
            } catch (e) {
              process.stderr.write(`[sandbox] invalid JSON line: ${line}\n`);
            }
          }
        }
      } catch {}
    }

    async function handleMessage(msg: any) {
      if (msg.done) {
        // Completion — persist vars and resolve
        const newVars: string[] = [];
        const indexed: string[] = [];

        if (msg.vars && typeof msg.vars === "object") {
          for (const [name, value] of Object.entries(msg.vars)) {
            const json = safeStringify(value);
            sandboxStore.setVar(sessionId, name, json);
            newVars.push(name);
            if (json.length > getIndexThreshold()) indexed.push(name);
          }
        }

        // Cap the result to prevent context window blow-up
        let resultStr = msg.result != null ? safeStringify(msg.result) : null;
        if (resultStr && resultStr.length > getMaxResultSize()) {
          resultStr = smartTruncate(resultStr, { maxLength: getMaxResultSize() });
        }

        finish({
          result: resultStr != null ? (typeof msg.result === "string" ? resultStr : JSON.parse(resultStr)) : null,
          error: msg.error,
          vars: newVars,
          indexed,
        });
      } else if (msg.rpc === "skill") {
        // Skill call — dispatch and respond
        try {
          const result = await dispatch(msg.id, msg.args ?? {});
          const response = safeStringify({ seq: msg.seq, result }) + "\n";
          proc.stdin.write(response);
        } catch (err) {
          const response = safeStringify({ seq: msg.seq, error: String(err) }) + "\n";
          proc.stdin.write(response);
        }
      } else if (msg.rpc === "search") {
        // FTS5 search call (now with 3-layer fallback)
        try {
          const results = sandboxStore.search(msg.session, msg.varName, msg.query);
          const parsed = results.map(r => {
            try { return JSON.parse(r.value); } catch { return r.value; }
          });
          const response = safeStringify({ seq: msg.seq, result: parsed }) + "\n";
          proc.stdin.write(response);
        } catch (err) {
          const response = safeStringify({ seq: msg.seq, error: String(err) }) + "\n";
          proc.stdin.write(response);
        }
      } else if (msg.rpc === "adapters") {
        // List available skill adapters (lightweight: id + description only)
        try {
          const list = getAdapterList();
          const response = safeStringify({ seq: msg.seq, result: list }) + "\n";
          proc.stdin.write(response);
        } catch (err) {
          const response = safeStringify({ seq: msg.seq, error: String(err) }) + "\n";
          proc.stdin.write(response);
        }
      } else if (msg.rpc === "describe") {
        // Get full input schema for a specific skill
        try {
          const schema = getAdapterSchema(msg.id);
          const response = safeStringify({ seq: msg.seq, result: schema }) + "\n";
          proc.stdin.write(response);
        } catch (err) {
          const response = safeStringify({ seq: msg.seq, error: String(err) }) + "\n";
          proc.stdin.write(response);
        }
      }
    }

    processLines();

    // Handle unexpected exit
    proc.exited.then((exitCode) => {
      if (!settled) {
        finish({
          result: null,
          error: `Sandbox process exited with code ${exitCode}${stderrChunks.length ? ": " + stderrChunks.join("") : ""}`,
          vars: [],
          indexed: [],
        });
      }
    });
  });
}
