<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun_v1-f472b6?logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/protocol-MCP_(Anthropic)-6366f1" alt="MCP" />
  <img src="https://img.shields.io/badge/protocol-A2A_(Google)-10b981" alt="A2A" />
  <img src="https://img.shields.io/badge/protocol-ACP_(Zed)-ef4444" alt="ACP" />
  <img src="https://img.shields.io/badge/agents-8_workers-f59e0b" alt="Agents" />
  <img src="https://img.shields.io/badge/MCP_tools-27-8b5cf6" alt="Tools" />
  <img src="https://img.shields.io/github/license/xrey167/a2a-mcp-server" alt="License" />
</p>

# A2A-MCP Server

**A multi-protocol AI agent orchestrator** that bridges Google's Agent-to-Agent (A2A) protocol, Anthropic's Model Context Protocol (MCP), and IBM's Agent Communication Protocol (ACP) into a single, production-ready runtime.

Built with **Bun** and **TypeScript**, it spawns 8 specialized worker agents, provides 27 MCP tools, supports DAG-based workflows, multi-agent collaboration strategies, federated peer discovery, enterprise RBAC, RTK-style token savings, and a full project generation factory with quality gates.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Quick Start](#quick-start)
- [CLI Commands](#cli-commands)
- [Worker Agents](#worker-agents)
- [MCP Tools](#mcp-tools)
- [MCP Resources](#mcp-resources)
- [MCP Prompts](#mcp-prompts)
- [A2A HTTP Endpoints](#a2a-http-endpoints)
- [ACP Integration (Zed IDE)](#acp-integration-zed-ide)
- [Skills System](#skills-system)
- [Workflow Engine](#workflow-engine)
- [Multi-Agent Collaboration](#multi-agent-collaboration)
- [Project Factory & Pipelines](#project-factory--pipelines)
- [Memory & Knowledge](#memory--knowledge)
- [Search](#search)
- [Sandbox Execution](#sandbox-execution)
- [Federation](#federation)
- [Output Filtering & Token Savings](#output-filtering--token-savings)
- [Security](#security)
- [Plugin System](#plugin-system)
- [Persona System](#persona-system)
- [MCP Registry & IDE Discovery](#mcp-registry--ide-discovery)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [Development](#development)
- [License](#license)

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│                     Orchestrator (v3.0.0)                   │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌─────────────┐  │
│  │ MCP     │  │ A2A     │  │ ACP      │  │ Dashboard   │  │
│  │ stdio   │  │ HTTP    │  │ stdin/   │  │ HTML UI     │  │
│  │ Server  │  │ Fastify │  │ stdout   │  │ /dashboard  │  │
│  └────┬────┘  └────┬────┘  └────┬─────┘  └─────────────┘  │
│       │            │            │                           │
│  ┌────┴────────────┴────────────┴─────────────────────┐    │
│  │            Skill Router & Dispatcher               │    │
│  │  (auto-route via LLM / direct URL / skill ID)      │    │
│  └────────────────────┬───────────────────────────────┘    │
│                       │                                     │
│  ┌────────────────────┴───────────────────────────────┐    │
│  │  Circuit Breaker │ Metrics │ Tracing │ Skill Cache │    │
│  │  RBAC │ Audit │ License Gate │ Prompt Sanitizer    │    │
│  └────────────────────┬───────────────────────────────┘    │
│                       │                                     │
│  ┌────────────────────┴───────────────────────────────┐    │
│  │                  Worker Fleet                       │    │
│  │  shell:8081  web:8082  ai:8083  code:8084          │    │
│  │  knowledge:8085  design:8086  factory:8087         │    │
│  │  data:8088  [user-workers:8090+]                   │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Event Bus │ Workflow Engine │ Federation │ Memory   │  │
│  │  Agent Collaboration │ Capability Negotiation       │  │
│  │  Webhooks │ Workspaces │ Sandbox │ Plugins          │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- `ANTHROPIC_API_KEY` environment variable (required for AI skills)
- `GOOGLE_API_KEY` environment variable (optional, for design worker)

### Installation

```bash
git clone https://github.com/xrey167/a2a-mcp-server.git
cd a2a-mcp-server
bun install
```

### Initialize Configuration

```bash
# Full profile — all 8 workers
bun run init

# Lite profile — shell + web + ai workers only
bun run init -- --lite

# Data profile — shell + web + ai + data workers
bun run init -- --data
```

This creates `~/.a2a-mcp/config.json` with sensible defaults.

### Start the Server

```bash
# Start orchestrator + all workers
bun run start

# Development mode with hot-reload
bun run dev

# Start as ACP server (for Zed IDE)
bun run start:acp
```

The server exposes three interfaces simultaneously:

| Protocol | Transport | Default Port |
|----------|-----------|-------------|
| MCP | stdio | — |
| A2A | HTTP (Fastify) | 8080 |
| ACP | stdin/stdout (NDJSON) | — |

---

## CLI Commands

The CLI is available as `a2a-mcp-server` (or `bun src/cli.ts`):

| Command | Description |
|---------|-------------|
| `init [--lite\|--data\|--full]` | Create config file with the selected worker profile |
| `config` | Print the resolved configuration |
| `workers` | List discovered worker agents and their skills |
| `create-worker <name>` | Scaffold a new user-space worker under `~/.a2a-mcp/workers/` |
| `search <query>` | Search the community worker registry |
| `install <name>` | Install a worker from the community registry |
| `registry` | List all entries in the community worker registry |
| `help` | Show help text |

---

## Worker Agents

Each worker is a standalone Fastify microservice spawned as a subprocess. Workers register their `AgentCard` at `/.well-known/agent.json` and expose skills via A2A-compatible HTTP endpoints.

| Worker | Port | Skills | Description |
|--------|------|--------|-------------|
| **shell** | 8081 | `run_shell`, `read_file`, `write_file`, `remember`, `recall` | File system operations and shell command execution |
| **web** | 8082 | `fetch_url`, `call_api`, `remember`, `recall` | HTTP requests with token-bucket rate limiting and 10 MB body limit |
| **ai** | 8083 | `ask_claude`, `search_files`, `query_sqlite`, `remember`, `recall` | Claude API calls (with CLI fallback), file glob search, read-only SQLite queries |
| **code** | 8084 | `codex_exec`, `codex_review`, `remember`, `recall` | Code execution and review with path traversal protection |
| **knowledge** | 8085 | `create_note`, `read_note`, `update_note`, `search_notes`, `list_notes`, `summarize_notes`, `remember`, `recall` | Obsidian vault CRUD with FTS5 full-text search index |
| **design** | 8086 | `enhance_ui_prompt`, `suggest_screens`, `design_critique`, `remember`, `recall` | UI/UX design assistance powered by Google Gemini 2.0 Flash |
| **factory** | 8087 | `normalize_intent`, `create_project`, `quality_gate`, `list_pipelines`, `list_templates`, `remember`, `recall` | Full project generation with 6 pipelines and "Ralph Mode" quality gate |
| **data** | 8088 | `parse_csv`, `parse_json`, `transform_data`, `analyze_data`, `pivot_table`, `remember`, `recall` | CSV/JSON parsing, 12 transform operations, statistical analysis, pivot tables |

### Worker Profiles

| Profile | Workers | Use Case |
|---------|---------|----------|
| `full` | All 8 workers | Full capability |
| `lite` | shell, web, ai | Lightweight setup for simple tasks |
| `data` | shell, web, ai, data | Data analysis focused |

### User-Space Workers

Create custom workers at `~/.a2a-mcp/workers/<name>/`:

```bash
a2a-mcp-server create-worker my-custom-worker
```

This scaffolds a complete Fastify worker with AgentCard, health check, and A2A task endpoint. User workers are auto-discovered and assigned ports starting at 8090.

### Community Worker Registry

8 built-in registry entries: `github-agent`, `slack-agent`, `postgres-agent`, `redis-agent`, `docker-agent`, `s3-agent`, `playwright-agent`, `email-agent`.

```bash
a2a-mcp-server search github    # Search by name, description, or tags
a2a-mcp-server install github-agent
```

---

## MCP Tools

The orchestrator exposes 27 tools via the MCP stdio interface. These are the tools available to any MCP client (Claude Desktop, Cursor, Windsurf, etc.):

### Core Delegation

| Tool | Description |
|------|-------------|
| `delegate` | Route a task to the best worker via auto-routing, direct URL, or skill ID |
| `list_agents` | List all worker agents, external agents, and their skills |

### Shell

| Tool | Description |
|------|-------------|
| `run_shell_stream` | Execute a shell command with real-time stdout/stderr streamed as MCP progress notifications |

### Workflow & Composition

| Tool | Description |
|------|-------------|
| `workflow_execute` | Execute a multi-step DAG workflow with parallel execution, template refs `{{stepId.result}}`, retry/skip error handling, and conditional execution |
| `compose_pipeline` | Create a reusable skill pipeline with `pipe()` syntax — each step's output feeds the next |
| `execute_pipeline` | Execute a composed pipeline by ID |
| `design_workflow` | Full design pipeline: suggest screens, create project, generate each screen (async, returns taskId) |
| `factory_workflow` | Full project generation pipeline: normalize, scaffold, codegen, quality gate (async, returns taskId) |

### Collaboration

| Tool | Description |
|------|-------------|
| `collaborate` | Multi-agent collaboration: `fan_out`, `consensus`, `debate`, `map_reduce` strategies |

### Sandbox

| Tool | Description |
|------|-------------|
| `sandbox_execute` | Execute TypeScript in an isolated Bun subprocess with access to all skills via `skill(id, args)` |

### Event System

| Tool | Description |
|------|-------------|
| `event_publish` | Publish an event to the topic-based event bus |
| `event_subscribe` | Subscribe to events matching a topic pattern (supports `*` and `#` wildcards) |
| `event_replay` | Replay events from history matching a topic pattern |

### Webhooks

| Tool | Description |
|------|-------------|
| `register_webhook` | Register an inbound webhook with HMAC-SHA256 authentication |
| `list_webhooks` | List all registered webhooks and their endpoints |

### Observability

| Tool | Description |
|------|-------------|
| `get_metrics` | Skill execution metrics: call counts, latencies (p50/p95/p99), error rates |
| `list_traces` | List recent distributed traces across agent calls |
| `get_trace` | Get waterfall visualization of a trace — full call chain with timing |
| `cache_stats` | Skill cache statistics: hit rate, entries, size, top cached skills |
| `cache_invalidate` | Invalidate cached skill results (by skill ID or all) |
| `negotiate_capability` | Find the best agent for a skill based on version, features, health, and load |
| `token_savings` | RTK-style output filtering statistics: total tokens saved, savings rate, top skills |
| `read_raw_output` | Read raw unfiltered output from tee files (before token-saving filters) |

### Administration

| Tool | Description |
|------|-------------|
| `workspace_manage` | Manage team workspaces: create, list, add/remove members, update settings |
| `audit_query` | Query the audit log by actor, skill, workspace, time range, and success/failure |
| `audit_stats` | Audit statistics: total calls, success rate, top skills, top actors |
| `license_info` | Show current license tier (free/pro/enterprise) and skill tier requirements |

---

## MCP Resources

14 resources exposed via the MCP `resources/list` handler:

| URI | Description |
|-----|-------------|
| `a2a://context` | Current project context (summary, goals, stack, notes) |
| `a2a://health` | Health status of all worker agents |
| `a2a://tasks` | List of all active and recent tasks |
| `a2a://metrics` | Skill execution metrics: call counts, latencies, error rates |
| `a2a://circuit-breakers` | Circuit breaker states for all workers |
| `a2a://webhooks` | Registered webhook endpoints |
| `a2a://event-bus` | Event bus stats, subscriptions, and dead letters |
| `a2a://traces` | Recent distributed traces across agent calls |
| `a2a://cache` | Skill result cache statistics |
| `a2a://capabilities` | Agent capability registry and negotiation stats |
| `a2a://pipelines` | Registered skill composition pipelines |
| `a2a://audit` | Recent audit log entries (enterprise) |
| `a2a://license` | Current license tier and skill gates |
| `a2a://workspaces` | Team workspaces and members |

---

## MCP Prompts

### Personas

7 agent-specific personas loaded from `src/personas/`:

| Persona | Description |
|---------|-------------|
| `orchestrator` | System prompt for the main orchestrator agent |
| `shell-agent` | System prompt for the shell worker |
| `web-agent` | System prompt for the web worker |
| `ai-agent` | System prompt for the AI worker |
| `code-agent` | System prompt for the code worker |
| `knowledge-agent` | System prompt for the knowledge worker |
| `factory-agent` | System prompt for the factory worker |

Each persona is a Markdown file with YAML frontmatter specifying model and temperature. Personas support hot-reload via filesystem watch.

### Task Delegation Prompt

| Prompt | Description |
|--------|-------------|
| `delegate-task` | Structured prompt template for task delegation with goal, context, and constraints |

---

## A2A HTTP Endpoints

The Fastify HTTP server (default port 8080) exposes:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/` | A2A JSON-RPC 2.0 entry point — methods: `tasks/send`, `tasks/get`, `tasks/cancel` |
| `GET` | `/.well-known/agent.json` | A2A Agent Card (agent identity, skills, capabilities) |
| `GET` | `/healthz` | Health check (returns `{ ok: true }`) |
| `GET` | `/readyz` | Readiness probe (all workers healthy) |
| `GET` | `/livez` | Liveness probe |
| `GET` | `/dashboard` | Interactive HTML dashboard with real-time metrics |
| `GET` | `/metrics` | Prometheus-style metrics JSON |
| `POST` | `/webhook/:id` | Inbound webhook receiver with HMAC-SHA256 verification |
| `GET` | `/sse/:taskId` | Server-Sent Events stream for task progress |

### A2A Authentication

Set `A2A_API_KEY` environment variable to protect all HTTP endpoints. Requests must include:

```
Authorization: Bearer <your-api-key>
```

---

## ACP Integration (Zed IDE)

The ACP server (`src/acp-server.ts`) implements IBM's Agent Communication Protocol v0.11.0 for integration with Zed IDE:

- **Transport**: NDJSON JSON-RPC 2.0 over stdin/stdout
- **Methods**: `initialize`, `initialized`, `agent/execute`, `agent/cancel`, `$/cancelRequest`
- **Streaming**: Token-level streaming via `textChunk` notifications
- **Start**: `bun run start:acp`

All orchestrator skills are automatically exposed as ACP-compatible tools.

---

## Skills System

Skills are the atomic units of capability. The orchestrator routes tasks to skills via three strategies:

1. **Direct URL**: `delegate({ url: "http://localhost:8081/..." })`
2. **Skill ID**: `delegate({ skillId: "run_shell" })`
3. **Auto-route**: `delegate({ task: "read the config file" })` — the orchestrator uses Claude to determine the best skill

### Built-in Skills (9 base skills)

| Skill ID | Description | Validation |
|----------|-------------|------------|
| `run_shell` | Execute shell commands | `command: string`, optional `timeout`, `cwd` |
| `read_file` | Read file contents | `path: string` with sanitization |
| `write_file` | Write file contents | `path: string`, `content: string` with sanitization |
| `fetch_url` | Fetch a URL | `url: string` with SSRF protection |
| `call_api` | HTTP API call | `url`, `method`, `headers`, `body` |
| `ask_claude` | Query Claude | `prompt: string`, optional `persona`, `model`, `system` |
| `search_files` | Glob file search | `pattern: string`, optional `cwd` |
| `query_sqlite` | SQLite query | `db: string`, `sql: string` (SELECT only) |
| `call_a2a_agent` | Call external A2A agent | `agentUrl: string`, `message: string` |

### Skill Routing Flow

```
Task arrives → License gate check → RBAC permission check → Audit log
  → Circuit breaker check → Cache lookup → Skill dispatch
  → Metrics recording → Tracing span → Response
```

### Skill Caching

Content-addressable LRU cache with SHA-256 keys. Configuration:

- Default TTL: 5 minutes (per-skill TTL overrides supported)
- Max entries: 500
- Max size: 50 MB
- Automatic eviction on size/count limits

### Skill Composition

Declarative skill chaining with `pipe()` syntax:

```json
{
  "tool": "compose_skills",
  "args": {
    "pipeline": [
      { "skillId": "read_file", "args": { "path": "data.csv" } },
      { "skillId": "ask_claude", "template": "Summarize this data: {{input}}" },
      { "skillId": "write_file", "args": { "path": "summary.md" }, "template": "{{input}}" }
    ],
    "onError": "abort"
  }
}
```

Supports `when` conditions for conditional execution and `onError` modes: `abort`, `skip`, `fallback`.

---

## Workflow Engine

DAG-based workflow execution with:

- **Template resolution**: `{{context.key}}` syntax with security-aware sanitization (shell escaping for shell skills, XML wrapping for LLM prompts)
- **Substitution limit**: 50 KB per resolved template
- **Cycle detection**: DFS-based topological sorting
- **Parallel execution**: Up to 5 concurrent steps (configurable)
- **Conditional execution**: `when` field with template evaluation
- **Retry**: Exponential backoff with configurable max retries
- **Error modes**: `abort`, `skip`, `fallback`

```json
{
  "tool": "run_workflow",
  "args": {
    "steps": [
      { "id": "fetch", "skillId": "fetch_url", "args": { "url": "https://api.example.com/data" } },
      { "id": "analyze", "skillId": "ask_claude", "dependsOn": ["fetch"],
        "args": { "prompt": "Analyze: {{context.fetch}}" } },
      { "id": "save", "skillId": "write_file", "dependsOn": ["analyze"],
        "args": { "path": "report.md", "content": "{{context.analyze}}" } }
    ]
  }
}
```

---

## Multi-Agent Collaboration

4 collaboration strategies via the `collaborate` tool:

| Strategy | Description |
|----------|-------------|
| `fan_out` | Send task to multiple agents in parallel, collect all results |
| `consensus` | Send to multiple agents, use an AI judge to score responses (1–10), select highest |
| `debate` | Multi-round debate between agents with configurable round count |
| `map_reduce` | Split input, distribute to agents, aggregate results via AI reducer |

```json
{
  "tool": "collaborate",
  "args": {
    "strategy": "consensus",
    "task": "Design a REST API for a todo app",
    "agents": ["http://localhost:8083", "http://localhost:8084"],
    "options": { "rounds": 3 }
  }
}
```

---

## Project Factory & Pipelines

The factory worker (port 8087) provides end-to-end project generation from a natural language idea through 5 phases:

1. **Template Matching** — Select the best pipeline for the idea
2. **Intent Normalization** — Expand vague idea into a detailed JSON spec via Claude
3. **Scaffold** — Generate project structure from file-based templates with `{{var}}` substitution
4. **Code Generation** — Generate implementation files via Claude
5. **Quality Gate ("Ralph Mode")** — Multi-dimensional quality review with iterative fix cycles

### Available Pipelines

| Pipeline | Stack | Quality Dimensions |
|----------|-------|--------------------|
| `app` | Expo, React Native, TypeScript | code_quality, type_safety, ux_completeness, error_handling, accessibility |
| `website` | Next.js, React, Tailwind CSS | code_quality, responsive_design, seo, accessibility, performance |
| `mcp-server` | MCP SDK, Bun, TypeScript | code_quality, type_safety, error_handling, mcp_compliance, security |
| `agent` | Claude API, Fastify, TypeScript | code_quality, type_safety, tool_design, error_handling, security |
| `api` | Fastify, SQLite, TypeScript | code_quality, type_safety, api_design, error_handling, security |
| `cli` | Bun, Zod, TypeScript | code_quality, type_safety, cli_ux, error_handling, documentation |

### Template Variants

Each pipeline supports domain-specific variants (e.g., `saas-starter`, `e-commerce`, `social-app`) stored at `src/templates/variants/<pipelineId>/<variantId>/TEMPLATE.md`. Variants provide pre-configured features, prompt enhancement rules, and quality checklists.

### Quality Gate

The quality gate ("Ralph Mode") scores generated code across multiple dimensions (0–100). The pipeline iterates up to `maxIterations` times (default: 3) until the average score exceeds the `passThreshold` (default: 85–90).

---

## Memory & Knowledge

### Dual-Write Memory

Every `remember` call writes to both:

1. **SQLite FTS5** (`~/.a2a-memory.db`) — Full-text search with BM25 ranking
2. **Obsidian Vault** (`~/obsidian-vault/a2a-memory/`) — Markdown files for human-readable access

`recall` retrieves by exact key match. `search_memory` uses FTS5 full-text search.

### Knowledge Worker

The knowledge worker (port 8085) provides full CRUD on an Obsidian vault with an FTS5 search index:

- `create_note` / `read_note` / `update_note` — File-based CRUD
- `search_notes` — Full-text search across all notes
- `list_notes` — Directory listing
- `summarize_notes` — AI-powered summarization via Claude

---

## Search

3-layer FTS5 search with progressive fallback:

1. **Porter stemming** — Standard FTS5 full-text search
2. **Trigram substring** — Character n-gram matching for partial matches
3. **Levenshtein fuzzy** — Edit-distance correction for typos

The sandbox store (`~/.a2a-sandbox.db`) provides the same 3-layer search for sandbox variables, with automatic vocabulary extraction and content chunking.

---

## Sandbox Execution

The `sandbox_execute` tool runs TypeScript code in an isolated Bun subprocess with:

- **Environment filtering**: 30+ dangerous env vars blocked (NODE_OPTIONS, LD_PRELOAD, all credential vars), 5 regex patterns for secret detection
- **IPC**: JSON lines over subprocess stdin/stdout
- **Timeout**: Configurable (default from `A2A_SANDBOX_TIMEOUT`)
- **`--smol` flag**: Reduced memory footprint

### Prelude Helpers

Code running in the sandbox has access to these built-in functions:

| Helper | Description |
|--------|-------------|
| `skill(id, args)` | Call any orchestrator skill from within the sandbox |
| `search(varName, query)` | Full-text search across sandbox variables |
| `adapters()` | List available data adapters |
| `describe(skillId)` | Get a skill's description and schema |
| `batch(items, fn, { concurrency })` | Parallel batch processing with concurrency control |
| `pick(arr, ...keys)` | Project specific keys from an array of objects |
| `sum(arr, key)` | Sum a numeric field across an array |
| `count(arr, key)` | Count occurrences by field value |
| `first(arr)` / `last(arr)` | Get first or last element |
| `table(arr)` | Format array as a readable table string |

---

## Federation

Federated peer discovery for multi-server deployments:

```json
{
  "tool": "manage_federation",
  "args": {
    "action": "add",
    "peerUrl": "https://other-server.example.com"
  }
}
```

Features:

- Auto-discovery via `/.well-known/agent.json`
- Periodic health checks (default: 30 seconds)
- Automatic skill aggregation from peers
- Stale peer removal on consecutive health check failures

---

## Output Filtering & Token Savings

RTK-style output filtering reduces token usage by intelligently filtering and truncating tool outputs before they reach the LLM context window.

**Modules:**

| Module | Description |
|--------|-------------|
| `src/output-filter.ts` | RTK-style output filtering — strips noise, truncates large payloads, preserves essential content |
| `src/token-tracker.ts` | Tracks token savings statistics per skill and globally |
| `src/tee.ts` | Records raw unfiltered outputs to tee files for debugging and audit |
| `src/truncate.ts` | Smart truncation for large responses with configurable limits |
| `src/env-filter.ts` | Filters dangerous environment variables from sandbox and shell contexts |

**MCP tools:**
- `token_savings` — View savings statistics (total saved, rate, top skills by savings)
- `read_raw_output` — Read raw pre-filter output from tee files

---

## Security

### Prompt Injection Protection

Comprehensive 6-pattern detection:

- Instruction override attempts ("ignore previous instructions")
- Role manipulation ("you are now")
- Context stuffing detection (>10 KB user input, >50 KB template content)
- Special character sequences and encoding tricks
- Delimiter injection attempts
- XML-wrapped user input isolation

### Path Sanitization

All file operations use `sanitizePath()`:

- Character whitelist: `[a-zA-Z0-9_.\/~-]`
- Traversal rejection: `..` sequences blocked
- Base directory containment check
- LLM-generated paths reject absolute paths

### Template Variable Sanitization

`sanitizeVar()` strips:

- All ASCII control characters and null bytes
- String delimiters and template characters (`` ` `` `$` `\` `"` `'`)
- Path separators (`/`) and double-dot sequences
- Shell metacharacters (`; & | < > ( ) { } [ ] ! # * ?`)

### SSRF Protection

- URL validation on all outbound requests
- Redirect rejection
- Worker URL allowlist validation

### RBAC & Authentication

Three roles: `admin`, `operator`, `viewer`. API keys are SHA-256 hashed and stored with `a2a_k_` prefix. Workspace-scoped access control.

### License Gating (Open Core)

Three tiers: `free`, `pro`, `enterprise`. Each skill is tagged with a minimum tier. License loaded from file (`~/.a2a-mcp/license.key`) or environment variable (`A2A_LICENSE_KEY`, base64-encoded).

### Audit Logging

Immutable SQLite audit trail (`~/.a2a-mcp/audit.db`) with:

- ISO-8601 timestamps
- Actor identification
- Action and resource tracking
- Indexed queries by actor, action, and time range
- 90-day automatic retention cleanup

### Circuit Breaker

Per-worker circuit breakers with three states:

| State | Behavior |
|-------|----------|
| `CLOSED` | Normal operation, counting failures |
| `OPEN` | All calls rejected immediately (after 5 failures) |
| `HALF_OPEN` | Single test call allowed (after 30s cooldown) |

Configuration: `failureThreshold: 5`, `cooldownMs: 30s`, `callTimeoutMs: 30s`, `successThreshold: 2` (to re-close).

---

## Plugin System

Two plugin sources with hot-reload:

### TypeScript Plugins

Place plugins at `src/plugins/<name>/index.ts` exporting a `skills: Skill[]` array. The orchestrator auto-discovers and registers them.

### Declarative Vault Plugins

Place plugin definitions at `<vault>/_plugins/<name>/plugin.md` with YAML frontmatter defining skill name, description, and prompt template. These become `ask_claude`-backed skills with `{{input}}` template substitution and automatic prompt sanitization.

Both plugin directories are watched for changes and hot-reloaded.

---

## Persona System

Personas are Markdown files at `src/personas/<name>.md` with YAML frontmatter:

```markdown
---
model: claude-sonnet-4-6
temperature: 0.7
---

You are a senior software architect...
```

Personas are used by the `ask_claude` skill and MCP prompts. They support hot-reload via filesystem watch. Path traversal protection is enforced.

---

## MCP Registry & IDE Discovery

The MCP registry scans multiple IDE configurations to discover available MCP servers:

| IDE | Config Path |
|-----|-------------|
| Claude Desktop | `~/.config/claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Codex | `~/.codex/mcp.json` |

Features:

- Lazy-connect: MCP servers are only connected on first use
- Manifest caching: 24-hour TTL to avoid repeated discovery
- Automatic tool registration: discovered MCP tools become available as orchestrator skills
- `list_mcp_servers` and `call_mcp_tool` MCP tools for runtime access

---

## Configuration

Configuration file at `~/.a2a-mcp/config.json`:

```json
{
  "port": 8080,
  "logLevel": "info",
  "workerProfile": "full",
  "workers": {
    "shell": { "port": 8081 },
    "web": { "port": 8082 },
    "ai": { "port": 8083 },
    "code": { "port": 8084 },
    "knowledge": { "port": 8085 },
    "design": { "port": 8086 },
    "factory": { "port": 8087 },
    "data": { "port": 8088 }
  },
  "memory": {
    "vaultPath": "~/Documents/Obsidian/a2a-knowledge"
  },
  "federation": {
    "peers": [],
    "healthCheckIntervalMs": 30000
  }
}
```

All config values can be overridden via environment variables (see below).

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (required for AI skills) | — |
| `GOOGLE_API_KEY` | Google API key (for design worker, Gemini) | — |
| `A2A_PORT` | HTTP server port | `8080` |
| `A2A_API_KEY` | API key for HTTP endpoint authentication | — |
| `A2A_LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error` | `info` |
| `A2A_SANDBOX_TIMEOUT` | Sandbox execution timeout (ms) | `30000` |
| `A2A_LICENSE_KEY` | Base64-encoded license key | — |
| `A2A_WORKER_PROFILE` | Worker profile: `full`, `lite`, `data` | `full` |
| `OBSIDIAN_VAULT` | Path to Obsidian vault for knowledge worker | `~/Documents/Obsidian/a2a-knowledge` |

---

## Deployment

### Docker

```bash
docker build -t a2a-mcp-server .
docker run -p 8080:8080 \
  -e ANTHROPIC_API_KEY=your-key \
  -v a2a-data:/data \
  a2a-mcp-server
```

### Docker Compose

```bash
docker compose up -d
```

The `docker-compose.yml` mounts a persistent volume for SQLite databases and config.

### Fly.io

```bash
fly launch --copy-config
fly secrets set A2A_API_KEY=your-secret ANTHROPIC_API_KEY=your-key
fly deploy
```

Configuration: IAD region, force HTTPS, auto-stop/start machines, min 1 running, shared-cpu-1x with 512 MB.

### Railway

```bash
railway up
```

Uses Dockerfile build, `/healthz` health check, ON_FAILURE restart with 3 retries.

### Health Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /healthz` | Basic liveness — `{ ok: true }` |
| `GET /readyz` | Readiness — all workers responding |
| `GET /livez` | Liveness — server process running |

---

## Development

```bash
# Install dependencies
bun install

# Run in development mode (hot-reload)
bun run dev

# Type check
bun build src/server.ts --target=bun --outdir=dist

# Run tests
bun test
```

### CI/CD

GitHub Actions workflow (`.github/workflows/ci.yml`) runs on push/PR to `main`:

1. Checkout
2. Setup Bun (latest)
3. Install dependencies (frozen lockfile)
4. Type check via `bun build`
5. Run tests via `bun test`

---

## License

MIT
