// src/scheduler.ts
// Recurring workflow/skill scheduler for OSINT monitoring.
// Runs configured jobs at intervals with jitter, publishing results to the event bus.

import { randomUUID } from "crypto";
import { publish } from "./event-bus.js";

// ── Types ────────────────────────────────────────────────────────

export interface SchedulerJob {
  id: string;
  /** Human-readable name */
  name: string;
  /** Interval between runs in ms */
  intervalMs: number;
  /** Random jitter in ms added to each interval (default: 10% of interval) */
  jitterMs?: number;
  /** Skill ID to invoke (mutually exclusive with workflow) */
  skillId?: string;
  /** Workflow ID to execute (mutually exclusive with skillId) */
  workflow?: string;
  /** Arguments passed to the skill/workflow */
  args: Record<string, unknown>;
  /** Whether the job is active */
  enabled: boolean;
  /** Timestamp of last run (ISO) */
  lastRunAt?: string;
  /** Timestamp of next scheduled run (ISO) */
  nextRunAt?: string;
  /** Number of successful runs */
  runCount: number;
  /** Number of failed runs */
  errorCount: number;
  /** Last error message */
  lastError?: string;
}

export type SchedulerJobInput = Pick<SchedulerJob, "name" | "intervalMs" | "args"> & {
  id?: string;
  skillId?: string;
  workflow?: string;
  jitterMs?: number;
  enabled?: boolean;
};

/** Callback invoked by the scheduler to dispatch a skill or workflow. */
export type DispatchFn = (
  skillId: string,
  args: Record<string, unknown>,
  text: string,
) => Promise<string>;

/** Callback invoked by the scheduler to execute a workflow. */
export type WorkflowFn = (
  workflowId: string,
  args: Record<string, unknown>,
) => Promise<string>;

// ── State ────────────────────────────────────────────────────────

const jobs = new Map<string, SchedulerJob>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let dispatchFn: DispatchFn | null = null;
let workflowFn: WorkflowFn | null = null;

// ── Public API ───────────────────────────────────────────────────

/** Initialize the scheduler with dispatch callbacks. */
export function initScheduler(opts: {
  dispatch: DispatchFn;
  executeWorkflow?: WorkflowFn;
}): void {
  dispatchFn = opts.dispatch;
  workflowFn = opts.executeWorkflow ?? null;
  process.stderr.write(`[scheduler] initialized\n`);
}

/** Add or update a scheduled job. */
export function addJob(input: SchedulerJobInput): SchedulerJob {
  const id = input.id ?? randomUUID().slice(0, 8);

  // Stop existing timer if updating
  const existingTimer = timers.get(id);
  if (existingTimer) clearTimeout(existingTimer);

  const job: SchedulerJob = {
    id,
    name: input.name,
    intervalMs: input.intervalMs,
    jitterMs: input.jitterMs ?? Math.floor(input.intervalMs * 0.1),
    skillId: input.skillId,
    workflow: input.workflow,
    args: input.args,
    enabled: input.enabled ?? true,
    runCount: 0,
    errorCount: 0,
  };

  jobs.set(id, job);

  if (job.enabled) {
    scheduleNext(job);
  }

  process.stderr.write(`[scheduler] job added: ${id} (${job.name}) every ${job.intervalMs}ms\n`);
  return job;
}

/** Remove a scheduled job. */
export function removeJob(id: string): boolean {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  return jobs.delete(id);
}

/** Pause or resume a job. */
export function toggleJob(id: string, enabled: boolean): SchedulerJob | null {
  const job = jobs.get(id);
  if (!job) return null;

  job.enabled = enabled;

  if (enabled) {
    scheduleNext(job);
  } else {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
    job.nextRunAt = undefined;
  }

  process.stderr.write(`[scheduler] job ${id} ${enabled ? "resumed" : "paused"}\n`);
  return job;
}

/** List all jobs. */
export function listJobs(): SchedulerJob[] {
  return [...jobs.values()];
}

/** Get a specific job. */
export function getJob(id: string): SchedulerJob | null {
  return jobs.get(id) ?? null;
}

/** Stop all jobs and clear state. */
export function stopScheduler(): void {
  for (const [id, timer] of timers) {
    clearTimeout(timer);
  }
  timers.clear();
  jobs.clear();
  process.stderr.write(`[scheduler] stopped all jobs\n`);
}

/** Get scheduler stats. */
export function getSchedulerStats(): {
  totalJobs: number;
  activeJobs: number;
  totalRuns: number;
  totalErrors: number;
} {
  let totalRuns = 0;
  let totalErrors = 0;
  let activeJobs = 0;

  for (const job of jobs.values()) {
    totalRuns += job.runCount;
    totalErrors += job.errorCount;
    if (job.enabled) activeJobs++;
  }

  return { totalJobs: jobs.size, activeJobs, totalRuns, totalErrors };
}

// ── Internal ─────────────────────────────────────────────────────

function scheduleNext(job: SchedulerJob): void {
  const jitter = Math.floor(Math.random() * (job.jitterMs ?? 0));
  const delay = job.intervalMs + jitter;
  const nextRun = new Date(Date.now() + delay);
  job.nextRunAt = nextRun.toISOString();

  const timer = setTimeout(() => executeJob(job), delay);
  timers.set(job.id, timer);
}

async function executeJob(job: SchedulerJob): Promise<void> {
  if (!job.enabled) return;

  const startTime = Date.now();
  process.stderr.write(`[scheduler] running job: ${job.id} (${job.name})\n`);

  try {
    let result: string;

    if (job.workflow && workflowFn) {
      result = await workflowFn(job.workflow, job.args);
    } else if (job.skillId && dispatchFn) {
      result = await dispatchFn(job.skillId, job.args, `Scheduled: ${job.name}`);
    } else {
      throw new Error("No dispatch function configured or no skillId/workflow specified");
    }

    job.runCount++;
    job.lastRunAt = new Date().toISOString();
    job.lastError = undefined;

    const durationMs = Date.now() - startTime;
    process.stderr.write(`[scheduler] job ${job.id} completed in ${durationMs}ms\n`);

    await publish(`scheduler.${job.id}.completed`, {
      jobId: job.id,
      jobName: job.name,
      durationMs,
      resultLength: result.length,
    }, { source: "scheduler" });

  } catch (err) {
    job.errorCount++;
    job.lastRunAt = new Date().toISOString();
    job.lastError = err instanceof Error ? err.message : String(err);

    process.stderr.write(`[scheduler] job ${job.id} failed: ${job.lastError}\n`);

    await publish(`scheduler.${job.id}.failed`, {
      jobId: job.id,
      jobName: job.name,
      error: job.lastError,
    }, { source: "scheduler" });
  }

  // Schedule next run
  if (job.enabled) {
    scheduleNext(job);
  }
}
