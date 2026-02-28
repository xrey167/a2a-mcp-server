import Fastify from "fastify";
import { spawnSync } from "child_process";
import { handleMemorySkill } from "../worker-memory.js";
import { getPersona, watchPersonas } from "../persona-loader.js";

const PORT = 8084;
const NAME = "code-agent";

const AGENT_CARD = {
  name: NAME,
  description: "Code agent — execute and review code via Codex, persistent memory",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "codex_exec", name: "Codex Exec", description: "Execute a coding task via Codex with full disk read and network access" },
    { id: "codex_review", name: "Codex Review", description: "Review code via Codex with full disk read access" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

function handleSkill(skillId: string, args: Record<string, unknown>, text: string): string {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;
  switch (skillId) {
    case "codex_exec": {
      const prompt = (args.prompt as string) ?? text;
      const result = spawnSync(
        "codex", ["exec", "--full-auto", prompt],
        { encoding: "utf-8", timeout: 120_000 }
      );
      if (result.error) return `Error: ${result.error.message}`;
      if (result.status !== 0) return `Exit ${result.status}: ${result.stderr?.trim() || result.stdout?.trim()}`;
      return result.stdout?.trim() || "(no output)";
    }
    case "codex_review": {
      const result = spawnSync(
        "codex", ["exec", "review", "--full-auto"],
        { encoding: "utf-8", timeout: 120_000 }
      );
      if (result.error) return `Error: ${result.error.message}`;
      if (result.status !== 0) return `Exit ${result.status}: ${result.stderr?.trim() || result.stdout?.trim()}`;
      return result.stdout?.trim() || "(no output)";
    }
    default:
      return `Unknown skill: ${skillId}`;
  }
}

const app = Fastify({ logger: false });

app.get("/.well-known/agent.json", async () => AGENT_CARD);

app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
  const data = request.body;
  if (data?.method !== "tasks/send") {
    reply.code(404);
    return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
  }

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "codex_exec";
  let resultText: string;
  try {
    resultText = handleSkill(sid, args ?? { prompt: text }, text);
  } catch (err) {
    resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    jsonrpc: "2.0", id: data.id,
    result: { id: taskId, status: { state: "completed" },
      artifacts: [{ parts: [{ kind: "text" as const, text: resultText }] }] },
  };
});

getPersona(NAME);
watchPersonas();

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
