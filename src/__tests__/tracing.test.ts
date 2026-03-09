import { describe, test, expect, beforeEach } from "bun:test";
import { startTrace, getTrace, listTraces, getWaterfall, searchTraces, getTracingStats, resetTracing } from "../tracing.js";

beforeEach(() => resetTracing());

describe("Tracing", () => {
  test("startTrace creates a trace", () => {
    const trace = startTrace("test-op", { foo: "bar" });
    expect(trace.traceId).toBeDefined();
    expect(trace.rootSpan.operationName).toBe("test-op");
    expect(trace.metadata).toEqual({ foo: "bar" });
  });

  test("child spans", () => {
    const trace = startTrace("parent");
    const child = trace.startSpan("child-1");
    child.setTag("worker", "shell").end();
    const child2 = trace.startSpan("child-2");
    child2.end("error");
    trace.end();

    const waterfall = getWaterfall(trace.traceId);
    expect(waterfall).toHaveLength(3); // root + 2 children
    expect(waterfall[0].operationName).toBe("parent");
    expect(waterfall[1].operationName).toBe("child-1");
    expect(waterfall[1].tags.worker).toBe("shell");
    expect(waterfall[2].status).toBe("error");
  });

  test("nested spans", () => {
    const trace = startTrace("root");
    const child = trace.startSpan("level-1");
    const grandchild = child.startSpan("level-2");
    grandchild.end();
    child.end();
    trace.end();

    const waterfall = getWaterfall(trace.traceId);
    expect(waterfall).toHaveLength(3);
    expect(waterfall[2].depth).toBe(2);
  });

  test("listTraces shows recent traces", () => {
    startTrace("op-1").end();
    startTrace("op-2").end();
    startTrace("op-3").end();
    const traces = listTraces(2);
    expect(traces).toHaveLength(2);
    expect(traces[0].operationName).toBe("op-3"); // most recent first
  });

  test("searchTraces finds by operation name", () => {
    startTrace("search-target").end();
    startTrace("other-op").end();
    const results = searchTraces("target");
    expect(results).toHaveLength(1);
  });

  test("searchTraces finds by tag", () => {
    const trace = startTrace("tagged-op");
    trace.startSpan("inner").setTag("skillId", "ask_claude").end();
    trace.end();
    const results = searchTraces("ask_claude");
    expect(results).toHaveLength(1);
  });

  test("span events", () => {
    const trace = startTrace("with-events");
    const span = trace.startSpan("my-span");
    span.addEvent("cache-miss", { key: "abc" });
    span.addEvent("retry", { attempt: 1 });
    span.end();
    trace.end();

    const retrieved = getTrace(trace.traceId);
    expect(retrieved?.rootSpan.children[0].events).toHaveLength(2);
  });

  test("stats", () => {
    startTrace("a").end();
    startTrace("b").end("error");
    const stats = getTracingStats();
    expect(stats.activeTraces).toBe(2);
    expect(stats.totalSpans).toBe(2);
  });
});
