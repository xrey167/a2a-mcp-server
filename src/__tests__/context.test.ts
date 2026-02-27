import { describe, test, expect } from "bun:test";
import { getProjectContext, setProjectContext, getContextPreamble } from "../context.js";

describe("Project Context", () => {
  test("getProjectContext returns default when no context set", () => {
    const ctx = getProjectContext();
    expect(ctx).toBeDefined();
    expect(typeof ctx.summary).toBe("string");
    expect(Array.isArray(ctx.goals)).toBe(true);
    expect(Array.isArray(ctx.stack)).toBe(true);
    expect(typeof ctx.notes).toBe("string");
    expect(typeof ctx.updatedAt).toBe("string");
  });

  test("setProjectContext updates and returns context", () => {
    const updated = setProjectContext({
      summary: "Test project summary",
      goals: ["goal1", "goal2"],
      stack: ["TypeScript", "Bun"],
      notes: "test notes",
    });

    expect(updated.summary).toBe("Test project summary");
    expect(updated.goals).toEqual(["goal1", "goal2"]);
    expect(updated.stack).toEqual(["TypeScript", "Bun"]);
    expect(updated.notes).toBe("test notes");
    expect(updated.updatedAt).toBeTruthy();
  });

  test("setProjectContext merges partial updates", () => {
    setProjectContext({ summary: "Base summary", goals: ["g1"] });
    const updated = setProjectContext({ notes: "new notes" });

    expect(updated.summary).toBe("Base summary");
    expect(updated.goals).toEqual(["g1"]);
    expect(updated.notes).toBe("new notes");
  });

  test("getContextPreamble returns empty string when no summary", () => {
    setProjectContext({ summary: "", goals: [], stack: [], notes: "" });
    expect(getContextPreamble()).toBe("");
  });

  test("getContextPreamble includes summary and details", () => {
    setProjectContext({
      summary: "A test project",
      goals: ["ship v1"],
      stack: ["TS"],
      notes: "important",
    });

    const preamble = getContextPreamble();
    expect(preamble).toContain("[Project Context]");
    expect(preamble).toContain("A test project");
    expect(preamble).toContain("ship v1");
    expect(preamble).toContain("TS");
    expect(preamble).toContain("important");
  });

  test("getProjectContext round-trips through set", () => {
    const input = {
      summary: "round trip",
      goals: ["a", "b"],
      stack: ["X", "Y"],
      notes: "z",
    };
    setProjectContext(input);
    const ctx = getProjectContext();
    expect(ctx.summary).toBe(input.summary);
    expect(ctx.goals).toEqual(input.goals);
    expect(ctx.stack).toEqual(input.stack);
    expect(ctx.notes).toBe(input.notes);
  });
});
