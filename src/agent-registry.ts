import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { discoverAgent } from "./a2a.js";
import type { AgentCard } from "./types.js";

const REGISTRY_FILE = join(homedir(), ".a2a-external-agents.json");

export interface RegistryEntry {
  url: string;
  card: AgentCard;
  registeredAt: number;
  lastSeenAt?: number;
}

let registry: Map<string, RegistryEntry> = new Map();

function loadFromFile(): RegistryEntry[] {
  try { return JSON.parse(readFileSync(REGISTRY_FILE, "utf-8")) as RegistryEntry[]; } catch { return []; }
}

function saveToFile(): void {
  try { writeFileSync(REGISTRY_FILE, JSON.stringify(Array.from(registry.values()), null, 2)); } catch {}
}

export function initAgentRegistry(): void {
  registry = new Map(loadFromFile().map(e => [e.url, e]));
}

export async function registerAgent(url: string): Promise<AgentCard> {
  const card = await discoverAgent(url);
  const entry: RegistryEntry = { url, card, registeredAt: Date.now(), lastSeenAt: Date.now() };
  registry.set(url, entry);
  saveToFile();
  return card;
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

export function touchAgent(url: string): void {
  const entry = registry.get(url);
  if (entry) entry.lastSeenAt = Date.now();
}
