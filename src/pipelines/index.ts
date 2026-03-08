/**
 * Pipeline registry — all available project generation pipelines.
 *
 * Templates are now file-based under src/templates/<pipelineId>/.
 * The inline `template` property has been removed from Pipeline.
 */

import type { Pipeline } from "./types.js";

// ── Mobile App Pipeline ─────────────────────────────────────────
const appPipeline: Pipeline = {
  id: "app",
  name: "Mobile App",
  description: "Expo + React Native mobile app with TypeScript",
  stack: ["TypeScript", "React Native", "Expo", "Expo Router"],
  intentPrompt: `You are a senior product manager expanding a vague app idea into a detailed product spec.

Given this idea: "{{idea}}"

Produce a JSON object with these fields:
- name: short app name (2-3 words, kebab-case)
- description: one-sentence pitch
- features: array of 5-8 core features, each with { name, description, priority: "must"|"should"|"nice" }
- screens: array of 4-6 screens, each with { name, purpose, keyComponents: string[] }
- monetization: how the app makes money
- targetAudience: who uses this
- techNotes: any special technical requirements (APIs, sensors, storage, etc.)

Respond with ONLY valid JSON — no markdown fences, no explanation.`,
  steps: [
    { id: "normalize", label: "Expanding intent into spec", skillId: "ask_claude", replacesSpec: true },
    { id: "scaffold", label: "Scaffolding project from template", skillId: "run_shell" },
    { id: "generate_screens", label: "Generating screen components", skillId: "ask_claude" },
    { id: "generate_navigation", label: "Generating navigation structure", skillId: "ask_claude" },
    { id: "generate_state", label: "Generating state management", skillId: "ask_claude" },
    { id: "generate_api", label: "Generating API layer", skillId: "ask_claude" },
    { id: "write_files", label: "Writing generated code to disk", skillId: "run_shell" },
    { id: "quality_gate", label: "Ralph Mode — quality review", skillId: "ask_claude" },
    { id: "fix_issues", label: "Fixing quality issues", skillId: "ask_claude", optional: true },
  ],
  qualityGate: {
    dimensions: ["code_quality", "type_safety", "ux_completeness", "error_handling", "accessibility"],
    passThreshold: 85,
    maxIterations: 3,
  },
};

// ── Website Pipeline ────────────────────────────────────────────
const websitePipeline: Pipeline = {
  id: "website",
  name: "Website",
  description: "Next.js website with TypeScript and Tailwind CSS",
  stack: ["TypeScript", "Next.js", "React", "Tailwind CSS"],
  intentPrompt: `You are a senior product designer expanding a vague website idea into a detailed spec.

Given this idea: "{{idea}}"

Produce a JSON object with these fields:
- name: site name (kebab-case)
- description: one-sentence pitch
- pages: array of 3-6 pages, each with { name, route, purpose, sections: string[] }
- style: { colorScheme: string, typography: string, visualStyle: string }
- features: array of interactive features (forms, animations, API integrations)
- seo: { title, description, keywords: string[] }
- deployment: recommended hosting approach

Respond with ONLY valid JSON — no markdown fences, no explanation.`,
  steps: [
    { id: "normalize", label: "Expanding intent into spec", skillId: "ask_claude", replacesSpec: true },
    { id: "scaffold", label: "Scaffolding project from template", skillId: "run_shell" },
    { id: "generate_pages", label: "Generating page components", skillId: "ask_claude" },
    { id: "generate_layout", label: "Generating layout and navigation", skillId: "ask_claude" },
    { id: "generate_styles", label: "Generating styles and theme", skillId: "ask_claude" },
    { id: "write_files", label: "Writing generated code to disk", skillId: "run_shell" },
    { id: "quality_gate", label: "Ralph Mode — quality review", skillId: "ask_claude" },
    { id: "fix_issues", label: "Fixing quality issues", skillId: "ask_claude", optional: true },
  ],
  qualityGate: {
    dimensions: ["code_quality", "responsive_design", "seo", "accessibility", "performance"],
    passThreshold: 85,
    maxIterations: 3,
  },
};

// ── MCP Server Pipeline ─────────────────────────────────────────
const mcpServerPipeline: Pipeline = {
  id: "mcp-server",
  name: "MCP Server",
  description: "Model Context Protocol server with TypeScript + Bun",
  stack: ["TypeScript", "Bun", "@modelcontextprotocol/sdk"],
  intentPrompt: `You are a senior developer expanding a vague MCP server idea into a detailed spec.

Given this idea: "{{idea}}"

Produce a JSON object with these fields:
- name: server name (kebab-case)
- description: what this MCP server does
- tools: array of 3-6 tools, each with { name, description, inputSchema: { type: "object", properties: {...}, required: string[] } }
- resources: array of 0-3 resources, each with { uri, name, description }
- dataSources: what external data/APIs this server connects to
- authStrategy: how authentication works (env vars, OAuth, none)
- techNotes: any special requirements

Respond with ONLY valid JSON — no markdown fences, no explanation.`,
  steps: [
    { id: "normalize", label: "Expanding intent into spec", skillId: "ask_claude", replacesSpec: true },
    { id: "scaffold", label: "Scaffolding project from template", skillId: "run_shell" },
    { id: "generate_tools", label: "Generating tool implementations", skillId: "ask_claude" },
    { id: "generate_resources", label: "Generating resource handlers", skillId: "ask_claude" },
    { id: "generate_server", label: "Generating server entry point", skillId: "ask_claude" },
    { id: "write_files", label: "Writing generated code to disk", skillId: "run_shell" },
    { id: "quality_gate", label: "Ralph Mode — quality review", skillId: "ask_claude" },
    { id: "fix_issues", label: "Fixing quality issues", skillId: "ask_claude", optional: true },
  ],
  qualityGate: {
    dimensions: ["code_quality", "type_safety", "error_handling", "mcp_compliance", "security"],
    passThreshold: 90,
    maxIterations: 3,
  },
};

// ── AI Agent Pipeline ───────────────────────────────────────────
const agentPipeline: Pipeline = {
  id: "agent",
  name: "AI Agent",
  description: "AI agent with tool-calling capabilities using Claude API",
  stack: ["TypeScript", "Bun", "@anthropic-ai/sdk", "Fastify"],
  intentPrompt: `You are a senior AI engineer expanding a vague agent idea into a detailed spec.

Given this idea: "{{idea}}"

Produce a JSON object with these fields:
- name: agent name (kebab-case)
- description: what this agent does
- personality: brief personality/tone description for the system prompt
- tools: array of 3-8 tools the agent can use, each with { name, description, implementation: "api"|"shell"|"compute"|"db" }
- triggers: how the agent is activated (API, schedule, webhook, chat)
- dataSources: what data the agent accesses
- outputFormat: what the agent produces (text, JSON, files, actions)
- guardrails: safety constraints and limits

Respond with ONLY valid JSON — no markdown fences, no explanation.`,
  steps: [
    { id: "normalize", label: "Expanding intent into spec", skillId: "ask_claude", replacesSpec: true },
    { id: "scaffold", label: "Scaffolding project from template", skillId: "run_shell" },
    { id: "generate_tools", label: "Generating agent tools", skillId: "ask_claude" },
    { id: "generate_agent", label: "Generating agent core logic", skillId: "ask_claude" },
    { id: "generate_server", label: "Generating API server", skillId: "ask_claude" },
    { id: "write_files", label: "Writing generated code to disk", skillId: "run_shell" },
    { id: "quality_gate", label: "Ralph Mode — quality review", skillId: "ask_claude" },
    { id: "fix_issues", label: "Fixing quality issues", skillId: "ask_claude", optional: true },
  ],
  qualityGate: {
    dimensions: ["code_quality", "type_safety", "tool_design", "error_handling", "security"],
    passThreshold: 85,
    maxIterations: 3,
  },
};

// ── API / Backend Pipeline ──────────────────────────────────────
const apiPipeline: Pipeline = {
  id: "api",
  name: "API Backend",
  description: "REST/GraphQL API with TypeScript, Bun, and SQLite",
  stack: ["TypeScript", "Bun", "Fastify", "SQLite"],
  intentPrompt: `You are a senior backend architect expanding a vague API idea into a detailed spec.

Given this idea: "{{idea}}"

Produce a JSON object with these fields:
- name: service name (kebab-case)
- description: what this API does
- entities: array of 3-6 data entities, each with { name, fields: Array<{ name, type, required: boolean }>, relationships: string[] }
- endpoints: array of API endpoints, each with { method, path, description, auth: boolean }
- auth: authentication strategy (JWT, API key, OAuth, none)
- storage: data storage approach
- techNotes: any special requirements (rate limiting, webhooks, etc.)

Respond with ONLY valid JSON — no markdown fences, no explanation.`,
  steps: [
    { id: "normalize", label: "Expanding intent into spec", skillId: "ask_claude", replacesSpec: true },
    { id: "scaffold", label: "Scaffolding project from template", skillId: "run_shell" },
    { id: "generate_schema", label: "Generating database schema", skillId: "ask_claude" },
    { id: "generate_routes", label: "Generating API routes", skillId: "ask_claude" },
    { id: "generate_middleware", label: "Generating middleware (auth, validation)", skillId: "ask_claude" },
    { id: "generate_server", label: "Generating server entry point", skillId: "ask_claude" },
    { id: "write_files", label: "Writing generated code to disk", skillId: "run_shell" },
    { id: "quality_gate", label: "Ralph Mode — quality review", skillId: "ask_claude" },
    { id: "fix_issues", label: "Fixing quality issues", skillId: "ask_claude", optional: true },
  ],
  qualityGate: {
    dimensions: ["code_quality", "type_safety", "api_design", "error_handling", "security"],
    passThreshold: 85,
    maxIterations: 3,
  },
};

// ── CLI Tool Pipeline ────────────────────────────────────────────
const cliPipeline: Pipeline = {
  id: "cli",
  name: "CLI Tool",
  description: "Command-line tool with TypeScript + Bun",
  stack: ["TypeScript", "Bun", "Zod"],
  intentPrompt: `You are a senior CLI developer expanding a vague command-line tool idea into a detailed spec.

Given this idea: "{{idea}}"

Produce a JSON object with these fields:
- name: tool name (kebab-case, short)
- description: one-sentence pitch of what this CLI does
- commands: array of 3-8 commands, each with { name, description, args: Array<{ name, type: "string"|"number"|"boolean", required: boolean, description: string }>, flags: Array<{ name, short?: string, type, description }> }
- globalFlags: array of flags available to all commands (beyond built-in --help/--version/--verbose/--json)
- config: { fileName, format: "json"|"yaml"|"toml", fields: Array<{ name, type, default, description }> } or null if no config needed
- outputFormats: which output formats to support ("text", "json", "table")
- techNotes: any special requirements (APIs, file system access, network, etc.)
- examples: array of 3-5 usage examples as strings

Respond with ONLY valid JSON — no markdown fences, no explanation.`,
  steps: [
    { id: "normalize", label: "Expanding intent into spec", skillId: "ask_claude", replacesSpec: true },
    { id: "scaffold", label: "Scaffolding project from template", skillId: "run_shell" },
    { id: "generate_commands", label: "Generating command implementations", skillId: "ask_claude" },
    { id: "generate_config", label: "Generating config management", skillId: "ask_claude" },
    { id: "generate_utils", label: "Generating utility modules", skillId: "ask_claude" },
    { id: "write_files", label: "Writing generated code to disk", skillId: "run_shell" },
    { id: "quality_gate", label: "Ralph Mode — quality review", skillId: "ask_claude" },
    { id: "fix_issues", label: "Fixing quality issues", skillId: "ask_claude", optional: true },
  ],
  qualityGate: {
    dimensions: ["code_quality", "type_safety", "cli_ux", "error_handling", "documentation"],
    passThreshold: 85,
    maxIterations: 3,
  },
};

// ── Pipeline Registry ───────────────────────────────────────────

export const PIPELINES = new Map<string, Pipeline>([
  ["app", appPipeline],
  ["website", websitePipeline],
  ["mcp-server", mcpServerPipeline],
  ["agent", agentPipeline],
  ["api", apiPipeline],
  ["cli", cliPipeline],
]);

export function getPipeline(id: string): Pipeline | undefined {
  return PIPELINES.get(id);
}

export function listPipelines(): Array<{ id: string; name: string; description: string; stack: string[] }> {
  return Array.from(PIPELINES.values()).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    stack: p.stack,
  }));
}

export type { Pipeline, PipelineStep, QualityGate };
