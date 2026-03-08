/**
 * Metrics Collection — lightweight observability for skill execution.
 *
 * Tracks:
 *   - Skill execution counts, latencies (p50/p95/p99), success/error rates
 *   - Worker-level utilization and uptime
 *   - System-wide throughput and error budgets
 *
 * Storage: in-memory; retains a bounded latency history per skill (last ~1000 samples)
 * and unbounded aggregate counters.
 * Exposed via MCP resource a2a://metrics.
 */

const WINDOW_MS = 5 * 60_000; // reserved for potential future time-windowed decay

interface SkillMetric {
  skillId: string;
  worker: string;
  calls: number;
  errors: number;
  latencies: number[]; // ms, rolling window
  lastCalled: number;
  lastError?: string;
}

interface WorkerMetric {
  name: string;
  url: string;
  totalCalls: number;
  totalErrors: number;
  avgLatencyMs: number;
  activeSince: number;
}

// ── Storage ──────────────────────────────────────────────────────

const skillMetrics = new Map<string, SkillMetric>();
const workerMetrics = new Map<string, WorkerMetric>();

// ── Public API ───────────────────────────────────────────────────

/** Record the start of a skill execution. Returns a function to call on completion. */
export function startSkillTimer(skillId: string, worker: string): (error?: string) => void {
  const start = performance.now();

  return (error?: string) => {
    const latency = Math.round(performance.now() - start);
    recordSkillCall(skillId, worker, latency, error);
  };
}

/** Record a completed skill call with latency. */
export function recordSkillCall(skillId: string, worker: string, latencyMs: number, error?: string): void {
  let metric = skillMetrics.get(skillId);
  if (!metric) {
    metric = { skillId, worker, calls: 0, errors: 0, latencies: [], lastCalled: 0 };
    skillMetrics.set(skillId, metric);
  }

  metric.calls++;
  metric.lastCalled = Date.now();
  metric.latencies.push(latencyMs);

  // Keep latency array bounded (last 1000 entries)
  if (metric.latencies.length > 1000) {
    metric.latencies = metric.latencies.slice(-500);
  }

  if (error) {
    metric.errors++;
    metric.lastError = error;
  }

  // Update worker-level metrics
  let wMetric = workerMetrics.get(worker);
  if (!wMetric) {
    wMetric = { name: worker, url: "", totalCalls: 0, totalErrors: 0, avgLatencyMs: 0, activeSince: Date.now() };
    workerMetrics.set(worker, wMetric);
  }
  wMetric.totalCalls++;
  if (error) wMetric.totalErrors++;
  // Running average
  wMetric.avgLatencyMs = Math.round(
    (wMetric.avgLatencyMs * (wMetric.totalCalls - 1) + latencyMs) / wMetric.totalCalls
  );
}

/** Register a worker for metrics tracking. */
export function registerWorkerMetric(name: string, url: string): void {
  if (!workerMetrics.has(name)) {
    workerMetrics.set(name, {
      name,
      url,
      totalCalls: 0,
      totalErrors: 0,
      avgLatencyMs: 0,
      activeSince: Date.now(),
    });
  } else {
    workerMetrics.get(name)!.url = url;
  }
}

// ── Percentile Computation ───────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Snapshot ─────────────────────────────────────────────────────

export interface MetricsSnapshot {
  timestamp: string;
  uptime: number;
  system: {
    totalCalls: number;
    totalErrors: number;
    errorRate: string;
    avgLatencyMs: number;
  };
  skills: Array<{
    skillId: string;
    worker: string;
    calls: number;
    errors: number;
    errorRate: string;
    latency: { p50: number; p95: number; p99: number; max: number };
    lastCalled: string;
  }>;
  workers: Array<{
    name: string;
    url: string;
    totalCalls: number;
    totalErrors: number;
    errorRate: string;
    avgLatencyMs: number;
  }>;
}

/** Get a snapshot of all metrics. */
export function getMetricsSnapshot(): MetricsSnapshot {
  let totalCalls = 0;
  let totalErrors = 0;
  let totalLatency = 0;

  const skills: MetricsSnapshot["skills"] = [];

  for (const [, metric] of skillMetrics) {
    totalCalls += metric.calls;
    totalErrors += metric.errors;

    const sorted = [...metric.latencies].sort((a, b) => a - b);
    totalLatency += sorted.reduce((a, b) => a + b, 0);

    skills.push({
      skillId: metric.skillId,
      worker: metric.worker,
      calls: metric.calls,
      errors: metric.errors,
      errorRate: metric.calls > 0 ? `${((metric.errors / metric.calls) * 100).toFixed(1)}%` : "0%",
      latency: {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
      },
      lastCalled: metric.lastCalled ? new Date(metric.lastCalled).toISOString() : "never",
    });
  }

  // Sort skills by call count descending
  skills.sort((a, b) => b.calls - a.calls);

  const workers: MetricsSnapshot["workers"] = [];
  for (const [, wMetric] of workerMetrics) {
    workers.push({
      name: wMetric.name,
      url: wMetric.url,
      totalCalls: wMetric.totalCalls,
      totalErrors: wMetric.totalErrors,
      errorRate: wMetric.totalCalls > 0 ? `${((wMetric.totalErrors / wMetric.totalCalls) * 100).toFixed(1)}%` : "0%",
      avgLatencyMs: wMetric.avgLatencyMs,
    });
  }

  return {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    system: {
      totalCalls,
      totalErrors,
      errorRate: totalCalls > 0 ? `${((totalErrors / totalCalls) * 100).toFixed(1)}%` : "0%",
      avgLatencyMs: totalCalls > 0 ? Math.round(totalLatency / totalCalls) : 0,
    },
    skills,
    workers,
  };
}

/** Reset all metrics (for testing). */
export function resetMetrics(): void {
  skillMetrics.clear();
  workerMetrics.clear();
}
