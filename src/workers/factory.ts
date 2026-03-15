/**
 * Factory Agent — project generation pipelines with template matching.
 *
 * Turns a vague idea into a production-ready project by orchestrating
 * the full stack of A2A workers: ai-agent (spec generation, code gen, QA),
 * shell-agent (scaffolding, file I/O), design-agent (UI critique),
 * and code-agent (review).
 *
 * Phase 0: Template matching — matches idea to a variant (saas-starter, e-commerce, etc.)
 * Phase 1: Intent normalization — expands idea with variant-specific domain knowledge
 * Phase 2: Scaffold — writes real template files + variant enhancements
 * Phase 3: Code generation — AI supplements template with spec-specific business logic
 * Phase 4: Quality gate — Ralph Mode with variant-specific checklist items
 *
 * Skills:
 *   normalize_intent   — expand idea → detailed JSON spec (with template matching)
 *   create_project     — full pipeline: match → normalize → scaffold → generate → QA
 *   quality_gate       — "Ralph Mode" multi-dimension code review
 *   list_pipelines     — available pipeline types
 *   list_templates     — available template variants per pipeline
 *   remember / recall  — shared memory
 */

import Fastify from "fastify";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { buildA2AResponse, buildA2AError, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";

const FactorySchemas = {
  normalize_intent: z.object({ idea: z.string().min(1), pipeline: z.string().optional().default("app") }).passthrough(),
  create_project: z.object({ idea: z.string().min(1), pipeline: z.string().optional().default("app"), outputDir: z.string().optional(), variant: z.string().optional() }).passthrough(),
  quality_gate: z.object({ code: z.string().min(1), spec: z.string().optional().default("{}"), pipeline: z.string().optional().default("app"), variant: z.string().optional() }).passthrough(),
  list_templates: z.object({ pipeline: z.string().optional().default("") }).passthrough(),
};
import { getPersona, watchPersonas } from "../persona-loader.js";
import { PIPELINES, listPipelines, getPipeline } from "../pipelines/index.js";
import type { Pipeline } from "../pipelines/types.js";
import { sanitizePath, sanitizeRelativePath } from "../path-utils.js";
import {
  loadTemplate,
  loadSpec,
  loadVariantSpec,
  listVariants,
  listAllVariants,
  type TemplateSpec,
  type VariantSummary,
} from "../templates/loader.js";
import { sendTask } from "../a2a.js";
import {
  sanitizeUserInput,
  sanitizeTemplateContent,
  sanitizeGeneratedCode,
  sanitizeStructuredData,
  buildSafePrompt,
} from "../prompt-sanitizer.js";

const PORT = 8087;
const NAME = "factory-agent";

// Worker URLs for direct calls — avoids routing through orchestrator.
// Configurable via env vars (set by orchestrator on spawn) with sensible defaults.
const WORKER_URLS = {
  ai: process.env.A2A_WORKER_AI_URL ?? "http://localhost:8083",
  shell: process.env.A2A_WORKER_SHELL_URL ?? "http://localhost:8081",
  design: process.env.A2A_WORKER_DESIGN_URL ?? "http://localhost:8086",
  code: process.env.A2A_WORKER_CODE_URL ?? "http://localhost:8084",
  web: process.env.A2A_WORKER_WEB_URL ?? "http://localhost:8082",
};

const AGENT_CARD = {
  name: NAME,
  description: "Factory agent — turns ideas into production-ready projects via multi-agent pipelines with template matching (AppFactory-style)",
  url: `http://localhost:${PORT}`,
  version: "2.0.0",
  capabilities: { streaming: false },
  skills: [
    {
      id: "normalize_intent",
      name: "Normalize Intent",
      description: "Expand a vague project idea into a detailed, structured JSON spec. Automatically matches to the best template variant for domain-specific enhancement.",
    },
    {
      id: "create_project",
      name: "Create Project",
      description: "Full project generation pipeline: match template → normalize intent → scaffold files → generate code → quality review loop. Returns the complete generated project summary.",
    },
    {
      id: "quality_gate",
      name: "Quality Gate",
      description: "Ralph Mode — multi-dimension code quality review with variant-specific checklist items. Scores code across dimensions and returns structured feedback with fixes.",
    },
    {
      id: "list_pipelines",
      name: "List Pipelines",
      description: "List available project generation pipelines and their tech stacks.",
    },
    {
      id: "list_templates",
      name: "List Templates",
      description: "List available template variants for a pipeline (e.g. saas-starter, e-commerce, social-app for mobile apps).",
    },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory" },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────

function log(msg: string) {
  process.stderr.write(`[${NAME}] ${msg}\n`);
}

async function askClaude(prompt: string, systemPrompt?: string): Promise<string> {
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
  return sendTask(WORKER_URLS.ai, {
    skillId: "ask_claude",
    args: { prompt: fullPrompt },
    message: { role: "user" as const, parts: [{ kind: "text" as const, text: fullPrompt }] },
  }, { timeoutMs: 120_000 });
}

async function runShell(command: string): Promise<string> {
  return sendTask(WORKER_URLS.shell, {
    skillId: "run_shell",
    args: { command },
    message: { role: "user" as const, parts: [{ kind: "text" as const, text: command }] },
  }, { timeoutMs: 60_000 });
}

async function writeFile(path: string, content: string): Promise<string> {
  return sendTask(WORKER_URLS.shell, {
    skillId: "write_file",
    args: { path, content },
    message: { role: "user" as const, parts: [{ kind: "text" as const, text: `Write to ${path}` }] },
  });
}

function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

// ── Template Matching (Phase 0) ─────────────────────────────────

interface MatchResult {
  variantId: string | null;
  variantSpec: TemplateSpec | null;
  confidence: "high" | "medium" | "low" | "none";
  reason: string;
}

/**
 * Match a user's idea to the best template variant for a pipeline.
 * Uses Claude to analyze the idea against available variant descriptions.
 */
async function matchTemplate(
  idea: string,
  pipelineId: string,
): Promise<MatchResult> {
  const variants = await listVariants(pipelineId);

  if (variants.length === 0) {
    return { variantId: null, variantSpec: null, confidence: "none", reason: "No variants available for this pipeline" };
  }

  const variantList = variants.map(v =>
    `- ${v.variantId}: ${v.description}\n  Ideal for: ${v.idealFor.join(", ")}`
  ).join("\n");

  const prompt = buildSafePrompt({
    instructions: `You are matching a user's project idea to the best template variant.

Analyze the idea and determine which variant (if any) is the best match from the available variants list.

Respond with ONLY valid JSON:
{
  "variantId": "<variant-id or null if none match>",
  "confidence": "high|medium|low|none",
  "reason": "Brief explanation of why this variant matches (or why none match)"
}

Rules:
- "high" = idea directly maps to a variant's ideal use cases
- "medium" = idea partially overlaps with a variant's domain
- "low" = idea has some relevance but variant would need significant customization
- "none" = no variant is relevant, use base pipeline template`,
    userContent: {
      project_idea: sanitizeUserInput(idea, "project_idea"),
    },
    additionalContext: `Available variants for the "${pipelineId}" pipeline:\n${variantList}`,
  });

  try {
    const raw = await askClaude(prompt);
    const parsed = JSON.parse(stripJsonFences(raw));

    const variantId = parsed.variantId as string | null;

    if (variantId && variants.some(v => v.variantId === variantId)) {
      const variantSpec = await loadVariantSpec(pipelineId, variantId);
      if (!variantSpec) {
        return { variantId: null, variantSpec: null, confidence: "none", reason: `Variant spec not found for variantId="${variantId}"` };
      }
      return {
        variantId,
        variantSpec,
        confidence: parsed.confidence ?? "medium",
        reason: parsed.reason ?? "",
      };
    }

    return {
      variantId: null,
      variantSpec: null,
      confidence: parsed.confidence ?? "none",
      reason: parsed.reason ?? "No matching variant",
    };
  } catch (err) {
    log(`template matching failed: ${err}`);
    return { variantId: null, variantSpec: null, confidence: "none", reason: "Matching failed, using base template" };
  }
}

// ── Intent Normalization (Phase 1) ──────────────────────────────

async function normalizeIntent(
  idea: string,
  pipelineId: string,
  variantSpec?: TemplateSpec | null,
): Promise<string> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineId}. Available: ${Array.from(PIPELINES.keys()).join(", ")}`);

  // Build the prompt — base intent prompt + variant enhancement
  const sanitizedIdea = sanitizeUserInput(idea, "project_idea");
  let prompt = pipeline.intentPrompt.replace("{{idea}}", sanitizedIdea);

  if (variantSpec) {
    // Inject variant-specific domain knowledge into the prompt
    const enhancement = buildVariantEnhancement(variantSpec);
    const sanitizedVariantId = sanitizeTemplateContent(variantSpec.variantId ?? "", "variant_id");

    prompt = `${prompt}

--- TEMPLATE VARIANT CONTEXT ---
This project matched the template variant with ID: ${sanitizedVariantId}

${enhancement}

Incorporate these domain-specific patterns and features into the spec.
The spec should include a "variant" field set to the variant ID from the context above.`;
  }

  log(`normalizing intent for "${idea}" via ${pipelineId} pipeline${variantSpec ? ` (variant: ${variantSpec.variantId})` : ""}`);

  const persona = getPersona(NAME);
  const raw = await askClaude(prompt, persona.systemPrompt || undefined);
  return stripJsonFences(raw);
}

/**
 * Build a prompt enhancement string from a variant's TEMPLATE.md spec.
 * All template-sourced content is sanitized to prevent injection.
 */
function buildVariantEnhancement(spec: TemplateSpec): string {
  const parts: string[] = [];

  if (spec.description) {
    parts.push(`**Template Description:**\n${sanitizeTemplateContent(spec.description, "description")}`);
  }

  if (spec.features.length > 0) {
    const featuresList = spec.features
      .map(f => sanitizeTemplateContent(f, "feature"))
      .join("\n");
    parts.push(`**Pre-Configured Features:**\n${featuresList}`);
  }

  if (spec.promptEnhancement) {
    parts.push(`**Prompt Enhancement Rules:**\n${sanitizeTemplateContent(spec.promptEnhancement, "enhancement_rules")}`);
  }

  if (spec.fileStructure) {
    parts.push(`**Expected File Structure:**\n${sanitizeTemplateContent(spec.fileStructure, "file_structure")}`);
  }

  if (Object.keys(spec.techStack).length > 0) {
    const techStackLines = Object.entries(spec.techStack).map(
      ([k, v]) => `- ${sanitizeTemplateContent(k, "tech_name")}: ${sanitizeTemplateContent(v, "tech_value")}`
    ).join("\n");
    parts.push(`**Additional Tech Stack:**\n${techStackLines}`);
  }

  return parts.join("\n\n");
}

// ── Quality Gate ("Ralph Mode") with variant checklist ──────────

interface QualityResult {
  passed: boolean;
  scores: Record<string, number>;
  average: number;
  issues: Array<{ dimension: string; severity: "critical" | "major" | "minor"; description: string; fix: string }>;
  summary: string;
  checklistResults?: Array<{ item: string; passed: boolean }>;
}

async function qualityGate(
  code: string,
  spec: string,
  pipeline: Pipeline,
  variantSpec?: TemplateSpec | null,
): Promise<QualityResult> {
  const dimensions = pipeline.qualityGate.dimensions;
  const threshold = pipeline.qualityGate.passThreshold;

  // Build checklist from base pipeline + variant-specific items
  const baseSpec = await loadSpec(pipeline.id);
  const checklist = [
    ...(baseSpec?.qualityChecklist ?? []),
    ...(variantSpec?.qualityChecklist ?? []),
  ];

  const checklistSection = checklist.length > 0
    ? `\n\nAlso verify this domain-specific checklist (mark each as pass/fail):\n${checklist.map((item, i) => `${i + 1}. ${item}`).join("\n")}`
    : "";

  const prompt = buildSafePrompt({
    instructions: `You are "Ralph" — a meticulous code reviewer who never lets subpar work ship.

Review the following generated code against its specification.

Score each dimension 0-100 and list issues found:
Dimensions: ${dimensions.join(", ")}
${checklistSection}

Respond with ONLY valid JSON:
{
  "scores": { ${dimensions.map(d => `"${d}": <0-100>`).join(", ")} },
  "issues": [{ "dimension": "...", "severity": "critical|major|minor", "description": "...", "fix": "..." }],
  "summary": "1-2 sentence overall assessment"${checklist.length > 0 ? `,
  "checklist": [{ "item": "...", "passed": true|false }]` : ""}
}

Be strict. A score of ${threshold}+ means production-ready quality. Deduct points for:
- Missing error handling (-10 per instance)
- Type safety gaps (-5 per any/unknown)
- No input validation at boundaries (-15)
- Missing accessibility attributes (-10 per component)
- Security vulnerabilities (-20 per finding)`,
    userContent: {
      specification: sanitizeStructuredData(JSON.parse(spec), "specification"),
      generated_code: sanitizeGeneratedCode(code),
    },
  });

  const raw = await askClaude(prompt);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    log(`qualityGate: failed to parse LLM response as JSON — treating as failed gate`);
    return { passed: false, scores: {}, average: 0, issues: [{ dimension: "parse", severity: "critical", description: "LLM returned non-JSON response", fix: "Retry generation" }], summary: "Quality gate could not parse LLM response" };
  }

  const scores = parsed.scores as Record<string, number>;

  // If there's a checklist, failing critical items lowers the score
  let checklistResults: Array<{ item: string; passed: boolean }> | undefined;
  if (parsed.checklist && Array.isArray(parsed.checklist)) {
    checklistResults = parsed.checklist;
    const failedCount = checklistResults.filter(c => !c.passed).length;
    // Each failed checklist item is an implicit issue
    if (failedCount > 0) {
      const penalty = Math.min(failedCount * 3, 15); // Max 15-point penalty from checklist
      for (const key of Object.keys(scores)) {
        scores[key] = Math.max(0, scores[key] - penalty);
      }
    }
  }

  const adjustedValues = Object.values(scores);
  const adjustedAverage = adjustedValues.length > 0
    ? Math.round(adjustedValues.reduce((a, b) => a + b, 0) / adjustedValues.length)
    : 0;

  return {
    passed: adjustedAverage >= threshold,
    scores,
    average: adjustedAverage,
    issues: parsed.issues ?? [],
    summary: parsed.summary ?? "",
    checklistResults,
  };
}

// ── Project Scaffolding (file-based templates) ──────────────────

async function scaffoldProject(
  outputDir: string,
  pipeline: Pipeline,
  projectName: string,
  description?: string,
): Promise<string[]> {
  // Sanitize outputDir to prevent command injection
  const safeDir = sanitizePath(outputDir);

  // Load template files from src/templates/<pipelineId>/
  const templateFiles = await loadTemplate(pipeline.id, {
    name: projectName,
    // Generate a valid bundle ID segment: only lowercase letters and digits,
    // must start with a letter, fall back to "app" if empty/starts with digit.
    bundleId: (() => {
      const raw = projectName.toLowerCase().replace(/[^a-z0-9]/g, "");
      return /^[a-z]/.test(raw) ? raw : raw ? `a${raw}` : "app";
    })(),
    description: description ?? `A ${pipeline.name} project`,
  });

  // Ensure output directory exists
  await runShell(`mkdir -p -- ${JSON.stringify(safeDir)}`);

  // Collect all unique directories we need to create
  const dirs = new Set<string>();
  for (const file of templateFiles) {
    const lastSlash = file.relativePath.lastIndexOf("/");
    if (lastSlash > 0) {
      dirs.add(`${safeDir}/${file.relativePath.substring(0, lastSlash)}`);
    }
  }
  if (dirs.size > 0) {
    // Sanitize each directory path before shell execution
    const safeDirs = Array.from(dirs).map(d => sanitizePath(d));
    await runShell(`mkdir -p ${safeDirs.map(d => JSON.stringify(d)).join(" ")}`);
  }

  // Write all template files (uses write_file skill, not shell)
  const writtenFiles: string[] = [];
  for (const file of templateFiles) {
    const fullPath = `${safeDir}/${file.relativePath}`;
    await writeFile(fullPath, file.content);
    writtenFiles.push(fullPath);
  }

  log(`scaffolded ${writtenFiles.length} template files to ${safeDir}`);
  return writtenFiles;
}

// ── Full Project Generation ─────────────────────────────────────

interface CreateProjectResult {
  projectName: string;
  outputDir: string;
  pipelineId: string;
  variantId: string | null;
  spec: Record<string, unknown>;
  filesGenerated: string[];
  qualityResult: QualityResult | null;
  iterations: number;
}

async function createProject(
  idea: string,
  pipelineId: string,
  outputDir?: string,
  forceVariant?: string,
): Promise<CreateProjectResult> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineId}`);

  // Phase 0: Template matching
  log("phase 0: matching template variant");
  let matchResult: MatchResult;
  if (forceVariant) {
    const spec = await loadVariantSpec(pipelineId, forceVariant);
    if (spec) {
      matchResult = {
        variantId: forceVariant,
        variantSpec: spec,
        confidence: "high",
        reason: `Forced variant: ${forceVariant}`,
      };
    } else {
      // Treat unknown forced variant as "no variant" to keep behavior consistent.
      matchResult = {
        variantId: undefined,
        variantSpec: undefined,
        confidence: "none",
        reason: `Unknown forced variant: ${forceVariant}, using base template`,
      };
    }
  } else {
    matchResult = await matchTemplate(idea, pipelineId);
  }

  if (matchResult.variantId) {
    log(`matched variant: ${matchResult.variantId} (${matchResult.confidence} confidence — ${matchResult.reason})`);
  } else {
    log(`no variant matched (${matchResult.reason}), using base template`);
  }

  // Phase 1: Normalize intent with variant context
  log("phase 1: normalizing intent");
  const specRaw = await normalizeIntent(idea, pipelineId, matchResult.variantSpec);
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(specRaw);
  } catch {
    throw new Error(`Intent normalization returned invalid JSON: ${specRaw.slice(0, 200)}`);
  }

  const projectName = (spec.name as string ?? "my-project")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "") || "my-project";
  const targetDir = outputDir ?? `/tmp/factory/${projectName}-${Date.now()}`;

  // Phase 2: Scaffold from templates
  log(`phase 2: scaffolding to ${targetDir}`);
  const description = (spec.description as string) ?? (spec.tagline as string) ?? undefined;
  const templateFiles = await scaffoldProject(targetDir, pipeline, projectName, description);

  // Phase 3: Generate code via Claude (supplements template with spec-specific logic)
  log("phase 3: generating code");
  const generatedFiles = await generateCode(targetDir, spec, pipeline, matchResult.variantSpec);
  const allFiles = [...new Set([...templateFiles, ...generatedFiles])];

  // Phase 4: Quality gate loop with variant checklist
  log("phase 4: quality gate (Ralph Mode)");
  let qualityResult: QualityResult | null = null;
  let iterations = 0;

  // Collect all generated code for review
  let allCode = "";
  for (const file of allFiles) {
    try {
      const content = await sendTask(WORKER_URLS.shell, {
        skillId: "read_file",
        args: { path: file },
        message: { role: "user" as const, parts: [{ kind: "text" as const, text: `read ${file}` }] },
      });
      allCode += `\n// === ${file} ===\n${content}`;
    } catch { /* file may not exist yet */ }
  }

  if (allCode.trim()) {
    for (let i = 0; i < pipeline.qualityGate.maxIterations; i++) {
      iterations++;
      qualityResult = await qualityGate(allCode, JSON.stringify(spec, null, 2), pipeline, matchResult.variantSpec);
      log(`quality gate iteration ${iterations}: avg=${qualityResult.average}, passed=${qualityResult.passed}`);

      if (qualityResult.passed) break;

      // Fix issues
      if (qualityResult.issues.length > 0 && i < pipeline.qualityGate.maxIterations - 1) {
        log(`fixing ${qualityResult.issues.length} issues`);

        const issuesList = qualityResult.issues
          .map(iss => `- [${iss.severity}] ${iss.dimension}: ${iss.description}\n  Fix: ${iss.fix}`)
          .join("\n");

        const fixPrompt = buildSafePrompt({
          instructions: `Fix the following issues in the code. Return ONLY the corrected code for each file, with file markers like "// === filepath ===" between them.

Issues to fix:
${issuesList}`,
          userContent: {
            current_code: sanitizeGeneratedCode(allCode),
          },
        });

        const fixed = await askClaude(fixPrompt);
        // Parse fixed files and write them
        const fileBlocks = fixed.split(/\/\/ === (.+?) ===/);
        for (let j = 1; j < fileBlocks.length; j += 2) {
          if (!fileBlocks[j]) continue;
          const filePath = fileBlocks[j].trim();
          const fileContent = fileBlocks[j + 1]?.trim();
          if (filePath && fileContent) {
            // Sanitize the file path from LLM to prevent path traversal
            const safePath = sanitizeRelativePath(filePath, targetDir);
            await writeFile(safePath, fileContent);
          }
        }

        // Re-read for next iteration
        allCode = fixed;
      }
    }
  }

  return {
    projectName,
    outputDir: targetDir,
    pipelineId,
    variantId: matchResult.variantId,
    spec,
    filesGenerated: allFiles,
    qualityResult,
    iterations,
  };
}

// ── Code Generation (pipeline + variant aware) ──────────────────

async function generateCode(
  targetDir: string,
  spec: Record<string, unknown>,
  pipeline: Pipeline,
  variantSpec?: TemplateSpec | null,
): Promise<string[]> {
  const files: string[] = [];

  const persona = getPersona(NAME);
  const systemCtx = persona.systemPrompt
    ? `${persona.systemPrompt}\n\nYou are generating code for a ${pipeline.name} project using: ${pipeline.stack.join(", ")}.`
    : `You are generating code for a ${pipeline.name} project using: ${pipeline.stack.join(", ")}.`;

  // Build variant-specific generation context (sanitized)
  let variantContext = "";
  if (variantSpec) {
    variantContext = `\n\nThis project uses a template variant.`;

    if (variantSpec.fileStructure) {
      variantContext += `\n\nExpected file structure from the variant:\n${sanitizeTemplateContent(variantSpec.fileStructure, "file_structure")}`;
    }

    if (variantSpec.features.length > 0) {
      const featuresList = variantSpec.features
        .map(f => `- ${sanitizeTemplateContent(f, "feature")}`)
        .join("\n");
      variantContext += `\n\nDomain-specific features to implement:\n${featuresList}`;
    }

    if (Object.keys(variantSpec.techStack).length > 0) {
      const techLines = Object.entries(variantSpec.techStack)
        .map(([k, v]) => `- ${sanitizeTemplateContent(k, "tech_name")}: ${sanitizeTemplateContent(v, "tech_value")}`)
        .join("\n");
      variantContext += `\n\nAdditional libraries to use:\n${techLines}`;
    }
  }

  const prompt = buildSafePrompt({
    instructions: `The project has been scaffolded with a starter template (${pipeline.stack.join(", ")}). Now generate the ADDITIONAL source code files needed to implement the spec's specific features.

Do NOT regenerate boilerplate files that already exist (package.json, tsconfig.json, basic layout/config files). Focus on the business logic, custom screens/pages/tools, and feature-specific code.

Rules:
- Use TypeScript with strict mode
- Include proper error handling
- Add input validation at system boundaries
- Follow ${pipeline.stack[0]} best practices
- Include necessary type definitions
- Import from existing template files where appropriate
- Generate complete implementations — not stubs, not TODOs, not placeholders
- Every file must be runnable

For each file, use this exact format:
// === <relative-path-from-project-root> ===
<file content>`,
    userContent: {
      specification: sanitizeStructuredData(spec, "specification"),
    },
    additionalContext: variantContext,
  });

  const raw = await askClaude(prompt, systemCtx);

  // Parse file blocks
  const blocks = raw.split(/\/\/ === (.+?) ===/);
  for (let i = 1; i < blocks.length; i += 2) {
    if (!blocks[i]) continue;
    const relPath = blocks[i].trim();
    const content = blocks[i + 1]?.trim();
    if (relPath && content) {
      // Sanitize the relative path from LLM to prevent path traversal
      const fullPath = sanitizeRelativePath(relPath, targetDir);
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      if (dir) {
        const safeDir = sanitizePath(dir);
        await runShell(`mkdir -p ${JSON.stringify(safeDir)}`);
      }
      await writeFile(fullPath, content);
      files.push(fullPath);
    }
  }

  return files;
}

// ── Skill Dispatcher ────────────────────────────────────────────

async function handleSkill(
  skillId: string,
  args: Record<string, unknown>,
  text: string,
): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;

  switch (skillId) {
    case "normalize_intent": {
      const { idea, pipeline: pipelineId } = FactorySchemas.normalize_intent.parse({ idea: args.idea ?? text, ...args });

      // Match template variant first
      const match = await matchTemplate(idea, pipelineId);
      const specText = await normalizeIntent(idea, pipelineId, match.variantSpec);

      // Wrap spec and match info in structured JSON to keep the skill contract
      let spec: unknown = null;
      let specRaw: string | undefined = undefined;
      try {
        spec = JSON.parse(specText);
      } catch {
        // If normalizeIntent did not return valid JSON, preserve the raw text
        specRaw = specText;
      }

      const response: Record<string, unknown> = {
        match: {
          pipelineId,
          variantId: (match as any).variantId ?? null,
          confidence: (match as any).confidence ?? null,
          reason: (match as any).reason ?? null,
        },
      };

      if (specRaw !== undefined) {
        response.specRaw = specRaw;
      } else {
        response.spec = spec;
      }

      return safeStringify(response, 2);
    }

    case "create_project": {
      const { idea, pipeline: pipelineId, outputDir, variant } = FactorySchemas.create_project.parse({ idea: args.idea ?? text, ...args });

      const result = await createProject(idea, pipelineId, outputDir, variant);

      // Build human-readable summary
      const lines = [
        `# Project Created: ${result.projectName}`,
        ``,
        `**Pipeline:** ${result.pipelineId}`,
        `**Variant:** ${result.variantId ?? "base (no variant)"}`,
        `**Output:** ${result.outputDir}`,
        `**Files:** ${result.filesGenerated.length}`,
        ``,
        `## Specification`,
        "```json",
        JSON.stringify(result.spec, null, 2),
        "```",
        ``,
        `## Generated Files`,
        ...result.filesGenerated.map(f => `- ${f}`),
      ];

      if (result.qualityResult) {
        lines.push(
          ``,
          `## Quality Gate (Ralph Mode)`,
          `**Status:** ${result.qualityResult.passed ? "PASSED" : "NEEDS WORK"} (${result.qualityResult.average}/100, threshold: ${getPipeline(pipelineId)!.qualityGate.passThreshold})`,
          `**Iterations:** ${result.iterations}`,
          ``,
          `### Scores`,
          ...Object.entries(result.qualityResult.scores).map(([dim, score]) => `- ${dim}: ${score}/100`),
        );

        if (result.qualityResult.checklistResults && result.qualityResult.checklistResults.length > 0) {
          lines.push(
            ``,
            `### Domain Checklist`,
            ...result.qualityResult.checklistResults.map(c =>
              `- [${c.passed ? "x" : " "}] ${c.item}`
            ),
          );
        }

        if (result.qualityResult.issues.length > 0) {
          lines.push(
            ``,
            `### Remaining Issues`,
            ...result.qualityResult.issues.map(iss => `- [${iss.severity}] ${iss.dimension}: ${iss.description}`),
          );
        }

        lines.push(``, `### Summary`, result.qualityResult.summary);
      }

      // Persist result to memory
      const { handleMemorySkill: _hm } = await import("../worker-memory.js");
      _hm(NAME, "remember", {
        key: `project:${result.projectName}`,
        value: JSON.stringify({
          pipeline: result.pipelineId,
          variant: result.variantId,
          outputDir: result.outputDir,
          spec: result.spec,
          quality: result.qualityResult ? {
            passed: result.qualityResult.passed,
            average: result.qualityResult.average,
          } : null,
          createdAt: new Date().toISOString(),
        }),
      });

      return lines.join("\n");
    }

    case "quality_gate": {
      const { code, spec, pipeline: pipelineId, variant: variantId } = FactorySchemas.quality_gate.parse({ code: args.code ?? text, ...args });

      const pipeline = getPipeline(pipelineId);
      if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineId}`);

      let variantSpec: TemplateSpec | null = null;
      if (variantId) {
        variantSpec = await loadVariantSpec(pipelineId, variantId);
      }

      const result = await qualityGate(code, spec, pipeline, variantSpec);
      return safeStringify(result, 2);
    }

    case "list_pipelines":
      return safeStringify(listPipelines(), 2);

    case "list_templates": {
      const { pipeline: pipelineId } = FactorySchemas.list_templates.parse(args);
      if (pipelineId) {
        const variants = await listVariants(pipelineId);
        return safeStringify({ pipeline: pipelineId, variants }, 2);
      }
      const allVariants = await listAllVariants();
      // Group by pipeline
      const grouped: Record<string, VariantSummary[]> = {};
      for (const v of allVariants) {
        (grouped[v.pipelineId] ??= []).push(v);
      }
      return safeStringify(grouped, 2);
    }

    default:
      return `Unknown skill: ${skillId}`;
  }
}

// ── Fastify Server ──────────────────────────────────────────────

const app = Fastify({ logger: false });

app.get("/.well-known/agent.json", async () => AGENT_CARD);

app.get("/healthz", async () => ({
  status: "ok",
  agent: NAME,
  uptime: process.uptime(),
  skills: AGENT_CARD.skills.map(s => s.id),
  pipelines: Array.from(PIPELINES.keys()),
}));

app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
  const data = request.body;
  if (data?.method !== "tasks/send") {
    reply.code(404);
    return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
  }

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "list_pipelines";

  const sizeErr = checkRequestSize(data);
  if (sizeErr) { reply.code(413); return { jsonrpc: "2.0", error: { code: -32000, message: sizeErr } }; }

  try {
    const result = await handleSkill(sid, args ?? {}, text);
    return buildA2AResponse(data.id, taskId, result);
  } catch (err) {
    log(`skill ${sid} failed: ${err instanceof Error ? err.message : String(err)}`);
    reply.code(500);
    return buildA2AError(data.id, err);
  }
});

getPersona(NAME);
watchPersonas();

app.listen({ port: PORT, host: "localhost" }).then(() => {
  log(`listening on http://localhost:${PORT}`);
});
