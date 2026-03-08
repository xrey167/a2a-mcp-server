import { describe, test, expect } from "bun:test";
import { executeWorkflow, validateWorkflow, type WorkflowDefinition, type DispatchFn } from "../workflow-engine.js";

const mockDispatch: DispatchFn = async (skillId, args, text) => {
  return `result-from-${skillId}`;
};

describe("Workflow Engine", () => {
  test("validates workflow structure", () => {
    expect(validateWorkflow(null)).toBe("Workflow must be an object");
    expect(validateWorkflow({})).toBe("Workflow requires an 'id' field");
    expect(validateWorkflow({ id: "test" })).toBe("Workflow requires a non-empty 'steps' array");
    expect(validateWorkflow({ id: "test", steps: [] })).toBe("Workflow requires a non-empty 'steps' array");
    expect(validateWorkflow({
      id: "test",
      steps: [{ id: "s1", skillId: "ask_claude" }],
    })).toBeNull();
  });

  test("detects cycles", () => {
    expect(validateWorkflow({
      id: "test",
      steps: [
        { id: "a", skillId: "s1", dependsOn: ["b"] },
        { id: "b", skillId: "s2", dependsOn: ["a"] },
      ],
    })).toMatch(/Cycle detected/);
  });

  test("detects missing dependencies", () => {
    expect(validateWorkflow({
      id: "test",
      steps: [
        { id: "a", skillId: "s1", dependsOn: ["nonexistent"] },
      ],
    })).toMatch(/unknown step/);
  });

  test("executes simple linear workflow", async () => {
    const workflow: WorkflowDefinition = {
      id: "linear",
      steps: [
        { id: "step1", skillId: "skill_a" },
        { id: "step2", skillId: "skill_b", dependsOn: ["step1"] },
      ],
    };

    const result = await executeWorkflow(workflow, mockDispatch);
    expect(result.status).toBe("completed");
    expect(result.steps.length).toBe(2);
    expect(result.steps[0].status).toBe("completed");
    expect(result.steps[1].status).toBe("completed");
    expect(result.steps[0].result).toBe("result-from-skill_a");
  });

  test("executes parallel steps", async () => {
    const callOrder: string[] = [];
    const dispatch: DispatchFn = async (skillId) => {
      callOrder.push(skillId);
      return `result-${skillId}`;
    };

    const workflow: WorkflowDefinition = {
      id: "parallel",
      steps: [
        { id: "a", skillId: "s1" },
        { id: "b", skillId: "s2" },
        { id: "c", skillId: "s3", dependsOn: ["a", "b"] },
      ],
    };

    const result = await executeWorkflow(workflow, dispatch);
    expect(result.status).toBe("completed");
    expect(result.steps.every(s => s.status === "completed")).toBe(true);
    // s1 and s2 should run before s3
    expect(callOrder.indexOf("s3")).toBeGreaterThan(callOrder.indexOf("s1"));
    expect(callOrder.indexOf("s3")).toBeGreaterThan(callOrder.indexOf("s2"));
  });

  test("template references resolve correctly", async () => {
    let capturedArgs: Record<string, unknown> = {};
    const dispatch: DispatchFn = async (skillId, args) => {
      if (skillId === "s2") capturedArgs = args;
      return `output-of-${skillId}`;
    };

    const workflow: WorkflowDefinition = {
      id: "template",
      steps: [
        { id: "first", skillId: "s1" },
        { id: "second", skillId: "s2", args: { prompt: "Analyze: {{first.result}}" }, dependsOn: ["first"] },
      ],
    };

    await executeWorkflow(workflow, dispatch);
    expect(capturedArgs.prompt).toBe("Analyze: output-of-s1");
  });

  test("handles step failure with skip", async () => {
    const dispatch: DispatchFn = async (skillId) => {
      if (skillId === "failing") throw new Error("boom");
      return `ok-${skillId}`;
    };

    const workflow: WorkflowDefinition = {
      id: "skip-test",
      steps: [
        { id: "a", skillId: "failing", onError: "skip" },
        { id: "b", skillId: "s2", dependsOn: ["a"] },
      ],
    };

    const result = await executeWorkflow(workflow, dispatch);
    expect(result.steps[0].status).toBe("skipped");
    expect(result.steps[1].status).toBe("completed");
  });

  test("handles step failure with cascade", async () => {
    const dispatch: DispatchFn = async (skillId) => {
      if (skillId === "failing") throw new Error("boom");
      return `ok-${skillId}`;
    };

    const workflow: WorkflowDefinition = {
      id: "fail-cascade",
      steps: [
        { id: "a", skillId: "failing" },
        { id: "b", skillId: "s2", dependsOn: ["a"] },
      ],
    };

    const result = await executeWorkflow(workflow, dispatch);
    expect(result.status).toBe("failed");
    expect(result.steps[0].status).toBe("failed");
    expect(result.steps[1].status).toBe("failed");
    expect(result.steps[1].error).toMatch(/Upstream step/);
  });

  test("retries on error", async () => {
    let callCount = 0;
    const dispatch: DispatchFn = async (skillId) => {
      callCount++;
      if (callCount < 3) throw new Error("transient");
      return "ok";
    };

    const workflow: WorkflowDefinition = {
      id: "retry-test",
      steps: [
        { id: "a", skillId: "s1", onError: "retry", maxRetries: 3 },
      ],
    };

    const result = await executeWorkflow(workflow, dispatch);
    expect(result.status).toBe("completed");
    expect(result.steps[0].retries).toBe(2);
  });

  test("progress callback is called", async () => {
    const messages: string[] = [];

    const workflow: WorkflowDefinition = {
      id: "progress",
      name: "Test Workflow",
      steps: [{ id: "a", skillId: "s1", label: "Step A" }],
    };

    await executeWorkflow(workflow, mockDispatch, (msg) => messages.push(msg));
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some(m => m.includes("Test Workflow"))).toBe(true);
    expect(messages.some(m => m.includes("Step A"))).toBe(true);
  });
});
