/**
 * Pipeline registry — all available project generation pipelines.
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
- name: short app name (2-3 words)
- tagline: one-sentence pitch
- features: array of 5-8 core features, each with { name, description, priority: "must"|"should"|"nice" }
- screens: array of 4-6 screens, each with { name, purpose, keyComponents: string[] }
- monetization: how the app makes money
- targetAudience: who uses this
- techNotes: any special technical requirements (APIs, sensors, storage, etc.)

Respond with ONLY valid JSON — no markdown fences, no explanation.`,
  steps: [
    { id: "normalize", label: "Expanding intent into spec", skillId: "ask_claude", replacesSpec: true },
    { id: "scaffold", label: "Scaffolding project structure", skillId: "run_shell" },
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
  template: {
    files: {
      "app/": "",
      "app/(tabs)/": "",
      "app/(tabs)/index.tsx": "",
      "app/(tabs)/_layout.tsx": "",
      "app/_layout.tsx": "",
      "components/": "",
      "hooks/": "",
      "constants/": "",
      "assets/": "",
      "package.json": JSON.stringify({
        name: "{{name}}",
        version: "1.0.0",
        main: "expo-router/entry",
        scripts: {
          start: "expo start",
          android: "expo start --android",
          ios: "expo start --ios",
          web: "expo start --web",
          lint: "expo lint",
        },
        dependencies: {
          expo: "~52.0.0",
          "expo-router": "~4.0.0",
          react: "18.3.1",
          "react-native": "0.76.3",
        },
        devDependencies: {
          "@types/react": "~18.3.0",
          typescript: "~5.3.0",
        },
      }, null, 2),
      "tsconfig.json": JSON.stringify({
        extends: "expo/tsconfig.base",
        compilerOptions: { strict: true },
      }, null, 2),
    },
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
- name: site name
- tagline: one-sentence pitch
- pages: array of 3-6 pages, each with { name, route, purpose, sections: string[] }
- style: { colorScheme: string, typography: string, visualStyle: string }
- features: array of interactive features (forms, animations, API integrations)
- seo: { title, description, keywords: string[] }
- deployment: recommended hosting approach

Respond with ONLY valid JSON — no markdown fences, no explanation.`,
  steps: [
    { id: "normalize", label: "Expanding intent into spec", skillId: "ask_claude", replacesSpec: true },
    { id: "scaffold", label: "Scaffolding project structure", skillId: "run_shell" },
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
  template: {
    files: {
      "src/app/": "",
      "src/app/page.tsx": "",
      "src/app/layout.tsx": "",
      "src/components/": "",
      "public/": "",
      "package.json": JSON.stringify({
        name: "{{name}}",
        version: "1.0.0",
        scripts: {
          dev: "next dev",
          build: "next build",
          start: "next start",
          lint: "next lint",
        },
        dependencies: {
          next: "15.1.0",
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        },
        devDependencies: {
          "@types/react": "^19.0.0",
          typescript: "^5.0.0",
          tailwindcss: "^4.0.0",
        },
      }, null, 2),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2017",
          lib: ["dom", "dom.iterable", "esnext"],
          strict: true,
          jsx: "preserve",
          moduleResolution: "bundler",
          plugins: [{ name: "next" }],
          paths: { "@/*": ["./src/*"] },
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
      }, null, 2),
    },
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
    { id: "scaffold", label: "Scaffolding project structure", skillId: "run_shell" },
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
  template: {
    files: {
      "src/": "",
      "src/index.ts": "",
      "src/tools/": "",
      "src/resources/": "",
      "package.json": JSON.stringify({
        name: "{{name}}",
        version: "1.0.0",
        type: "module",
        scripts: {
          start: "bun src/index.ts",
          dev: "bun --watch src/index.ts",
          build: "bun build src/index.ts --target bun --outdir dist",
        },
        dependencies: {
          "@modelcontextprotocol/sdk": "^1.12.0",
        },
        devDependencies: {
          "@types/bun": "latest",
          typescript: "^5.0.0",
        },
      }, null, 2),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          esModuleInterop: true,
          types: ["bun-types"],
        },
        include: ["src/**/*.ts"],
      }, null, 2),
    },
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
    { id: "scaffold", label: "Scaffolding project structure", skillId: "run_shell" },
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
  template: {
    files: {
      "src/": "",
      "src/agent.ts": "",
      "src/tools/": "",
      "src/server.ts": "",
      "package.json": JSON.stringify({
        name: "{{name}}",
        version: "1.0.0",
        type: "module",
        scripts: {
          start: "bun src/server.ts",
          dev: "bun --watch src/server.ts",
          agent: "bun src/agent.ts",
        },
        dependencies: {
          "@anthropic-ai/sdk": "^0.39.0",
          fastify: "^5.0.0",
        },
        devDependencies: {
          "@types/bun": "latest",
          typescript: "^5.0.0",
        },
      }, null, 2),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          esModuleInterop: true,
          types: ["bun-types"],
        },
        include: ["src/**/*.ts"],
      }, null, 2),
    },
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
    { id: "scaffold", label: "Scaffolding project structure", skillId: "run_shell" },
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
  template: {
    files: {
      "src/": "",
      "src/server.ts": "",
      "src/routes/": "",
      "src/middleware/": "",
      "src/db/": "",
      "src/db/schema.ts": "",
      "package.json": JSON.stringify({
        name: "{{name}}",
        version: "1.0.0",
        type: "module",
        scripts: {
          start: "bun src/server.ts",
          dev: "bun --watch src/server.ts",
          "db:migrate": "bun src/db/migrate.ts",
        },
        dependencies: {
          fastify: "^5.0.0",
          "@fastify/cors": "^10.0.0",
        },
        devDependencies: {
          "@types/bun": "latest",
          typescript: "^5.0.0",
        },
      }, null, 2),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          esModuleInterop: true,
          types: ["bun-types"],
        },
        include: ["src/**/*.ts"],
      }, null, 2),
    },
  },
};

// ── Pipeline Registry ───────────────────────────────────────────

export const PIPELINES = new Map<string, Pipeline>([
  ["app", appPipeline],
  ["website", websitePipeline],
  ["mcp-server", mcpServerPipeline],
  ["agent", agentPipeline],
  ["api", apiPipeline],
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

export type { Pipeline, PipelineStep, QualityGate, PipelineTemplate };
