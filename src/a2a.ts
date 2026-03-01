import { randomUUID } from "crypto";
import type { AgentCard, Message } from "./types.js";

/** Coerce any A2A Part shape to a plain string for MCP callers. */
function extractPartText(part: unknown): string {
  if (typeof part !== "object" || part === null) return String(part);
  const p = part as Record<string, unknown>;
  if (!p.kind || p.kind === "text") return (p.text as string) ?? "";
  if (p.kind === "data") return JSON.stringify(p.data);
  if (p.kind === "file") {
    const f = p.file as Record<string, unknown> | undefined;
    return f?.uri ? `file:${f.uri}` : f?.name ? `file:${f.name}` : "[file]";
  }
  return JSON.stringify(part);
}

export type { AgentCard };

const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTask(agentUrl: string, params: {
  skillId?: string; args?: Record<string, unknown>;
  message: Message | { role: string; parts: Array<{ text: string }> };
  contextId?: string;
}, options: { apiKey?: string; timeoutMs?: number } = {}): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey) headers["Authorization"] = `Bearer ${options.apiKey}`;
  const res = await fetchWithTimeout(agentUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "tasks/send", id: randomUUID(),
      params: { id: randomUUID(), ...params } }),
  }, options.timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${agentUrl}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Invalid JSON response from ${agentUrl}`);
  }
  if (typeof json !== "object" || json === null) {
    throw new Error(`Unexpected response from ${agentUrl}: ${JSON.stringify(json)}`);
  }
  const obj = json as Record<string, unknown>;
  if (obj.error) {
    const err = obj.error as Record<string, unknown>;
    throw new Error((err.message as string) ?? JSON.stringify(err));
  }
  const firstPart = (obj.result as any)?.artifacts?.[0]?.parts?.[0];
  return firstPart !== undefined ? extractPartText(firstPart) : JSON.stringify(obj.result);
}

export async function discoverAgent(agentUrl: string): Promise<AgentCard> {
  const res = await fetchWithTimeout(`${agentUrl}/.well-known/agent.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${agentUrl}/.well-known/agent.json`);
  return res.json();
}
