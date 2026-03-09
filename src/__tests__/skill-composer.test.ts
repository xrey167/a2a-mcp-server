import { describe, test, expect, beforeEach } from "bun:test";
import { compose, executePipeline, listPipelines, removePipeline, resetPipelines } from "../skill-composer.js";

beforeEach(() => resetPipelines());

const mockDispatch = async (skillId: string, args: Record<string, unknown>, text: string): Promise<string> => {
  if (skillId === "upper") return text.toUpperCase();
  if (skillId === "reverse") return text.split("").reverse().join("");
  if (skillId === "failing") throw new Error("skill failed");
  return `${skillId}: ${JSON.stringify(args)}`;
};

describe("Skill Composer", () => {
  test("compose registers a pipeline", () => {
    compose("test-pipe", [{ skillId: "upper" }, { skillId: "reverse" }]);
    const pipes = listPipelines();
    expect(pipes).toHaveLength(1);
    expect(pipes[0].name).toBe("test-pipe");
    expect(pipes[0].steps).toBe(2);
  });

  test("execute pipeline chains results", async () => {
    const pipeline = compose("chain", [
      { skillId: "upper", transform: "hello" },
      { skillId: "reverse" },
    ]);
    const result = await executePipeline(pipeline, {}, mockDispatch);
    expect(result.status).toBe("completed");
    expect(result.output).toBe("OLLEH");
  });

  test("pipeline uses input templates", async () => {
    const pipeline = compose("templated", [
      { skillId: "upper", transform: "{{input.text}}" },
    ]);
    const result = await executePipeline(pipeline, { text: "hello" }, mockDispatch);
    expect(result.output).toBe("HELLO");
  });

  test("pipeline abort on error by default", async () => {
    const pipeline = compose("abort", [
      { skillId: "failing" },
      { skillId: "upper", transform: "should not run" },
    ]);
    const result = await executePipeline(pipeline, {}, mockDispatch);
    expect(result.status).toBe("failed");
    expect(result.stepResults).toHaveLength(1);
  });

  test("pipeline skip on error", async () => {
    const pipeline = compose("skip-err", [
      { skillId: "failing", onError: "skip" },
      { skillId: "upper", transform: "hello" },
    ]);
    const result = await executePipeline(pipeline, {}, mockDispatch);
    expect(result.status).toBe("partial");
    expect(result.stepResults).toHaveLength(2);
    expect(result.output).toBe("HELLO");
  });

  test("pipeline fallback on error", async () => {
    const pipeline = compose("fallback", [
      { skillId: "failing", onError: { fallback: "fallback-value" } },
      { skillId: "upper" },
    ]);
    const result = await executePipeline(pipeline, {}, mockDispatch);
    expect(result.output).toBe("FALLBACK-VALUE");
  });

  test("pipeline conditional skip with when", async () => {
    const pipeline = compose("conditional", [
      { skillId: "upper", transform: "hello", as: "step1" },
      { skillId: "reverse", when: "{{steps.step1.result}}" },
    ]);
    const result = await executePipeline(pipeline, {}, mockDispatch);
    expect(result.output).toBe("OLLEH");
  });

  test("removePipeline works", () => {
    compose("remove-me", [{ skillId: "upper" }]);
    expect(listPipelines()).toHaveLength(1);
    removePipeline("remove-me");
    expect(listPipelines()).toHaveLength(0);
  });

  test("execute by name", async () => {
    compose("by-name", [{ skillId: "upper", transform: "test" }]);
    const result = await executePipeline("by-name", {}, mockDispatch);
    expect(result.output).toBe("TEST");
  });
});
