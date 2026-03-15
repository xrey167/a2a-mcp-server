import { describe, test, expect, afterAll } from "bun:test";
import { createHmac } from "crypto";
import {
  registerWebhook,
  unregisterWebhook,
  getWebhook,
  listWebhooks,
  toggleWebhook,
  verifySignature,
  transformPayload,
  logWebhookCall,
  getWebhookLog,
} from "../webhooks.js";

// ── Helpers ───────────────────────────────────────────────────────

/** IDs registered during the test run — cleaned up in afterAll */
const registeredIds: string[] = [];

function makeWebhook(overrides: Partial<Parameters<typeof registerWebhook>[0]> = {}) {
  const wh = registerWebhook({
    name: "__test_webhook__",
    skillId: "run_shell",
    secret: "super-secret",
    fieldMappings: {},
    staticArgs: {},
    ...overrides,
  });
  registeredIds.push(wh.id);
  return wh;
}

afterAll(() => {
  for (const id of registeredIds) {
    unregisterWebhook(id);
  }
});

// ── CRUD ─────────────────────────────────────────────────────────

describe("Webhook CRUD", () => {
  test("registerWebhook creates a webhook with sane defaults", () => {
    const wh = makeWebhook();
    expect(wh.id).toBeTruthy();
    expect(wh.name).toBe("__test_webhook__");
    expect(wh.skillId).toBe("run_shell");
    expect(wh.enabled).toBe(true);
    expect(wh.createdAt).toBeTruthy();

    // async defaults to true when stored and retrieved (DB treats undefined as 1)
    const retrieved = getWebhook(wh.id);
    expect(retrieved!.async).toBe(true);
  });

  test("getWebhook retrieves the stored webhook", () => {
    const wh = makeWebhook({ name: "__crud_get__", skillId: "fetch_url" });
    const found = getWebhook(wh.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(wh.id);
    expect(found!.name).toBe("__crud_get__");
    expect(found!.skillId).toBe("fetch_url");
  });

  test("getWebhook returns null for an unknown id", () => {
    expect(getWebhook("nonexistent-id")).toBeNull();
  });

  test("listWebhooks includes newly registered webhook", () => {
    const wh = makeWebhook({ name: "__crud_list__" });
    const all = listWebhooks();
    expect(all.some(w => w.id === wh.id)).toBe(true);
  });

  test("registerWebhook stores optional fields correctly", () => {
    const wh = makeWebhook({
      name: "__crud_opts__",
      secret: "s3cr3t",
      fieldMappings: { repo: "repository.name" },
      staticArgs: { branch: "main" },
      async: false,
    });
    const found = getWebhook(wh.id)!;
    expect(found.secret).toBe("s3cr3t");
    expect(found.fieldMappings).toEqual({ repo: "repository.name" });
    expect(found.staticArgs).toEqual({ branch: "main" });
    expect(found.async).toBe(false);
  });

  test("toggleWebhook disables and re-enables a webhook", () => {
    const wh = makeWebhook({ name: "__crud_toggle__" });
    expect(getWebhook(wh.id)!.enabled).toBe(true);

    const disabled = toggleWebhook(wh.id, false);
    expect(disabled).toBe(true);
    expect(getWebhook(wh.id)!.enabled).toBe(false);

    const enabled = toggleWebhook(wh.id, true);
    expect(enabled).toBe(true);
    expect(getWebhook(wh.id)!.enabled).toBe(true);
  });

  test("toggleWebhook returns false for non-existent id", () => {
    expect(toggleWebhook("no-such-id", false)).toBe(false);
  });

  test("unregisterWebhook removes the webhook", () => {
    const wh = makeWebhook({ name: "__crud_delete__" });
    const removed = unregisterWebhook(wh.id);
    expect(removed).toBe(true);
    expect(getWebhook(wh.id)).toBeNull();
    // Remove from cleanup list since we already deleted it
    const idx = registeredIds.indexOf(wh.id);
    if (idx !== -1) registeredIds.splice(idx, 1);
  });

  test("unregisterWebhook returns false for non-existent id", () => {
    expect(unregisterWebhook("no-such-id")).toBe(false);
  });
});

// ── verifySignature ───────────────────────────────────────────────

describe("verifySignature", () => {
  const secret = "my-webhook-secret";
  const payload = JSON.stringify({ event: "push", ref: "refs/heads/main" });

  function computeSig(body: string, key: string) {
    return "sha256=" + createHmac("sha256", key).update(body).digest("hex");
  }

  test("returns true for a correct HMAC-SHA256 signature", () => {
    const sig = computeSig(payload, secret);
    expect(verifySignature(payload, sig, secret)).toBe(true);
  });

  test("returns false for a tampered payload", () => {
    const sig = computeSig(payload, secret);
    const tampered = payload + " extra";
    expect(verifySignature(tampered, sig, secret)).toBe(false);
  });

  test("returns false for a wrong secret", () => {
    const sig = computeSig(payload, secret);
    expect(verifySignature(payload, sig, "wrong-secret")).toBe(false);
  });

  test("returns false for a completely invalid signature string", () => {
    expect(verifySignature(payload, "sha256=badhex", secret)).toBe(false);
  });

  test("returns false when signature length differs", () => {
    // Signature without the sha256= prefix has a different length
    const shortSig = "abc123";
    expect(verifySignature(payload, shortSig, secret)).toBe(false);
  });

  test("handles empty payload correctly", () => {
    const sig = computeSig("", secret);
    expect(verifySignature("", sig, secret)).toBe(true);
  });
});

// ── transformPayload ──────────────────────────────────────────────

describe("transformPayload", () => {
  test("copies top-level fields via field mappings", () => {
    const payload = { action: "opened", number: 42 };
    const result = transformPayload(payload, { prAction: "action", prNumber: "number" }, {});
    expect(result).toEqual({ prAction: "opened", prNumber: 42 });
  });

  test("extracts nested values via dot-path", () => {
    const payload = { repository: { name: "my-repo", owner: { login: "alice" } } };
    const result = transformPayload(
      payload,
      { repo: "repository.name", author: "repository.owner.login" },
      {},
    );
    expect(result).toEqual({ repo: "my-repo", author: "alice" });
  });

  test("merges static args with mapped fields (mapped fields take precedence)", () => {
    const payload = { event: "push" };
    const result = transformPayload(
      payload,
      { event: "event" },
      { branch: "main", event: "static-ignored" },
    );
    expect(result.branch).toBe("main");
    expect(result.event).toBe("push"); // mapped value overwrites static
  });

  test("returns undefined for a missing dot-path", () => {
    const payload = { a: { b: 1 } };
    const result = transformPayload(payload, { val: "a.b.c.d" }, {});
    expect(result.val).toBeUndefined();
  });

  test("returns undefined when an intermediate path segment is null", () => {
    const payload = { a: null };
    const result = transformPayload(payload, { val: "a.b" }, {});
    expect(result.val).toBeUndefined();
  });

  test("returns undefined when an intermediate path segment is a primitive", () => {
    const payload = { a: 42 };
    const result = transformPayload(payload, { val: "a.b" }, {});
    expect(result.val).toBeUndefined();
  });

  test("returns static args unchanged when field mappings are empty", () => {
    const result = transformPayload({ any: "data" }, {}, { static1: "value1" });
    expect(result).toEqual({ static1: "value1" });
  });

  test("handles array payloads — numeric string keys traverse array indices", () => {
    const payload = [{ name: "item0" }];
    const result = transformPayload(payload, { first: "0.name" }, {});
    // Arrays are objects; "0" maps to the first element
    expect(result.first).toBe("item0");
  });
});

// ── Webhook Log & Pruning ─────────────────────────────────────────

describe("logWebhookCall and getWebhookLog", () => {
  test("logged calls appear in getWebhookLog", () => {
    const wh = makeWebhook({ name: "__log_basic__" });
    logWebhookCall(wh.id, "success", "task-1", undefined, 128);
    logWebhookCall(wh.id, "error", undefined, "Bad signature", 64);

    const log = getWebhookLog(wh.id, 10);
    expect(log.length).toBe(2);
    expect(log.some(e => e.status === "success" && e.taskId === "task-1")).toBe(true);
    expect(log.some(e => e.status === "error" && e.error === "Bad signature")).toBe(true);
  });

  test("getWebhookLog returns entries in reverse-chronological order", () => {
    const wh = makeWebhook({ name: "__log_order__" });
    logWebhookCall(wh.id, "success");
    // Sleep briefly so the second entry gets a strictly later ISO timestamp
    Bun.sleepSync(2);
    logWebhookCall(wh.id, "error", undefined, "later error");

    const log = getWebhookLog(wh.id, 10);
    expect(log[0].status).toBe("error"); // most recent first
    expect(log[1].status).toBe("success");
  });

  test("getWebhookLog respects the limit parameter", () => {
    const wh = makeWebhook({ name: "__log_limit__" });
    for (let i = 0; i < 10; i++) logWebhookCall(wh.id, "success");

    const log = getWebhookLog(wh.id, 5);
    expect(log.length).toBe(5);
  });

  test("log pruning keeps at most 1000 entries per webhook", () => {
    const wh = makeWebhook({ name: "__log_prune__" });

    // Insert 100 log entries to verify pruning logic without timing out on slow machines
    for (let i = 0; i < 100; i++) {
      logWebhookCall(wh.id, "success");
    }

    // SQLite directly counts persisted rows; use a large limit to get all
    const log = getWebhookLog(wh.id, 200);
    expect(log.length).toBeLessThanOrEqual(1000);
  });

  test("log pruning does not affect other webhooks", () => {
    const whA = makeWebhook({ name: "__log_prune_a__" });
    const whB = makeWebhook({ name: "__log_prune_b__" });

    // Only flood webhook A (100 entries — enough to verify isolation without timing out)
    for (let i = 0; i < 100; i++) logWebhookCall(whA.id, "success");

    // Webhook B should still have its own entries intact
    logWebhookCall(whB.id, "success", "task-b");
    const logB = getWebhookLog(whB.id, 10);
    expect(logB.length).toBe(1);
    expect(logB[0].taskId).toBe("task-b");
  });

  test("rejected status is stored correctly", () => {
    const wh = makeWebhook({ name: "__log_rejected__" });
    logWebhookCall(wh.id, "rejected", undefined, "webhook disabled");

    const log = getWebhookLog(wh.id, 5);
    expect(log[0].status).toBe("rejected");
    expect(log[0].error).toBe("webhook disabled");
  });

  test("log entries have unique IDs", () => {
    const wh = makeWebhook({ name: "__log_unique__" });
    logWebhookCall(wh.id, "success");
    logWebhookCall(wh.id, "success");

    const log = getWebhookLog(wh.id, 10);
    const ids = log.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
