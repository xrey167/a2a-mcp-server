/**
 * Template loader — reads project templates from disk and applies variable substitution.
 *
 * Templates live in src/templates/<pipelineId>/ as real files.
 * Files are read recursively and written to the target directory with {{var}} replacement.
 *
 * Special convention:
 *   - Files named `__name__` in path → replaced with project name (e.g. `__name__.ts` → `my-app.ts`)
 *   - `{{name}}`, `{{description}}`, etc. inside file contents → replaced from vars map
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

/**
 * Recursively collect all files from a template directory.
 */
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
 * Apply variable substitution to a string.
 * Replaces {{varName}} patterns and __name__ path segments.
 */
function substitute(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] ?? match;
  });
}

/**
 * Load all template files for a pipeline, with variable substitution applied.
 *
 * @param pipelineId — matches a subdirectory name under src/templates/
 * @param vars — substitution variables (at minimum: { name })
 * @returns array of { relativePath, content } ready to write to disk
 */
export async function loadTemplate(pipelineId: string, vars: TemplateVars): Promise<TemplateFile[]> {
  const templateDir = join(__dirname, pipelineId);

  // Check template directory exists
  try {
    const s = await stat(templateDir);
    if (!s.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Template not found for pipeline: ${pipelineId} (expected ${templateDir})`);
  }

  const rawFiles = await collectFiles(templateDir);
  const result: TemplateFile[] = [];

  for (const { abs, rel } of rawFiles) {
    const content = await readFile(abs, "utf-8");

    // Substitute in both path and content
    let resolvedPath = substitute(rel, vars);
    // Also handle __name__ in paths
    resolvedPath = resolvedPath.replace(/__name__/g, vars.name);

    result.push({
      relativePath: resolvedPath,
      content: substitute(content, vars),
    });
  }

  return result;
}

/**
 * List available template pipeline IDs (directories under src/templates/).
 */
export async function listTemplateIds(): Promise<string[]> {
  const entries = await readdir(__dirname, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => !name.startsWith("."));
}
