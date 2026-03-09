import { describe, test, expect, beforeEach } from "bun:test";
import { recordSkillCall, getMetricsSnapshot, resetMetrics, startSkillTimer, registerWorkerMetric } from "../metrics.js";

describe("Metrics", () => {
  beforeEach(() => {
    resetMetrics();
  });

  test("recordSkillCall tracks calls", () => {
    recordSkillCall("ask_claude", "ai-agent", 150);
    recordSkillCall("ask_claude", "ai-agent", 200);
    recordSkillCall("run_shell", "shell-agent", 50);

    const snapshot = getMetricsSnapshot();
    expect(snapshot.system.totalCalls).toBe(3);
    expect(snapshot.system.totalErrors).toBe(0);
    expect(snapshot.skills.length).toBe(2);
  });

  test("tracks errors", () => {
    recordSkillCall("fetch_url", "web-agent", 100);
    recordSkillCall("fetch_url", "web-agent", 500, "timeout");
    recordSkillCall("fetch_url", "web-agent", 200);

    const snapshot = getMetricsSnapshot();
    const fetchMetric = snapshot.skills.find(s => s.skillId === "fetch_url");
    expect(fetchMetric).toBeDefined();
    expect(fetchMetric!.calls).toBe(3);
    expect(fetchMetric!.errors).toBe(1);
    expect(fetchMetric!.errorRate).toBe("33.3%");
  });

  test("computes latency percentiles", () => {
    for (let i = 1; i <= 100; i++) {
      recordSkillCall("test_skill", "test-worker", i);
    }

    const snapshot = getMetricsSnapshot();
    const metric = snapshot.skills.find(s => s.skillId === "test_skill");
    expect(metric).toBeDefined();
    expect(metric!.latency.p50).toBe(50);
    expect(metric!.latency.p95).toBe(95);
    expect(metric!.latency.p99).toBe(99);
    expect(metric!.latency.max).toBe(100);
  });

  test("startSkillTimer measures duration", async () => {
    const endTimer = startSkillTimer("timed_skill", "test-worker");
    await new Promise(r => setTimeout(r, 20));
    endTimer();

    const snapshot = getMetricsSnapshot();
    const metric = snapshot.skills.find(s => s.skillId === "timed_skill");
    expect(metric).toBeDefined();
    expect(metric!.calls).toBe(1);
    expect(metric!.latency.p50).toBeGreaterThanOrEqual(15);
  });

  test("registerWorkerMetric initializes worker", () => {
    registerWorkerMetric("test-worker", "http://localhost:9999");
    const snapshot = getMetricsSnapshot();
    const worker = snapshot.workers.find(w => w.name === "test-worker");
    expect(worker).toBeDefined();
    expect(worker!.url).toBe("http://localhost:9999");
    expect(worker!.totalCalls).toBe(0);
  });

  test("skills sorted by call count", () => {
    recordSkillCall("low", "w1", 10);
    for (let i = 0; i < 5; i++) recordSkillCall("high", "w2", 10);
    for (let i = 0; i < 3; i++) recordSkillCall("mid", "w3", 10);

    const snapshot = getMetricsSnapshot();
    expect(snapshot.skills[0].skillId).toBe("high");
    expect(snapshot.skills[1].skillId).toBe("mid");
    expect(snapshot.skills[2].skillId).toBe("low");
  });
});
