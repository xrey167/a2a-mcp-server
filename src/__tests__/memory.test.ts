import { describe, test, expect, afterAll } from "bun:test";
import { memory } from "../memory.js";

const TEST_AGENT = "__test_agent__";

// Clean up after tests
afterAll(() => {
  // Remove all test keys
  const keys = memory.listKeys(TEST_AGENT);
  for (const key of keys) {
    memory.forget(TEST_AGENT, key);
  }
});

describe("Memory - basic CRUD", () => {
  test("set and get", () => {
    memory.set(TEST_AGENT, "greeting", "hello world");
    expect(memory.get(TEST_AGENT, "greeting")).toBe("hello world");
  });

  test("get returns null for missing key", () => {
    expect(memory.get(TEST_AGENT, "nonexistent_key_12345")).toBeNull();
  });

  test("set overwrites existing key", () => {
    memory.set(TEST_AGENT, "overwrite_test", "v1");
    memory.set(TEST_AGENT, "overwrite_test", "v2");
    expect(memory.get(TEST_AGENT, "overwrite_test")).toBe("v2");
  });

  test("all returns all memories for agent", () => {
    memory.set(TEST_AGENT, "all_a", "val_a");
    memory.set(TEST_AGENT, "all_b", "val_b");
    const all = memory.all(TEST_AGENT);
    expect(all.all_a).toBe("val_a");
    expect(all.all_b).toBe("val_b");
  });

  test("forget removes a key", () => {
    memory.set(TEST_AGENT, "forget_me", "temp");
    expect(memory.get(TEST_AGENT, "forget_me")).toBe("temp");
    memory.forget(TEST_AGENT, "forget_me");
    expect(memory.get(TEST_AGENT, "forget_me")).toBeNull();
  });
});

describe("Memory - search (FTS5)", () => {
  test("search finds matching records", () => {
    memory.set(TEST_AGENT, "fts_note", "The quick brown fox jumps");
    memory.set(TEST_AGENT, "fts_other", "Lazy dog sleeps");

    const results = memory.search("fox", TEST_AGENT);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.key === "fts_note")).toBe(true);
  });

  test("search across all agents when no agent filter", () => {
    memory.set(TEST_AGENT, "fts_global", "uniqueSearchTerm12345");
    const results = memory.search("uniqueSearchTerm12345");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.agent === TEST_AGENT)).toBe(true);
  });

  test("search returns empty for no matches", () => {
    const results = memory.search("xyzzy_nonexistent_term_99999", TEST_AGENT);
    expect(results).toEqual([]);
  });
});

describe("Memory - listKeys", () => {
  test("lists all keys for agent", () => {
    memory.set(TEST_AGENT, "list_k1", "v");
    memory.set(TEST_AGENT, "list_k2", "v");
    const keys = memory.listKeys(TEST_AGENT);
    expect(keys).toContain("list_k1");
    expect(keys).toContain("list_k2");
  });

  test("lists keys with prefix filter", () => {
    memory.set(TEST_AGENT, "prefix_a", "v");
    memory.set(TEST_AGENT, "prefix_b", "v");
    memory.set(TEST_AGENT, "other_c", "v");

    const filtered = memory.listKeys(TEST_AGENT, "prefix_");
    expect(filtered).toContain("prefix_a");
    expect(filtered).toContain("prefix_b");
    expect(filtered).not.toContain("other_c");
  });
});

describe("Memory - cleanup", () => {
  test("cleanup with large maxAge keeps recent entries", () => {
    const uniqueKey = `cleanup_keep_${Date.now()}`;
    memory.set(TEST_AGENT, uniqueKey, "keep me");
    const removed = memory.cleanup(365); // 365 days — entry is seconds old, not 365 days
    expect(memory.get(TEST_AGENT, uniqueKey)).toBe("keep me");
    // Verify zero entries were removed (all test entries are fresh)
    expect(removed).toBe(0);
    memory.forget(TEST_AGENT, uniqueKey);
  });

  test("cleanup with zero days removes entries older than 0 days", () => {
    // Write a known entry, verify it exists
    const uniqueKey = `cleanup_zero_${Date.now()}`;
    memory.set(TEST_AGENT, uniqueKey, "ephemeral");
    expect(memory.get(TEST_AGENT, uniqueKey)).toBe("ephemeral");

    // Wait so the unixepoch() timestamp is strictly in the past (SQLite unixepoch
    // has 1-second granularity, so we need >1s to guarantee cutoff < entry ts)
    Bun.sleepSync(1100);

    const removed = memory.cleanup(0);
    expect(removed).toBeGreaterThanOrEqual(1);
    // Explicitly verify the specific entry was removed
    expect(memory.get(TEST_AGENT, uniqueKey)).toBeNull();
  });
});

describe("Memory - path safety", () => {
  test("noteFile sanitizes path traversal in agent name", () => {
    // This should not throw or create files outside MEMORY_DIR
    memory.set("../../../etc", "test_key_safety", "safe value");
    expect(memory.get("../../../etc", "test_key_safety")).toBe("safe value");
    memory.forget("../../../etc", "test_key_safety");
  });

  test("noteFile sanitizes path traversal in key", () => {
    memory.set(TEST_AGENT, "../../passwd", "safe value");
    expect(memory.get(TEST_AGENT, "../../passwd")).toBe("safe value");
    memory.forget(TEST_AGENT, "../../passwd");
  });
});
