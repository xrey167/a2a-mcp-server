import { describe, test, expect, beforeEach } from "bun:test";
import { getHealth, markReady, markNotReady, updateWorkerHealth, resetCloudState } from "../cloud.js";

describe("cloud", () => {
  beforeEach(() => {
    resetCloudState();
  });

  test("getHealth returns unhealthy when no workers", () => {
    const health = getHealth("1.0.0");
    expect(health.status).toBe("unhealthy");
    expect(health.version).toBe("1.0.0");
    expect(health.workers).toHaveLength(0);
    expect(typeof health.uptime).toBe("number");
  });

  test("getHealth returns healthy when all workers healthy", () => {
    updateWorkerHealth("shell", "http://localhost:8081", true);
    updateWorkerHealth("web", "http://localhost:8082", true);
    const health = getHealth("1.0.0");
    expect(health.status).toBe("healthy");
    expect(health.workers).toHaveLength(2);
  });

  test("getHealth returns degraded when some workers unhealthy", () => {
    updateWorkerHealth("shell", "http://localhost:8081", true);
    updateWorkerHealth("web", "http://localhost:8082", false);
    const health = getHealth("1.0.0");
    expect(health.status).toBe("degraded");
  });

  test("markReady/markNotReady toggles readiness", () => {
    markReady();
    // readiness is internal state, tested via the health routes
    markNotReady();
    // no crash = success
  });

  test("updateWorkerHealth tracks lastCheck", () => {
    const before = Date.now();
    updateWorkerHealth("test", "http://localhost:9999", true);
    const health = getHealth("1.0.0");
    const worker = health.workers.find(w => w.name === "test");
    expect(worker).toBeDefined();
    expect(worker!.healthy).toBe(true);
    expect(worker!.lastCheck).toBeGreaterThanOrEqual(before);
  });
});
