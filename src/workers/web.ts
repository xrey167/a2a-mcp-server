import Fastify from "fastify";
import { handleMemorySkill } from "../worker-memory.js";
import { getPersona, watchPersonas } from "../persona-loader.js";

const PORT = 8082;
const NAME = "web-agent";

const AGENT_CARD = {
  name: NAME,
  description: "Web/HTTP agent — fetch URLs, call APIs, persistent memory",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "fetch_url", name: "Fetch URL", description: "Fetch content from a URL (text or JSON)" },
    { id: "call_api", name: "Call API", description: "Make an HTTP request to an external API" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;
  switch (skillId) {
    case "fetch_url": {
      const url = (args.url as string) ?? text;
      const format = (args.format as string) ?? "text";
      const res = await fetch(url);
      if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;
      return format === "json"
        ? JSON.stringify(await res.json(), null, 2)
        : await res.text();
    }
    case "call_api": {
      const url = args.url as string;
      const method = (args.method as string) ?? "GET";
      const headers = (args.headers as Record<string, string>) ?? {};
      const body = args.body;
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return `HTTP ${res.status}\n${await res.text()}`;
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
  const sid = skillId ?? "fetch_url";
  let resultText: string;
  try {
    resultText = await handleSkill(sid, args ?? { url: text }, text);
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
