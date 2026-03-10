import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, openSync, writeSync, closeSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Point the tee directory at a temp folder so tests are isolated
let tempDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tee-test-"));
  origHome = process.env.HOME;
  process.env.HOME = tempDir;
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("readTee", () => {
  test("reads a valid tee file", async () => {
    // Dynamic import so HOME override is picked up
    const { teeOutput, readTee } = await import("../tee.js");
    const content = "hello world";
    const filePath = teeOutput(content, "test_skill");
    const result = readTee(filePath);
    expect(result).toBe(content);
  });

  test("returns error for missing file", async () => {
    const { readTee } = await import("../tee.js");
    const missingPath = join(tempDir, ".a2a-mcp", "tee", "nonexistent.txt");
    const result = readTee(missingPath);
    expect(result).toMatch(/Error: file not found/);
  });

  test("returns error for path outside tee directory", async () => {
    const { readTee } = await import("../tee.js");
    const result = readTee("/etc/passwd");
    expect(result).toMatch(/Error: path must be within/);
  });

  test("returns error when file exceeds 10 MB size limit", async () => {
    const { readTee } = await import("../tee.js");
    const teeDir = join(tempDir, ".a2a-mcp", "tee");
    mkdirSync(teeDir, { recursive: true });
    const bigFile = join(teeDir, "big.txt");
    // Write 11 MB of data
    const chunk = Buffer.alloc(1024 * 1024, "x"); // 1 MB
    const fd = openSync(bigFile, "w");
    for (let i = 0; i < 11; i++) {
      writeSync(fd, chunk);
    }
    closeSync(fd);

    const result = readTee(bigFile);
    expect(result).toMatch(/Error: file too large to read/);
    expect(result).toMatch(/KB/);
  });
});
