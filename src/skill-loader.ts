/**
 * Skill Loader — dynamic skill plugins with hot-reload.
 *
 * Sources (both merged at startup):
 *   1. src/plugins/<name>/index.ts  — TypeScript skills (full logic)
 *      Each file must export: export const skills: Skill[]
 *
 *   2. <vault>/_plugins/<name>/plugin.md  — Declarative prompt-based skills
 *      Format: YAML frontmatter (id, name, description, prompt_template) + docs body
 *      These become ask_claude-backed skills (no custom code needed).
 *
 * Hot-reload: fs.watch on both directories; changes take effect immediately.
 */

import { readFileSync, existsSync, watch } from "fs";
import { readdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import type { Skill } from "./skills.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(__dirname, "plugins");
const VAULT_PLUGINS_DIR = join(
  process.env.OBSIDIAN_VAULT ?? join(homedir(), "Documents/Obsidian/a2a-knowledge"),
  "_plugins"
);

// ── State ────────────────────────────────────────────────────────

/** Combined map of all dynamically loaded skills: id → Skill */
export const pluginSkills = new Map<string, Skill>();

let changeCallback: (() => void) | null = null;

// ── TypeScript plugins (src/plugins/) ────────────────────────────

async function loadTsPlugins(): Promise<Skill[]> {
  if (!existsSync(PLUGINS_DIR)) return [];

  const skills: Skill[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(PLUGINS_DIR);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const indexFile = join(PLUGINS_DIR, entry, "index.ts");
    if (!existsSync(indexFile)) continue;
    try {
      // Cache-bust with timestamp to force re-import on hot-reload
      const mod = await import(`${indexFile}?t=${Date.now()}`);
      const exported = mod.skills ?? mod.default?.skills;
      if (Array.isArray(exported)) {
        skills.push(...exported);
        process.stderr.write(`[skill-loader] loaded plugin: ${entry} (${exported.length} skills)\n`);
      }
    } catch (err) {
      process.stderr.write(`[skill-loader] failed to load plugin ${entry}: ${err}\n`);
    }
  }

  return skills;
}

// ── Declarative vault plugins (_plugins/) ────────────────────────

function parsePluginMd(content: string): { id: string; name: string; description: string; promptTemplate: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    meta[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
  }

  if (!meta.id || !meta.name) return null;

  return {
    id: meta.id,
    name: meta.name,
    description: meta.description ?? "",
    promptTemplate: meta.prompt_template ?? match[2].trim(),
  };
}

async function loadVaultPlugins(): Promise<Skill[]> {
  if (!existsSync(VAULT_PLUGINS_DIR)) return [];

  const skills: Skill[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(VAULT_PLUGINS_DIR);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const mdFile = join(VAULT_PLUGINS_DIR, entry, "plugin.md");
    if (!existsSync(mdFile)) continue;
    try {
      const parsed = parsePluginMd(readFileSync(mdFile, "utf-8"));
      if (!parsed) continue;

      const { id, name, description, promptTemplate } = parsed;

      // Declarative skill: runs the prompt template via ask_claude
      const skill: Skill = {
        id,
        name,
        description,
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string", description: "Input for this skill" },
          },
          required: ["input"],
        },
        run: async ({ input }) => {
          const prompt = promptTemplate.replace("{{input}}", String(input ?? ""));
          // Delegate to ask_claude skill via dynamic import to avoid circular deps
          const { SKILL_MAP } = await import("./skills.js");
          const askClaude = SKILL_MAP.get("ask_claude");
          if (!askClaude) return `ask_claude not available for vault plugin: ${id}`;
          return askClaude.run({ prompt });
        },
      };

      skills.push(skill);
      process.stderr.write(`[skill-loader] loaded vault plugin: ${entry} (${id})\n`);
    } catch (err) {
      process.stderr.write(`[skill-loader] failed to load vault plugin ${entry}: ${err}\n`);
    }
  }

  return skills;
}

// ── Reload ───────────────────────────────────────────────────────

async function reload() {
  pluginSkills.clear();
  const [tsSkills, vaultSkills] = await Promise.all([loadTsPlugins(), loadVaultPlugins()]);
  for (const skill of [...tsSkills, ...vaultSkills]) {
    pluginSkills.set(skill.id, skill);
  }
  if (changeCallback) changeCallback();
}

// ── Public API ───────────────────────────────────────────────────

/** Load all plugins from disk. Call once at startup. */
export async function initPlugins() {
  await reload();
  process.stderr.write(`[skill-loader] loaded ${pluginSkills.size} plugin skills\n`);
}

/**
 * Watch both plugin directories for changes.
 * Pass a callback to be notified when skills are reloaded.
 */
export function watchPlugins(onReload?: () => void) {
  changeCallback = onReload ?? null;

  if (existsSync(PLUGINS_DIR)) {
    try {
      watch(PLUGINS_DIR, { recursive: true }, async (eventType, filename) => {
        if (!filename) return;
        process.stderr.write(`[skill-loader] change detected in plugins: ${filename}\n`);
        await reload();
      });
      process.stderr.write(`[skill-loader] watching ${PLUGINS_DIR}\n`);
    } catch {}
  }

  if (existsSync(VAULT_PLUGINS_DIR)) {
    try {
      watch(VAULT_PLUGINS_DIR, { recursive: true }, async (eventType, filename) => {
        if (!filename) return;
        process.stderr.write(`[skill-loader] change detected in vault plugins: ${filename}\n`);
        await reload();
      });
      process.stderr.write(`[skill-loader] watching ${VAULT_PLUGINS_DIR}\n`);
    } catch {}
  }
}
