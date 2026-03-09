/**
 * Tool registry — define all MCP tools here.
 *
 * Each tool has:
 *   - A definition (name, description, inputSchema) returned by registerTools()
 *   - A handler function dispatched by handleToolCall()
 */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── Tool Definitions ────────────────────────────────────────────

const tools: ToolDef[] = [
  {
    name: "hello",
    description: "Returns a greeting message",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name to greet" },
      },
      required: ["name"],
    },
  },
  {
    name: "echo",
    description: "Echoes back the input text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo" },
      },
      required: ["text"],
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<string, ToolHandler> = {
  async hello(args) {
    const name = String(args.name ?? "World");
    return `Hello, ${name}! Welcome to {{name}}.`;
  },

  async echo(args) {
    const text = String(args.text ?? "");
    if (!text) throw new Error("echo requires non-empty text");
    return text;
  },
};

// ── Exports ─────────────────────────────────────────────────────

export function registerTools(): ToolDef[] {
  return tools;
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args);
}
