import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadRegistry, searchRegistry, getRegistryEntry, saveRegistry } from "../worker-registry.js";
import type { Registry } from "../worker-registry.js";

describe("worker-registry", () => {
  const origHome = process.env.HOME;
  let testHome: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `.a2a-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HOME = testHome;
    mkdirSync(join(testHome, ".a2a-mcp"), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("loadRegistry returns built-in entries when no local file", () => {
    const registry = loadRegistry();
    expect(registry.workers.length).toBeGreaterThan(0);
    expect(registry.version).toBe(1);
  });

  test("built-in registry includes expected workers", () => {
    const registry = loadRegistry();
    const names = registry.workers.map(w => w.name);
    expect(names).toContain("github-agent");
    expect(names).toContain("slack-agent");
    expect(names).toContain("postgres-agent");
    expect(names).toContain("docker-agent");
  });

  test("searchRegistry finds by name", () => {
    const results = searchRegistry("github");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("github-agent");
  });

  test("searchRegistry finds by tag", () => {
    const results = searchRegistry("database");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.name === "postgres-agent")).toBe(true);
  });

  test("searchRegistry finds by skill id", () => {
    const results = searchRegistry("pg_query");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("postgres-agent");
  });

  test("searchRegistry finds by description keyword", () => {
    const results = searchRegistry("browser");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.name === "playwright-agent")).toBe(true);
  });

  test("searchRegistry is case insensitive", () => {
    const results = searchRegistry("DOCKER");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("docker-agent");
  });

  test("searchRegistry returns empty for no matches", () => {
    const results = searchRegistry("nonexistent-xyz-12345");
    expect(results).toEqual([]);
  });

  test("getRegistryEntry returns entry by name", () => {
    const entry = getRegistryEntry("slack-agent");
    expect(entry).toBeDefined();
    expect(entry!.author).toBe("a2a-community");
    expect(entry!.skills).toContain("slack_send");
  });

  test("getRegistryEntry returns undefined for missing", () => {
    const entry = getRegistryEntry("nonexistent");
    expect(entry).toBeUndefined();
  });

  test("saveRegistry persists to local file", () => {
    const custom: Registry = {
      version: 2,
      updated: "2026-03-09",
      workers: [
        {
          name: "custom-agent",
          description: "A custom worker",
          author: "test",
          version: "0.1.0",
          repo: "https://github.com/test/custom",
          skills: ["custom_skill"],
          tags: ["custom"],
        },
      ],
    };

    saveRegistry(custom);

    // Reload and verify it merged with built-in
    const loaded = loadRegistry();
    expect(loaded.version).toBe(2);
    const customEntry = loaded.workers.find(w => w.name === "custom-agent");
    expect(customEntry).toBeDefined();
    // Built-in entries should also be present (merged)
    expect(loaded.workers.find(w => w.name === "github-agent")).toBeDefined();
  });

  test("local registry entries override built-in by name", () => {
    const override: Registry = {
      version: 2,
      updated: "2026-03-09",
      workers: [
        {
          name: "github-agent",
          description: "OVERRIDDEN github agent",
          author: "custom-author",
          version: "2.0.0",
          repo: "https://github.com/custom/github",
          skills: ["custom_github"],
          tags: ["github"],
        },
      ],
    };

    saveRegistry(override);
    const loaded = loadRegistry();
    const gh = loaded.workers.find(w => w.name === "github-agent");
    expect(gh).toBeDefined();
    expect(gh!.description).toBe("OVERRIDDEN github agent");
    expect(gh!.version).toBe("2.0.0");
  });

  test("all built-in entries have required fields", () => {
    const registry = loadRegistry();
    for (const w of registry.workers) {
      expect(w.name).toBeTruthy();
      expect(w.description).toBeTruthy();
      expect(w.author).toBeTruthy();
      expect(w.version).toBeTruthy();
      expect(w.repo).toBeTruthy();
      expect(w.skills.length).toBeGreaterThan(0);
      expect(w.tags.length).toBeGreaterThan(0);
    }
  });
});
