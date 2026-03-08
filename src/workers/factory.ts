/**
 * Factory Agent — project generation pipelines.
 *
 * Turns a vague idea into a production-ready project by orchestrating
 * the full stack of A2A workers: ai-agent (spec generation, code gen, QA),
 * shell-agent (scaffolding, file I/O), design-agent (UI critique),
 * and code-agent (review).
 *
 * Skills:
 *   normalize_intent   — expand idea → detailed JSON spec
 *   create_project     — full pipeline: normalize → scaffold → generate → QA
 *   quality_gate       — "Ralph Mode" multi-dimension code review
 *   list_pipelines     — available pipeline types
 *   remember / recall  — shared memory
 */

import Fastify from "fastify";
import { handleMemorySkill } from "../worker-memory.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { PIPELINES, listPipelines, getPipeline } from "../pipelines/index.js";
import type { Pipeline } from "../pipelines/types.js";
import { loadTemplate } from "../templates/loader.js";
import { sendTask } from "../a2a.js";
import { randomUUID } from "crypto";

const PORT = 8087;
const NAME = "factory-agent";

// Worker URLs for direct calls — avoids routing through orchestrator
const WORKER_URLS = {
  ai: "http://localhost:8083",
  shell: "http://localhost:8081",
  design: "http://localhost:8086",
  code: "http://localhost:8084",
  web: "http://localhost:8082",
};

const AGENT_CARD = {
  name: NAME,
  description: "Factory agent — turns ideas into production-ready projects via multi-agent pipelines (AppFactory-style)",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    {
      id: "normalize_intent",
      name: "Normalize Intent",
      description: "Expand a vague project idea into a detailed, structured JSON spec. Returns the full product specification.",
    },
    {
      id: "create_project",
      name: "Create Project",
      description: "Full project generation pipeline: normalize intent → scaffold files → generate code → quality review loop. Returns the complete generated project summary.",
    },
    {
      id: "quality_gate",
      name: "Quality Gate",
      description: "Ralph Mode — multi-dimension code quality review. Scores code across dimensions and returns structured feedback with fixes.",
    },
    {
      id: "list_pipelines",
      name: "List Pipelines",
      description: "List available project generation pipelines and their tech stacks.",
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

async function reviewCode(code: string, context: string): Promise<string> {
  return sendTask(WORKER_URLS.code, {
    skillId: "codex_review",
    args: { code, context },
    message: { role: "user" as const, parts: [{ kind: "text" as const, text: context }] },
  }, { timeoutMs: 120_000 });
}

function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

// ── Intent Normalization ────────────────────────────────────────

async function normalizeIntent(idea: string, pipelineId: string): Promise<string> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineId}. Available: ${Array.from(PIPELINES.keys()).join(", ")}`);

  const prompt = pipeline.intentPrompt.replace("{{idea}}", idea);
  log(`normalizing intent for "${idea}" via ${pipelineId} pipeline`);

  const persona = getPersona(NAME);
  const raw = await askClaude(prompt, persona.systemPrompt || undefined);
  return stripJsonFences(raw);
}

// ── Quality Gate ("Ralph Mode") ─────────────────────────────────

interface QualityResult {
  passed: boolean;
  scores: Record<string, number>;
  average: number;
  issues: Array<{ dimension: string; severity: "critical" | "major" | "minor"; description: string; fix: string }>;
  summary: string;
}

async function qualityGate(
  code: string,
  spec: string,
  pipeline: Pipeline,
): Promise<QualityResult> {
  const dimensions = pipeline.qualityGate.dimensions;
  const threshold = pipeline.qualityGate.passThreshold;

  const prompt = `You are "Ralph" — a meticulous code reviewer who never lets subpar work ship.

Review the following generated code against its specification.

**Specification:**
${spec}

**Generated Code:**
${code}

Score each dimension 0-100 and list issues found:
Dimensions: ${dimensions.join(", ")}

Respond with ONLY valid JSON:
{
  "scores": { ${dimensions.map(d => `"${d}": <0-100>`).join(", ")} },
  "issues": [{ "dimension": "...", "severity": "critical|major|minor", "description": "...", "fix": "..." }],
  "summary": "1-2 sentence overall assessment"
}

Be strict. A score of 85+ means production-ready quality. Deduct points for:
- Missing error handling (-10 per instance)
- Type safety gaps (-5 per any/unknown)
- No input validation at boundaries (-15)
- Missing accessibility attributes (-10 per component)
- Security vulnerabilities (-20 per finding)`;

  const raw = await askClaude(prompt);
  const parsed = JSON.parse(stripJsonFences(raw));

  const scores = parsed.scores as Record<string, number>;
  const values = Object.values(scores);
  const average = values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;

  return {
    passed: average >= threshold,
    scores,
    average,
    issues: parsed.issues ?? [],
    summary: parsed.summary ?? "",
  };
}

// ── Project Scaffolding (file-based templates) ──────────────────

async function scaffoldProject(
  outputDir: string,
  pipeline: Pipeline,
  projectName: string,
  description?: string,
): Promise<string[]> {
  // Load template files from src/templates/<pipelineId>/
  const templateFiles = await loadTemplate(pipeline.id, {
    name: projectName,
    description: description ?? `A ${pipeline.name} project`,
  });

  // Ensure output directory exists
  await runShell(`mkdir -p ${outputDir}`);

  // Collect all unique directories we need to create
  const dirs = new Set<string>();
  for (const file of templateFiles) {
    const lastSlash = file.relativePath.lastIndexOf("/");
    if (lastSlash > 0) {
      dirs.add(`${outputDir}/${file.relativePath.substring(0, lastSlash)}`);
    }
  }
  if (dirs.size > 0) {
    await runShell(`mkdir -p ${Array.from(dirs).join(" ")}`);
  }

  // Write all template files
  const writtenFiles: string[] = [];
  for (const file of templateFiles) {
    const fullPath = `${outputDir}/${file.relativePath}`;
    await writeFile(fullPath, file.content);
    writtenFiles.push(fullPath);
  }

  log(`scaffolded ${writtenFiles.length} template files to ${outputDir}`);
  return writtenFiles;
}

// ── Full Project Generation ─────────────────────────────────────

interface CreateProjectResult {
  projectName: string;
  outputDir: string;
  pipelineId: string;
  spec: Record<string, unknown>;
  filesGenerated: string[];
  qualityResult: QualityResult | null;
  iterations: number;
}

async function createProject(
  idea: string,
  pipelineId: string,
  outputDir?: string,
): Promise<CreateProjectResult> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineId}`);

  // Step 1: Normalize intent
  log("step 1/4: normalizing intent");
  const specRaw = await normalizeIntent(idea, pipelineId);
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(specRaw);
  } catch {
    throw new Error(`Intent normalization returned invalid JSON: ${specRaw.slice(0, 200)}`);
  }

  const projectName = (spec.name as string ?? "my-project").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const targetDir = outputDir ?? `/tmp/factory/${projectName}-${Date.now()}`;

  // Step 2: Scaffold from templates
  log(`step 2/4: scaffolding to ${targetDir}`);
  const description = (spec.description as string) ?? (spec.tagline as string) ?? undefined;
  const templateFiles = await scaffoldProject(targetDir, pipeline, projectName, description);

  // Step 3: Generate code via Claude (supplements template with spec-specific logic)
  log("step 3/4: generating code");
  const generatedFiles = await generateCode(targetDir, spec, pipeline);
  // Merge template files into generated list (dedup)
  const allFiles = [...new Set([...templateFiles, ...generatedFiles])];

  // Step 4: Quality gate loop
  log("step 4/4: quality gate (Ralph Mode)");
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
      qualityResult = await qualityGate(allCode, JSON.stringify(spec, null, 2), pipeline);
      log(`quality gate iteration ${iterations}: avg=${qualityResult.average}, passed=${qualityResult.passed}`);

      if (qualityResult.passed) break;

      // Fix issues
      if (qualityResult.issues.length > 0 && i < pipeline.qualityGate.maxIterations - 1) {
        log(`fixing ${qualityResult.issues.length} issues`);
        const fixPrompt = `Fix the following issues in the code. Return ONLY the corrected code for each file, with file markers like "// === filepath ===" between them.

Issues:
${qualityResult.issues.map(iss => `- [${iss.severity}] ${iss.dimension}: ${iss.description}\n  Fix: ${iss.fix}`).join("\n")}

Current code:
${allCode}`;

        const fixed = await askClaude(fixPrompt);
        // Parse fixed files and write them
        const fileBlocks = fixed.split(/\/\/ === (.+?) ===/);
        for (let j = 1; j < fileBlocks.length; j += 2) {
          const filePath = fileBlocks[j].trim();
          const fileContent = fileBlocks[j + 1]?.trim();
          if (filePath && fileContent) {
            await writeFile(filePath, fileContent);
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
    spec,
    filesGenerated: allFiles,
    qualityResult,
    iterations,
  };
}

// ── Code Generation (pipeline-aware) ────────────────────────────

async function generateCode(
  targetDir: string,
  spec: Record<string, unknown>,
  pipeline: Pipeline,
): Promise<string[]> {
  const files: string[] = [];
  const specStr = JSON.stringify(spec, null, 2);

  const persona = getPersona(NAME);
  const systemCtx = persona.systemPrompt
    ? `${persona.systemPrompt}\n\nYou are generating code for a ${pipeline.name} project using: ${pipeline.stack.join(", ")}.`
    : `You are generating code for a ${pipeline.name} project using: ${pipeline.stack.join(", ")}.`;

  const prompt = `Given this project specification:
${specStr}

The project has been scaffolded with a starter template (${pipeline.stack.join(", ")}). Now generate the ADDITIONAL source code files needed to implement the spec's specific features.

Do NOT regenerate boilerplate files that already exist (package.json, tsconfig.json, basic layout/config files). Focus on the business logic, custom screens/pages/tools, and feature-specific code.

Rules:
- Use TypeScript with strict mode
- Include proper error handling
- Add input validation at system boundaries
- Follow ${pipeline.stack[0]} best practices
- Include necessary type definitions
- Import from existing template files where appropriate

For each file, use this exact format:
// === <relative-path-from-project-root> ===
<file content>

Generate complete implementations — not stubs, not TODOs, not placeholders. Every file must be runnable.`;

  const raw = await askClaude(prompt, systemCtx);

  // Parse file blocks
  const blocks = raw.split(/\/\/ === (.+?) ===/);
  for (let i = 1; i < blocks.length; i += 2) {
    const relPath = blocks[i].trim();
    const content = blocks[i + 1]?.trim();
    if (relPath && content) {
      const fullPath = `${targetDir}/${relPath}`;
      // Ensure parent directory exists
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      if (dir) await runShell(`mkdir -p ${dir}`);
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
      const idea = (args.idea as string) ?? text;
      const pipelineId = (args.pipeline as string) ?? "app";
      if (!idea) throw new Error("normalize_intent requires idea");
      const result = await normalizeIntent(idea, pipelineId);
      return result;
    }

    case "create_project": {
      const idea = (args.idea as string) ?? text;
      const pipelineId = (args.pipeline as string) ?? "app";
      const outputDir = args.outputDir as string | undefined;
      if (!idea) throw new Error("create_project requires idea");

      const result = await createProject(idea, pipelineId, outputDir);

      // Build human-readable summary
      const lines = [
        `# Project Created: ${result.projectName}`,
        ``,
        `**Pipeline:** ${result.pipelineId}`,
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
      const code = (args.code as string) ?? text;
      const spec = (args.spec as string) ?? "{}";
      const pipelineId = (args.pipeline as string) ?? "app";
      if (!code) throw new Error("quality_gate requires code");

      const pipeline = getPipeline(pipelineId);
      if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineId}`);

      const result = await qualityGate(code, spec, pipeline);
      return JSON.stringify(result, null, 2);
    }

    case "list_pipelines":
      return JSON.stringify(listPipelines(), null, 2);

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

  try {
    const result = await handleSkill(sid, args ?? {}, text);
    return {
      jsonrpc: "2.0", id: data.id,
      result: {
        id: taskId,
        status: { state: "completed" },
        artifacts: [{ parts: [{ kind: "text" as const, text: result }] }],
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`skill ${sid} failed: ${msg}`);
    reply.code(500);
    return { jsonrpc: "2.0", id: data.id, error: { code: -32000, message: msg } };
  }
});

getPersona(NAME);
watchPersonas();

app.listen({ port: PORT, host: "localhost" }).then(() => {
  log(`listening on http://localhost:${PORT}`);
});
