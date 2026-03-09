/**
 * Peer discovery for A2A workers.
 *
 * Workers import callPeer() to invoke skills on other workers directly
 * (no orchestrator routing hop). Discovery calls the orchestrator's
 * list_agents once to build a skillId → workerUrl map, then caches it
 * for 60 s so subsequent calls go straight to the target worker.
 *
 * Usage in any worker:
 *   import { callPeer } from "../peer.js";
 *   const summary = await callPeer("ask_claude", { prompt }, prompt, 60_000);
 */

import { sendTask } from "./a2a.js";
import type { AgentCard } from "./types.js";

const ORCHESTRATOR_URL = process.env.A2A_ORCHESTRATOR_URL ?? "http://localhost:8080";
const CACHE_TTL_MS = 60_000;

let skillMap: Map<string, string> | null = null;
let cachedAt = 0;

// ── Discovery ────────────────────────────────────────────────────

async function refreshPeerMap(): Promise<Map<string, string>> {
  try {
    const raw = await sendTask(ORCHESTRATOR_URL, {
      skillId: "list_agents",
      args: {},
      message: { role: "user" as const, parts: [{ kind: "text" as const, text: "" }] },
    });
    const agents: Array<AgentCard & { source?: string }> = JSON.parse(raw);
    const map = new Map<string, string>();
    for (const agent of agents) {
      for (const skill of agent.skills ?? []) {
        map.set(skill.id, agent.url);
      }
    }
    skillMap = map;
    cachedAt = Date.now();
    process.stderr.write(`[peer] discovered ${map.size} skills across ${agents.length} agents\n`);
    return map;
  } catch (err) {
    process.stderr.write(`[peer] discovery failed: ${err}\n`);
    return skillMap ?? new Map(); // return stale cache on failure
  }
}

/** Return the current peer skill map, refreshing if stale (>60 s). */
export async function getPeerMap(): Promise<Map<string, string>> {
  if (skillMap && Date.now() - cachedAt < CACHE_TTL_MS) return skillMap;
  return refreshPeerMap();
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Call a skill on a peer worker directly (bypasses orchestrator routing).
 * On first call, discovers peers via the orchestrator's list_agents.
 * Subsequent calls use the 60-second cache — no orchestrator hop.
 * Throws if no peer has the requested skill.
 */
export async function callPeer(
  skillId: string,
  args: Record<string, unknown>,
  message = "",
  timeoutMs?: number,
): Promise<string> {
  let map = await getPeerMap();
  let url = map.get(skillId);

  if (!url) {
    // Refresh once in case a new worker was registered since last discovery
    map = await refreshPeerMap();
    url = map.get(skillId);
    if (!url) throw new Error(`No peer found with skill: ${skillId}`);
  }

  try {
    return await sendTask(
      url,
      { skillId, args, message: { role: "user" as const, parts: [{ kind: "text" as const, text: message }] } },
      { timeoutMs },
    );
  } catch (err) {
    skillMap = null; // invalidate cache so next call re-discovers
    throw err;
  }
}
