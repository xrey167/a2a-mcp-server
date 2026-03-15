import Fastify from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { buildA2AResponse, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";

const AiSchemas = {
  ask_claude: z.looseObject({ prompt: z.string().min(1), model: z.string().optional(), max_tokens: z.number().int().positive().optional() }),
  search_files: z.looseObject({ pattern: z.string().min(1), directory: z.string().optional().default(".") }),
  query_sqlite: z.looseObject({ database: z.string().min(1), sql: z.string().min(1) }),
};
import { resolve } from "node:path";
import { runClaudeCLI } from "../claude-cli.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { initPlugins, watchPlugins, pluginSkills } from "../skill-loader.js";
import { sanitizePath } from "../path-utils.js";

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
      const { prompt, model: argModel, max_tokens: argMaxTokens } = AiSchemas.ask_claude.parse({ prompt: args.prompt ?? text, ...args });
      const persona = getPersona(NAME);
      const model = argModel ?? persona.model;
      const envMaxTokens = parseInt(process.env.A2A_ASK_CLAUDE_MAX_TOKENS ?? "4096", 10);
      const maxTokens = argMaxTokens ?? (Number.isNaN(envMaxTokens) ? 4096 : envMaxTokens);
      try {
        const client = new Anthropic();
        const message = await client.messages.create({
          model, max_tokens: maxTokens,
          system: persona.systemPrompt || undefined,
          messages: [{ role: "user", content: prompt }],
        });
        if (message.content.length === 0) throw new Error("Anthropic returned empty content array");
        const textContent = message.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map(b => b.text)
          .join("\n");
        if (textContent) return textContent;
        // No text blocks — serialize first block as fallback
        const block = message.content[0];
        if (!block) throw new Error("Anthropic returned empty content array");
        return safeStringify(block);
      } catch (anthropicErr) {
        // Try Ollama/LM Studio as second fallback (OpenAI-compatible API)
        const ollamaUrl = process.env.OLLAMA_URL ?? process.env.LM_STUDIO_URL;
        const ollamaModel = process.env.OLLAMA_MODEL ?? "llama3";
        if (ollamaUrl) {
          try {
            process.stderr.write(`[${NAME}] Falling back to Ollama/LM Studio at ${ollamaUrl}\n`);
            const ollamaRes = await fetch(`${ollamaUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: ollamaModel,
                messages: [
                  ...(persona.systemPrompt ? [{ role: "system", content: persona.systemPrompt }] : []),
                  { role: "user", content: prompt },
                ],
                stream: false,
              }),
              signal: AbortSignal.timeout(120_000),
            });
            if (ollamaRes.ok) {
              const ollamaData = await ollamaRes.json() as any;
              const content = ollamaData?.message?.content ?? ollamaData?.choices?.[0]?.message?.content ?? "";
              if (content) return content;
            }
          } catch (ollamaErr) {
            process.stderr.write(`[${NAME}] Ollama fallback failed: ${ollamaErr}\n`);
          }
        }
        // Final fallback to claude CLI (Claude Code OAuth)
        return await runClaudeCLI(prompt, model);
      }
    }
    case "search_files": {
      const { pattern, directory } = AiSchemas.search_files.parse({ pattern: args.pattern ?? text, ...args });
      const safeBase = process.cwd();
      const resolvedDir = resolve(safeBase, directory);
      if (resolvedDir !== safeBase && !resolvedDir.startsWith(safeBase + "/")) {
        return "Error: directory traversal outside working directory is not allowed";
      }
      const glob = new Glob(pattern);
      const matches: string[] = [];
      for await (const file of glob.scan(resolvedDir)) {
        matches.push(file);
      }
      return matches.length > 0 ? matches.join("\n") : "No files found";
    }
    case "query_sqlite": {
      const { database, sql } = AiSchemas.query_sqlite.parse(args);
      if (!sql.trim().toUpperCase().startsWith("SELECT")) {
        return "Only SELECT queries are allowed";
      }
      const db = new Database(sanitizePath(database), { readonly: true });
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

  const sizeErr = checkRequestSize(data);
  if (sizeErr) { reply.code(413); return { jsonrpc: "2.0", error: { code: -32000, message: sizeErr } }; }

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "ask_claude";
  let resultText: string;
  try {
    const result = await handleSkill(sid, args ?? { prompt: text }, text);
    resultText = typeof result === "string" ? result : safeStringify(result, 2);
  } catch (err) {
    resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return buildA2AResponse(data.id, taskId, resultText);
});

// Init persona + plugin hot-reload
getPersona(NAME); // warm cache
watchPersonas();
initPlugins().then(() => watchPlugins());

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
