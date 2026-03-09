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

// ── adapters() — list available skill adapters ────────────
async function adapters(): Promise<Array<{ id: string; description: string }>> {
  const seq = ++__seq;
  return new Promise((resolve, reject) => {
    __pending.set(seq, { resolve, reject });
    __send({ rpc: "adapters", seq });
  });
}

// ── describe() — get full input schema for a skill ────────
async function describe(skillId: string): Promise<any> {
  const seq = ++__seq;
  return new Promise((resolve, reject) => {
    __pending.set(seq, { resolve, reject });
    __send({ rpc: "describe", id: skillId, seq });
  });
}

// ── batch() — process array with concurrency control ──────
async function batch<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  opts?: { concurrency?: number; onProgress?: (done: number, total: number) => void }
): Promise<R[]> {
  const concurrency = opts?.concurrency ?? 5;
  const results: R[] = new Array(items.length);
  let idx = 0;
  let done = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
      done++;
      if (opts?.onProgress) opts.onProgress(done, items.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
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
