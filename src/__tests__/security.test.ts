import { describe, test, expect, beforeAll } from "bun:test";
import { AgentError } from "../errors.js";
import { isAllowedUrl, configureAllowedUrls } from "../url-validation.js";
import { safeName } from "../memory.js";

// Configure allowed ports/URLs for testing (matches default worker ports)
beforeAll(() => {
  configureAllowedUrls([8080, 8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090, 8091, 8092, 8093, 8094], []);
});

/**
 * Security-focused tests for review findings.
 * Tests URL validation, path traversal prevention, and input sanitization.
 */

describe("URL validation (SSRF prevention)", () => {
  test("allows localhost worker URLs", () => {
    expect(isAllowedUrl("http://localhost:8081")).toBe(true);
    expect(isAllowedUrl("http://localhost:8082")).toBe(true);
    expect(isAllowedUrl("http://localhost:8083")).toBe(true);
    expect(isAllowedUrl("http://localhost:8084")).toBe(true);
    expect(isAllowedUrl("http://localhost:8085")).toBe(true);
    expect(isAllowedUrl("http://localhost:8080")).toBe(true);
    expect(isAllowedUrl("http://127.0.0.1:8081")).toBe(true);
  });

  test("allows IPv6 loopback worker URLs", () => {
    expect(isAllowedUrl("http://[::1]:8081")).toBe(true);
    expect(isAllowedUrl("http://[::1]:8082")).toBe(true);
    expect(isAllowedUrl("http://[::ffff:127.0.0.1]:8081")).toBe(true);
    expect(isAllowedUrl("http://[::ffff:127.0.0.1]:8082")).toBe(true);
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

  test("blocks IPv6 loopback on non-worker ports", () => {
    expect(isAllowedUrl("http://[::1]:22")).toBe(false);
    expect(isAllowedUrl("http://[::1]:3000")).toBe(false);
    expect(isAllowedUrl("http://[::ffff:127.0.0.1]:9090")).toBe(false);
    expect(isAllowedUrl("http://[::ffff:127.0.0.1]:80")).toBe(false);
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
