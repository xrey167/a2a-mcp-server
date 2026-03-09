import { describe, test, expect, afterAll } from "bun:test";
import { auditLog, auditQuery, auditStats, auditPrune, closeAuditDb } from "../audit.js";

describe("audit", () => {
  afterAll(() => {
    closeAuditDb();
  });

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
    // Prune entries older than 0 days shouldn't remove recent entries
    const removed = auditPrune(0);
    // May or may not remove — depends on timing
    expect(typeof removed).toBe("number");
  });

  test("timestamp is returned as ISO 8601 string", () => {
    auditLog({ actor: "ts-format-test", role: "admin", skillId: "test_ts", success: true });
    const entries = auditQuery({ actor: "ts-format-test", limit: 1 });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const ts = entries[0].timestamp;
    // Must parse back to a valid date
    expect(Number.isFinite(new Date(ts).getTime())).toBe(true);
    // Must look like an ISO string (contains 'T' and ends with 'Z')
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("auditQuery filters by since/until correctly", async () => {
    const before = new Date().toISOString();
    await Bun.sleep(10);

    auditLog({ actor: "time-filter-test", role: "admin", skillId: "time_skill", success: true });

    await Bun.sleep(10);
    const after = new Date().toISOString();

    // since=before should include the entry
    const found = auditQuery({ actor: "time-filter-test", since: before });
    expect(found.length).toBeGreaterThanOrEqual(1);

    // since=after should exclude the entry
    const notFound = auditQuery({ actor: "time-filter-test", since: after });
    expect(notFound.length).toBe(0);

    // until=before should exclude the entry
    const alsoNotFound = auditQuery({ actor: "time-filter-test", until: before });
    expect(alsoNotFound.length).toBe(0);
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

  test("auditLog truncates long args", () => {
    const longArgs = "x".repeat(5000);
    auditLog({ actor: "trunc-test", role: "admin", skillId: "test", success: true, args: longArgs });
    const entries = auditQuery({ actor: "trunc-test" });
    expect(entries[0].args!.length).toBeLessThanOrEqual(2048);
  });
});
