import { describe, test, expect, beforeEach } from "bun:test";
import { CircuitBreaker, CircuitOpenError, getBreaker, getAllBreakerStats, resetAllBreakers } from "../circuit-breaker.js";

describe("CircuitBreaker", () => {
  test("starts in closed state", () => {
    const breaker = new CircuitBreaker("test-closed");
    expect(breaker.currentState).toBe("closed");
  });

  test("stays closed on successful calls", async () => {
    const breaker = new CircuitBreaker("test-success");
    await breaker.call(async () => "ok");
    await breaker.call(async () => "ok");
    expect(breaker.currentState).toBe("closed");
    expect(breaker.stats.totalSuccess).toBe(2);
  });

  test("opens after failure threshold", async () => {
    const breaker = new CircuitBreaker("test-failure", { failureThreshold: 3, cooldownMs: 1000 });

    for (let i = 0; i < 3; i++) {
      try { await breaker.call(async () => { throw new Error("fail"); }); } catch {}
    }

    expect(breaker.currentState).toBe("open");
    expect(breaker.stats.totalFailure).toBe(3);
  });

  test("rejects calls when open", async () => {
    const breaker = new CircuitBreaker("test-reject", { failureThreshold: 2, cooldownMs: 60_000 });

    for (let i = 0; i < 2; i++) {
      try { await breaker.call(async () => { throw new Error("fail"); }); } catch {}
    }

    expect(breaker.currentState).toBe("open");
    try {
      await breaker.call(async () => "should not run");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof CircuitOpenError).toBe(true);
    }
    expect(breaker.stats.totalRejected).toBe(1);
  });

  test("transitions to half_open after cooldown", async () => {
    const breaker = new CircuitBreaker("test-halfopen", { failureThreshold: 2, cooldownMs: 50 });

    for (let i = 0; i < 2; i++) {
      try { await breaker.call(async () => { throw new Error("fail"); }); } catch {}
    }
    expect(breaker.currentState).toBe("open");

    // Wait for cooldown
    await new Promise(r => setTimeout(r, 60));

    // Next call should go through (half_open state)
    const result = await breaker.call(async () => "recovered");
    expect(result).toBe("recovered");
  });

  test("reset brings breaker back to closed", async () => {
    const breaker = new CircuitBreaker("test-reset", { failureThreshold: 2 });

    for (let i = 0; i < 2; i++) {
      try { await breaker.call(async () => { throw new Error("fail"); }); } catch {}
    }
    expect(breaker.currentState).toBe("open");

    breaker.reset();
    expect(breaker.currentState).toBe("closed");
  });

  test("stats tracks all metrics", async () => {
    const breaker = new CircuitBreaker("test-stats", { failureThreshold: 5 });
    await breaker.call(async () => "ok");
    try { await breaker.call(async () => { throw new Error("fail"); }); } catch {}
    await breaker.call(async () => "ok");

    const stats = breaker.stats;
    expect(stats.totalCalls).toBe(3);
    expect(stats.totalSuccess).toBe(2);
    expect(stats.totalFailure).toBe(1);
    expect(stats.state).toBe("closed");
  });
});

describe("getBreaker / getAllBreakerStats", () => {
  test("getBreaker returns singleton", () => {
    const b1 = getBreaker("singleton-test");
    const b2 = getBreaker("singleton-test");
    expect(b1).toBe(b2);
  });

  test("getAllBreakerStats returns all breakers", () => {
    getBreaker("stats-a");
    getBreaker("stats-b");
    const stats = getAllBreakerStats();
    expect("stats-a" in stats).toBe(true);
    expect("stats-b" in stats).toBe(true);
  });
});
