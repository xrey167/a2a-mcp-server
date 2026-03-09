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

/**
 * Safe math evaluator — parses and evaluates arithmetic without eval/Function.
 * Supports: +, -, *, /, %, parentheses, decimals, negative numbers.
 */
function safeEvaluate(expr: string): number {
  const tokens = expr.match(/(\d+\.?\d*|[+\-*/%()])/g);
  if (!tokens) throw new Error("Empty or invalid expression");

  let pos = 0;

  function peek(): string | undefined { return tokens[pos]; }
  function consume(): string {
    if (pos >= tokens.length) throw new Error("Unexpected end of expression");
    return tokens[pos++];
  }

  // Grammar: expr → term ((+|-) term)*
  function parseExpr(): number {
    let result = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const right = parseTerm();
      result = op === "+" ? result + right : result - right;
    }
    return result;
  }

  // term → factor ((*|/|%) factor)*
  function parseTerm(): number {
    let result = parseFactor();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = consume();
      const right = parseFactor();
      if (op === "*") result *= right;
      else if (op === "/") {
        if (right === 0) throw new Error("Division by zero");
        result /= right;
      } else result %= right;
    }
    return result;
  }

  // factor → number | '(' expr ')' | '-' factor
  function parseFactor(): number {
    const token = peek();
    if (token === "(") {
      consume(); // (
      const result = parseExpr();
      if (consume() !== ")") throw new Error("Missing closing parenthesis");
      return result;
    }
    if (token === "-") {
      consume();
      return -parseFactor();
    }
    const num = consume();
    const value = Number(num);
    if (isNaN(value)) throw new Error(`Invalid number: ${num}`);
    return value;
  }

  const result = parseExpr();
  if (pos < tokens.length) throw new Error(`Unexpected token: ${tokens[pos]}`);
  return result;
}

const calculate: Tool = {
  spec: {
    name: "calculate",
    description: "Evaluate a mathematical expression and return the result",
    input_schema: {
      type: "object" as const,
      properties: {
        expression: {
          type: "string",
          description: "Math expression to evaluate (e.g. '2 + 2', '(10 - 3) * 4', '100 / 3')",
        },
      },
      required: ["expression"],
    },
  },
  async execute(input) {
    const expr = String(input.expression ?? "");
    if (!expr) return "Error: expression is required";
    try {
      const result = safeEvaluate(expr);
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
