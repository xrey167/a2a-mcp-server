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
    delete process.env.A2A_ERP_AUTO_RENEW_ENABLED;
    delete process.env.A2A_ERP_SWEEP_INTERVAL_MS;
    delete process.env.A2A_ERP_SWEEP_JITTER_MS;
    delete process.env.A2A_ERP_SNAPSHOT_EXPORT_ENABLED;
    delete process.env.A2A_ERP_SNAPSHOT_INTERVAL_MS;
    delete process.env.A2A_ERP_SNAPSHOT_RETENTION_DAYS;
    delete process.env.A2A_ERP_SNAPSHOT_OUTPUT_DIR;
    delete process.env.A2A_ERP_SNAPSHOT_SIGNING_KEY;
    delete process.env.A2A_SANDBOX_TIMEOUT;
    delete process.env.A2A_MAX_RESPONSE_SIZE;
  });

  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
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

  test("loads ERP renewal defaults and env overrides", () => {
    let config = loadConfig();
    expect(config.erp.autoRenewEnabled).toBe(true);
    expect(config.erp.renewalSweepIntervalMs).toBe(60 * 60 * 1000);
    expect(config.erp.renewalSweepJitterMs).toBe(5 * 60 * 1000);
    expect(config.erp.snapshotExportEnabled).toBe(false);
    expect(config.erp.snapshotExportIntervalMs).toBe(24 * 60 * 60 * 1000);
    expect(config.erp.snapshotRetentionDays).toBe(30);
    expect(config.erp.snapshotOutputDir).toContain("/.a2a-mcp/reports/connector-renewals");
    expect(config.erp.snapshotSigningKey).toBeUndefined();

    resetConfig();
    process.env.A2A_ERP_AUTO_RENEW_ENABLED = "false";
    process.env.A2A_ERP_SWEEP_INTERVAL_MS = "120000";
    process.env.A2A_ERP_SWEEP_JITTER_MS = "10000";
    process.env.A2A_ERP_SNAPSHOT_EXPORT_ENABLED = "true";
    process.env.A2A_ERP_SNAPSHOT_INTERVAL_MS = "3600000";
    process.env.A2A_ERP_SNAPSHOT_RETENTION_DAYS = "7";
    process.env.A2A_ERP_SNAPSHOT_OUTPUT_DIR = "/tmp/a2a-snapshots";
    process.env.A2A_ERP_SNAPSHOT_SIGNING_KEY = "topsecret";
    config = loadConfig();
    expect(config.erp.autoRenewEnabled).toBe(false);
    expect(config.erp.renewalSweepIntervalMs).toBe(120_000);
    expect(config.erp.renewalSweepJitterMs).toBe(10_000);
    expect(config.erp.snapshotExportEnabled).toBe(true);
    expect(config.erp.snapshotExportIntervalMs).toBe(3_600_000);
    expect(config.erp.snapshotRetentionDays).toBe(7);
    expect(config.erp.snapshotOutputDir).toBe("/tmp/a2a-snapshots");
    expect(config.erp.snapshotSigningKey).toBe("topsecret");
  });
});
