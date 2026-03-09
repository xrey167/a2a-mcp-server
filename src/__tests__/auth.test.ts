import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApiKey, validateApiKey, isSkillAllowed, revokeApiKey, listApiKeys, getRolePermissions } from "../auth.js";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const AUTH_FILE = join(process.env.HOME ?? homedir(), ".a2a-mcp", "auth.json");

describe("auth", () => {
  let originalFile: string | null = null;

  beforeEach(() => {
    // Back up existing auth file
    if (existsSync(AUTH_FILE)) {
      originalFile = require("fs").readFileSync(AUTH_FILE, "utf-8");
    }
    // Ensure dir exists
    const dir = join(process.env.HOME ?? homedir(), ".a2a-mcp");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Clean slate
    if (existsSync(AUTH_FILE)) unlinkSync(AUTH_FILE);
  });

  afterEach(() => {
    // Restore original
    if (originalFile) {
      require("fs").writeFileSync(AUTH_FILE, originalFile);
    } else if (existsSync(AUTH_FILE)) {
      unlinkSync(AUTH_FILE);
    }
  });

  test("createApiKey returns a key starting with a2a_k_", () => {
    const { key, entry } = createApiKey("test-key", "admin");
    expect(key).toMatch(/^a2a_k_/);
    expect(entry.name).toBe("test-key");
    expect(entry.role).toBe("admin");
    expect(entry.prefix).toBe(key.slice(0, 12));
  });

  test("validateApiKey returns entry for valid key", () => {
    const { key } = createApiKey("valid-key", "operator");
    const entry = validateApiKey(key);
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("valid-key");
    expect(entry!.role).toBe("operator");
  });

  test("validateApiKey returns null for invalid key", () => {
    expect(validateApiKey("a2a_k_invalid")).toBeNull();
  });

  test("validateApiKey returns null for expired key", () => {
    const { key } = createApiKey("expired", "admin", { ttlMs: -1000 });
    expect(validateApiKey(key)).toBeNull();
  });

  test("isSkillAllowed respects admin role", () => {
    const { key } = createApiKey("admin", "admin");
    const entry = validateApiKey(key)!;
    expect(isSkillAllowed(entry, "anything")).toBe(true);
    expect(isSkillAllowed(entry, "sandbox_execute")).toBe(true);
  });

  test("isSkillAllowed respects viewer role", () => {
    const { key } = createApiKey("viewer", "viewer");
    const entry = validateApiKey(key)!;
    expect(isSkillAllowed(entry, "delegate")).toBe(true);
    expect(isSkillAllowed(entry, "get_metrics")).toBe(true);
    expect(isSkillAllowed(entry, "sandbox_execute")).toBe(false);
  });

  test("isSkillAllowed respects allowedSkills whitelist", () => {
    const { key } = createApiKey("limited", "operator", { allowedSkills: ["delegate", "list_agents"] });
    const entry = validateApiKey(key)!;
    expect(isSkillAllowed(entry, "delegate")).toBe(true);
    expect(isSkillAllowed(entry, "sandbox_execute")).toBe(false);
  });

  test("isSkillAllowed respects deniedSkills blocklist", () => {
    const { key } = createApiKey("blocked", "operator", { deniedSkills: ["sandbox_execute"] });
    const entry = validateApiKey(key)!;
    expect(isSkillAllowed(entry, "delegate")).toBe(true);
    expect(isSkillAllowed(entry, "sandbox_execute")).toBe(false);
  });

  test("revokeApiKey removes the key", () => {
    const { key, entry } = createApiKey("to-revoke", "admin");
    expect(revokeApiKey(entry.prefix)).toBe(true);
    expect(validateApiKey(key)).toBeNull();
  });

  test("revokeApiKey by name", () => {
    createApiKey("named-key", "viewer");
    expect(revokeApiKey("named-key")).toBe(true);
    expect(listApiKeys()).toHaveLength(0);
  });

  test("listApiKeys returns entries without keyHash", () => {
    createApiKey("key1", "admin");
    createApiKey("key2", "viewer");
    const keys = listApiKeys();
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect((k as any).keyHash).toBeUndefined();
    }
  });

  test("getRolePermissions returns all roles", () => {
    const perms = getRolePermissions();
    expect(perms.admin).toContain("*");
    expect(perms.viewer).toContain("delegate");
    expect(perms.operator).toContain("sandbox_execute");
  });
});
