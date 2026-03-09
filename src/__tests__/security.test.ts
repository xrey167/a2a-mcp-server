import { describe, test, expect } from "bun:test";
import { AgentError } from "../errors.js";
import { sanitizePath, sanitizeRelativePath } from "../path-utils.js";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

describe("URL validation with remote worker whitelist", () => {
  // Updated validation logic matching server.ts: supports configured remote URLs
  const ALLOWED_PORTS = new Set([8081, 8082, 8083]);
  const ALLOWED_REMOTE_URLS = new Set(["https://agent.example.com", "http://192.168.1.100:9090"]);

  function isAllowedUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
        const port = parseInt(parsed.port || "80", 10);
        return ALLOWED_PORTS.has(port);
      }
      const origin = parsed.origin;
      for (const allowed of ALLOWED_REMOTE_URLS) {
        try { if (new URL(allowed).origin === origin) return true; } catch {}
      }
      return false;
    } catch { return false; }
  }

  test("allows configured remote URLs", () => {
    expect(isAllowedUrl("https://agent.example.com")).toBe(true);
    expect(isAllowedUrl("https://agent.example.com/a2a")).toBe(true);
    expect(isAllowedUrl("http://192.168.1.100:9090")).toBe(true);
    expect(isAllowedUrl("http://192.168.1.100:9090/healthz")).toBe(true);
  });

  test("blocks non-whitelisted remote URLs", () => {
    expect(isAllowedUrl("https://evil.example.com")).toBe(false);
    expect(isAllowedUrl("http://192.168.1.100:9091")).toBe(false);
    expect(isAllowedUrl("http://192.168.1.101:9090")).toBe(false);
  });

  test("still allows localhost on allowed ports", () => {
    expect(isAllowedUrl("http://localhost:8081")).toBe(true);
  });

  test("still blocks cloud metadata endpoints", () => {
    expect(isAllowedUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedUrl("http://metadata.google.internal")).toBe(false);
  });

  test("origin matching ignores path/query/fragment", () => {
    expect(isAllowedUrl("https://agent.example.com/foo?bar=1#baz")).toBe(true);
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

describe("File path sanitization (write_file security)", () => {
  test("allows safe alphanumeric paths", () => {
    expect(() => sanitizePath("file.txt")).not.toThrow();
    expect(() => sanitizePath("src/index.ts")).not.toThrow();
    expect(() => sanitizePath("my-project/src/app.js")).not.toThrow();
    expect(() => sanitizePath("~/Documents/test.txt")).not.toThrow();
    expect(() => sanitizePath("path/to/file_name.json")).not.toThrow();
  });

  test("rejects path traversal with ..", () => {
    expect(() => sanitizePath("../etc/passwd")).toThrow("path contains '..'");
    expect(() => sanitizePath("../../etc/shadow")).toThrow("path contains '..'");
    expect(() => sanitizePath("src/../../../etc/passwd")).toThrow("path contains '..'");
    expect(() => sanitizePath("..")).toThrow("path contains '..'");
    expect(() => sanitizePath("./..")).toThrow("path contains '..'");
    expect(() => sanitizePath("valid/../../invalid")).toThrow("path contains '..'");
  });

  test("rejects paths with shell metacharacters", () => {
    expect(() => sanitizePath("file;rm -rf /")).toThrow("disallowed characters");
    expect(() => sanitizePath("file|cat /etc/passwd")).toThrow("disallowed characters");
    expect(() => sanitizePath("file&whoami")).toThrow("disallowed characters");
    expect(() => sanitizePath("file$HOME")).toThrow("disallowed characters");
    expect(() => sanitizePath("file`id`")).toThrow("disallowed characters");
    expect(() => sanitizePath("file$(whoami)")).toThrow("disallowed characters");
    expect(() => sanitizePath("file\nmalicious")).toThrow("disallowed characters");
    expect(() => sanitizePath("file\rmalicious")).toThrow("disallowed characters");
  });

  test("rejects paths with spaces and special characters", () => {
    expect(() => sanitizePath("file name.txt")).toThrow("disallowed characters");
    expect(() => sanitizePath("path with spaces/file.txt")).toThrow("disallowed characters");
    expect(() => sanitizePath("file*")).toThrow("disallowed characters");
    expect(() => sanitizePath("file?")).toThrow("disallowed characters");
    expect(() => sanitizePath("file[0]")).toThrow("disallowed characters");
    expect(() => sanitizePath("file{1}")).toThrow("disallowed characters");
  });

  test("rejects empty or invalid paths", () => {
    expect(() => sanitizePath("")).toThrow("non-empty string");
    expect(() => sanitizePath(null as any)).toThrow("non-empty string");
    expect(() => sanitizePath(undefined as any)).toThrow("non-empty string");
  });
});

describe("Relative path sanitization (LLM output security)", () => {
  let testDir: string;

  // Create a temporary test directory before each test
  function setupTestDir() {
    testDir = mkdtempSync(join(tmpdir(), "path-test-"));
  }

  // Clean up after each test
  function cleanupTestDir() {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  }

  test("allows safe relative paths within project directory", () => {
    setupTestDir();
    try {
      const result = sanitizeRelativePath("src/index.ts", testDir);
      expect(result).toContain(testDir);
      expect(result).toContain("src/index.ts");
    } finally {
      cleanupTestDir();
    }
  });

  test("blocks path traversal attempts that escape project directory", () => {
    setupTestDir();
    try {
      expect(() => sanitizeRelativePath("../../../etc/passwd", testDir)).toThrow();
      expect(() => sanitizeRelativePath("../../secrets.txt", testDir)).toThrow();
    } finally {
      cleanupTestDir();
    }
  });

  test("rejects absolute paths from LLM", () => {
    setupTestDir();
    try {
      expect(() => sanitizeRelativePath("/etc/passwd", testDir)).toThrow("absolute path");
      expect(() => sanitizeRelativePath("/tmp/malicious.sh", testDir)).toThrow("absolute path");
      expect(() => sanitizeRelativePath("/home/user/.ssh/id_rsa", testDir)).toThrow("absolute path");
    } finally {
      cleanupTestDir();
    }
  });

  test("blocks paths that resolve outside the base directory", () => {
    setupTestDir();
    try {
      // Even if the path doesn't contain .. explicitly, if it resolves outside baseDir, reject it
      expect(() => sanitizeRelativePath("src/../../../etc/passwd", testDir)).toThrow();
    } finally {
      cleanupTestDir();
    }
  });

  test("validates paths stay within nested subdirectories", () => {
    setupTestDir();
    try {
      const result1 = sanitizeRelativePath("src/components/Button.tsx", testDir);
      expect(result1).toContain(testDir);

      const result2 = sanitizeRelativePath("docs/api/reference.md", testDir);
      expect(result2).toContain(testDir);
    } finally {
      cleanupTestDir();
    }
  });

  test("rejects malicious LLM-crafted paths", () => {
    setupTestDir();
    try {
      // Common LLM attack patterns
      expect(() => sanitizeRelativePath("../../../../bin/sh", testDir)).toThrow();
      expect(() => sanitizeRelativePath("src/../../../../../../root/.ssh/authorized_keys", testDir)).toThrow();
      expect(() => sanitizeRelativePath("...//...//etc/passwd", testDir)).toThrow("'..'");
      expect(() => sanitizeRelativePath("src;rm -rf /", testDir)).toThrow("disallowed characters");
    } finally {
      cleanupTestDir();
    }
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
