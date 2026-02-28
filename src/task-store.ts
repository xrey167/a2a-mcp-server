import { memory } from "./memory.js";
import { randomUUID } from "crypto";

export type TaskState = "pending" | "completed" | "failed";

export interface TaskRecord {
  taskId: string;
  state: TaskState;
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
  sessionId?: string;
  skillId?: string;
  agentUrl?: string;
}

const AGENT = "task-store";
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function createTask(meta: { sessionId?: string; skillId?: string; agentUrl?: string }): string {
  const taskId = randomUUID();
  const record: TaskRecord = { taskId, state: "pending", createdAt: Date.now(), ...meta };
  memory.set(AGENT, taskId, JSON.stringify(record));
  return taskId;
}

export function completeTask(taskId: string, result: string): void {
  const existing = getTask(taskId);
  if (!existing) return;
  memory.set(AGENT, taskId, JSON.stringify({ ...existing, state: "completed", result, completedAt: Date.now() }));
}

export function failTask(taskId: string, error: string): void {
  const existing = getTask(taskId);
  if (!existing) return;
  memory.set(AGENT, taskId, JSON.stringify({ ...existing, state: "failed", error, completedAt: Date.now() }));
}

export function getTask(taskId: string): TaskRecord | null {
  const raw = memory.get(AGENT, taskId);
  if (!raw) return null;
  try { return JSON.parse(raw) as TaskRecord; } catch { return null; }
}

export function pruneStale(): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [key, value] of Object.entries(memory.all(AGENT))) {
    try {
      const record = JSON.parse(value) as TaskRecord;
      if (record.createdAt < cutoff) memory.forget(AGENT, key);
    } catch {
      memory.forget(AGENT, key);
    }
  }
}
