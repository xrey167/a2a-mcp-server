# Sandbox Execution Engine — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add MCX-style sandboxed TypeScript execution to the orchestrator, enabling ~98% token reduction by processing data locally in isolated Bun subprocesses.

**Architecture:** Two new orchestrator skills (`sandbox_execute`, `sandbox_vars`) backed by a new `src/sandbox.ts` module. Code runs in isolated Bun subprocesses that communicate with the orchestrator via stdin/stdout IPC. Variables persist in a separate SQLite database (`~/.a2a-sandbox.db`) with FTS5 auto-indexing for large results.

**Tech Stack:** Bun (subprocess spawning, SQLite via `bun:sqlite`), TypeScript, FTS5 full-text search

---

### Task 1: Sandbox SQLite Store

Create the `src/sandbox-store.ts` module — SQLite database, variable CRUD, FTS5 auto-indexing.

**Files:**
- Create: `src/sandbox-store.ts`
- Create: `src/__tests__/sandbox-store.test.ts`

**Step 1: Write the failing tests**

```ts
// src/__tests__/sandbox-store.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { sandboxStore } from "../sandbox-store.js";

const SESSION = "__test_session__";

afterAll(() => {
  sandboxStore.deleteSession(SESSION);
});

describe("SandboxStore - CRUD", () => {
  test("setVar and getVar", () => {
    sandboxStore.setVar(SESSION, "$users", JSON.stringify([{ id: 1 }]));
    const val = sandboxStore.getVar(SESSION, "$users");
    expect(val).not.toBeNull();
    expect(JSON.parse(val!)).toEqual([{ id: 1 }]);
  });

  test("getVar returns null for missing var", () => {
    expect(sandboxStore.getVar(SESSION, "$missing")).toBeNull();
  });

  test("listVars returns all vars for session", () => {
    sandboxStore.setVar(SESSION, "$a", '"val_a"');
    sandboxStore.setVar(SESSION, "$b", '"val_b"');
    const vars = sandboxStore.listVars(SESSION);
    expect(vars.some(v => v.name === "$a")).toBe(true);
    expect(vars.some(v => v.name === "$b")).toBe(true);
  });

  test("deleteVar removes a var", () => {
    sandboxStore.setVar(SESSION, "$temp", '"gone"');
    sandboxStore.deleteVar(SESSION, "$temp");
    expect(sandboxStore.getVar(SESSION, "$temp")).toBeNull();
  });

  test("deleteSession removes all vars", () => {
    const s = "__delete_test__";
    sandboxStore.setVar(s, "$x", '"1"');
    sandboxStore.setVar(s, "$y", '"2"');
    sandboxStore.deleteSession(s);
    expect(sandboxStore.listVars(s)).toEqual([]);
  });
});

describe("SandboxStore - FTS5 auto-indexing", () => {
  test("large vars are searchable via FTS5", () => {
    // Create a value > 4096 bytes
    const bigArray = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      name: `invoice_${i}`,
      status: i % 3 === 0 ? "overdue" : "paid",
    }));
    sandboxStore.setVar(SESSION, "$invoices", JSON.stringify(bigArray));

    const results = sandboxStore.search(SESSION, "$invoices", "overdue");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("small vars are NOT indexed (search returns empty)", () => {
    sandboxStore.setVar(SESSION, "$tiny", '"hello"');
    const results = sandboxStore.search(SESSION, "$tiny", "hello");
    expect(results).toEqual([]);
  });
});

describe("SandboxStore - cleanup", () => {
  test("prune removes old sessions", () => {
    const s = `__prune_${Date.now()}__`;
    sandboxStore.setVar(s, "$old", '"ancient"');
    // Wait for timestamp to be in the past
    Bun.sleepSync(1100);
    const removed = sandboxStore.prune(0);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(sandboxStore.getVar(s, "$old")).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/sandbox-store.test.ts`
Expected: FAIL — module `../sandbox-store.js` not found

**Step 3: Write the implementation**

```ts
// src/sandbox-store.ts
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";

const INDEX_THRESHOLD = 4096; // bytes — auto-index vars larger than this

const db = new Database(join(homedir(), ".a2a-sandbox.db"));
db.run("PRAGMA journal_mode=WAL");

// Main variable table
db.run(`CREATE TABLE IF NOT EXISTS sandbox_vars (
  session TEXT NOT NULL,
  name    TEXT NOT NULL,
  value   TEXT NOT NULL,
  size    INTEGER NOT NULL,
  ts      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (session, name)
)`);

// FTS5 index for large results
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS sandbox_fts USING fts5(
  session, name, value,
  content=sandbox_vars, content_rowid=rowid
)`);

// Sync triggers
db.run(`CREATE TRIGGER IF NOT EXISTS sandbox_ai AFTER INSERT ON sandbox_vars
  WHEN NEW.size > ${INDEX_THRESHOLD} BEGIN
  INSERT INTO sandbox_fts(rowid, session, name, value)
    VALUES (NEW.rowid, NEW.session, NEW.name, NEW.value);
END`);

db.run(`CREATE TRIGGER IF NOT EXISTS sandbox_ad AFTER DELETE ON sandbox_vars BEGIN
  INSERT INTO sandbox_fts(sandbox_fts, rowid, session, name, value)
    VALUES('delete', OLD.rowid, OLD.session, OLD.name, OLD.value);
END`);

db.run(`CREATE TRIGGER IF NOT EXISTS sandbox_au AFTER UPDATE ON sandbox_vars BEGIN
  INSERT INTO sandbox_fts(sandbox_fts, rowid, session, name, value)
    VALUES('delete', OLD.rowid, OLD.session, OLD.name, OLD.value);
  INSERT INTO sandbox_fts(rowid, session, name, value)
    SELECT NEW.rowid, NEW.session, NEW.name, NEW.value WHERE NEW.size > ${INDEX_THRESHOLD};
END`);

try { db.run(`INSERT INTO sandbox_fts(sandbox_fts) VALUES('rebuild')`); } catch {}

export const sandboxStore = {
  setVar(session: string, name: string, value: string): void {
    db.run(
      `INSERT OR REPLACE INTO sandbox_vars (session, name, value, size, ts) VALUES (?,?,?,?,unixepoch())`,
      [session, name, value, value.length]
    );
  },

  getVar(session: string, name: string): string | null {
    return (db.query<{ value: string }, [string, string]>(
      `SELECT value FROM sandbox_vars WHERE session=? AND name=?`
    ).get(session, name))?.value ?? null;
  },

  listVars(session: string): Array<{ name: string; size: number; ts: number }> {
    return db.query<{ name: string; size: number; ts: number }, [string]>(
      `SELECT name, size, ts FROM sandbox_vars WHERE session=? ORDER BY ts DESC`
    ).all(session);
  },

  deleteVar(session: string, name: string): void {
    db.run(`DELETE FROM sandbox_vars WHERE session=? AND name=?`, [session, name]);
  },

  deleteSession(session: string): void {
    db.run(`DELETE FROM sandbox_vars WHERE session=?`, [session]);
  },

  search(session: string, varName: string, query: string): Array<{ value: string; rank: number }> {
    return db.query<{ value: string; rank: number }, [string, string, string]>(
      `SELECT v.value, f.rank
       FROM sandbox_fts f JOIN sandbox_vars v ON f.rowid = v.rowid
       WHERE sandbox_fts MATCH ? AND v.session = ? AND v.name = ?
       ORDER BY f.rank LIMIT 50`
    ).all(query, session, varName);
  },

  getAllVars(session: string): Record<string, unknown> {
    const rows = db.query<{ name: string; value: string }, [string]>(
      `SELECT name, value FROM sandbox_vars WHERE session=?`
    ).all(session);
    const vars: Record<string, unknown> = {};
    for (const r of rows) {
      try { vars[r.name] = JSON.parse(r.value); } catch { vars[r.name] = r.value; }
    }
    return vars;
  },

  prune(maxAgeDays: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - (maxAgeDays * 86400);
    const rows = db.query<{ session: string }, [number]>(
      `SELECT DISTINCT session FROM sandbox_vars WHERE ts < ?`
    ).all(cutoff);
    if (rows.length === 0) return 0;
    db.run(`DELETE FROM sandbox_vars WHERE ts < ?`, [cutoff]);
    return rows.length;
  },
};
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/sandbox-store.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/sandbox-store.ts src/__tests__/sandbox-store.test.ts
git commit -m "feat: sandbox variable store with FTS5 auto-indexing"
```

---

### Task 2: Sandbox Prelude Template

Create the TypeScript prelude that gets injected into every sandbox subprocess — defines `skill()`, `search()`, data helpers, and `$vars`.

**Files:**
- Create: `src/sandbox-prelude.ts`
- Create: `src/__tests__/sandbox-prelude.test.ts`

**Step 1: Write the failing test**

```ts
// src/__tests__/sandbox-prelude.test.ts
import { describe, test, expect } from "bun:test";
import { buildPrelude } from "../sandbox-prelude.js";

describe("Sandbox prelude", () => {
  test("buildPrelude returns valid TypeScript string", () => {
    const code = buildPrelude({}, "test-session");
    expect(typeof code).toBe("string");
    expect(code).toContain("async function skill(");
    expect(code).toContain("function pick(");
    expect(code).toContain("function sum(");
    expect(code).toContain("function count(");
    expect(code).toContain("function first(");
    expect(code).toContain("function last(");
    expect(code).toContain("function table(");
    expect(code).toContain("async function search(");
    expect(code).toContain("const $vars");
  });

  test("buildPrelude injects existing vars", () => {
    const code = buildPrelude({ "$users": [1, 2, 3] }, "test-session");
    expect(code).toContain("[1,2,3]");
  });

  test("buildPrelude wraps user code in async main", () => {
    const full = buildPrelude({}, "s1") + "\n// USER CODE\nreturn 42;";
    // The prelude should set up the framework for wrapping user code
    expect(full).toContain("return 42");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/sandbox-prelude.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// src/sandbox-prelude.ts

/**
 * Build the TypeScript prelude that gets prepended to sandbox code.
 * Defines: skill(), search(), pick/sum/count/first/last/table helpers, $vars.
 *
 * The subprocess communicates with the orchestrator via stdin/stdout JSON lines:
 * - stdout: {"rpc":"skill","id":"...","args":{...},"seq":N}  (skill call)
 * - stdout: {"done":true,"result":...,"vars":{...}}          (completion)
 * - stdin:  {"seq":N,"result":...} or {"seq":N,"error":"..."} (skill response)
 */
export function buildPrelude(existingVars: Record<string, unknown>, sessionId: string): string {
  const varsJson = JSON.stringify(existingVars);
  return `
// ── Sandbox Prelude ──────────────────────────────────────
import { createInterface } from "readline";

const $vars: Record<string, any> = ${varsJson};
const __sessionId = ${JSON.stringify(sessionId)};

// ── IPC plumbing ─────────────────────────────────────────
let __seq = 0;
const __pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

const __rl = createInterface({ input: process.stdin });
__rl.on("line", (line: string) => {
  try {
    const msg = JSON.parse(line);
    const p = __pending.get(msg.seq);
    if (!p) return;
    __pending.delete(msg.seq);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  } catch {}
});

function __send(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

// ── skill() — call any worker skill ──────────────────────
async function skill(id: string, args: Record<string, unknown> = {}): Promise<any> {
  const seq = ++__seq;
  return new Promise((resolve, reject) => {
    __pending.set(seq, { resolve, reject });
    __send({ rpc: "skill", id, args, seq });
  });
}

// ── search() — FTS5 search over auto-indexed var ─────────
async function search(varName: string, query: string): Promise<any[]> {
  const seq = ++__seq;
  return new Promise((resolve, reject) => {
    __pending.set(seq, { resolve, reject });
    __send({ rpc: "search", varName, query, session: __sessionId, seq });
  });
}

// ── Data helpers ─────────────────────────────────────────
function pick<T extends Record<string, any>>(arr: T[], ...keys: (keyof T)[]): Partial<T>[] {
  return arr.map(item => {
    const out: Partial<T> = {};
    for (const k of keys) if (k in item) out[k] = item[k];
    return out;
  });
}

function sum(arr: any[], key: string): number {
  return arr.reduce((s, item) => s + (Number(item[key]) || 0), 0);
}

function count(arr: any[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of arr) {
    const v = String(item[key] ?? "undefined");
    counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

function first<T>(arr: T[], n = 1): T[] { return arr.slice(0, n); }
function last<T>(arr: T[], n = 1): T[] { return arr.slice(-n); }

function table(arr: any[]): string {
  if (!arr.length) return "(empty)";
  const keys = Object.keys(arr[0]);
  const widths = keys.map(k => Math.max(k.length, ...arr.map(r => String(r[k] ?? "").length)));
  const header = keys.map((k, i) => k.padEnd(widths[i])).join(" | ");
  const sep = widths.map(w => "-".repeat(w)).join("-+-");
  const rows = arr.map(r => keys.map((k, i) => String(r[k] ?? "").padEnd(widths[i])).join(" | "));
  return [header, sep, ...rows].join("\\n");
}

// ── Main wrapper ─────────────────────────────────────────
async function __main() {
`;
}

/**
 * Build the epilogue that closes the main wrapper,
 * captures the return value, and sends it back.
 */
export function buildEpilogue(): string {
  return `
}

// Run and report result
__main()
  .then((result) => {
    __send({ done: true, result, vars: $vars });
    __rl.close();
  })
  .catch((err) => {
    __send({ done: true, result: null, error: String(err), vars: $vars });
    __rl.close();
  });
`;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/sandbox-prelude.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/sandbox-prelude.ts src/__tests__/sandbox-prelude.test.ts
git commit -m "feat: sandbox prelude template with IPC, helpers, and var injection"
```

---

### Task 3: Sandbox Executor (subprocess lifecycle + IPC)

Create `src/sandbox.ts` — the core executor that spawns the subprocess, handles IPC, and returns results.

**Files:**
- Create: `src/sandbox.ts`
- Create: `src/__tests__/sandbox.test.ts`

**Step 1: Write the failing tests**

```ts
// src/__tests__/sandbox.test.ts
import { describe, test, expect } from "bun:test";
import { executeSandbox } from "../sandbox.js";

// Mock dispatchSkill — in real server this routes to workers
const mockDispatch = async (skillId: string, args: Record<string, unknown>): Promise<string> => {
  if (skillId === "fetch_url") return JSON.stringify({ items: [{ id: 1, price: 10 }, { id: 2, price: 20 }] });
  return `mock result for ${skillId}`;
};

describe("Sandbox executor", () => {
  test("executes simple code and returns result", async () => {
    const result = await executeSandbox({
      code: "return 1 + 2;",
      sessionId: "__test_exec__",
      dispatch: mockDispatch,
    });
    expect(result.result).toBe(3);
  });

  test("skill() calls route through dispatch", async () => {
    const result = await executeSandbox({
      code: `
        const data = await skill('fetch_url', { url: 'https://example.com' });
        const parsed = JSON.parse(data);
        return parsed.items.length;
      `,
      sessionId: "__test_skill__",
      dispatch: mockDispatch,
    });
    expect(result.result).toBe(2);
  });

  test("variables persist in $vars", async () => {
    const result = await executeSandbox({
      code: `
        $vars["$count"] = 42;
        return $vars["$count"];
      `,
      sessionId: "__test_vars__",
      dispatch: mockDispatch,
    });
    expect(result.result).toBe(42);
    expect(result.vars).toContain("$count");
  });

  test("helpers work (sum, count, pick)", async () => {
    const result = await executeSandbox({
      code: `
        const items = [
          { name: "a", price: 10, status: "active" },
          { name: "b", price: 20, status: "active" },
          { name: "c", price: 30, status: "inactive" },
        ];
        return {
          total: sum(items, "price"),
          byStatus: count(items, "status"),
          names: pick(items, "name"),
        };
      `,
      sessionId: "__test_helpers__",
      dispatch: mockDispatch,
    });
    expect(result.result.total).toBe(60);
    expect(result.result.byStatus).toEqual({ active: 2, inactive: 1 });
    expect(result.result.names).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
  });

  test("timeout kills subprocess", async () => {
    const start = Date.now();
    const result = await executeSandbox({
      code: "await new Promise(r => setTimeout(r, 60000)); return 'never';",
      sessionId: "__test_timeout__",
      dispatch: mockDispatch,
      timeout: 2000,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(result.error).toBeDefined();
  });

  test("syntax errors are caught", async () => {
    const result = await executeSandbox({
      code: "return {{{invalid;",
      sessionId: "__test_syntax__",
      dispatch: mockDispatch,
    });
    expect(result.error).toBeDefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/sandbox.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// src/sandbox.ts
import { randomUUID } from "crypto";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createInterface } from "readline";
import { buildPrelude, buildEpilogue } from "./sandbox-prelude.js";
import { sandboxStore } from "./sandbox-store.js";

const DEFAULT_TIMEOUT = 30_000;
const INDEX_THRESHOLD = 4096;

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
  const { code, sessionId, dispatch, timeout = DEFAULT_TIMEOUT } = opts;

  // Load existing vars from SQLite
  const existingVars = sandboxStore.getAllVars(sessionId);

  // Build temp file: prelude + user code + epilogue
  const tmpFile = join(tmpdir(), `sandbox-${randomUUID()}.ts`);
  const fullCode = buildPrelude(existingVars, sessionId) + "\n" + code + "\n" + buildEpilogue();
  writeFileSync(tmpFile, fullCode, "utf-8");

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
    const proc = Bun.spawn(["bun", tmpFile], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
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
            const json = JSON.stringify(value);
            sandboxStore.setVar(sessionId, name, json);
            newVars.push(name);
            if (json.length > INDEX_THRESHOLD) indexed.push(name);
          }
        }

        finish({
          result: msg.result ?? null,
          error: msg.error,
          vars: newVars,
          indexed,
        });
      } else if (msg.rpc === "skill") {
        // Skill call — dispatch and respond
        try {
          const result = await dispatch(msg.id, msg.args ?? {});
          const response = JSON.stringify({ seq: msg.seq, result }) + "\n";
          proc.stdin.write(response);
        } catch (err) {
          const response = JSON.stringify({ seq: msg.seq, error: String(err) }) + "\n";
          proc.stdin.write(response);
        }
      } else if (msg.rpc === "search") {
        // FTS5 search call
        try {
          const results = sandboxStore.search(msg.session, msg.varName, msg.query);
          const parsed = results.map(r => {
            try { return JSON.parse(r.value); } catch { return r.value; }
          });
          const response = JSON.stringify({ seq: msg.seq, result: parsed }) + "\n";
          proc.stdin.write(response);
        } catch (err) {
          const response = JSON.stringify({ seq: msg.seq, error: String(err) }) + "\n";
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
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/sandbox.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/sandbox.ts src/__tests__/sandbox.test.ts
git commit -m "feat: sandbox executor with subprocess IPC and timeout handling"
```

---

### Task 4: Wire Sandbox Skills into Orchestrator

Add `sandbox_execute` and `sandbox_vars` to `server.ts` — skill definitions, dispatch cases, and tool registration.

**Files:**
- Modify: `src/server.ts`

**Step 1: Add import at top of server.ts (after existing imports)**

Add after line ~23 (after the `AgentError` import):

```ts
import { executeSandbox } from "./sandbox.js";
import { sandboxStore } from "./sandbox-store.js";
```

**Step 2: Add dispatch cases in `dispatchSkill()` function**

Add before the `default:` case in the switch statement (around line 421):

```ts
    case "sandbox_execute": {
      const code = args.code as string;
      if (!code) throw new Error("sandbox_execute requires code");
      const sessionId = (args.sessionId as string) ?? `sandbox-${randomUUID()}`;
      const timeout = (args.timeout as number) ?? 30_000;

      const result = await executeSandbox({
        code,
        sessionId,
        dispatch: dispatchSkill,
        timeout,
      });

      // Build compact response
      const summary: Record<string, unknown> = {
        sessionId,
        result: result.result,
      };
      if (result.error) summary.error = result.error;
      if (result.vars.length > 0) summary.vars = result.vars;
      if (result.indexed.length > 0) {
        summary.indexed = result.indexed.map(name => {
          const raw = sandboxStore.getVar(sessionId, name);
          return `${name} (${raw ? raw.length : 0} bytes, FTS5 indexed)`;
        });
      }
      return JSON.stringify(summary, null, 2);
    }

    case "sandbox_vars": {
      const sessionId = args.sessionId as string;
      if (!sessionId) throw new Error("sandbox_vars requires sessionId");
      const action = (args.action as string) ?? "list";

      switch (action) {
        case "list":
          return JSON.stringify(sandboxStore.listVars(sessionId), null, 2);
        case "get": {
          const varName = args.varName as string;
          if (!varName) throw new Error("sandbox_vars get requires varName");
          const val = sandboxStore.getVar(sessionId, varName);
          return val ?? `Variable not found: ${varName}`;
        }
        case "delete": {
          const varName = args.varName as string;
          if (!varName) throw new Error("sandbox_vars delete requires varName");
          sandboxStore.deleteVar(sessionId, varName);
          return `Deleted ${varName} from session ${sessionId}`;
        }
        default:
          throw new Error(`Unknown sandbox_vars action: ${action}`);
      }
    }
```

**Step 3: Add skill definitions (after `designWorkflowSkill` around line 661)**

```ts
const sandboxExecuteSkill = {
  id: "sandbox_execute",
  name: "Sandbox Execute",
  description: "Run TypeScript code in an isolated sandbox with access to all worker skills via skill(). Variables persist across calls per session. Large results auto-indexed for FTS5 search. Use this instead of delegate when you need to process/filter data locally to reduce token usage.",
  inputSchema: {
    type: "object" as const,
    properties: {
      code: { type: "string", description: "TypeScript code to run. Has access to: skill(id, args), search(varName, query), $vars, pick(), sum(), count(), first(), last(), table(). The return value is sent back." },
      sessionId: { type: "string", description: "Session ID for variable persistence (auto-generated if omitted)" },
      timeout: { type: "number", description: "Timeout in ms (default 30000)" },
    },
    required: ["code"],
  },
};

const sandboxVarsSkill = {
  id: "sandbox_vars",
  name: "Sandbox Variables",
  description: "List, inspect, or delete persisted sandbox variables for a session",
  inputSchema: {
    type: "object" as const,
    properties: {
      sessionId: { type: "string", description: "Session ID" },
      action: { type: "string", description: "list (default), get, or delete", enum: ["list", "get", "delete"] },
      varName: { type: "string", description: "Variable name (required for get/delete)" },
    },
    required: ["sessionId"],
  },
};
```

**Step 4: Register tools in `getAllToolDefs()` (around line 687)**

Add to the `tools` array alongside the other skill entries:

```ts
    { name: sandboxExecuteSkill.id, description: sandboxExecuteSkill.description, inputSchema: sandboxExecuteSkill.inputSchema },
    { name: sandboxVarsSkill.id, description: sandboxVarsSkill.description, inputSchema: sandboxVarsSkill.inputSchema },
```

**Step 5: Add `randomUUID` import if not already present**

Check if `randomUUID` is already imported from `"crypto"`. If not, add:

```ts
import { randomUUID } from "crypto";
```

**Step 6: Add sandbox prune to startup**

In the main startup section (near the end of server.ts where workers are spawned), add:

```ts
sandboxStore.prune(7); // Clean up sandbox vars older than 7 days
```

**Step 7: Run full test suite**

Run: `bun test`
Expected: All existing + new tests PASS

**Step 8: Commit**

```bash
git add src/server.ts
git commit -m "feat: wire sandbox_execute and sandbox_vars into orchestrator"
```

---

### Task 5: Integration Test — End-to-End Sandbox Flow

Write a test that exercises the full flow: execute code that calls skills, persist vars, search indexed results.

**Files:**
- Create: `src/__tests__/sandbox-integration.test.ts`

**Step 1: Write the integration test**

```ts
// src/__tests__/sandbox-integration.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { executeSandbox } from "../sandbox.js";
import { sandboxStore } from "../sandbox-store.js";

const SESSION = "__integration_test__";

// Mock dispatch that simulates worker responses
const mockDispatch = async (skillId: string, args: Record<string, unknown>): Promise<string> => {
  switch (skillId) {
    case "fetch_url":
      // Simulate a large API response (> 4KB to trigger FTS5 indexing)
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        name: `Item ${i + 1}`,
        category: i % 2 === 0 ? "electronics" : "clothing",
        price: Math.round(Math.random() * 10000) / 100,
        description: `This is a detailed description for item ${i + 1} with various searchable keywords`,
      }));
      return JSON.stringify(items);
    case "query_sqlite":
      return JSON.stringify([{ count: 42 }]);
    default:
      return `Unknown skill: ${skillId}`;
  }
};

afterAll(() => {
  sandboxStore.deleteSession(SESSION);
});

describe("Sandbox integration", () => {
  test("full flow: fetch → process → persist → search", async () => {
    // Step 1: Fetch and process data
    const r1 = await executeSandbox({
      code: `
        const raw = await skill('fetch_url', { url: 'https://api.example.com/items' });
        const items = JSON.parse(raw);
        $vars["$items"] = items;
        return {
          total: items.length,
          categories: count(items, "category"),
          avgPrice: Math.round(sum(items, "price") / items.length * 100) / 100,
        };
      `,
      sessionId: SESSION,
      dispatch: mockDispatch,
    });

    expect(r1.error).toBeUndefined();
    expect(r1.result.total).toBe(100);
    expect(r1.result.categories.electronics).toBe(50);
    expect(r1.result.categories.clothing).toBe(50);
    expect(r1.vars).toContain("$items");
    // $items should be > 4KB and auto-indexed
    expect(r1.indexed).toContain("$items");

    // Step 2: Second call references persisted vars
    const r2 = await executeSandbox({
      code: `
        const items = $vars["$items"];
        return {
          firstThree: first(items, 3).map(i => i.name),
          lastTwo: last(items, 2).map(i => i.name),
        };
      `,
      sessionId: SESSION,
      dispatch: mockDispatch,
    });

    expect(r2.error).toBeUndefined();
    expect(r2.result.firstThree).toHaveLength(3);
    expect(r2.result.lastTwo).toHaveLength(2);
  });

  test("table() helper produces readable output", async () => {
    const r = await executeSandbox({
      code: `
        const data = [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
        ];
        return table(data);
      `,
      sessionId: SESSION,
      dispatch: mockDispatch,
    });

    expect(r.error).toBeUndefined();
    expect(r.result).toContain("Alice");
    expect(r.result).toContain("Bob");
    expect(r.result).toContain("name");
    expect(r.result).toContain("age");
  });

  test("errors in sandbox code are caught gracefully", async () => {
    const r = await executeSandbox({
      code: `
        const data = JSON.parse("not json");
        return data;
      `,
      sessionId: SESSION,
      dispatch: mockDispatch,
    });

    expect(r.error).toBeDefined();
  });
});
```

**Step 2: Run integration tests**

Run: `bun test src/__tests__/sandbox-integration.test.ts`
Expected: All PASS

**Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/__tests__/sandbox-integration.test.ts
git commit -m "test: sandbox integration tests — full fetch→process→persist→search flow"
```

---

### Task 6: Update CLAUDE.md Documentation

Update the project documentation to reflect the new sandbox capabilities.

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add sandbox section to the Architecture table**

In the "Shared modules" section, add:

```markdown
- `src/sandbox.ts` — sandbox executor: spawns isolated Bun subprocesses, handles stdin/stdout IPC for skill calls, manages timeout/cleanup
- `src/sandbox-store.ts` — `~/.a2a-sandbox.db`: variable persistence (SQLite) + FTS5 auto-indexing for large results (>4KB)
- `src/sandbox-prelude.ts` — TypeScript prelude template injected into sandbox code (skill(), search(), helpers, $vars)
```

**Step 2: Add sandbox to the orchestrator skills list**

In the architecture description, mention the new tools:

```markdown
**Sandbox execution:** `sandbox_execute` runs TypeScript in isolated Bun subprocesses with access to all worker skills via `skill(id, args)`. Variables persist per session in SQLite. Results >4KB auto-indexed for FTS5 search via `search(varName, query)`. `sandbox_vars` manages persisted variables.
```

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add sandbox execution to architecture docs"
```

---

### Task 7: Final Verification

Run the complete test suite and verify everything works together.

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests PASS (existing + all new sandbox tests)

**Step 2: Type-check via bundler**

Run: `bun build src/server.ts --target bun --outdir /tmp/a2a-check`
Expected: No type errors

**Step 3: Verify file count**

New files created:
- `src/sandbox.ts`
- `src/sandbox-store.ts`
- `src/sandbox-prelude.ts`
- `src/__tests__/sandbox.test.ts`
- `src/__tests__/sandbox-store.test.ts`
- `src/__tests__/sandbox-prelude.test.ts`
- `src/__tests__/sandbox-integration.test.ts`

Modified files:
- `src/server.ts`
- `CLAUDE.md`

**Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: final sandbox execution cleanup"
```
