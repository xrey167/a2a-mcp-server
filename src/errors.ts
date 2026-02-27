/**
 * Structured Error Types for A2A MCP Server
 *
 * Typed errors with codes, messages, and optional details.
 * Used across orchestrator and workers for consistent error reporting.
 */

export type ErrorCode =
  | "SKILL_NOT_FOUND"
  | "WORKER_UNAVAILABLE"
  | "TASK_TIMEOUT"
  | "TASK_FAILED"
  | "TASK_CANCELED"
  | "TASK_NOT_FOUND"
  | "INVALID_ARGS"
  | "MCP_ERROR"
  | "ROUTING_ERROR"
  | "INTERNAL_ERROR";

export class AgentError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.details = details;
  }

  /** JSON-RPC compatible error object for A2A responses. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export class SkillNotFoundError extends AgentError {
  constructor(skillId: string, worker?: string) {
    super("SKILL_NOT_FOUND", `Skill not found: ${skillId}`, { skillId, worker });
    this.name = "SkillNotFoundError";
  }
}

export class WorkerUnavailableError extends AgentError {
  constructor(workerName: string, reason?: string) {
    super("WORKER_UNAVAILABLE", `Worker unavailable: ${workerName}${reason ? ` (${reason})` : ""}`, { worker: workerName, reason });
    this.name = "WorkerUnavailableError";
  }
}

export class TaskTimeoutError extends AgentError {
  constructor(taskId: string, timeoutMs: number) {
    super("TASK_TIMEOUT", `Task ${taskId} timed out after ${timeoutMs}ms`, { taskId, timeoutMs });
    this.name = "TaskTimeoutError";
  }
}

export class TaskNotFoundError extends AgentError {
  constructor(taskId: string) {
    super("TASK_NOT_FOUND", `Task not found: ${taskId}`, { taskId });
    this.name = "TaskNotFoundError";
  }
}

export class InvalidArgsError extends AgentError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("INVALID_ARGS", message, details);
    this.name = "InvalidArgsError";
  }
}

/** Format any error (AgentError or plain Error) into a consistent log line. */
export function formatError(err: unknown, context?: { taskId?: string; skill?: string; worker?: string }): string {
  const parts: string[] = [];
  if (context?.taskId) parts.push(`taskId=${context.taskId}`);
  if (context?.skill) parts.push(`skill=${context.skill}`);
  if (context?.worker) parts.push(`worker=${context.worker}`);

  if (err instanceof AgentError) {
    parts.push(`code=${err.code}`);
    parts.push(err.message);
  } else if (err instanceof Error) {
    parts.push(err.message);
  } else {
    parts.push(String(err));
  }

  return parts.join(" ");
}

/** Extract a structured error for A2A status.error field. */
export function toStatusError(err: unknown): { code: string; message: string } {
  if (err instanceof AgentError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: "INTERNAL_ERROR", message: err.message };
  }
  return { code: "INTERNAL_ERROR", message: String(err) };
}
