/**
 * Template loader — reads project templates from disk and applies variable substitution.
 *
 * Two types of template content:
 *   1. Code templates (src/templates/<pipelineId>/) — real source files with {{var}} substitution
 *   2. Spec templates (src/templates/<pipelineId>/TEMPLATE.md) — prompt enhancement documents
 *      that guide AI code generation with domain-specific features and quality checklists
 *
 * Template variants live in src/templates/variants/<pipelineId>/<variantId>/TEMPLATE.md
 * and provide domain-specific prompt enhancements (e.g. saas-starter, e-commerce, social-app).
 */

import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";
import { readdir, readFile, stat } from "fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TemplateVars {
  name: string;
  description?: string;
  [key: string]: string | undefined;
}

export interface TemplateFile {
  /** Relative path from template root (with vars substituted in path) */
  relativePath: string;
  /** File content with vars substituted */
  content: string;
}

/** Parsed TEMPLATE.md spec — drives prompt enhancement and quality checking */
export interface TemplateSpec {
  /** Pipeline this spec belongs to */
  pipelineId: string;
  /** Variant ID (e.g. "saas-starter") or null for base pipeline spec */
  variantId: string | null;
  /** Human-readable variant name */
  name: string;
  /** Description of what this template produces */
  description: string;
  /** Pre-configured features this variant injects */
  features: string[];
  /** Ideal use cases */
  idealFor: string[];
  /** Expected file structure (directory tree description) */
  fileStructure: string;
  /** Default tech stack additions beyond the base pipeline */
  techStack: Record<string, string>;
  /** Prompt enhancement rules — how to expand vague ideas with domain features */
  promptEnhancement: string;
  /** Domain-specific quality checklist items for Ralph */
  qualityChecklist: string[];
  /** Customization points users can tweak */
  customizationPoints: string[];
  /** Raw markdown content */
  raw: string;
}

/** Variant summary for listing/matching */
export interface VariantSummary {
  pipelineId: string;
  variantId: string;
  name: string;
  description: string;
  idealFor: string[];
}

// ── File Collection ─────────────────────────────────────────────

async function collectFiles(dir: string, base: string = dir): Promise<Array<{ abs: string; rel: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<{ abs: string; rel: string }> = [];

  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(abs, base));
    } else if (entry.isFile()) {
      files.push({ abs, rel: relative(base, abs) });
    }
  }

  return files;
}

/**
 * Sanitize a template variable value to prevent injection.
 * Strips characters that could break out of string contexts in generated code,
 * path traversal sequences, and shell metacharacters.
 *
 * Exported for testing.
 */
export function sanitizeVar(value: string): string {
  return value
    // Strip null bytes and all ASCII control characters (newlines, tabs, etc.)
    .replace(/[\x00-\x1f\x7f]/g, "")
    // Strip string delimiters and template/escape chars (JS, TS, shell, Python, etc.)
    .replace(/[`$\\"']/g, "")
    // Strip path separators to prevent directory traversal
    .replace(/\//g, "")
    // Strip double-dot sequences that remain after stripping slashes
    .replace(/\.\./g, "")
    // Strip shell metacharacters
    .replace(/[;&|<>(){}[\]!#*?]/g, "")
    .trim();
}

function substitute(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = vars[key];
    if (value === undefined) return match;
    return sanitizeVar(value);
  });
}

// ── Code Template Loading ───────────────────────────────────────

/**
 * Load all template files for a pipeline, with variable substitution applied.
 * Excludes TEMPLATE.md spec files from the output.
 */
export async function loadTemplate(pipelineId: string, vars: TemplateVars): Promise<TemplateFile[]> {
  const templateDir = join(__dirname, pipelineId);

  try {
    const s = await stat(templateDir);
    if (!s.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Template not found for pipeline: ${pipelineId} (expected ${templateDir})`);
  }

  const rawFiles = await collectFiles(templateDir);
  const result: TemplateFile[] = [];

  for (const { abs, rel } of rawFiles) {
    // Skip TEMPLATE.md — it's a spec doc, not a code file
    if (rel === "TEMPLATE.md" || rel.endsWith("/TEMPLATE.md")) continue;

    const content = await readFile(abs, "utf-8");
    let resolvedPath = substitute(rel, vars);
    resolvedPath = resolvedPath.replace(/__name__/g, sanitizeVar(vars.name));

    // Substitute {{vars}} and __name__ in content too (for consistency with paths)
    let resolvedContent = substitute(content, vars);
    resolvedContent = resolvedContent.replace(/__name__/g, sanitizeVar(vars.name));

    result.push({
      relativePath: resolvedPath,
      content: resolvedContent,
    });
  }

  return result;
}

// ── Spec Template Parsing ───────────────────────────────────────

/**
 * Parse a TEMPLATE.md into a structured TemplateSpec.
 * Extracts sections by markdown headers.
 */
function parseTemplateSpec(
  raw: string,
  pipelineId: string,
  variantId: string | null,
): TemplateSpec {
  const sections = new Map<string, string>();
  let currentSection = "_header";
  let currentContent: string[] = [];

  for (const line of raw.split("\n")) {
    const headerMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      sections.set(currentSection.toLowerCase(), currentContent.join("\n").trim());
      currentSection = headerMatch[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  sections.set(currentSection.toLowerCase(), currentContent.join("\n").trim());

  // Extract bullet lists from a section
  const extractBullets = (key: string): string[] => {
    const content = sections.get(key) ?? "";
    return content
      .split("\n")
      .filter(l => l.match(/^[-*]\s+\[?\s*\]?\s*/))
      .map(l => l.replace(/^[-*]\s+\[?\s*\]?\s*/, "").trim())
      .filter(Boolean);
  };

  // Extract table rows as key-value pairs
  const extractTable = (key: string): Record<string, string> => {
    const content = sections.get(key) ?? "";
    const result: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
      if (match) {
        const keyCell = match[1].trim();
        const valueCell = match[2].trim();
        const isHeaderSeparator =
          keyCell.includes("---") || valueCell.includes("---");
        const isHeaderRow = keyCell.toLowerCase() === "component";
        if (!isHeaderSeparator && !isHeaderRow) {
          result[keyCell] = valueCell;
        }
      }
    }
    return result;
  };

  // Try multiple section name variations
  const getSection = (...keys: string[]): string => {
    for (const k of keys) {
      const val = sections.get(k.toLowerCase());
      if (val) return val;
    }
    return "";
  };

  // Extract name from header metadata or first heading
  const headerText = sections.get("_header") ?? "";
  const nameMatch = headerText.match(/\*\*(?:Pipeline|Category|Template)\*\*:\s*(.+)/);

  return {
    pipelineId,
    variantId,
    name: variantId
      ? variantId.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ")
      : pipelineId,
    description: getSection("description"),
    features: [
      ...extractBullets("core features"),
      ...extractBullets("pre-configured features"),
    ],
    idealFor: extractBullets("ideal for"),
    fileStructure: getSection("file structure"),
    techStack: extractTable("default tech stack"),
    promptEnhancement: getSection("usage", "prompt enhancement"),
    qualityChecklist: [
      ...extractBullets("quality expectations"),
      ...extractBullets("quality checklist"),
    ],
    customizationPoints: extractBullets("customization points"),
    raw,
  };
}

/**
 * Load the TEMPLATE.md spec for a base pipeline.
 */
export async function loadSpec(pipelineId: string): Promise<TemplateSpec | null> {
  const specPath = join(__dirname, pipelineId, "TEMPLATE.md");
  try {
    const content = await readFile(specPath, "utf-8");
    return parseTemplateSpec(content, pipelineId, null);
  } catch {
    return null;
  }
}

/**
 * Load a variant's TEMPLATE.md spec.
 */
export async function loadVariantSpec(
  pipelineId: string,
  variantId: string,
): Promise<TemplateSpec | null> {
  const specPath = join(__dirname, "variants", pipelineId, variantId, "TEMPLATE.md");
  try {
    const content = await readFile(specPath, "utf-8");
    return parseTemplateSpec(content, pipelineId, variantId);
  } catch {
    return null;
  }
}

/**
 * List all variants for a pipeline.
 */
export async function listVariants(pipelineId: string): Promise<VariantSummary[]> {
  const variantsDir = join(__dirname, "variants", pipelineId);
  try {
    const entries = await readdir(variantsDir, { withFileTypes: true });
    const summaries: VariantSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const spec = await loadVariantSpec(pipelineId, entry.name);
      if (spec) {
        summaries.push({
          pipelineId,
          variantId: entry.name,
          name: spec.name,
          description: spec.description,
          idealFor: spec.idealFor,
        });
      }
    }

    return summaries;
  } catch {
    return [];
  }
}

/**
 * List all variants across all pipelines.
 */
export async function listAllVariants(): Promise<VariantSummary[]> {
  const variantsRoot = join(__dirname, "variants");
  try {
    const pipelines = await readdir(variantsRoot, { withFileTypes: true });
    const all: VariantSummary[] = [];
    for (const p of pipelines) {
      if (p.isDirectory()) {
        all.push(...await listVariants(p.name));
      }
    }
    return all;
  } catch {
    return [];
  }
}

/**
 * List available template pipeline IDs (directories under src/templates/).
 */
export async function listTemplateIds(): Promise<string[]> {
  const entries = await readdir(__dirname, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => !name.startsWith(".") && name !== "variants");
}
