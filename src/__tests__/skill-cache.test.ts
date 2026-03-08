import { describe, test, expect, beforeEach } from "bun:test";
import { getFromCache, putInCache, invalidateSkill, invalidateAll, getCacheStats, configureCacheSkill, resetCache } from "../skill-cache.js";

beforeEach(() => resetCache());

describe("Skill Cache", () => {
  test("cache miss returns undefined", () => {
    expect(getFromCache("fetch_url", { url: "test" })).toBeUndefined();
  });

  test("put and get", () => {
    putInCache("fetch_url", { url: "test" }, "result-data");
    expect(getFromCache("fetch_url", { url: "test" })).toBe("result-data");
  });

  test("different args = different entries", () => {
    putInCache("fetch_url", { url: "a" }, "result-a");
    putInCache("fetch_url", { url: "b" }, "result-b");
    expect(getFromCache("fetch_url", { url: "a" })).toBe("result-a");
    expect(getFromCache("fetch_url", { url: "b" })).toBe("result-b");
  });

  test("no-cache skills are never cached", () => {
    putInCache("run_shell", { command: "ls" }, "output");
    expect(getFromCache("run_shell", { command: "ls" })).toBeUndefined();
  });

  test("expiration removes entry", async () => {
    putInCache("test_skill", { x: 1 }, "data", { ttlMs: 50 });
    expect(getFromCache("test_skill", { x: 1 })).toBe("data");
    await new Promise(r => setTimeout(r, 60));
    expect(getFromCache("test_skill", { x: 1 })).toBeUndefined();
  });

  test("invalidateSkill removes matching entries", () => {
    putInCache("fetch_url", { url: "a" }, "data-a");
    putInCache("fetch_url", { url: "b" }, "data-b");
    putInCache("ask_claude", { prompt: "x" }, "data-x");
    const removed = invalidateSkill("fetch_url");
    expect(removed).toBe(2);
    expect(getFromCache("fetch_url", { url: "a" })).toBeUndefined();
    expect(getFromCache("ask_claude", { prompt: "x" })).toBe("data-x");
  });

  test("invalidateAll clears everything", () => {
    putInCache("a", { x: 1 }, "1");
    putInCache("b", { x: 2 }, "2");
    invalidateAll();
    const stats = getCacheStats();
    expect(stats.entries).toBe(0);
  });

  test("stats track hits and misses", () => {
    putInCache("test", { x: 1 }, "val");
    getFromCache("test", { x: 1 }); // hit
    getFromCache("test", { x: 1 }); // hit
    getFromCache("test", { x: 99 }); // miss
    const stats = getCacheStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe("66.7%");
  });

  test("configureCacheSkill sets no-cache", () => {
    putInCache("custom_skill", { a: 1 }, "data");
    expect(getFromCache("custom_skill", { a: 1 })).toBe("data");
    configureCacheSkill("custom_skill", "no-cache");
    expect(getFromCache("custom_skill", { a: 1 })).toBeUndefined();
  });
});
