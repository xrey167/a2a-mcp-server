import { randomUUID } from "crypto";
import type { AgentCard, Message } from "./types.js";

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
}): Promise<string> {
  const res = await fetchWithTimeout(agentUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tasks/send", id: randomUUID(),
      params: { id: randomUUID(), ...params } }),
  });
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
  return (obj.result as any)?.artifacts?.[0]?.parts?.[0]?.text ?? JSON.stringify(obj.result);
}

export async function discoverAgent(agentUrl: string): Promise<AgentCard> {
  const res = await fetchWithTimeout(`${agentUrl}/.well-known/agent.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${agentUrl}/.well-known/agent.json`);
  return res.json();
}
