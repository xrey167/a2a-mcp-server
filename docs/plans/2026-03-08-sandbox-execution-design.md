# Sandbox Execution Engine — Design Doc

**Date:** 2026-03-08
**Status:** Approved
**Inspiration:** [MCX](https://github.com/schizoidcock/mcx) — sandboxed code execution for ~98% token reduction

## Problem

Current architecture passes full API/tool results through MCP into the model's context window. A 50KB JSON response costs ~15,000 tokens even when the agent only needs a 3-field summary. MCX solves this by letting agents write code that processes data locally, returning only compact results.

## Solution

Add an MCX-style sandbox execution engine as orchestrator-level skills in `server.ts`. Agents write TypeScript code that runs in an isolated Bun subprocess. The sandbox has access to all worker skills via IPC, and results are persisted in SQLite with FTS5 auto-indexing for large outputs.

## New MCP Tools

### `sandbox_execute`

Run TypeScript in an isolated Bun subprocess with access to all worker skills.

```ts
{
  code: string,         // TypeScript code to run
  sessionId?: string,   // groups variable persistence (auto-generated if omitted)
  timeout?: number,     // ms, default 30_000
}
// Returns: { result: <return value>, vars: string[], indexed: string[] }
```

### `sandbox_vars`

List, inspect, or delete persisted variables for a session.

```ts
{
  sessionId: string,
  action?: "list" | "get" | "delete",  // default "list"
  varName?: string,     // required for get/delete
}
```

## Sandbox Built-in Functions

Available inside sandbox code (injected via prelude):

| Function | Purpose |
|---|---|
| `skill(id, args)` | Call any worker skill (fetch_url, query_sqlite, run_shell, etc.) |
| `search(varName, query)` | FTS5 search over an auto-indexed variable |
| `adapters()` | List available skill adapters (ids + descriptions). Progressive — not loaded into context until requested. |
| `describe(skillId)` | Get full input schema for a specific skill. Lets agent discover parameters on-demand. |
| `batch(items, fn, opts?)` | Process array items through an async function with configurable concurrency. `opts.concurrency` (default 5), `opts.onProgress` callback. |
| `pick(arr, ...keys)` | Pluck fields from array of objects |
| `sum(arr, key)` | Sum a numeric field |
| `count(arr, key)` | Group-by count |
| `first(arr, n)` / `last(arr, n)` | Slice helpers |
| `table(arr)` | Format as ASCII table |
| `$vars` | Map of all persisted variables from previous calls in this session |

## Progressive Adapter Loading

Instead of dumping all skill schemas into the sandbox context upfront, adapters are discoverable on-demand:

```ts
// Agent discovers what's available (lightweight — just ids + descriptions)
const skills = await adapters();
// → [{ id: "fetch_url", description: "Fetch content from a URL" }, ...]

// Agent inspects a specific skill's full schema only when needed
const schema = await describe("query_sqlite");
// → { properties: { database: { type: "string" }, sql: { type: "string" } }, required: [...] }

// Then calls it with knowledge of the schema
const rows = await skill("query_sqlite", { database: "/tmp/app.db", sql: "SELECT * FROM users" });
```

This keeps the initial sandbox context minimal. The model only pays context tokens for skills it actually inspects.

## Batch Operations

Built-in `batch()` function for processing arrays of items with controlled concurrency:

```ts
// Process 100 URLs with concurrency of 10
const urls = [...]; // 100 URLs
const results = await batch(urls, async (url) => {
  const data = await skill('fetch_url', { url });
  return JSON.parse(data);
}, { concurrency: 10 });

// With progress tracking
const results = await batch(items, processFn, {
  concurrency: 5,
  onProgress: (done, total) => { /* logged to stderr */ }
});
```

The orchestrator handles concurrent IPC — multiple in-flight `seq` numbers are supported.

## Execution Model: Subprocess with stdin/stdout IPC

```
Orchestrator                          Sandbox subprocess
─────────────                         ──────────────────

spawn(["bun", tmpFile])               boots up, reads prelude
     │                                     │
     │                                code calls skill('fetch_url', {url})
     │                                     │
     │◄──── stdout: {"rpc":"skill",  ──────┘
     │        "id":"fetch_url",
     │        "args":{url:...},
     │        "seq":1}
     │
  dispatchSkill("fetch_url", args)
  route to web-agent, get result
     │
     ├────► stdin: {"seq":1,         ──────►
     │        "result":"<html>..."}         │
     │                               code continues, processes data
     │                               assigns to $vars, calls return
     │                                     │
     │◄──── stdout: {"done":true,   ───────┘
     │        "result":{count:42},
     │        "vars":{"$invoices":[...]}}
     │
  persist vars to SQLite
  auto-index if > 4KB
  return compact result to model
```

### IPC Protocol

**Sandbox → Orchestrator (stdout):**
- Skill call: `{"rpc":"skill", "id":"...", "args":{...}, "seq": N}\n`
- Adapter list: `{"rpc":"adapters", "seq": N}\n`
- Adapter describe: `{"rpc":"describe", "id":"...", "seq": N}\n`
- Completion: `{"done":true, "result":..., "vars":{...}}\n`

**Orchestrator → Sandbox (stdin):**
- Skill response: `{"seq": N, "result":...}\n`
- Skill error: `{"seq": N, "error":"..."}\n`

Multiple in-flight `seq` numbers supported for batch concurrency.

### Subprocess Lifecycle

1. Load `$vars` from SQLite for the session
2. Write temp file `/tmp/sandbox-{uuid}.ts` with prelude + user code
3. `Bun.spawn(["bun", tmpFile])` with stdin/stdout pipes
4. Read stdout line-by-line, dispatch skill calls via `dispatchSkill()`
5. On `{"done":true}`, collect result and new vars
6. Timeout: kill subprocess after `timeout` ms (default 30s)
7. Clean up temp file

## Storage: Separate SQLite Database

**File:** `~/.a2a-sandbox.db`

Separate from `~/.a2a-memory.db` to avoid schema coupling and allow independent cleanup.

### Schema

```sql
CREATE TABLE IF NOT EXISTS sandbox_vars (
  session TEXT NOT NULL,
  name    TEXT NOT NULL,     -- e.g. "$invoices"
  value   TEXT NOT NULL,     -- JSON serialized
  size    INTEGER NOT NULL,  -- byte length of value
  ts      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (session, name)
);

CREATE VIRTUAL TABLE IF NOT EXISTS sandbox_fts USING fts5(
  session, name, value,
  content=sandbox_vars, content_rowid=rowid
);

-- Sync triggers (same pattern as memory.ts memory_fts triggers)
CREATE TRIGGER IF NOT EXISTS sandbox_ai AFTER INSERT ON sandbox_vars BEGIN
  INSERT INTO sandbox_fts(rowid, session, name, value)
    VALUES (NEW.rowid, NEW.session, NEW.name, NEW.value);
END;

CREATE TRIGGER IF NOT EXISTS sandbox_ad AFTER DELETE ON sandbox_vars BEGIN
  INSERT INTO sandbox_fts(sandbox_fts, rowid, session, name, value)
    VALUES('delete', OLD.rowid, OLD.session, OLD.name, OLD.value);
END;

CREATE TRIGGER IF NOT EXISTS sandbox_au AFTER UPDATE ON sandbox_vars BEGIN
  INSERT INTO sandbox_fts(sandbox_fts, rowid, session, name, value)
    VALUES('delete', OLD.rowid, OLD.session, OLD.name, OLD.value);
  INSERT INTO sandbox_fts(rowid, session, name, value)
    VALUES (NEW.rowid, NEW.session, NEW.name, NEW.value);
END;
```

### Auto-Indexing

Variables with `size > 4096` bytes are automatically indexed into `sandbox_fts`. The `search()` function inside the sandbox queries this table, returning only matching rows instead of the full dataset.

### Cleanup

Variables older than 7 days auto-pruned on server startup (same pattern as task store TTL).

## New Files

| File | Purpose |
|---|---|
| `src/sandbox.ts` | Sandbox runtime: SQLite store, FTS5 indexing, subprocess management, IPC protocol |
| `src/sandbox-prelude.ts` | Template for injected prelude (skill(), search(), helpers, $vars) |

## Modified Files

| File | Change |
|---|---|
| `src/server.ts` | Add `sandbox_execute` and `sandbox_vars` to orchestrator skills. Wire IPC dispatch. |

## Token Reduction Example

```
Without sandbox:
  1. delegate → fetch_url → 50KB JSON in context
  2. Model reads 50KB, filters, responds
  Token cost: ~15,000 tokens

With sandbox:
  1. sandbox_execute:
     const data = await skill('fetch_url', {url: '...'});
     const items = JSON.parse(data);
     return { total: items.length, overdue: items.filter(i => new Date(i.due) < new Date()).length };
  2. Returns: { total: 247, overdue: 42 }
  Token cost: ~50 tokens
```

## Out of Scope (YAGNI)

- No adapter generation CLI (skills are already defined)
- No network isolation (agent already has run_shell)
- No file processing skill (use skill('read_file', ...) from sandbox)
