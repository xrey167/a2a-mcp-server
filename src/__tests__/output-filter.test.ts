import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyFilters, resetFilterConfig } from "../output-filter.js";

// Enable output filtering for tests
process.env.A2A_OUTPUT_FILTER_ENABLED = "true";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("output-filter head/tail selection", () => {
  let tmpHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    // Point HOME at a temp dir so filters.json doesn't bleed across tests
    tmpHome = join(tmpdir(), `a2a-filter-test-${Date.now()}`);
    mkdirSync(join(tmpHome, ".a2a-mcp"), { recursive: true });
    savedHome = process.env.HOME;
    process.env.HOME = tmpHome;
    resetFilterConfig();
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    resetFilterConfig();
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  test("tail-only rule truncates when lines exceed tailLines", () => {
    // Inject a custom filter rule that only has tailLines (no headLines)
    writeFileSync(
      join(tmpHome, ".a2a-mcp", "filters.json"),
      JSON.stringify({
        filters: {
          "tail-only": {
            matchSkill: "my_skill",
            tailLines: 5,
          },
        },
      }),
    );
    resetFilterConfig();

    const input = makeLines(20); // 20 lines, exceeds tailLines=5
    const result = applyFilters(input, { skillId: "my_skill", workerName: "test" });

    expect(result.filtersApplied).toContain("tail-only:head-tail");
    // Output should contain the last 5 lines
    expect(result.output).toContain("line 16");
    expect(result.output).toContain("line 20");
    // And an omission notice
    expect(result.output).toContain("lines omitted");
    // Lines before the tail should not appear (head is empty)
    expect(result.output).not.toContain("line 1\n");
  });

  test("tail-only rule does NOT truncate when lines <= tailLines", () => {
    writeFileSync(
      join(tmpHome, ".a2a-mcp", "filters.json"),
      JSON.stringify({
        filters: {
          "tail-only": {
            matchSkill: "my_skill",
            tailLines: 10,
          },
        },
      }),
    );
    resetFilterConfig();

    const input = makeLines(8); // 8 lines, within tailLines=10
    const result = applyFilters(input, { skillId: "my_skill", workerName: "test" });

    expect(result.filtersApplied).not.toContain("tail-only:head-tail");
    expect(result.output).toBe(input);
  });

  test("head-only rule still works correctly", () => {
    writeFileSync(
      join(tmpHome, ".a2a-mcp", "filters.json"),
      JSON.stringify({
        filters: {
          "head-only": {
            matchSkill: "my_skill",
            headLines: 3,
          },
        },
      }),
    );
    resetFilterConfig();

    const input = makeLines(10); // 10 lines, exceeds headLines=3
    const result = applyFilters(input, { skillId: "my_skill", workerName: "test" });

    expect(result.filtersApplied).toContain("head-only:head-tail");
    expect(result.output).toContain("line 1");
    expect(result.output).toContain("line 3");
    expect(result.output).toContain("lines omitted");
    expect(result.output).not.toContain("line 10");
  });

  test("head+tail rule keeps head and tail, omits middle", () => {
    writeFileSync(
      join(tmpHome, ".a2a-mcp", "filters.json"),
      JSON.stringify({
        filters: {
          "head-tail": {
            matchSkill: "my_skill",
            headLines: 2,
            tailLines: 2,
          },
        },
      }),
    );
    resetFilterConfig();

    const input = makeLines(10); // 10 lines, exceeds headLines+tailLines=4
    const result = applyFilters(input, { skillId: "my_skill", workerName: "test" });

    expect(result.filtersApplied).toContain("head-tail:head-tail");
    expect(result.output).toContain("line 1");
    expect(result.output).toContain("line 2");
    expect(result.output).toContain("line 9");
    expect(result.output).toContain("line 10");
    expect(result.output).toContain("lines omitted");
    // Middle lines should be omitted
    expect(result.output).not.toContain("line 5");
  });
});
