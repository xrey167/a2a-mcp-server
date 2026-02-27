/**
 * Persona Loader — reads src/personas/<agent-name>.md, injects into Claude calls.
 *
 * Format:
 *   ---
 *   model: claude-sonnet-4-6
 *   temperature: 0.7
 *   ---
 *
 *   System prompt body here (plain markdown, no strict format).
 *
 * Hot-reload: file watcher updates cache on save. No restart needed.
 */

import { readFileSync, existsSync, watch } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = join(__dirname, "personas");

// ── Types ────────────────────────────────────────────────────────

export interface PersonaConfig {
  model: string;
  temperature: number;
  systemPrompt: string;
}

const DEFAULT_PERSONA: PersonaConfig = {
  model: "claude-sonnet-4-6",
  temperature: 0.7,
  systemPrompt: "",
};

// ── Cache ────────────────────────────────────────────────────────

const cache = new Map<string, PersonaConfig>();

// ── Parse ────────────────────────────────────────────────────────

function parsePersonaFile(content: string): PersonaConfig {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { ...DEFAULT_PERSONA, systemPrompt: content.trim() };
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key) meta[key] = val;
  }

  return {
    model: meta.model ?? DEFAULT_PERSONA.model,
    temperature: meta.temperature ? parseFloat(meta.temperature) : DEFAULT_PERSONA.temperature,
    systemPrompt: match[2].trim(),
  };
}

function loadFromDisk(agentName: string): PersonaConfig {
  const filePath = join(PERSONAS_DIR, `${agentName}.md`);
  if (!existsSync(filePath)) return { ...DEFAULT_PERSONA };
  try {
    return parsePersonaFile(readFileSync(filePath, "utf-8"));
  } catch (err) {
    process.stderr.write(`[persona-loader] failed to load ${agentName}: ${err}\n`);
    return { ...DEFAULT_PERSONA };
  }
}

// ── Public API ───────────────────────────────────────────────────

/** Get the persona for an agent (from cache or disk). */
export function getPersona(agentName: string): PersonaConfig {
  if (!cache.has(agentName)) {
    cache.set(agentName, loadFromDisk(agentName));
  }
  return cache.get(agentName)!;
}

/** Force reload all cached personas from disk. */
export function reloadPersonas() {
  for (const agentName of cache.keys()) {
    cache.set(agentName, loadFromDisk(agentName));
  }
  process.stderr.write(`[persona-loader] reloaded ${cache.size} personas\n`);
}

/**
 * Start watching the personas directory for changes.
 * Call once at startup; reloads are automatic on save.
 */
export function watchPersonas() {
  if (!existsSync(PERSONAS_DIR)) return;
  try {
    watch(PERSONAS_DIR, (eventType, filename) => {
      if (!filename?.endsWith(".md")) return;
      const agentName = filename.replace(/\.md$/, "");
      const updated = loadFromDisk(agentName);
      cache.set(agentName, updated);
      process.stderr.write(`[persona-loader] reloaded persona: ${agentName}\n`);
    });
    process.stderr.write(`[persona-loader] watching ${PERSONAS_DIR}\n`);
  } catch {}
}
