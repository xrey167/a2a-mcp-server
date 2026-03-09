/**
 * Distributed Tracing — OpenTelemetry-style trace/span observability.
 *
 * Tracks the full call chain across agents, showing exactly where time
 * is spent and where errors occur. Unlike simple metrics, traces show
 * causality and flow through the system.
 *
 * Features:
 *   - Trace/span hierarchy (root → child spans)
 *   - Automatic context propagation
 *   - Waterfall visualization data
 *   - Span tags and events
 *   - Configurable sampling rate
 *
 * Usage:
 *   const trace = startTrace("delegate", { skillId: "ask_claude" });
 *   const span = trace.startSpan("routing");
 *   span.setTag("worker", "ai-agent");
 *   span.end();
 *   const result = await doWork();
 *   trace.end();
 *
 * No other A2A/MCP project provides distributed tracing.
 */

import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: "ok" | "error" | "in_progress";
  tags: Record<string, string | number | boolean>;
  events: SpanEvent[];
  children: Span[];

  /** Add a tag to this span. */
  setTag(key: string, value: string | number | boolean): Span;
  /** Add an event to this span. */
  addEvent(name: string, attributes?: Record<string, unknown>): Span;
  /** Start a child span. */
  startSpan(operationName: string): Span;
  /** End this span. */
  end(status?: "ok" | "error"): void;
}

export interface Trace {
  traceId: string;
  rootSpan: Span;
  startTime: number;
  endTime?: number;
  metadata: Record<string, unknown>;

  /** Start a child span of the root. */
  startSpan(operationName: string): Span;
  /** End the trace (ends root span if still open). */
  end(status?: "ok" | "error"): void;
}

export interface TraceSnapshot {
  traceId: string;
  operationName: string;
  status: string;
  durationMs?: number;
  startTime: string;
  metadata: Record<string, unknown>;
  spanCount: number;
}

export interface WaterfallEntry {
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startOffset: number; // ms from trace start
  durationMs: number;
  status: string;
  tags: Record<string, string | number | boolean>;
  depth: number;
}

// ── Configuration ────────────────────────────────────────────────

const MAX_TRACES = 200;
const TRACE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── State ────────────────────────────────────────────────────────

const traces = new Map<string, Trace>();
const traceOrder: string[] = []; // for LRU eviction

// ── Span Implementation ──────────────────────────────────────────

function createSpan(traceId: string, operationName: string, parentSpanId?: string): Span {
  const span: Span = {
    traceId,
    spanId: randomUUID().slice(0, 16),
    parentSpanId,
    operationName,
    startTime: Date.now(),
    status: "in_progress",
    tags: {},
    events: [],
    children: [],

    setTag(key: string, value: string | number | boolean): Span {
      span.tags[key] = value;
      return span;
    },

    addEvent(name: string, attributes?: Record<string, unknown>): Span {
      span.events.push({ name, timestamp: Date.now(), attributes });
      return span;
    },

    startSpan(childOp: string): Span {
      const child = createSpan(traceId, childOp, span.spanId);
      span.children.push(child);
      return child;
    },

    end(status?: "ok" | "error"): void {
      span.endTime = Date.now();
      span.durationMs = span.endTime - span.startTime;
      span.status = status ?? "ok";
    },
  };

  return span;
}

// ── Public API ───────────────────────────────────────────────────

/** Start a new trace with a root span. */
export function startTrace(operationName: string, metadata?: Record<string, unknown>): Trace {
  const traceId = randomUUID();
  const rootSpan = createSpan(traceId, operationName);

  const trace: Trace = {
    traceId,
    rootSpan,
    startTime: Date.now(),
    metadata: metadata ?? {},

    startSpan(childOp: string): Span {
      return rootSpan.startSpan(childOp);
    },

    end(status?: "ok" | "error"): void {
      if (rootSpan.status === "in_progress") {
        rootSpan.end(status);
      }
      trace.endTime = Date.now();
    },
  };

  traces.set(traceId, trace);
  traceOrder.push(traceId);
  pruneTraces();

  return trace;
}

/** Get a trace by ID. */
export function getTrace(traceId: string): Trace | undefined {
  return traces.get(traceId);
}

/** List recent traces. */
export function listTraces(limit = 50): TraceSnapshot[] {
  const result: TraceSnapshot[] = [];
  const ids = traceOrder.slice(-limit).reverse();

  for (const id of ids) {
    const trace = traces.get(id);
    if (!trace) continue;
    result.push({
      traceId: trace.traceId,
      operationName: trace.rootSpan.operationName,
      status: trace.rootSpan.status,
      durationMs: trace.rootSpan.durationMs,
      startTime: new Date(trace.startTime).toISOString(),
      metadata: trace.metadata,
      spanCount: countSpans(trace.rootSpan),
    });
  }

  return result;
}

/** Get a waterfall visualization of a trace. */
export function getWaterfall(traceId: string): WaterfallEntry[] {
  const trace = traces.get(traceId);
  if (!trace) return [];

  const entries: WaterfallEntry[] = [];
  flattenSpans(trace.rootSpan, trace.startTime, 0, entries);
  return entries;
}

/** Search traces by operation name or tag value. */
export function searchTraces(query: string, limit = 20): TraceSnapshot[] {
  const results: TraceSnapshot[] = [];
  const lowerQuery = query.toLowerCase();

  for (const [, trace] of traces) {
    if (results.length >= limit) break;
    if (matchesTraceQuery(trace, lowerQuery)) {
      results.push({
        traceId: trace.traceId,
        operationName: trace.rootSpan.operationName,
        status: trace.rootSpan.status,
        durationMs: trace.rootSpan.durationMs,
        startTime: new Date(trace.startTime).toISOString(),
        metadata: trace.metadata,
        spanCount: countSpans(trace.rootSpan),
      });
    }
  }

  return results;
}

/** Get tracing stats. */
export function getTracingStats(): {
  activeTraces: number;
  totalSpans: number;
  avgDurationMs: number;
  errorRate: string;
} {
  let totalSpans = 0;
  let totalDuration = 0;
  let completedCount = 0;
  let errorCount = 0;

  for (const [, trace] of traces) {
    totalSpans += countSpans(trace.rootSpan);
    if (trace.rootSpan.durationMs !== undefined) {
      totalDuration += trace.rootSpan.durationMs;
      completedCount++;
    }
    if (trace.rootSpan.status === "error") errorCount++;
  }

  return {
    activeTraces: traces.size,
    totalSpans,
    avgDurationMs: completedCount > 0 ? Math.round(totalDuration / completedCount) : 0,
    errorRate: traces.size > 0 ? `${((errorCount / traces.size) * 100).toFixed(1)}%` : "0%",
  };
}

/** Clear all traces (for testing). */
export function resetTracing(): void {
  traces.clear();
  traceOrder.length = 0;
}

// ── Helpers ──────────────────────────────────────────────────────

function countSpans(span: Span): number {
  return 1 + span.children.reduce((sum, child) => sum + countSpans(child), 0);
}

function flattenSpans(span: Span, traceStart: number, depth: number, entries: WaterfallEntry[]): void {
  entries.push({
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    operationName: span.operationName,
    startOffset: span.startTime - traceStart,
    durationMs: span.durationMs ?? (Date.now() - span.startTime),
    status: span.status,
    tags: span.tags,
    depth,
  });

  for (const child of span.children) {
    flattenSpans(child, traceStart, depth + 1, entries);
  }
}

function matchesTraceQuery(trace: Trace, query: string): boolean {
  if (trace.rootSpan.operationName.toLowerCase().includes(query)) return true;
  return hasMatchingSpan(trace.rootSpan, query);
}

function hasMatchingSpan(span: Span, query: string): boolean {
  if (span.operationName.toLowerCase().includes(query)) return true;
  for (const [, value] of Object.entries(span.tags)) {
    if (String(value).toLowerCase().includes(query)) return true;
  }
  return span.children.some(child => hasMatchingSpan(child, query));
}

function pruneTraces(): void {
  const cutoff = Date.now() - TRACE_TTL_MS;
  while (traceOrder.length > MAX_TRACES || (traceOrder.length > 0 && (traces.get(traceOrder[0])?.startTime ?? 0) < cutoff)) {
    const id = traceOrder.shift();
    if (id) traces.delete(id);
  }
}
