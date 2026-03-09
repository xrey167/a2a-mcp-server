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
