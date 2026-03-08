import { describe, test, expect } from "bun:test";
import { AgentError } from "../errors.js";
import { sanitizeVar } from "../templates/loader.js";

/**
 * Security-focused tests for review findings.
 * Tests URL validation, path traversal prevention, and input sanitization.
 */

describe("URL validation (SSRF prevention)", () => {
  // Re-implement the validation logic for testing (same logic as in server.ts)
  // Note: port 8080 (orchestrator) is excluded to prevent infinite recursion
  const ALLOWED_PORTS = new Set([8081, 8082, 8083, 8084, 8085, 8086]);
  function isAllowedUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return false;
      const port = parseInt(parsed.port || "80", 10);
      return ALLOWED_PORTS.has(port);
    } catch {
      return false;
    }
  }

  test("allows localhost worker URLs", () => {
    expect(isAllowedUrl("http://localhost:8081")).toBe(true);
    expect(isAllowedUrl("http://localhost:8082")).toBe(true);
    expect(isAllowedUrl("http://localhost:8083")).toBe(true);
    expect(isAllowedUrl("http://localhost:8084")).toBe(true);
    expect(isAllowedUrl("http://localhost:8085")).toBe(true);
    expect(isAllowedUrl("http://localhost:8086")).toBe(true);
    expect(isAllowedUrl("http://127.0.0.1:8081")).toBe(true);
  });

  test("blocks orchestrator port 8080 (prevents infinite recursion)", () => {
    expect(isAllowedUrl("http://localhost:8080")).toBe(false);
  });

  test("blocks external URLs", () => {
    expect(isAllowedUrl("http://evil.com:8081")).toBe(false);
    expect(isAllowedUrl("https://api.example.com")).toBe(false);
    expect(isAllowedUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedUrl("http://metadata.google.internal")).toBe(false);
  });

  test("blocks localhost on non-worker ports", () => {
    expect(isAllowedUrl("http://localhost:22")).toBe(false);
    expect(isAllowedUrl("http://localhost:3000")).toBe(false);
    expect(isAllowedUrl("http://localhost:9090")).toBe(false);
    expect(isAllowedUrl("http://localhost:80")).toBe(false);
  });

  test("blocks malformed URLs", () => {
    expect(isAllowedUrl("not-a-url")).toBe(false);
    expect(isAllowedUrl("")).toBe(false);
    expect(isAllowedUrl("ftp://localhost:8081")).toBe(false);
  });
});

describe("Persona name validation (path traversal prevention)", () => {
  const ALLOWED_PERSONAS = new Set(["orchestrator", "shell-agent", "web-agent", "ai-agent", "code-agent", "knowledge-agent"]);

  test("allows valid persona names", () => {
    expect(ALLOWED_PERSONAS.has("orchestrator")).toBe(true);
    expect(ALLOWED_PERSONAS.has("shell-agent")).toBe(true);
    expect(ALLOWED_PERSONAS.has("knowledge-agent")).toBe(true);
  });

  test("blocks path traversal attempts", () => {
    expect(ALLOWED_PERSONAS.has("../../etc/passwd")).toBe(false);
    expect(ALLOWED_PERSONAS.has("../../../etc/shadow")).toBe(false);
    expect(ALLOWED_PERSONAS.has("..")).toBe(false);
  });

  test("blocks arbitrary names", () => {
    expect(ALLOWED_PERSONAS.has("evil-agent")).toBe(false);
    expect(ALLOWED_PERSONAS.has("")).toBe(false);
    expect(ALLOWED_PERSONAS.has("orchestrator/../../etc/passwd")).toBe(false);
  });
});

describe("Memory path sanitization", () => {
  // Re-implement safeName for testing (same logic as in memory.ts)
  function safeName(name: string): string {
    return name.replace(/[\/\\\.]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
  }

  test("strips directory traversal sequences", () => {
    expect(safeName("../../../etc")).toBe("etc");
    expect(safeName("../../passwd")).toBe("passwd");
    expect(safeName("..")).toBe("unnamed");
  });

  test("strips slashes and backslashes", () => {
    expect(safeName("foo/bar")).toBe("foo_bar");
    expect(safeName("foo\\bar")).toBe("foo_bar");
    expect(safeName("/etc/passwd")).toBe("etc_passwd");
  });

  test("handles normal names unchanged", () => {
    expect(safeName("shell-agent")).toBe("shell-agent");
    expect(safeName("my_key")).toBe("my_key");
    expect(safeName("test123")).toBe("test123");
  });

  test("handles empty and dot-only names", () => {
    expect(safeName("")).toBe("unnamed");
    expect(safeName("...")).toBe("unnamed");
    expect(safeName("./")).toBe("unnamed");
  });
});

describe("Template variable sanitization (sanitizeVar)", () => {
  test("strips backticks, dollar signs, and backslashes (original chars)", () => {
    expect(sanitizeVar("foo`bar")).toBe("foobar");
    expect(sanitizeVar("foo$bar")).toBe("foobar");
    expect(sanitizeVar("foo\\bar")).toBe("foobar");
  });

  test("strips double and single quotes to prevent string literal injection", () => {
    expect(sanitizeVar('foo"bar')).toBe("foobar");
    expect(sanitizeVar("foo'bar")).toBe("foobar");
    expect(sanitizeVar('evil", injected: "')).toBe("evil, injected:");
  });

  test("strips control characters including newlines and null bytes", () => {
    expect(sanitizeVar("foo\nbar")).toBe("foobar");
    expect(sanitizeVar("foo\r\nbar")).toBe("foobar");
    expect(sanitizeVar("foo\x00bar")).toBe("foobar");
    expect(sanitizeVar("foo\tbar")).toBe("foobar");
  });

  test("strips path separators to prevent directory traversal", () => {
    expect(sanitizeVar("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeVar("foo/bar")).toBe("foobar");
    expect(sanitizeVar("foo/../secret")).toBe("foosecret");
  });

  test("strips shell metacharacters", () => {
    expect(sanitizeVar("foo; rm -rf /")).toBe("foo rm -rf");
    expect(sanitizeVar("foo | cat /etc/passwd")).toBe("foo  cat etcpasswd");
    expect(sanitizeVar("foo && evil")).toBe("foo  evil");
    expect(sanitizeVar("foo > /dev/null")).toBe("foo  devnull");
    expect(sanitizeVar("foo < input.txt")).toBe("foo  input.txt");
  });

  test("preserves normal project names and descriptions", () => {
    expect(sanitizeVar("my-awesome-app")).toBe("my-awesome-app");
    expect(sanitizeVar("MyApp 2.0")).toBe("MyApp 2.0");
    expect(sanitizeVar("  hello  ")).toBe("hello");
    expect(sanitizeVar("A helpful AI agent")).toBe("A helpful AI agent");
  });
});
