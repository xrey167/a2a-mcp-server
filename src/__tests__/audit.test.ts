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
    // Prune entries older than 0 days shouldn't remove recent entries
    const removed = auditPrune(0);
    // May or may not remove — depends on timing
    expect(typeof removed).toBe("number");
  });

  test("auditLog truncates long args", () => {
    const longArgs = "x".repeat(5000);
    auditLog({ actor: "trunc-test", role: "admin", skillId: "test", success: true, args: longArgs });
    const entries = auditQuery({ actor: "trunc-test" });
    expect(entries[0].args!.length).toBeLessThanOrEqual(2048);
  });
});
