import { describe, test, expect } from "bun:test";
import {
  AgentError,
  SkillNotFoundError,
  WorkerUnavailableError,
  TaskTimeoutError,
  TaskNotFoundError,
  InvalidArgsError,
  formatError,
  toStatusError,
} from "../errors.js";

describe("AgentError", () => {
  test("creates error with code and message", () => {
    const err = new AgentError("INTERNAL_ERROR", "something broke");
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.message).toBe("something broke");
    expect(err.details).toBeUndefined();
    expect(err.name).toBe("AgentError");
  });

  test("creates error with details", () => {
    const err = new AgentError("TASK_FAILED", "bad", { taskId: "t1" });
    expect(err.details).toEqual({ taskId: "t1" });
  });

  test("toJSON returns structured object", () => {
    const err = new AgentError("ROUTING_ERROR", "no route", { skillId: "x" });
    const json = err.toJSON();
    expect(json).toEqual({
      code: "ROUTING_ERROR",
      message: "no route",
      details: { skillId: "x" },
    });
  });

  test("toJSON omits details when absent", () => {
    const err = new AgentError("INTERNAL_ERROR", "oops");
    const json = err.toJSON();
    expect(json).toEqual({ code: "INTERNAL_ERROR", message: "oops" });
    expect("details" in json).toBe(false);
  });

  test("is instanceof Error", () => {
    const err = new AgentError("INTERNAL_ERROR", "x");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AgentError).toBe(true);
  });
});

describe("Specialized errors", () => {
  test("SkillNotFoundError", () => {
    const err = new SkillNotFoundError("my_skill", "web-agent");
    expect(err.code).toBe("SKILL_NOT_FOUND");
    expect(err.message).toBe("Skill not found: my_skill");
    expect(err.details).toEqual({ skillId: "my_skill", worker: "web-agent" });
    expect(err.name).toBe("SkillNotFoundError");
  });

  test("WorkerUnavailableError with reason", () => {
    const err = new WorkerUnavailableError("shell-agent", "timed out");
    expect(err.code).toBe("WORKER_UNAVAILABLE");
    expect(err.message).toBe("Worker unavailable: shell-agent (timed out)");
  });

  test("WorkerUnavailableError without reason", () => {
    const err = new WorkerUnavailableError("shell-agent");
    expect(err.message).toBe("Worker unavailable: shell-agent");
  });

  test("TaskTimeoutError", () => {
    const err = new TaskTimeoutError("task-1", 5000);
    expect(err.code).toBe("TASK_TIMEOUT");
    expect(err.details).toEqual({ taskId: "task-1", timeoutMs: 5000 });
  });

  test("TaskNotFoundError", () => {
    const err = new TaskNotFoundError("task-99");
    expect(err.code).toBe("TASK_NOT_FOUND");
  });

  test("InvalidArgsError", () => {
    const err = new InvalidArgsError("missing field");
    expect(err.code).toBe("INVALID_ARGS");
  });
});

describe("formatError", () => {
  test("formats AgentError with context", () => {
    const err = new SkillNotFoundError("x");
    const line = formatError(err, { taskId: "t1", skill: "x", worker: "w1" });
    expect(line).toContain("taskId=t1");
    expect(line).toContain("skill=x");
    expect(line).toContain("worker=w1");
    expect(line).toContain("SKILL_NOT_FOUND");
  });

  test("formats plain Error", () => {
    const err = new Error("plain");
    const line = formatError(err);
    expect(line).toBe("plain");
  });

  test("formats string", () => {
    const line = formatError("oops");
    expect(line).toBe("oops");
  });
});

describe("toStatusError", () => {
  test("converts AgentError", () => {
    const err = new AgentError("TASK_FAILED", "it broke");
    expect(toStatusError(err)).toEqual({ code: "TASK_FAILED", message: "it broke" });
  });

  test("converts plain Error", () => {
    const err = new Error("boom");
    expect(toStatusError(err)).toEqual({ code: "INTERNAL_ERROR", message: "boom" });
  });

  test("converts string", () => {
    expect(toStatusError("wat")).toEqual({ code: "INTERNAL_ERROR", message: "wat" });
  });
});
