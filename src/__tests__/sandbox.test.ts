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
