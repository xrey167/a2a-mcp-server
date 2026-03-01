import Fastify from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { handleMemorySkill } from "../worker-memory.js";
import { runClaudeCLI } from "../claude-cli.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { initPlugins, watchPlugins, pluginSkills } from "../skill-loader.js";

const PORT = 8083;
const NAME = "ai-agent";

const AGENT_CARD = {
  name: NAME,
  description: "AI agent — Claude, file search, SQLite queries, persistent memory",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "ask_claude", name: "Ask Claude", description: "Send a prompt to Claude and return the response" },
    { id: "search_files", name: "Search Files", description: "Find files matching a glob pattern" },
    { id: "query_sqlite", name: "Query SQLite", description: "Run a read-only SQL query against a SQLite database" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string | Record<string, unknown>> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;
  switch (skillId) {
    case "ask_claude": {
      const prompt = (args.prompt as string) ?? text;
      const persona = getPersona(NAME);
      const model = (args.model as string) ?? persona.model;
      try {
        const client = new Anthropic();
        const message = await client.messages.create({
          model, max_tokens: 1024,
          system: persona.systemPrompt || undefined,
          messages: [{ role: "user", content: prompt }],
        });
        const block = message.content[0];
        return block.type === "text" ? block.text : JSON.stringify(block);
      } catch {
        // 15s hard limit — the CLI can stall when called from inside a running
        // Claude Code session (port conflicts on MCP server re-spawn).
        return await runClaudeCLI(prompt, model, 15_000);
      }
    }
    case "search_files": {
      const pattern = (args.pattern as string) ?? text;
      const directory = (args.directory as string) ?? ".";
      const glob = new Glob(pattern);
      const matches: string[] = [];
      for await (const file of glob.scan(directory)) {
        matches.push(file);
      }
      return matches.length > 0 ? matches.join("\n") : "No files found";
    }
    case "query_sqlite": {
      const database = args.database as string;
      const sql = args.sql as string;
      if (!sql.trim().toUpperCase().startsWith("SELECT")) {
        return "Only SELECT queries are allowed";
      }
      const db = new Database(database, { readonly: true });
      try {
        const rows = db.query(sql).all();
        return { kind: "data" as const, data: rows };
      } finally {
        db.close();
      }
    }
    default: {
      // Check dynamically loaded plugin skills
      const plugin = pluginSkills.get(skillId);
      if (plugin) return plugin.run(args);
      return `Unknown skill: ${skillId}`;
    }
  }
}

const app = Fastify({ logger: false });

app.get("/.well-known/agent.json", async () => AGENT_CARD);

app.get("/healthz", async () => ({
  status: "ok",
  agent: NAME,
  uptime: process.uptime(),
  skills: AGENT_CARD.skills.map(s => s.id),
}));

app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
  const data = request.body;
  if (data?.method !== "tasks/send") {
    reply.code(404);
    return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
  }

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "ask_claude";
  const result = await handleSkill(sid, args ?? { prompt: text }, text);
  const part = typeof result === "string"
    ? { kind: "text" as const, text: result }
    : result;

  return {
    jsonrpc: "2.0", id: data.id,
    result: { id: taskId, status: { state: "completed" },
      artifacts: [{ parts: [part] }] },
  };
});

// Init persona + plugin hot-reload
getPersona(NAME); // warm cache
watchPersonas();
initPlugins().then(() => watchPlugins());

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
