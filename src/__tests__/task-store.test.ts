import { describe, test, expect, beforeEach } from "bun:test";
import {
  createTask,
  markWorking,
  markCompleted,
  markFailed,
  markCanceled,
  emitProgress,
  getTask,
  listTasks,
  pruneTasks,
  toA2AResult,
  taskEvents,
  __clearTasksForTesting,
} from "../task-store.js";

describe("Task Store", () => {
  // Reset task store state before each test to prevent test coupling
  beforeEach(() => {
    __clearTasksForTesting();
  });

  test("createTask creates a task in submitted state", () => {
    const task = createTask({ skillId: "run_shell" });
    expect(task.state).toBe("submitted");
    expect(task.skillId).toBe("run_shell");
    expect(task.artifacts).toEqual([]);
    expect(task.id).toBeTruthy();
    expect(task.createdAt).toBeGreaterThan(0);
  });

  test("createTask with custom id", () => {
    const task = createTask({ id: "custom-id-1" });
    expect(task.id).toBe("custom-id-1");
    expect(getTask("custom-id-1")).toBe(task);
  });

  test("markWorking transitions from submitted to working", () => {
    const task = createTask();
    const updated = markWorking(task.id);
    expect(updated?.state).toBe("working");
    expect(getTask(task.id)?.state).toBe("working");
  });

  test("markCompleted transitions to completed with artifacts", () => {
    const task = createTask();
    markWorking(task.id);
    const updated = markCompleted(task.id, "result text");
    expect(updated?.state).toBe("completed");
    expect(updated?.artifacts).toEqual([{ parts: [{ text: "result text" }] }]);
  });

  test("markFailed transitions to failed with error", () => {
    const task = createTask();
    markWorking(task.id);
    const updated = markFailed(task.id, { code: "TASK_FAILED", message: "boom" });
    expect(updated?.state).toBe("failed");
    expect(updated?.error).toEqual({ code: "TASK_FAILED", message: "boom" });
  });

  test("markCanceled transitions to canceled", () => {
    const task = createTask();
    markWorking(task.id);
    const updated = markCanceled(task.id);
    expect(updated?.state).toBe("canceled");
  });

  test("cannot transition from terminal state", () => {
    const task = createTask();
    markWorking(task.id);
    markCompleted(task.id, "done");

    expect(markWorking(task.id)).toBeNull();
    expect(markFailed(task.id, { code: "X", message: "x" })).toBeNull();
    expect(markCanceled(task.id)).toBeNull();
    expect(getTask(task.id)?.state).toBe("completed");
  });

  test("cannot transition from canceled", () => {
    const task = createTask();
    markCanceled(task.id);
    expect(markCompleted(task.id, "too late")).toBeNull();
    expect(getTask(task.id)?.state).toBe("canceled");
  });

  test("getTask returns undefined for unknown id", () => {
    expect(getTask("nonexistent")).toBeUndefined();
  });

  test("listTasks returns all tasks", () => {
    const t1 = createTask();
    const t2 = createTask();
    const all = listTasks();
    expect(all.some(t => t.id === t1.id)).toBe(true);
    expect(all.some(t => t.id === t2.id)).toBe(true);
  });

  test("listTasks filters by state", () => {
    const t1 = createTask();
    markWorking(t1.id);
    markCompleted(t1.id, "done");

    const t2 = createTask();
    markWorking(t2.id);

    const working = listTasks("working");
    expect(working.some(t => t.id === t2.id)).toBe(true);
    expect(working.some(t => t.id === t1.id)).toBe(false);
  });

  test("pruneTasks removes old terminal tasks", () => {
    const task = createTask();
    markCompleted(task.id, "done");

    // Force the updatedAt to the past
    const stored = getTask(task.id)!;
    stored.updatedAt = Date.now() - 100_000;

    const pruned = pruneTasks(50_000);
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(getTask(task.id)).toBeUndefined();
  });

  test("pruneTasks does not remove active tasks", () => {
    const task = createTask();
    markWorking(task.id);

    // Force old timestamp
    const stored = getTask(task.id)!;
    stored.updatedAt = Date.now() - 100_000;

    const pruned = pruneTasks(50_000);
    // Active (working) task should not be pruned
    expect(getTask(task.id)).toBeTruthy();
  });
});

describe("toA2AResult", () => {
  test("builds result for completed task", () => {
    const task = createTask({ id: "r1" });
    markWorking(task.id);
    markCompleted(task.id, "hello");

    const result = toA2AResult(getTask("r1")!);
    expect(result).toEqual({
      id: "r1",
      status: { state: "completed" },
      artifacts: [{ parts: [{ text: "hello" }] }],
    });
  });

  test("builds result for failed task", () => {
    const task = createTask({ id: "r2" });
    markWorking(task.id);
    markFailed(task.id, { code: "ERR", message: "bad" });

    const result = toA2AResult(getTask("r2")!);
    expect(result).toEqual({
      id: "r2",
      status: { state: "failed", error: { code: "ERR", message: "bad" } },
    });
  });

  test("builds result for submitted task (no artifacts)", () => {
    const task = createTask({ id: "r3" });
    const result = toA2AResult(task);
    expect(result).toEqual({
      id: "r3",
      status: { state: "submitted" },
    });
  });
});

describe("Task Events", () => {
  test("emits events on state changes", async () => {
    const events: any[] = [];
    const task = createTask({ id: "evt-1" });

    const handler = (e: any) => events.push(e);
    taskEvents.on(`task:evt-1`, handler);

    markWorking(task.id);
    markCompleted(task.id, "done");

    taskEvents.removeListener(`task:evt-1`, handler);

    // submitted event + working event + completed event
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some(e => e.state === "working")).toBe(true);
    expect(events.some(e => e.state === "completed")).toBe(true);
  });

  test("emitProgress sends progress event", () => {
    const events: any[] = [];
    const task = createTask({ id: "evt-2" });
    markWorking(task.id);

    const handler = (e: any) => events.push(e);
    taskEvents.on(`task:evt-2`, handler);

    emitProgress(task.id, "50% done");

    taskEvents.removeListener(`task:evt-2`, handler);

    expect(events.some(e => e.type === "progress" && e.data === "50% done")).toBe(true);
  });
});
