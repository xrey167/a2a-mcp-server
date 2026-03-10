import { randomUUID } from "crypto";

export interface AgentCard {
  name: string; description: string; url: string; version: string;
  capabilities: { streaming: boolean };
  skills: Array<{ id: string; name: string; description: string }>;
}

export async function sendTask(agentUrl: string, params: {
  skillId?: string; args?: Record<string, unknown>;
  message: { role: string; parts: Array<{ text: string }> };
}): Promise<string> {
  const res = await fetch(agentUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tasks/send", id: randomUUID(),
      params: { id: randomUUID(), ...params } }),
    redirect: "manual", // Prevent following redirects to bypass SSRF checks
  });

  // Reject redirects
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Redirect detected (${res.status}) — rejected to prevent SSRF bypass`);
  }

  const json = await res.json() as any;
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  return json.result?.artifacts?.[0]?.parts?.[0]?.text ?? JSON.stringify(json.result);
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
  });

  // Reject redirects
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Redirect detected (${res.status}) — rejected to prevent SSRF bypass`);
  }

  return res.json();
}

export async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs: number = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Redirect detected (${res.status}) — rejected to prevent SSRF bypass`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}
