import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createLogger } from "../logger.js";

describe("createLogger", () => {
  let captured: string[] = [];
  const originalWrite = process.stderr.write;

  beforeEach(() => {
    captured = [];
    process.stderr.write = ((chunk: any) => {
      captured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as any;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  test("creates logger with all levels", () => {
    const log = createLogger("test-worker");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  test("info writes JSON to stderr", () => {
    const log = createLogger("test-worker");
    log.info("hello world");
    expect(captured.length).toBe(1);
    const entry = JSON.parse(captured[0]);
    expect(entry.level).toBe("info");
    expect(entry.worker).toBe("test-worker");
    expect(entry.msg).toBe("hello world");
    expect(entry.ts).toBeDefined();
  });

  test("includes metadata in log entry", () => {
    const log = createLogger("test-worker");
    log.warn("slow query", { durationMs: 500, query: "SELECT *" });
    const entry = JSON.parse(captured[0]);
    expect(entry.level).toBe("warn");
    expect(entry.durationMs).toBe(500);
    expect(entry.query).toBe("SELECT *");
  });

  test("error level always logs", () => {
    const log = createLogger("test-worker");
    log.error("fatal crash", { code: 1 });
    expect(captured.length).toBe(1);
    const entry = JSON.parse(captured[0]);
    expect(entry.level).toBe("error");
  });
});
