/**
 * Skill Composer — declarative skill chaining with pipe() syntax.
 *
 * Allows composing multiple skills into reusable pipelines.
 * Each step's output feeds into the next step's input, with
 * optional transforms, filters, and error handling.
 *
 * This is unique in the A2A ecosystem — no other project offers
 * declarative skill composition.
 *
 * Usage:
 *   const pipeline = compose("fetch-and-summarize", [
 *     { skillId: "fetch_url", args: { url: "{{input.url}}" } },
 *     { skillId: "ask_claude", transform: "Summarize: {{prev.result}}" },
 *     { skillId: "create_note", args: { title: "Summary", content: "{{prev.result}}" } },
 *   ]);
 *   const result = await executePipeline(pipeline, { url: "https://..." }, dispatch);
 */

import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────

export interface PipelineStep {
  /** Skill to invoke */
  skillId: string;
  /** Static args (supports {{prev.result}}, {{input.*}}, {{steps.stepId.result}} templates) */
  args?: Record<string, unknown>;
  /** If set, used as the message/prompt with template resolution */
  transform?: string;
  /** Optional alias for referencing this step's output */
  as?: string;
  /** Skip this step if condition evaluates to falsy */
  when?: string;
  /** What to do on error: abort (default), skip, or use a fallback value */
  onError?: "abort" | "skip" | { fallback: unknown };
}

export interface Pipeline {
  id: string;
  name: string;
  description?: string;
  steps: PipelineStep[];
  /** Created timestamp */
  createdAt: string;
}

export interface PipelineResult {
  pipelineId: string;
  status: "completed" | "failed" | "partial";
  /** Final step's result */
  output: unknown;
  /** All step results */
  stepResults: Array<{
    skillId: string;
    alias?: string;
    status: "completed" | "skipped" | "failed";
    result?: string;
    error?: string;
    durationMs: number;
  }>;
  totalDurationMs: number;
}

export type PipelineDispatchFn = (skillId: string, args: Record<string, unknown>, text: string) => Promise<string>;

// ── Pipeline Registry ────────────────────────────────────────────

const pipelines = new Map<string, Pipeline>();

/** Register a composed pipeline. */
export function compose(name: string, steps: PipelineStep[], description?: string): Pipeline {
  // Warn if two steps share the same effective alias (step.as ?? step.skillId)
  const aliases = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const key = steps[i].as ?? steps[i].skillId;
    if (aliases.has(key)) {
      process.stderr.write(`[composer] pipeline "${name}": steps ${aliases.get(key)} and ${i} share alias "${key}" — add 'as' fields to distinguish them\n`);
    } else {
      aliases.set(key, i);
    }
  }

  const pipeline: Pipeline = {
    id: randomUUID(),
    name,
    description,
    steps,
    createdAt: new Date().toISOString(),
  };
  pipelines.set(pipeline.id, pipeline);
  pipelines.set(name, pipeline); // also index by name
  const safeName = name.replace(/[\r\n]/g, "");
  process.stderr.write(`[composer] pipeline registered: ${safeName} (${steps.length} steps)\n`);
  return pipeline;
}

/** Get a pipeline by ID or name. */
export function getPipeline(idOrName: string): Pipeline | undefined {
  return pipelines.get(idOrName);
}

/** List all registered pipelines. */
export function listPipelines(): Array<{ id: string; name: string; description?: string; steps: number; createdAt: string }> {
  const seen = new Set<string>();
  const result: Array<{ id: string; name: string; description?: string; steps: number; createdAt: string }> = [];
  for (const [, p] of pipelines) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    result.push({ id: p.id, name: p.name, description: p.description, steps: p.steps.length, createdAt: p.createdAt });
  }
  return result;
}

/** Remove a pipeline. */
export function removePipeline(idOrName: string): boolean {
  const pipeline = pipelines.get(idOrName);
  if (!pipeline) return false;
  pipelines.delete(pipeline.id);
  pipelines.delete(pipeline.name);
  return true;
}

// ── Template Resolution ──────────────────────────────────────────

const MAX_SUBSTITUTION_LENGTH = 50_000;

/** Sanitize a substituted value: truncate + strip control chars. */
function sanitizeSubstitution(value: string): string {
  return value
    .slice(0, MAX_SUBSTITUTION_LENGTH)
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");
}

function resolveTemplate(
  template: unknown,
  context: { input: Record<string, unknown>; prev: { result?: string }; steps: Record<string, { result?: string }> },
): unknown {
  if (typeof template === "string") {
    // Non-embedded single reference: parse JSON so downstream skills get objects/arrays
    const singleRefMatch = template.match(/^\s*\{\{([\w.]+)\}\}\s*$/);
    if (singleRefMatch) {
      const value = getNestedValue(context, singleRefMatch[1]);
      if (value === undefined) return `<${singleRefMatch[1]}>`;
      const str = sanitizeSubstitution(String(value));
      try { return JSON.parse(str); } catch { return str; }
    }

    // Embedded: substitute as sanitized string within the larger text
    return template.replace(/\{\{([\w.]+)\}\}/g, (_, path: string) => {
      const value = getNestedValue(context, path);
      return value !== undefined ? sanitizeSubstitution(String(value)) : `<${path}>`;
    });
  }
  if (Array.isArray(template)) {
    return template.map(v => resolveTemplate(v, context));
  }
  if (typeof template === "object" && template !== null) {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      resolved[k] = resolveTemplate(v, context);
    }
    return resolved;
  }
  return template;
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    // Guard against prototype pollution via __proto__, constructor, prototype keys
    if (part === "__proto__" || part === "constructor" || part === "prototype") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ── Execution ────────────────────────────────────────────────────

/** Execute a pipeline with given input. */
export async function executePipeline(
  pipelineOrId: Pipeline | string,
  input: Record<string, unknown>,
  dispatch: PipelineDispatchFn,
): Promise<PipelineResult> {
  const pipeline = typeof pipelineOrId === "string" ? pipelines.get(pipelineOrId) : pipelineOrId;
  if (!pipeline) throw new Error(`Pipeline not found: ${pipelineOrId}`);

  const startTime = Date.now();
  const stepResults: PipelineResult["stepResults"] = [];
  const stepsMap: Record<string, { result?: string }> = {};
  let prevResult: string | undefined;
  let lastOutput: unknown;

  for (const step of pipeline.steps) {
    const stepStart = Date.now();
    const context = {
      input,
      prev: { result: prevResult },
      steps: stepsMap,
    };

    // Check condition
    if (step.when) {
      const resolved = resolveTemplate(step.when, context) as string;
      if (!resolved || resolved === "false" || resolved === "0" || resolved === "undefined") {
        stepResults.push({ skillId: step.skillId, alias: step.as, status: "skipped", durationMs: 0 });
        stepsMap[step.as ?? step.skillId] = { result: prevResult };
        continue;
      }
    }

    // Resolve args and transform
    const resolvedArgs = (step.args ? resolveTemplate(step.args, context) : {}) as Record<string, unknown>;
    const text = step.transform ? resolveTemplate(step.transform, context) as string : prevResult ?? "";

    try {
      const result = await dispatch(step.skillId, resolvedArgs, text);
      const duration = Date.now() - stepStart;

      prevResult = result;
      lastOutput = result;
      stepsMap[step.as ?? step.skillId] = { result };
      stepResults.push({ skillId: step.skillId, alias: step.as, status: "completed", result, durationMs: duration });
    } catch (err) {
      const duration = Date.now() - stepStart;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (step.onError === "skip") {
        stepResults.push({ skillId: step.skillId, alias: step.as, status: "skipped", error: errorMsg, durationMs: duration });
        stepsMap[step.as ?? step.skillId] = { result: prevResult };
        continue;
      }

      if (typeof step.onError === "object" && "fallback" in step.onError) {
        const raw = step.onError.fallback;
        const fallback = typeof raw === "string" ? raw : JSON.stringify(raw);
        prevResult = fallback;
        lastOutput = fallback;
        stepsMap[step.as ?? step.skillId] = { result: fallback };
        stepResults.push({ skillId: step.skillId, alias: step.as, status: "completed", result: fallback, durationMs: duration });
        continue;
      }

      // Default: abort
      stepResults.push({ skillId: step.skillId, alias: step.as, status: "failed", error: errorMsg, durationMs: duration });
      return {
        pipelineId: pipeline.id,
        status: "failed",
        output: errorMsg,
        stepResults,
        totalDurationMs: Date.now() - startTime,
      };
    }
  }

  const hasPartial = stepResults.some(r => r.status === "skipped" || r.status === "failed");
  return {
    pipelineId: pipeline.id,
    status: hasPartial ? "partial" : "completed",
    output: lastOutput,
    stepResults,
    totalDurationMs: Date.now() - startTime,
  };
}

/** Reset all pipelines (for testing). */
export function resetPipelines(): void {
  pipelines.clear();
}
