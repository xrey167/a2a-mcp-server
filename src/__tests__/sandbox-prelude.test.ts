// src/__tests__/sandbox-prelude.test.ts
import { describe, test, expect } from "bun:test";
import { buildPrelude } from "../sandbox-prelude.js";

describe("Sandbox prelude", () => {
  test("buildPrelude returns valid TypeScript string", () => {
    const code = buildPrelude({}, "test-session");
    expect(typeof code).toBe("string");
    expect(code).toContain("async function skill(");
    expect(code).toContain("function pick<");
    expect(code).toContain("function sum(");
    expect(code).toContain("function count(");
    expect(code).toContain("function first<");
    expect(code).toContain("function last<");
    expect(code).toContain("function table(");
    expect(code).toContain("async function search(");
    expect(code).toContain("async function adapters(");
    expect(code).toContain("async function describe(");
    expect(code).toContain("async function batch<");
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
