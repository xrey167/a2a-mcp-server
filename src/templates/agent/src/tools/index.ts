/**
 * Tool registry — agent tools that Claude can call.
 *
 * Each tool defines:
 *   - spec: Anthropic-format tool definition (name, description, input_schema)
 *   - execute: the handler function
 */

import type Anthropic from "@anthropic-ai/sdk";

export interface Tool {
  spec: Anthropic.Messages.Tool;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

// ── Tool: get_time ──────────────────────────────────────────────

const getTime: Tool = {
  spec: {
    name: "get_time",
    description: "Returns the current date and time in ISO format",
    input_schema: {
      type: "object" as const,
      properties: {
        timezone: {
          type: "string",
          description: "IANA timezone (e.g. 'America/New_York'). Defaults to UTC.",
        },
      },
      required: [],
    },
  },
  async execute(input) {
    const tz = (input.timezone as string) || "UTC";
    try {
      return new Date().toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" });
    } catch {
      return `Invalid timezone: ${tz}. Use IANA format (e.g. America/New_York).`;
    }
  },
};

// ── Tool: calculate ─────────────────────────────────────────────

const calculate: Tool = {
  spec: {
    name: "calculate",
    description: "Evaluate a mathematical expression and return the result",
    input_schema: {
      type: "object" as const,
      properties: {
        expression: {
          type: "string",
          description: "Math expression to evaluate (e.g. '2 + 2', 'Math.sqrt(16)')",
        },
      },
      required: ["expression"],
    },
  },
  async execute(input) {
    const expr = String(input.expression ?? "");
    if (!expr) return "Error: expression is required";
    // Only allow safe math operations
    if (!/^[\d\s+\-*/().,%Math\w]+$/.test(expr)) {
      return "Error: expression contains disallowed characters";
    }
    try {
      const fn = new Function(`"use strict"; return (${expr});`);
      const result = fn();
      return String(result);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ── Registry ────────────────────────────────────────────────────

export const tools: Tool[] = [getTime, calculate];

export const toolMap = new Map<string, Tool>(
  tools.map((t) => [t.spec.name, t]),
);
