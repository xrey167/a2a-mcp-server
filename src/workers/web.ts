import Fastify from "fastify";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { buildA2AResponse, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";

const WebSchemas = {
  fetch_url: z.object({ url: z.string().url(), format: z.enum(["text", "json"]).optional().default("text") }).passthrough(),
  call_api: z.object({ url: z.string().url(), method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().default("GET"), headers: z.record(z.string()).optional().default({}), body: z.unknown().optional() }).passthrough(),
};

const PORT = 8082;
const NAME = "web-agent";

// Configurable timeouts (env vars set by orchestrator, or sensible defaults)
const FETCH_TIMEOUT_MS = parseInt(process.env.A2A_FETCH_TIMEOUT ?? "30000", 10);
const MAX_RESPONSE_BYTES = parseInt(process.env.A2A_MAX_RESPONSE_BYTES ?? String(10 * 1024 * 1024), 10); // 10MB
const RATE_LIMIT_RPM = parseInt(process.env.A2A_WEB_RATE_LIMIT ?? "0", 10); // 0 = unlimited

// Simple token-bucket rate limiter (per-minute)
const rateBucket = { tokens: RATE_LIMIT_RPM, lastRefill: Date.now() };
function checkRateLimit(): boolean {
  if (RATE_LIMIT_RPM <= 0) return true; // unlimited
  const now = Date.now();
  const elapsed = now - rateBucket.lastRefill;
  if (elapsed >= 60_000) {
    rateBucket.tokens = RATE_LIMIT_RPM;
    rateBucket.lastRefill = now;
  }
  if (rateBucket.tokens <= 0) return false;
  rateBucket.tokens--;
  return true;
}

/** Read response body with a hard byte limit. Returns null if limit exceeded. */
async function readBodyWithLimit(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let chunks: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel();
        return null;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    // Flush decoder
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

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
  if (!checkRateLimit()) return "Rate limit exceeded — try again in a moment";
  switch (skillId) {
    case "fetch_url": {
      const { url, format } = WebSchemas.fetch_url.parse({ url: args.url ?? text, ...args });
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;
      // Early reject if content-length header is set and exceeds limit
      const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
      if (contentLength > MAX_RESPONSE_BYTES) return `Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`;
      // Stream body with byte limit to guard against missing/spoofed content-length
      const body = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
      if (body === null) return `Response too large: exceeded ${MAX_RESPONSE_BYTES} byte limit during streaming`;
      return format === "json"
        ? safeStringify(JSON.parse(body), 2)
        : body;
    }
    case "call_api": {
      const { url, method, headers, body } = WebSchemas.call_api.parse({ url: args.url ?? text, ...args });
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body ? safeStringify(body) : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return `HTTP ${res.status}\n${await res.text()}`;
    }
    default:
      return `Unknown skill: ${skillId}`;
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
  const sid = skillId ?? "fetch_url";
  let resultText: string;
  try {
    resultText = await handleSkill(sid, args ?? { url: text }, text);
  } catch (err) {
    resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return buildA2AResponse(data.id, taskId, resultText);
});

getPersona(NAME);
watchPersonas();

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
