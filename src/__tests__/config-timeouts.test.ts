import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, resetConfig } from "../config.js";

describe("Config timeouts and web sections", () => {
  const origHome = process.env.HOME;

  beforeEach(() => {
    resetConfig();
    // Point HOME to a temp dir so no host config.json is found
    process.env.HOME = "/tmp/.a2a-config-test-nonexistent";
    // Clear env vars that might interfere
    delete process.env.A2A_PORT;
    delete process.env.A2A_API_KEY;
    delete process.env.A2A_SANDBOX_TIMEOUT;
    delete process.env.A2A_MAX_RESPONSE_SIZE;
  });

  afterEach(() => {
    process.env.HOME = origHome;
  });

  test("loads default timeout values", () => {
    const config = loadConfig();
    expect(config.timeouts).toBeDefined();
    expect(config.timeouts.shell).toBe(15_000);
    expect(config.timeouts.fetch).toBe(30_000);
    expect(config.timeouts.codex).toBe(120_000);
    expect(config.timeouts.peer).toBe(60_000);
  });

  test("loads default web config", () => {
    const config = loadConfig();
    expect(config.web).toBeDefined();
    expect(config.web.rateLimit).toBe(0);
    expect(config.web.maxResponseBytes).toBe(10 * 1024 * 1024);
  });

  test("loads default sandbox config", () => {
    const config = loadConfig();
    expect(config.sandbox.timeout).toBe(30_000);
    expect(config.sandbox.maxResultSize).toBe(25_000);
    expect(config.sandbox.indexThreshold).toBe(4096);
  });
});
