import { describe, test, expect, afterAll } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { unlinkSync } from "fs";

// Use an isolated temp DB so tests never touch the user's real ~/.a2a-mcp/audit.db
const testDbPath = join(tmpdir(), `a2a-audit-test-${Date.now()}.db`);
process.env.A2A_AUDIT_DB = testDbPath;

// Dynamic import AFTER env is set so module picks up the test DB path
const { auditLog, auditQuery, auditStats, auditPrune, closeAuditDb } =
  await import("../audit.js");

// Clean up temp DB after all tests
afterAll(() => {
  closeAuditDb();
  try { unlinkSync(testDbPath); } catch {}
  try { unlinkSync(testDbPath + "-wal"); } catch {}
  try { unlinkSync(testDbPath + "-shm"); } catch {}
});

describe("audit", () => {

  test("auditLog writes and auditQuery reads entries", () => {
    auditLog({
      actor: "test-actor",
      role: "admin",
      skillId: "delegate",
      success: true,
      durationMs: 42,
    });

    const entries = auditQuery({ actor: "test-actor", limit: 10 });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[0];
    expect(entry.actor).toBe("test-actor");
    expect(entry.skillId).toBe("delegate");
    expect(entry.success).toBe(true);
    expect(entry.durationMs).toBe(42);
  });

  test("auditLog records failures", () => {
    auditLog({
      actor: "fail-actor",
      role: "viewer",
      skillId: "sandbox_execute",
      success: false,
      error: "Permission denied",
    });

    const entries = auditQuery({ actor: "fail-actor", success: false });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].error).toBe("Permission denied");
    expect(entries[0].success).toBe(false);
  });

  test("auditQuery filters by skillId", () => {
    auditLog({ actor: "skill-test", role: "operator", skillId: "workflow_execute", success: true });
    auditLog({ actor: "skill-test", role: "operator", skillId: "delegate", success: true });

    const workflows = auditQuery({ actor: "skill-test", skillId: "workflow_execute" });
    for (const e of workflows) {
      expect(e.skillId).toBe("workflow_execute");
    }
  });

  test("auditQuery filters by workspace", () => {
    auditLog({ actor: "ws-test", role: "admin", skillId: "delegate", workspace: "ws_abc", success: true });
    auditLog({ actor: "ws-test", role: "admin", skillId: "delegate", workspace: "ws_xyz", success: true });

    const results = auditQuery({ workspace: "ws_abc" });
    for (const e of results) {
      expect(e.workspace).toBe("ws_abc");
    }
  });

  test("auditStats returns summary", () => {
    const stats = auditStats();
    expect(stats.totalCalls).toBeGreaterThanOrEqual(1);
    expect(typeof stats.successRate).toBe("number");
    expect(Array.isArray(stats.topSkills)).toBe(true);
    expect(Array.isArray(stats.topActors)).toBe(true);
  });

  test("auditPrune removes old entries", () => {
    // Prune entries older than 90 days (the default); should not remove recent entries
    const removed = auditPrune(90);
    expect(typeof removed).toBe("number");
  });

  test("auditLog stores timestamp in ISO-8601 UTC format", () => {
    auditLog({ actor: "ts-format-test", role: "admin", skillId: "ts_check", success: true });
    const entries = auditQuery({ actor: "ts-format-test", limit: 1 });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const { timestamp } = entries[0];
    // Must match ISO-8601 UTC: "YYYY-MM-DDTHH:MM:SS.sssZ"
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    // Must be parseable and not NaN
    expect(Number.isNaN(new Date(timestamp).getTime())).toBe(false);
  });

  test("auditQuery since/until filters work with ISO-8601 timestamps", () => {
    const before = new Date(Date.now() - 1000).toISOString();
    auditLog({ actor: "filter-ts-test", role: "admin", skillId: "ts_filter", success: true });
    const after = new Date(Date.now() + 1000).toISOString();

    const withSince = auditQuery({ actor: "filter-ts-test", since: before });
    expect(withSince.length).toBeGreaterThanOrEqual(1);

    const withUntil = auditQuery({ actor: "filter-ts-test", until: after });
    expect(withUntil.length).toBeGreaterThanOrEqual(1);

    // since in the future → nothing returned
    const noResults = auditQuery({ actor: "filter-ts-test", since: after });
    expect(noResults.length).toBe(0);
  });

  test("auditStats since filter works with ISO-8601 timestamps", () => {
    const beforeAll = new Date(Date.now() - 1000).toISOString();
    auditLog({ actor: "stats-ts-test", role: "admin", skillId: "ts_stats", success: true });

    const stats = auditStats(beforeAll);
    expect(stats.totalCalls).toBeGreaterThanOrEqual(1);

    // since in the future → totalCalls should be 0
    const futureStats = auditStats(new Date(Date.now() + 1000).toISOString());
    expect(futureStats.totalCalls).toBe(0);
  });

  test("auditPrune removes entries older than cutoff", async () => {
    auditLog({ actor: "prune-epoch-test", role: "admin", skillId: "prune_me", success: true });
    await Bun.sleep(20);

    // Prune with 0 days: everything older than right-now should be removed
    const removed = auditPrune(0);
    expect(removed).toBeGreaterThanOrEqual(1);

    // The entry we just created should now be gone
    const remaining = auditQuery({ actor: "prune-epoch-test" });
    expect(remaining.length).toBe(0);
  });

  test("auditLog stores timestamp in ISO-8601 UTC format", () => {
    auditLog({ actor: "ts-format-test", role: "admin", skillId: "ts_check", success: true });
    const entries = auditQuery({ actor: "ts-format-test", limit: 1 });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const { timestamp } = entries[0];
    // Must match ISO-8601 UTC: "YYYY-MM-DDTHH:MM:SS.sssZ"
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    // Must be parseable and not NaN
    expect(Number.isNaN(new Date(timestamp).getTime())).toBe(false);
  });

  test("auditQuery since/until filters work with ISO-8601 timestamps", () => {
    const before = new Date(Date.now() - 1000).toISOString();
    auditLog({ actor: "filter-ts-test", role: "admin", skillId: "ts_filter", success: true });
    const after = new Date(Date.now() + 1000).toISOString();

    const withSince = auditQuery({ actor: "filter-ts-test", since: before });
    expect(withSince.length).toBeGreaterThanOrEqual(1);

    const withUntil = auditQuery({ actor: "filter-ts-test", until: after });
    expect(withUntil.length).toBeGreaterThanOrEqual(1);

    // since in the future → nothing returned
    const noResults = auditQuery({ actor: "filter-ts-test", since: after });
    expect(noResults.length).toBe(0);
  });

  test("auditStats since filter works with ISO-8601 timestamps", () => {
    const beforeAll = new Date(Date.now() - 1000).toISOString();
    auditLog({ actor: "stats-ts-test", role: "admin", skillId: "ts_stats", success: true });

    const stats = auditStats(beforeAll);
    expect(stats.totalCalls).toBeGreaterThanOrEqual(1);

    // since in the future → totalCalls should be 0
    const futureStats = auditStats(new Date(Date.now() + 1000).toISOString());
    expect(futureStats.totalCalls).toBe(0);
  });
});
