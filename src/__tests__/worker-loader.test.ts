import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { discoverUserWorkers, scaffoldWorker, ensureWorkersDir } from "../worker-loader.js";

describe("worker-loader", () => {
  const origHome = process.env.HOME;
  let testHome: string;
  let workersDir: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `.a2a-worker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workersDir = join(testHome, ".a2a-mcp", "workers");
    process.env.HOME = testHome;
    mkdirSync(workersDir, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("discoverUserWorkers returns empty when no workers dir exists", () => {
    rmSync(workersDir, { recursive: true, force: true });
    const workers = discoverUserWorkers();
    expect(workers).toEqual([]);
  });

  test("discoverUserWorkers returns empty when dir is empty", () => {
    const workers = discoverUserWorkers();
    expect(workers).toEqual([]);
  });

  test("discoverUserWorkers finds workers with index.ts", () => {
    const workerDir = join(workersDir, "my-tool");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "index.ts"), "// worker code");

    const workers = discoverUserWorkers();
    expect(workers.length).toBe(1);
    expect(workers[0].name).toBe("my-tool");
    expect(workers[0].path).toContain("my-tool/index.ts");
    expect(workers[0].port).toBeGreaterThanOrEqual(8095);
  });

  test("discoverUserWorkers respects worker.json port", () => {
    const workerDir = join(workersDir, "custom-port");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "index.ts"), "// worker code");
    writeFileSync(join(workerDir, "worker.json"), JSON.stringify({ port: 9999 }));

    const workers = discoverUserWorkers();
    const found = workers.find(w => w.name === "custom-port");
    expect(found).toBeDefined();
    expect(found!.port).toBe(9999);
  });

  test("discoverUserWorkers ignores directories without index.ts", () => {
    const workerDir = join(workersDir, "no-index");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "README.md"), "# not a worker");

    const workers = discoverUserWorkers();
    expect(workers.find(w => w.name === "no-index")).toBeUndefined();
  });

  test("scaffoldWorker creates worker directory with files", () => {
    const dir = scaffoldWorker("test-worker", 8095);

    expect(existsSync(join(dir, "index.ts"))).toBe(true);
    expect(existsSync(join(dir, "worker.json"))).toBe(true);

    const config = JSON.parse(require("fs").readFileSync(join(dir, "worker.json"), "utf-8"));
    expect(config.port).toBe(8095);
    expect(config.name).toBe("test-worker");
  });

  test("scaffoldWorker throws if worker already exists", () => {
    scaffoldWorker("duplicate", 8096);
    expect(() => scaffoldWorker("duplicate", 8097)).toThrow("already exists");
  });

  test("ensureWorkersDir creates directory if missing", () => {
    rmSync(workersDir, { recursive: true, force: true });
    expect(existsSync(workersDir)).toBe(false);
    ensureWorkersDir();
    expect(existsSync(workersDir)).toBe(true);
  });
});
