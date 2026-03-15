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
  color_palette: z.looseObject({
    /** Brand or product description to base the palette on */
    description: z.string().min(1).refine(s => s.trim().length > 0, "description must not be blank"),
    /** Optional mood/tone hint, e.g. "energetic", "calm", "professional", "playful" */
    mood: z.string().max(100).optional(),
    /** Number of accent colors to include (1-5, default 2) */
    accents: z.number().int().min(1).max(5).optional().default(2),
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
    { id: "color_palette", name: "Color Palette", description: "Generate a coordinated brand color palette from a description. Returns JSON with primary, secondary, background, surface, text, and accent colors — each with a hex code, name, and usage role. Optional mood hint (e.g. 'calm', 'energetic') and configurable accent count (1-5)." },
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

// ── Generate a coordinated brand color palette ───────────────────
async function colorPalette(description: string, mood: string | undefined, accents: number): Promise<string> {
  const moodLine = mood ? `\nMood/tone: ${sanitizeUserInput(mood, "mood_hint", 100)}` : "";

  const systemInstruction = `You are a professional brand designer specialising in color systems.
Generate a complete, harmonious color palette for a brand and return ONLY valid JSON — no markdown fences, no explanation.

Required JSON shape:
{
  "primary":    { "hex": "#xxxxxx", "name": "...", "role": "..." },
  "secondary":  { "hex": "#xxxxxx", "name": "...", "role": "..." },
  "background": { "hex": "#xxxxxx", "name": "...", "role": "..." },
  "surface":    { "hex": "#xxxxxx", "name": "...", "role": "..." },
  "text":       { "hex": "#xxxxxx", "name": "...", "role": "..." },
  "textMuted":  { "hex": "#xxxxxx", "name": "...", "role": "..." },
  "accents":    [{ "hex": "#xxxxxx", "name": "...", "role": "..." }, ...]
}

Rules:
- All hex values must be valid 6-digit lowercase hex codes (#rrggbb)
- name: a descriptive color name (e.g. "Deep Ocean", "Warm Sand")
- role: one-sentence usage guidance (e.g. "Primary CTA buttons and key interactive elements")
- accents array must have exactly ${accents} entries
- Ensure WCAG AA contrast between text and background (#4.5:1 minimum)
- Colors must feel cohesive — use a coherent hue family or complementary scheme`;

  const userPrompt = `Brand/product description:${moodLine}

${sanitizeUserInput(description, "brand_description")}`;

  const raw = await callGemini(systemInstruction, userPrompt);

  if (raw.trim().length === 0) {
    process.stderr.write(`[${NAME}] color_palette: Gemini returned empty response (descLen=${description.length})\n`);
    throw new Error("color_palette: Gemini returned empty response — retry or check model availability");
  }

  // Strip optional markdown fences
  const stripped = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  // Validate JSON and required fields
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    process.stderr.write(`[${NAME}] color_palette: Gemini returned non-JSON output (${stripped.slice(0, 80)}...)\n`);
    throw new Error("color_palette: model did not return valid JSON — retry or try a simpler description");
  }

  const p = parsed as Record<string, unknown>;
  const hasRequired = ["primary", "secondary", "background", "surface", "text", "textMuted", "accents"].every(k => k in p);
  if (!hasRequired || !Array.isArray(p.accents) || (p.accents as unknown[]).length !== accents) {
    process.stderr.write(`[${NAME}] color_palette: incomplete palette shape — keys=${Object.keys(p).join(",")}, accents=${Array.isArray(p.accents) ? p.accents.length : "missing"}\n`);
    throw new Error("color_palette: model returned incomplete palette — retry or check model availability");
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

    case "color_palette": {
      let cpParsed: ReturnType<typeof DesignSchemas.color_palette.parse>;
      try {
        cpParsed = DesignSchemas.color_palette.parse({ description: args.description ?? text, ...args });
      } catch (err) {
        process.stderr.write(`[${NAME}] color_palette: Zod parse error: ${err instanceof Error ? err.message : String(err)}\n`);
        throw err;
      }
      const { description, mood, accents } = cpParsed;

      if (description.length > 2_000) {
        process.stderr.write(`[${NAME}] color_palette: description too large (${description.length} chars)\n`);
        return `Error: description is ${description.length} characters — exceeds 2,000 character limit`;
      }

      return colorPalette(description, mood, accents);
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
