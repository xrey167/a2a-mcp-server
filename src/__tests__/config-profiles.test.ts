import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, resetConfig } from "../config.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Config profiles and remote workers", () => {
  const origHome = process.env.HOME;
  let testHome: string;

  beforeEach(() => {
    resetConfig();
    testHome = join(tmpdir(), `.a2a-config-profile-test-${Date.now()}`);
    process.env.HOME = testHome;
    delete process.env.A2A_PORT;
    delete process.env.A2A_API_KEY;
    delete process.env.A2A_SANDBOX_TIMEOUT;
    delete process.env.A2A_MAX_RESPONSE_SIZE;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("defaults have no profile or remoteWorkers", () => {
    const config = loadConfig();
    expect(config.profile).toBeUndefined();
    expect(config.remoteWorkers).toBeUndefined();
  });

  test("lite profile produces 3 enabled workers", () => {
    const configDir = join(testHome, ".a2a-mcp");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ profile: "lite" }));

    const config = loadConfig();
    expect(config.profile).toBe("lite");
    expect(config.workers).toBeDefined();

    const enabled = config.workers!.filter(w => w.enabled);
    const disabled = config.workers!.filter(w => !w.enabled);
    expect(enabled.length).toBe(3);
    expect(enabled.map(w => w.name).sort()).toEqual(["ai", "shell", "web"]);
    expect(disabled.length).toBe(5);
  });

  test("data profile produces 4 enabled workers", () => {
    const configDir = join(testHome, ".a2a-mcp");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ profile: "data" }));

    const config = loadConfig();
    const enabled = config.workers!.filter(w => w.enabled);
    expect(enabled.length).toBe(4);
    expect(enabled.map(w => w.name).sort()).toEqual(["ai", "data", "shell", "web"]);
  });

  test("full profile enables all 8 workers", () => {
    const configDir = join(testHome, ".a2a-mcp");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ profile: "full" }));

    const config = loadConfig();
    const enabled = config.workers!.filter(w => w.enabled);
    expect(enabled.length).toBe(8);
  });

  test("explicit workers config takes priority over profile", () => {
    const configDir = join(testHome, ".a2a-mcp");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      profile: "lite",
      workers: [
        { name: "shell", path: "workers/shell.ts", port: 8081, enabled: true },
        { name: "web", path: "workers/web.ts", port: 8082, enabled: false },
      ],
    }));

    const config = loadConfig();
    // workers should come from explicit config, not profile
    expect(config.workers!.length).toBe(2);
    expect(config.workers![1].enabled).toBe(false);
  });

  test("remoteWorkers are loaded from config", () => {
    const configDir = join(testHome, ".a2a-mcp");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      remoteWorkers: [
        { name: "external-agent", url: "https://agent.example.com", apiKey: "secret" },
        { name: "another-agent", url: "http://192.168.1.100:9090" },
      ],
    }));

    const config = loadConfig();
    expect(config.remoteWorkers).toBeDefined();
    expect(config.remoteWorkers!.length).toBe(2);
    expect(config.remoteWorkers![0].name).toBe("external-agent");
    expect(config.remoteWorkers![0].apiKey).toBe("secret");
    expect(config.remoteWorkers![1].apiKey).toBeUndefined();
  });

  test("invalid profile value is rejected", () => {
    const configDir = join(testHome, ".a2a-mcp");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ profile: "invalid" }));

    // Should fall back to defaults (validation error)
    const config = loadConfig();
    expect(config.profile).toBeUndefined();
  });
});
