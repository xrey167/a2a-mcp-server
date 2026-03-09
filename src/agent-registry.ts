import { readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { discoverAgent } from "./a2a.js";
import type { AgentCard } from "./types.js";

const REGISTRY_FILE = join(homedir(), ".a2a-external-agents.json");

export interface RegistryEntry {
  url: string;
  card: AgentCard;
  registeredAt: number;
  apiKey?: string;
}

let registry: Map<string, RegistryEntry> = new Map();

function loadFromFile(): RegistryEntry[] {
  try { return JSON.parse(readFileSync(REGISTRY_FILE, "utf-8")) as RegistryEntry[]; } catch { return []; }
}

function saveToFile(): void {
  try {
    // mode 0o600: owner read/write only — API keys must not be world-readable
    writeFileSync(REGISTRY_FILE, JSON.stringify(Array.from(registry.values()), null, 2), { mode: 0o600 });
    chmodSync(REGISTRY_FILE, 0o600); // enforce on pre-existing files
  } catch (err) {
    process.stderr.write(`[agent-registry] failed to save registry: ${err}\n`);
  }
}

export function initAgentRegistry(): void {
  registry = new Map(loadFromFile().map(e => [e.url, e]));
}

export async function registerAgent(url: string, apiKey?: string): Promise<AgentCard> {
  const card = await discoverAgent(url);
  const entry: RegistryEntry = { url, card, registeredAt: Date.now(), apiKey };
  registry.set(url, entry);
  saveToFile();
  return card;
}

export function getAgentApiKey(url: string): string | undefined {
  return registry.get(url)?.apiKey;
}

export function unregisterAgent(url: string): boolean {
  const existed = registry.has(url);
  registry.delete(url);
  if (existed) saveToFile();
  return existed;
}

export function getExternalCards(): AgentCard[] {
  return Array.from(registry.values()).map(e => e.card);
}

export function getRegistryEntries(): RegistryEntry[] {
  return Array.from(registry.values());
}
