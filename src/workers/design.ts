import Fastify from "fastify";
import { GoogleGenAI } from "@google/genai";
import { spawnSync } from "child_process";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { sanitizeUserInput } from "../prompt-sanitizer.js";
import { buildA2AResponse, buildA2AError, checkRequestSize } from "../worker-harness.js";

const DesignSchemas = {
  enhance_ui_prompt: z.looseObject({ description: z.string().min(1), deviceType: z.string().optional().default("mobile") }),
  suggest_screens: z.looseObject({ appConcept: z.string().min(1), deviceType: z.string().optional().default("mobile") }),
  design_critique: z.looseObject({ description: z.string().min(1) }),
  generate_brand: z.looseObject({
    appName: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    industry: z.string().max(200).optional(),
    targetAudience: z.string().max(200).optional(),
  }),
};

const PORT = 8086;
const NAME = "design-agent";

const AGENT_CARD = {
  name: NAME,
  description: "Design agent — Gemini-powered UI prompt engineering and design critique",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "enhance_ui_prompt", name: "Enhance UI Prompt", description: "Expand a vague UI description into a detailed, structured Stitch-ready design prompt" },
    { id: "suggest_screens", name: "Suggest Screens", description: "Suggest essential screens for an app concept, each with a detailed design prompt" },
    { id: "design_critique", name: "Design Critique", description: "Critique a UI design description and return actionable improvements" },
    { id: "generate_brand", name: "Generate Brand", description: "Generate a consistent brand identity (color palette, typography, visual style, tone) from an app name and description. Use the output to anchor all subsequent enhance_ui_prompt and suggest_screens calls." },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory" },
  ],
};

// ── Auth: SDK with API key (singleton), or fall back to gemini CLI (OAuth) ──
let _gemini: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI {
  if (_gemini) return _gemini;
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("no-api-key");
  _gemini = new GoogleGenAI({ apiKey });
  return _gemini;
}

function runGeminiCLI(prompt: string): string {
  const result = spawnSync("gemini", ["-p", prompt], {
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) throw new Error(result.stderr || "gemini CLI failed");
  return result.stdout.trim();
}

// Unified call: SDK when API key is set, gemini CLI otherwise.
// systemInstruction is prepended to the user prompt for CLI mode.
async function callGemini(systemInstruction: string, userPrompt: string): Promise<string> {
  try {
    const ai = getGemini();
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      config: { systemInstruction },
      contents: userPrompt,
    });
    if (!response?.text) throw new Error("Gemini returned empty response");
    return response.text.trim();
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "no-api-key") throw err;
    // CLI fallback: prefix system instruction into the prompt
    return runGeminiCLI(`${systemInstruction}\n\n${userPrompt}`);
  }
}

// Device-specific UI component vocabulary — steers Stitch toward the right layout language
const DEVICE_VOCAB: Record<string, string> = {
  mobile:  "bottom navigation bar, floating action button, swipeable cards, pull-to-refresh, modal bottom sheets",
  desktop: "sidebar navigation, data tables, split-pane layouts, hover states, dropdown menus, breadcrumbs",
  tablet:  "master-detail pane, collapsible sidebar, adaptive grid, touch-optimized with pointer fallbacks",
};

// ── Core: enhance a vague concept into a Stitch-ready design prompt ──
async function enhanceUiPrompt(description: string, deviceType: string): Promise<string> {
  const vocab = DEVICE_VOCAB[deviceType] ?? DEVICE_VOCAB.mobile;

  const systemInstruction = `You are a senior UX designer writing design briefs for an AI UI generation tool called Stitch.
Your output is rendered directly — describe exactly what Stitch should draw.

Rules:
- Write ONE coherent paragraph (4–8 sentences). No bullet points, no headers.
- Name specific ${deviceType} UI components such as: ${vocab}.
- Specify a color mood using descriptive names ("deep navy", "warm coral", "sage green") — never hex codes.
- Include one visual style from: minimal, material, glassmorphic, neumorphic, flat, vibrant, or editorial.
- Describe typography in two words: one for headings, one for body (e.g. "bold geometric headings, light readable body").
- State the content hierarchy: what is dominant, what is secondary.
- Mention key states where relevant: loading skeletons, empty states, active/selected highlights.`;

  const userPrompt = `Target device type: ${deviceType}

${sanitizeUserInput(description, "ui_description")}`;

  return callGemini(systemInstruction, userPrompt);
}

// ── Suggest the set of screens an app needs ──────────────────────
async function suggestScreens(appConcept: string, deviceType: string): Promise<string> {
  const systemInstruction = `You are a product designer planning the screen architecture for a new app.
Respond ONLY with a valid JSON array — no markdown fences, no explanation:
[{ "name": "Screen Name", "prompt": "detailed Stitch-ready design prompt..." }, ...]
Include 3-6 screens. Each prompt must specify colors, layout, and key components.`;

  const userPrompt = `Target device: ${deviceType}

List the essential screens as JSON for the following app concept:

${sanitizeUserInput(appConcept, "app_concept")}`;

  const raw = await callGemini(systemInstruction, userPrompt);
  // Strip optional markdown code fences (``` or ```json) that models sometimes add despite instructions
  return raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

// ── Critique a design and return structured feedback ─────────────
async function designCritique(description: string): Promise<string> {
  const systemInstruction = `You are a senior UX design critic with expertise in modern mobile and web UI.
Structure your response as:
1. **Strengths** — what works well
2. **Issues** — usability or visual concerns
3. **Improvements** — 3-5 concrete actionable suggestions
4. **Enhanced Prompt** — rewrite incorporating your improvements`;

  const userPrompt = `Analyze this design description:

${sanitizeUserInput(description, "design_description")}`;

  return callGemini(systemInstruction, userPrompt);
}

// ── Generate a brand identity system for an app ──────────────────
async function generateBrand(appName: string, description: string, industry?: string, targetAudience?: string): Promise<string> {
  if (description.length > 2_000) {
    process.stderr.write(`[${NAME}] generate_brand: description too large (${description.length} chars)\n`);
    throw new Error(`generate_brand: description is ${description.length} characters — exceeds 2,000 character limit`);
  }

  const systemInstruction = `You are a brand strategist and visual designer. Given an app concept, produce a complete brand identity system as JSON.

Respond ONLY with a valid JSON object — no markdown fences, no explanation:
{
  "palette": ["descriptive color name 1", "descriptive color name 2", "descriptive color name 3"],
  "primaryColor": "descriptive color name",
  "accentColor": "descriptive color name",
  "backgroundColor": "descriptive color name",
  "typography": { "heading": "one-word style (e.g. bold geometric)", "body": "one-word style (e.g. light readable)" },
  "visualStyle": "one of: minimal | material | glassmorphic | neumorphic | flat | vibrant | editorial",
  "mood": ["adjective1", "adjective2", "adjective3"],
  "voice": "one sentence describing the brand's communication style"
}

Use descriptive color names ("deep navy", "warm coral") — never hex codes. Palette must be 3-5 colors that work together.`;

  const contextLines = [
    `App name: ${sanitizeUserInput(appName, "app_name", 200)}`,
    industry ? `Industry: ${sanitizeUserInput(industry, "industry", 200)}` : null,
    targetAudience ? `Target audience: ${sanitizeUserInput(targetAudience, "target_audience", 200)}` : null,
    `Description: ${sanitizeUserInput(description, "app_description", 2_000)}`,
  ].filter(Boolean).join("\n");

  const raw = await callGemini(systemInstruction, contextLines);
  if (!raw || raw.trim().length === 0) {
    process.stderr.write(`[${NAME}] generate_brand: Gemini returned empty response\n`);
    throw new Error("generate_brand: model returned empty response — retry or check API key");
  }
  const stripped = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  if (stripped.length === 0) {
    process.stderr.write(`[${NAME}] generate_brand: response was only markdown fences\n`);
    throw new Error("generate_brand: model returned only markdown fences — retry");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    process.stderr.write(`[${NAME}] generate_brand: JSON.parse failed — ${err instanceof Error ? err.message : String(err)} — raw: ${stripped.slice(0, 80)}\n`);
    throw new Error("generate_brand: model did not return valid JSON — retry");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.stderr.write(`[${NAME}] generate_brand: unexpected JSON structure (type=${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed})\n`);
    throw new Error("generate_brand: model returned unexpected JSON structure — retry");
  }
  const p = parsed as Record<string, unknown>;
  const requiredKeys = ["palette", "primaryColor", "accentColor", "backgroundColor", "typography", "visualStyle", "mood", "voice"];
  const missing = requiredKeys.filter(k => !(k in p));
  if (missing.length > 0) {
    process.stderr.write(`[${NAME}] generate_brand: missing required fields: ${missing.join(", ")}\n`);
    throw new Error(`generate_brand: model response missing required fields: ${missing.join(", ")} — retry`);
  }

  return stripped;
}

// ── Skill dispatcher ─────────────────────────────────────────────
async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;

  switch (skillId) {
    case "enhance_ui_prompt": {
      const { description, deviceType } = DesignSchemas.enhance_ui_prompt.parse({ description: args.description ?? text, ...args });
      return enhanceUiPrompt(description, deviceType.toLowerCase());
    }

    case "suggest_screens": {
      const { appConcept, deviceType } = DesignSchemas.suggest_screens.parse({ appConcept: args.appConcept ?? text, ...args });
      return suggestScreens(appConcept, deviceType.toLowerCase());
    }

    case "design_critique": {
      const { description } = DesignSchemas.design_critique.parse({ description: args.description ?? text, ...args });
      return designCritique(description);
    }

    case "generate_brand": {
      let gbParsed: ReturnType<typeof DesignSchemas.generate_brand.parse>;
      try {
        gbParsed = DesignSchemas.generate_brand.parse({ appName: args.appName ?? text, ...args });
      } catch (err) {
        process.stderr.write(`[${NAME}] generate_brand: Zod parse error: ${err instanceof Error ? err.message : String(err)}\n`);
        throw err;
      }
      const { appName, description, industry, targetAudience } = gbParsed;
      return generateBrand(appName, description, industry, targetAudience);
    }

    default:
      return `Unknown skill: ${skillId}`;
  }
}

// ── Fastify server ───────────────────────────────────────────────
const app = Fastify({ logger: false });

app.get("/.well-known/agent.json", async () => AGENT_CARD);

app.get("/healthz", async () => ({
  status: "ok",
  agent: NAME,
  uptime: process.uptime(),
  skills: AGENT_CARD.skills.map(s => s.id),
}));

app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
  const data = request.body;
  if (data?.method !== "tasks/send") {
    reply.code(404);
    return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
  }

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "enhance_ui_prompt";

  const sizeErr = checkRequestSize(data);
  if (sizeErr) { reply.code(413); return { jsonrpc: "2.0", error: { code: -32000, message: sizeErr } }; }

  try {
    const result = await handleSkill(sid, args ?? { description: text }, text);
    return buildA2AResponse(data.id, taskId, result);
  } catch (err) {
    reply.code(500);
    return buildA2AError(data.id, err);
  }
});

getPersona(NAME); // warm cache
watchPersonas();

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
