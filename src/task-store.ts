/**
 * Task Store — A2A task lifecycle management.
 *
 * States: submitted → working → completed | failed | canceled
 *
 * Tasks are stored in-memory with an EventEmitter for SSE streaming.
 * Supports polling via tasks/get and cancellation via tasks/cancel.
 */

import { randomUUID } from "crypto";
import { EventEmitter } from "events";

export type TaskState = "submitted" | "working" | "completed" | "failed" | "canceled";

export interface TaskArtifact {
  parts: Array<{ text: string }>;
}

export interface TaskError {
  code: string;
  message: string;
}

export interface Task {
  id: string;
  state: TaskState;
  skillId?: string;
  workerUrl?: string;
  artifacts: TaskArtifact[];
  error?: TaskError;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEvent {
  taskId: string;
  type: "state_change" | "progress" | "artifact";
  state: TaskState;
  data?: string;
  error?: TaskError;
}

// ── Store ─────────────────────────────────────────────────────────

const tasks = new Map<string, Task>();
export const taskEvents = new EventEmitter();

// Don't limit listeners — SSE clients can be many
taskEvents.setMaxListeners(100);

// ── Public API ────────────────────────────────────────────────────

/** Create a new task in "submitted" state. */
export function createTask(opts?: { id?: string; skillId?: string; workerUrl?: string }): Task {
  const now = Date.now();
  const task: Task = {
    id: opts?.id ?? randomUUID(),
    state: "submitted",
    skillId: opts?.skillId,
    workerUrl: opts?.workerUrl,
    artifacts: [],
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(task.id, task);
  emitEvent(task, "state_change");
  return task;
}

/** Transition task to "working" state. */
export function markWorking(taskId: string, progressText?: string): Task | null {
  const task = tasks.get(taskId);
  if (!task || isTerminal(task.state)) return null;

  task.state = "working";
  task.updatedAt = Date.now();
  emitEvent(task, progressText ? "progress" : "state_change", progressText);
  return task;
}

/** Emit a progress event without changing state (must be in "working" state). */
export function emitProgress(taskId: string, text: string): void {
  const task = tasks.get(taskId);
  if (!task || task.state !== "working") return;
  task.updatedAt = Date.now();
  emitEvent(task, "progress", text);
}

/** Transition task to "completed" with result artifacts. */
export function markCompleted(taskId: string, resultText: string): Task | null {
  const task = tasks.get(taskId);
  if (!task || isTerminal(task.state)) return null;

  task.state = "completed";
  task.artifacts = [{ parts: [{ text: resultText }] }];
  task.updatedAt = Date.now();
  emitEvent(task, "state_change");
  return task;
}

/** Transition task to "failed" with error. */
export function markFailed(taskId: string, error: TaskError): Task | null {
  const task = tasks.get(taskId);
  if (!task || isTerminal(task.state)) return null;

  task.state = "failed";
  task.error = error;
  task.updatedAt = Date.now();
  emitEvent(task, "state_change");
  return task;
}

/** Transition task to "canceled". */
export function markCanceled(taskId: string): Task | null {
  const task = tasks.get(taskId);
  if (!task || isTerminal(task.state)) return null;

  task.state = "canceled";
  task.updatedAt = Date.now();
  emitEvent(task, "state_change");
  return task;
}

/** Get task by ID. */
export function getTask(taskId: string): Task | undefined {
  return tasks.get(taskId);
}

/** List all tasks, optionally filtered by state. */
export function listTasks(state?: TaskState): Task[] {
  const all = Array.from(tasks.values());
  if (!state) return all;
  return all.filter(t => t.state === state);
}

/** Remove old tasks (older than maxAgeMs). Returns count removed. */
export function pruneTasks(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  let count = 0;
  for (const [id, task] of tasks) {
    if (task.updatedAt < cutoff && isTerminal(task.state)) {
      tasks.delete(id);
      count++;
    }
  }
  return count;
}

// ── Helpers ───────────────────────────────────────────────────────

function isTerminal(state: TaskState): boolean {
  return state === "completed" || state === "failed" || state === "canceled";
}

function emitEvent(task: Task, type: TaskEvent["type"], data?: string): void {
  const event: TaskEvent = {
    taskId: task.id,
    type,
    state: task.state,
    ...(data ? { data } : {}),
    ...(task.error ? { error: task.error } : {}),
  };
  taskEvents.emit("task", event);
  taskEvents.emit(`task:${task.id}`, event);
}

/** Build an A2A-compliant task result object. */
export function toA2AResult(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    status: {
      state: task.state,
      ...(task.error ? { error: task.error } : {}),
    },
    ...(task.artifacts.length > 0 ? { artifacts: task.artifacts } : {}),
  };
}
