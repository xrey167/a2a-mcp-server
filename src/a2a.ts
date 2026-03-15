import { randomUUID } from "crypto";
import type { AgentCard, Part, Task } from "./types.js";

export type { AgentCard };

/** JSON-RPC 2.0 error object returned by A2A workers */
interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 2.0 envelope for A2A tasks/send responses */
interface TaskResponse {
  jsonrpc: "2.0";
  id: string;
  result?: Task;
  error?: JsonRpcError;
}

export async function sendTask(agentUrl: string, params: {
  skillId?: string; args?: Record<string, unknown>;
  message: { role: string; parts: Part[] };
  [key: string]: unknown;
}, opts?: { apiKey?: string; timeoutMs?: number }): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts?.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;
  const res = await fetch(agentUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "tasks/send", id: randomUUID(),
      params: { id: randomUUID(), ...params } }),
    redirect: "manual", // Prevent following redirects to bypass SSRF checks
    signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });

  // Reject redirects
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Redirect detected (${res.status}) — rejected to prevent SSRF bypass`);
  }

  const json = await res.json() as TaskResponse;
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  if (json.result === undefined) throw new Error("Invalid A2A response: missing both 'result' and 'error' fields.");
  const part = json.result?.artifacts?.[0]?.parts?.[0];
  if (part && part.kind === "text") return part.text;
  return JSON.stringify(json.result);
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Redirect detected (${res.status}) — rejected to prevent SSRF bypass`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverAgent(agentUrl: string): Promise<AgentCard> {
  const res = await fetch(`${agentUrl}/.well-known/agent.json`, {
    redirect: "manual", // Prevent following redirects to bypass SSRF checks
    signal: AbortSignal.timeout(10_000),
  });

  // Reject redirects
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Redirect detected (${res.status}) — rejected to prevent SSRF bypass`);
  }

  return res.json() as Promise<AgentCard>;
}

