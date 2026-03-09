// src/__tests__/sandbox-integration.test.ts
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { executeSandbox, setAdapters } from "../sandbox.js";
import { sandboxStore } from "../sandbox-store.js";

const SESSION = "__integration_test__";

// Mock dispatch that simulates worker responses
const mockDispatch = async (skillId: string, args: Record<string, unknown>): Promise<string> => {
  switch (skillId) {
    case "fetch_url": {
      // Simulate a large API response (> 4KB to trigger FTS5 indexing)
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        name: `Item ${i + 1}`,
        category: i % 2 === 0 ? "electronics" : "clothing",
        price: Math.round(Math.random() * 10000) / 100,
        description: `This is a detailed description for item ${i + 1} with various searchable keywords`,
      }));
      return JSON.stringify(items);
    }
    case "query_sqlite":
      return JSON.stringify([{ count: 42 }]);
    default:
      return `Unknown skill: ${skillId}`;
  }
};

beforeAll(() => {
  // Register mock adapters for progressive discovery tests
  setAdapters(
    [
      { id: "fetch_url", description: "Fetch content from a URL" },
      { id: "query_sqlite", description: "Query a SQLite database" },
      { id: "run_shell", description: "Run a shell command" },
    ],
    new Map([
      ["fetch_url", { type: "object", properties: { url: { type: "string" } }, required: ["url"] }],
      ["query_sqlite", { type: "object", properties: { database: { type: "string" }, sql: { type: "string" } }, required: ["database", "sql"] }],
    ]),
  );
});

afterAll(() => {
  sandboxStore.deleteSession(SESSION);
});

describe("Sandbox integration", () => {
  test("full flow: fetch -> process -> persist -> search", async () => {
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

  test("adapters() returns list of available skills", async () => {
    const r = await executeSandbox({
      code: `
        const skills = await adapters();
        return { count: skills.length, hasIds: skills.every(s => s.id && s.description) };
      `,
      sessionId: SESSION,
      dispatch: mockDispatch,
    });

    expect(r.error).toBeUndefined();
    expect(r.result.count).toBeGreaterThan(0);
    expect(r.result.hasIds).toBe(true);
  });

  test("describe() returns schema for a specific skill", async () => {
    const r = await executeSandbox({
      code: `
        const schema = await describe("fetch_url");
        return { hasProperties: !!schema.properties, hasRequired: Array.isArray(schema.required) };
      `,
      sessionId: SESSION,
      dispatch: mockDispatch,
    });

    expect(r.error).toBeUndefined();
    expect(r.result.hasProperties).toBe(true);
  });

  test("batch() processes items with concurrency", async () => {
    const r = await executeSandbox({
      code: `
        const urls = Array.from({ length: 10 }, (_, i) => "https://example.com/" + i);
        const results = await batch(urls, async (url) => {
          const data = await skill('fetch_url', { url });
          return JSON.parse(data).length;
        }, { concurrency: 3 });
        return { total: results.length, allEqual: results.every(r => r === 100) };
      `,
      sessionId: SESSION,
      dispatch: mockDispatch,
    });

    expect(r.error).toBeUndefined();
    expect(r.result.total).toBe(10);
    expect(r.result.allEqual).toBe(true);
  });

  test("progressive discovery: adapters -> describe -> skill", async () => {
    const r = await executeSandbox({
      code: `
        // Step 1: Discover available skills
        const skills = await adapters();
        const fetchSkill = skills.find(s => s.id === "fetch_url");
        if (!fetchSkill) return { error: "fetch_url not found" };

        // Step 2: Get schema for the skill we want
        const schema = await describe(fetchSkill.id);

        // Step 3: Call it with knowledge of the schema
        const data = await skill(fetchSkill.id, { url: "https://example.com" });
        const items = JSON.parse(data);

        return {
          discovered: fetchSkill.id,
          schemaKeys: Object.keys(schema.properties || {}),
          itemCount: items.length,
        };
      `,
      sessionId: SESSION,
      dispatch: mockDispatch,
    });

    expect(r.error).toBeUndefined();
    expect(r.result.discovered).toBe("fetch_url");
    expect(r.result.itemCount).toBe(100);
  });
});
