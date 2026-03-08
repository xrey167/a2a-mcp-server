/**
 * Workflow Engine — DAG-based multi-agent task orchestration.
 *
 * Allows defining workflows as directed acyclic graphs of steps,
 * where each step invokes a skill on a worker agent. Steps can
 * declare dependencies on other steps, and the engine executes
 * them in topological order with maximum parallelism.
 *
 * Features:
 *   - DAG execution with automatic parallelization
 *   - Step output piping: use {{stepId.result}} in args to reference outputs
 *   - Conditional execution: steps can have a `when` expression
 *   - Error handling: configurable per-step (fail, skip, retry)
 *   - Progress tracking via task store
 *
 * Usage:
 *   const workflow = {
 *     id: "research-and-summarize",
 *     steps: [
 *       { id: "search", skillId: "fetch_url", args: { url: "..." } },
 *       { id: "analyze", skillId: "ask_claude", args: { prompt: "Analyze: {{search.result}}" }, dependsOn: ["search"] },
 *       { id: "save", skillId: "create_note", args: { title: "Research", content: "{{analyze.result}}" }, dependsOn: ["analyze"] },
 *     ],
 *   };
 *   const result = await executeWorkflow(workflow, dispatch);
 */

import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────

export interface WorkflowStep {
  /** Unique step ID within the workflow */
  id: string;
  /** Skill to invoke */
  skillId: string;
  /** Arguments for the skill. Supports {{stepId.result}} template references. */
  args?: Record<string, unknown>;
  /** Message text (optional, used as fallback for skills that expect text) */
  message?: string;
  /** Step IDs that must complete before this step runs */
  dependsOn?: string[];
  /** Error handling strategy */
  onError?: "fail" | "skip" | "retry";
  /** Max retries (only used when onError is "retry") */
  maxRetries?: number;
  /** Condition expression: "{{stepId.result}}" must be truthy, or "always" */
  when?: string;
  /** Human-readable label for progress reporting */
  label?: string;
}

export interface WorkflowDefinition {
  /** Unique workflow ID */
  id: string;
  /** Human-readable name */
  name?: string;
  /** Description of what this workflow does */
  description?: string;
  /** Ordered list of steps (dependencies define actual execution order) */
  steps: WorkflowStep[];
  /** Maximum concurrent steps (default: 5) */
  maxConcurrency?: number;
}

export interface StepResult {
  stepId: string;
  status: "completed" | "failed" | "skipped";
  result?: string;
  error?: string;
  durationMs: number;
  retries?: number;
}

export interface WorkflowResult {
  workflowId: string;
  status: "completed" | "failed" | "partial";
  steps: StepResult[];
  totalDurationMs: number;
}

export type DispatchFn = (skillId: string, args: Record<string, unknown>, text: string) => Promise<string>;
export type ProgressFn = (message: string) => void;

// ── Template Resolution ──────────────────────────────────────────

function resolveTemplates(
  value: unknown,
  stepResults: Map<string, StepResult>,
): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\.result\}\}/g, (_, stepId) => {
      const result = stepResults.get(stepId);
      return result?.result ?? `<step ${stepId} not found>`;
    });
  }
  if (Array.isArray(value)) {
    return value.map(v => resolveTemplates(v, stepResults));
  }
  if (typeof value === "object" && value !== null) {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveTemplates(v, stepResults);
    }
    return resolved;
  }
  return value;
}

// ── DAG Validation ───────────────────────────────────────────────

function validateDAG(steps: WorkflowStep[]): string | null {
  const stepIds = new Set(steps.map(s => s.id));

  // Check for duplicate IDs
  if (stepIds.size !== steps.length) {
    return "Duplicate step IDs found";
  }

  // Check for missing dependencies
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!stepIds.has(dep)) {
        return `Step "${step.id}" depends on unknown step "${dep}"`;
      }
    }
  }

  // Check for cycles using DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const adjList = new Map<string, string[]>();

  for (const step of steps) {
    adjList.set(step.id, step.dependsOn ?? []);
  }

  function hasCycle(node: string): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const dep of adjList.get(node) ?? []) {
      if (hasCycle(dep)) return true;
    }
    inStack.delete(node);
    return false;
  }

  for (const step of steps) {
    if (hasCycle(step.id)) {
      return `Cycle detected involving step "${step.id}"`;
    }
  }

  return null;
}

// ── Condition Evaluation ─────────────────────────────────────────

function evaluateCondition(when: string | undefined, stepResults: Map<string, StepResult>): boolean {
  if (!when || when === "always") return true;

  // Check {{stepId.result}} is truthy
  const resolved = when.replace(/\{\{(\w+)\.result\}\}/g, (_, stepId) => {
    const result = stepResults.get(stepId);
    if (!result || result.status !== "completed" || !result.result) return "";
    return result.result;
  });

  // Check {{stepId.status}} === "completed"
  const statusResolved = resolved.replace(/\{\{(\w+)\.status\}\}/g, (_, stepId) => {
    const result = stepResults.get(stepId);
    return result?.status ?? "unknown";
  });

  return statusResolved.trim().length > 0 && statusResolved.trim() !== "false" && statusResolved.trim() !== "0";
}

// ── Execution Engine ─────────────────────────────────────────────

export async function executeWorkflow(
  workflow: WorkflowDefinition,
  dispatch: DispatchFn,
  onProgress?: ProgressFn,
): Promise<WorkflowResult> {
  const startTime = Date.now();

  // Validate DAG
  const validationError = validateDAG(workflow.steps);
  if (validationError) {
    return {
      workflowId: workflow.id,
      status: "failed",
      steps: [{ stepId: "__validation__", status: "failed", error: validationError, durationMs: 0 }],
      totalDurationMs: 0,
    };
  }

  const stepMap = new Map(workflow.steps.map(s => [s.id, s]));
  const stepResults = new Map<string, StepResult>();
  const maxConcurrency = workflow.maxConcurrency ?? 5;

  onProgress?.(`Starting workflow "${workflow.name ?? workflow.id}" with ${workflow.steps.length} steps`);

  // Topological execution with concurrency
  const completed = new Set<string>();
  const running = new Set<string>();
  const failed = new Set<string>();

  async function executeStep(step: WorkflowStep): Promise<StepResult> {
    const stepStart = Date.now();
    const label = step.label ?? step.id;

    // Check condition
    if (!evaluateCondition(step.when, stepResults)) {
      onProgress?.(`⊘ Skipping "${label}" (condition not met)`);
      return { stepId: step.id, status: "skipped", durationMs: 0 };
    }

    onProgress?.(`▶ Running "${label}" (${step.skillId})`);

    // Resolve template references in args
    const resolvedArgs = (resolveTemplates(step.args ?? {}, stepResults) ?? {}) as Record<string, unknown>;
    const resolvedMessage = resolveTemplates(step.message ?? "", stepResults) as string;

    let lastError: string | undefined;
    const maxRetries = step.onError === "retry" ? (step.maxRetries ?? 2) : 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await dispatch(step.skillId, resolvedArgs, resolvedMessage);
        const duration = Date.now() - stepStart;
        onProgress?.(`✓ "${label}" completed (${duration}ms)`);
        return {
          stepId: step.id,
          status: "completed",
          result,
          durationMs: duration,
          ...(attempt > 0 ? { retries: attempt } : {}),
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries) {
          onProgress?.(`↻ "${label}" retry ${attempt + 1}/${maxRetries}`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // backoff
        }
      }
    }

    const duration = Date.now() - stepStart;

    if (step.onError === "skip") {
      onProgress?.(`⊘ "${label}" failed but skipped: ${lastError}`);
      return { stepId: step.id, status: "skipped", error: lastError, durationMs: duration };
    }

    onProgress?.(`✗ "${label}" failed: ${lastError}`);
    return { stepId: step.id, status: "failed", error: lastError, durationMs: duration };
  }

  // Execute steps in topological order with max concurrency
  while (completed.size + failed.size < workflow.steps.length) {
    // Find ready steps (all deps completed, not already done or running)
    const ready = workflow.steps.filter(step => {
      if (completed.has(step.id) || running.has(step.id) || failed.has(step.id)) return false;
      const deps = step.dependsOn ?? [];
      return deps.every(d => completed.has(d) || failed.has(d));
    });

    if (ready.length === 0 && running.size === 0) {
      // Deadlock — some steps can't run because their deps failed
      break;
    }

    // Execute up to maxConcurrency steps in parallel
    const batch = ready.slice(0, maxConcurrency - running.size);
    if (batch.length === 0) {
      // Wait for a running step to complete
      await new Promise(r => setTimeout(r, 100));
      continue;
    }

    const promises = batch.map(async (step) => {
      running.add(step.id);
      const result = await executeStep(step);
      running.delete(step.id);
      stepResults.set(step.id, result);

      if (result.status === "failed") {
        failed.add(step.id);
        // If this step has onError: "fail" (default), abort dependent steps
        if (step.onError !== "skip") {
          // Mark all downstream steps as failed
          const downstream = findDownstream(step.id, workflow.steps);
          for (const dsId of downstream) {
            if (!completed.has(dsId) && !failed.has(dsId)) {
              failed.add(dsId);
              stepResults.set(dsId, {
                stepId: dsId,
                status: "failed",
                error: `Upstream step "${step.id}" failed`,
                durationMs: 0,
              });
            }
          }
        }
      } else {
        completed.add(step.id);
      }
    });

    await Promise.all(promises);
  }

  const totalDurationMs = Date.now() - startTime;
  const allResults = workflow.steps.map(s => stepResults.get(s.id) ?? {
    stepId: s.id,
    status: "skipped" as const,
    error: "Not reached",
    durationMs: 0,
  });

  const hasFailures = allResults.some(r => r.status === "failed");
  const allCompleted = allResults.every(r => r.status === "completed" || r.status === "skipped");

  onProgress?.(`Workflow "${workflow.name ?? workflow.id}" finished in ${totalDurationMs}ms — ${completed.size} completed, ${failed.size} failed`);

  return {
    workflowId: workflow.id,
    status: hasFailures ? (completed.size > 0 ? "partial" : "failed") : "completed",
    steps: allResults,
    totalDurationMs,
  };
}

/** Find all steps that transitively depend on a given step. */
function findDownstream(stepId: string, steps: WorkflowStep[]): string[] {
  const downstream = new Set<string>();
  const queue = [stepId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const step of steps) {
      if (step.dependsOn?.includes(current) && !downstream.has(step.id)) {
        downstream.add(step.id);
        queue.push(step.id);
      }
    }
  }

  return [...downstream];
}

// ── Workflow Validation ──────────────────────────────────────────

/** Validate a workflow definition before execution. Returns null if valid, error message otherwise. */
export function validateWorkflow(workflow: unknown): string | null {
  if (typeof workflow !== "object" || workflow === null) return "Workflow must be an object";
  const w = workflow as Record<string, unknown>;
  if (typeof w.id !== "string" || !w.id) return "Workflow requires an 'id' field";
  if (!Array.isArray(w.steps) || w.steps.length === 0) return "Workflow requires a non-empty 'steps' array";

  for (let i = 0; i < w.steps.length; i++) {
    const step = w.steps[i];
    if (typeof step !== "object" || step === null) return `Step ${i} must be an object`;
    const s = step as Record<string, unknown>;
    if (typeof s.id !== "string" || !s.id) return `Step ${i} requires an 'id' field`;
    if (typeof s.skillId !== "string" || !s.skillId) return `Step ${i} requires a 'skillId' field`;
  }

  return validateDAG(w.steps as WorkflowStep[]);
}
