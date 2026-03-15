<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun_v1-f472b6?logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/protocol-MCP_(Anthropic)-6366f1" alt="MCP" />
  <img src="https://img.shields.io/badge/protocol-A2A_(Google)-10b981" alt="A2A" />
  <img src="https://img.shields.io/badge/protocol-ACP_(Zed)-ef4444" alt="ACP" />
  <img src="https://img.shields.io/badge/agents-15_workers-f59e0b" alt="Agents" />
  <img src="https://img.shields.io/badge/MCP_tools-120-8b5cf6" alt="Tools" />
  <img src="https://github.com/xrey167/a2a-mcp-server/actions/workflows/ci.yml/badge.svg" alt="CI" />
  <img src="https://img.shields.io/github/license/xrey167/a2a-mcp-server" alt="License" />
</p>

# A2A-MCP Server

A multi-protocol automation runtime that connects **Claude Code**, **Zed IDE**, and any A2A-compatible agent to a fleet of 15 specialized worker agents. Built on **Bun** and **TypeScript** with no build step required.

It speaks three protocols simultaneously:

- **MCP** (stdio) — Claude Code and any MCP-compatible client
- **A2A** (HTTP, port 8080) — Google's Agent-to-Agent protocol for agent federation
- **ACP** (stdin/stdout) — Zed IDE integration

> **Agency Product Mode:** The server ships with packaged agency workflows, ERP connectors, and RBAC/audit trails targeting recurring client-delivery operations at EUR 1.5k–3k/month. See [Agency Product Mode](#agency-product-mode).

---

## Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [CLI Commands](#cli-commands)
- [Worker Agents](#worker-agents)
- [MCP Tools](#mcp-tools)
- [MCP Resources](#mcp-resources)
- [MCP Prompts](#mcp-prompts)
- [A2A HTTP Endpoints](#a2a-http-endpoints)
- [Workflow Engine](#workflow-engine)
- [Multi-Agent Collaboration](#multi-agent-collaboration)
- [Skill Pipelines (Composer)](#skill-pipelines-composer)
- [Project Factory](#project-factory)
- [Sandbox Execution](#sandbox-execution)
- [Memory & Knowledge](#memory--knowledge)
- [Event Bus](#event-bus)
- [Distributed Tracing](#distributed-tracing)
- [Skill Cache](#skill-cache)
- [Capability Negotiation](#capability-negotiation)
- [Webhooks](#webhooks)
- [Output Filtering & Token Savings](#output-filtering--token-savings)
- [Federation](#federation)
- [Security & RBAC](#security--rbac)
- [Audit Logging](#audit-logging)
- [Skill Tiers & Licensing](#skill-tiers--licensing)
- [Persona System](#persona-system)
- [Plugin System](#plugin-system)
- [ACP Integration (Zed IDE)](#acp-integration-zed-ide)
- [Agency Product Mode](#agency-product-mode)
- [ERP Expansion APIs](#erp-expansion-apis)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [Development](#development)
- [License](#license)

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                      Orchestrator v3.0.0                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ MCP      │  │ A2A HTTP │  │ ACP      │  │ Dashboard     │  │
│  │ stdio    │  │ :8080    │  │ stdin/   │  │ /dashboard    │  │
│  │ Server   │  │ Fastify  │  │ stdout   │  │ HTML UI       │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────────────┘  │
│       └─────────────┴─────────────┘                            │
│                           │                                     │
│  ┌────────────────────────┴──────────────────────────────────┐ │
│  │              Skill Router & Dispatcher                    │ │
│  │   1. agentUrl provided → direct (circuit-broken)         │ │
│  │   2. skillId provided  → skill map lookup                │ │
│  │   3. neither           → ask_claude picks {url, skillId} │ │
│  └────────────────────────┬──────────────────────────────────┘ │
│                           │                                     │
│  ┌────────────────────────┴──────────────────────────────────┐ │
│  │  Circuit Breaker │ Metrics │ Tracing │ Skill Cache        │ │
│  │  RBAC │ Audit │ License Gate │ Prompt Sanitizer           │ │
│  └────────────────────────┬──────────────────────────────────┘ │
│                           │                                     │
│  ┌────────────────────────┴──────────────────────────────────┐ │
│  │                     Worker Fleet                          │ │
│  │  shell:8081   web:8082    ai:8083    code:8084            │ │
│  │  knowledge:8085  design:8086  factory:8087                │ │
│  │  data:8088   news:8089   market:8090  signal:8091         │ │
│  │  monitor:8092  infra:8093  climate:8094                   │ │
│  └───────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

**Single entry point:** `src/server.ts` is simultaneously the MCP server and A2A orchestrator. On startup it:

1. Reads `~/.a2a-mcp/config.json` (profile, enabled workers, remote workers)
2. Spawns enabled local worker processes via `Bun.spawn`
3. Discovers each worker's agent card via `GET /.well-known/agent.json` (exponential-backoff, 5 attempts)
4. Builds a `skillId → workerURL` routing map
5. Begins health polling every 30 s

**stdout is reserved for MCP JSON-RPC.** All workers write diagnostics to stderr only.

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- `ANTHROPIC_API_KEY` (for `ask_claude` and LLM routing)
- Optional: `GOOGLE_API_KEY` (design worker), `NASA_FIRMS_KEY` (climate worker)

### Install & register

```bash
git clone https://github.com/xrey167/a2a-mcp-server
cd a2a-mcp-server
bun install

# Initialize config (choose a profile)
bun src/cli.ts init          # full  — all 15 workers
bun src/cli.ts init --lite   # lite  — shell + web + ai
bun src/cli.ts init --data   # data  — lite + data
bun src/cli.ts init --osint  # osint — lite + 6 OSINT workers

# Register with Claude Code (user scope)
claude mcp add --scope user a2a-mcp-bridge -- bun $(pwd)/src/server.ts
claude mcp list   # verify
```

### Start

```bash
bun src/server.ts              # orchestrator + all enabled workers
bun src/workers/shell.ts       # single worker in isolation
```

### Test a tool without restarting Claude Code

```bash
env -u CLAUDECODE claude -p "Use the delegate tool to run echo hello" \
  --allowedTools "mcp__a2a-mcp-bridge__delegate"
```

---

## CLI Commands

```bash
bun src/cli.ts <command> [options]
```

| Command | Description |
|---|---|
| `init [--lite\|--data\|--osint\|--full]` | Create `~/.a2a-mcp/config.json` |
| `config` | Print current config |
| `workers` | List workers and their status |
| `auth-create-key` | Create an RBAC API key |
| `auth-list-keys` | List all key metadata |
| `auth-revoke-key --target <id>` | Revoke a key |
| `create-worker <name> [--port <n>]` | Scaffold a new worker file |
| `search <query>` | Search the worker registry |
| `install <worker-name>` | Install a registry worker |
| `registry` | List all available registry workers |
| `help` | Show help |

### Profiles

| Profile | Workers | Use case |
|---|---|---|
| `lite` | shell + web + ai | Fast, minimal footprint |
| `data` | lite + data | Data processing |
| `osint` | lite + news + market + signal + monitor + infra + climate | Intelligence gathering |
| `full` | All 15 workers | Maximum capability |

---

## Worker Agents

All workers are standalone Fastify HTTP servers implementing the A2A protocol. Each exports a `/.well-known/agent.json` agent card and a `/healthz` endpoint. All include `remember` / `recall` skills backed by SQLite + Obsidian dual-write.

| Worker | Port | Skills |
|---|---|---|
| **shell** | 8081 | `run_shell`, `read_file`, `write_file` + SSE streaming at `/stream` |
| **web** | 8082 | `fetch_url`, `call_api` |
| **ai** | 8083 | `ask_claude`, `search_files`, `query_sqlite` |
| **code** | 8084 | `codex_exec`, `codex_review` (via `codex` CLI subprocess) |
| **knowledge** | 8085 | `create_note`, `read_note`, `update_note`, `search_notes`, `list_notes` |
| **design** | 8086 | `enhance_ui_prompt`, `suggest_screens`, `design_critique` (Gemini-powered) |
| **factory** | 8087 | `normalize_intent`, `create_project`, `quality_gate`, `list_pipelines`, `list_templates` |
| **data** | 8088 | `parse_csv`, `parse_json`, `transform_data`, `analyze_data`, `pivot_table` |
| **news** | 8089 | `fetch_rss`, `aggregate_feeds`, `classify_news`, `cluster_news`, `detect_signals` |
| **market** | 8090 | `fetch_quote`, `price_history`, `technical_analysis`, `screen_market`, `detect_anomalies`, `correlation` |
| **signal** | 8091 | `aggregate_signals`, `classify_threat`, `detect_convergence`, `baseline_compare`, `instability_index` |
| **monitor** | 8092 | `track_conflicts`, `detect_surge`, `theater_posture`, `track_vessels`, `check_freshness`, `watchlist_check` |
| **infra** | 8093 | `cascade_analysis`, `supply_chain_map`, `chokepoint_assess`, `redundancy_score`, `dependency_graph` |
| **climate** | 8094 | `fetch_earthquakes`, `fetch_wildfires`, `fetch_natural_events`, `assess_exposure`, `climate_anomalies`, `event_correlate` |

### Adding a custom worker

```bash
bun src/cli.ts create-worker my-tool --port 8100
```

This scaffolds `src/workers/my-tool.ts`. Add it to `ALL_WORKERS` in `src/server.ts` and it will be spawned automatically.

---

## MCP Tools

120 tools registered on the MCP server, organized by category:

### Core delegation

| Tool | Description |
|---|---|
| `delegate` | Route a skill to the appropriate worker (sync) |
| `delegate_async` | Fire-and-forget delegation; returns a task ID |
| `list_agents` | List all discovered workers with health and skills |
| `register_agent` | Dynamically register a remote agent |
| `unregister_agent` | Remove a remote agent |

### Sandbox execution

| Tool | Description |
|---|---|
| `sandbox_execute` | Run TypeScript in an isolated Bun subprocess with access to all worker skills |
| `sandbox_vars` | List, read, or delete persisted sandbox variables |

### Memory

| Tool | Description |
|---|---|
| `remember` | Store a fact (SQLite + Obsidian dual-write) |
| `recall` | Retrieve facts by keyword |
| `memory_list` | List stored memories |
| `memory_cleanup` | Remove stale or duplicate memories |

### Workflows & pipelines

| Tool | Description |
|---|---|
| `workflow_execute` | Run a DAG-based multi-agent workflow |
| `factory_workflow` | Generate a complete project from a vague idea |
| `compose_pipeline` | Define a declarative skill pipeline |
| `execute_pipeline` | Run a previously composed pipeline |
| `list_pipelines` | List saved pipelines |

### Event bus

| Tool | Description |
|---|---|
| `event_publish` | Publish an event to a topic |
| `event_subscribe` | Subscribe to a topic pattern |
| `event_replay` | Replay event history from a timestamp |

### Multi-agent collaboration

| Tool | Description |
|---|---|
| `collaborate` | Run fan_out / consensus / debate / map_reduce across agents |

### Observability

| Tool | Description |
|---|---|
| `get_metrics` | Get skill execution metrics (call counts, p50/p95/p99 latencies, error rates) |
| `worker_health` | Get circuit-breaker state and health for all workers |
| `list_traces` | List distributed traces |
| `get_trace` | Get a trace with waterfall visualization |
| `search_traces` | Search traces by tag or span name |

### Skill cache

| Tool | Description |
|---|---|
| `cache_stats` | Cache hit/miss stats and memory usage |
| `cache_invalidate` | Invalidate cache entries by skill or pattern |
| `cache_configure` | Set per-skill TTL or global cache size |

### Capability negotiation

| Tool | Description |
|---|---|
| `negotiate_capability` | Find the best worker for a skill+version requirement |
| `list_capabilities` | List all registered capabilities with version and load info |
| `capability_stats` | Routing decisions and scoring breakdown |

### Auth & workspaces

| Tool | Description |
|---|---|
| `workspace_manage` | Create, update, list, and delete team workspaces |
| `license_info` | Show current license tier and enabled skills |

### Audit

| Tool | Description |
|---|---|
| `audit_query` | Query the immutable audit trail |
| `audit_stats` | Aggregated audit statistics |

### Webhooks

| Tool | Description |
|---|---|
| `webhook_register` | Register an external webhook endpoint |
| `webhook_list` | List registered webhooks |
| `webhook_delete` | Remove a webhook |

### Agency (product)

| Tool | Description |
|---|---|
| `agency_workflow_templates` | Retrieve ready-to-adapt workflow JSON |
| `agency_roi_snapshot` | KPI snapshot: runs, failure rate, time saved |

---

## MCP Resources

Resources expose live data as readable URIs:

| URI | Content |
|---|---|
| `a2a://agents` | All discovered worker agent cards |
| `a2a://metrics` | Execution metrics (JSON) |
| `a2a://traces` | Recent distributed traces |
| `a2a://cache` | Skill cache state |
| `a2a://capabilities` | Capability registry |
| `a2a://event-bus` | Event bus topics and subscriptions |
| `a2a://pipelines` | Saved skill pipelines |
| `a2a://workspaces` | Team workspaces |
| `a2a://audit` | Recent audit log entries |
| `a2a://license` | License tier and gated skills |
| `a2a://agency-workflows` | Packaged agency workflow templates |
| `a2a://agency-roi` | Agency ROI metrics |

---

## MCP Prompts

| Prompt | Description |
|---|---|
| `osint_brief` | Generate an OSINT intelligence brief |
| `osint_alert_scan` | Scan for threat alerts across OSINT workers |
| `osint_threat_assess` | Full threat assessment pipeline |

---

## A2A HTTP Endpoints

The orchestrator exposes a Fastify HTTP server on port 8080:

| Method | Path | Description |
|---|---|---|
| `POST` | `/` | A2A task dispatch (`tasks/send`) |
| `GET` | `/.well-known/agent.json` | Orchestrator agent card |
| `GET` | `/healthz` | Health check |
| `GET` | `/readyz` | Readiness check |
| `GET` | `/health` | Detailed health (all workers) |
| `GET` | `/dashboard` | HTML dashboard UI |
| `POST` | `/webhooks/:id` | Incoming webhook receiver |

Each local worker also exposes the same structure on its own port. Workers additionally expose `GET /stream` for SSE streaming (shell worker).

**A2A task format:**

```json
{
  "jsonrpc": "2.0",
  "method": "tasks/send",
  "params": {
    "skillId": "run_shell",
    "args": { "command": "echo hello" },
    "message": { "role": "user", "parts": [{ "text": "run echo hello" }] }
  }
}
```

---

## Workflow Engine

`workflow_execute` runs multi-step DAG-based workflows with maximum parallelism.

```json
{
  "name": "my-workflow",
  "steps": [
    {
      "id": "fetch",
      "skillId": "fetch_url",
      "args": { "url": "https://example.com/api" }
    },
    {
      "id": "analyze",
      "skillId": "ask_claude",
      "dependsOn": ["fetch"],
      "args": { "prompt": "Summarize: {{fetch.result}}" }
    },
    {
      "id": "save",
      "skillId": "create_note",
      "dependsOn": ["analyze"],
      "args": { "title": "Summary", "content": "{{analyze.result}}" },
      "onError": "skip"
    }
  ]
}
```

**Features:**
- Topological sort with max parallelism
- Template references: `{{stepId.result}}`, `{{input.fieldName}}`
- Per-step error strategies: `fail` (default), `skip`, `retry`
- Conditional execution via `when` expressions

---

## Multi-Agent Collaboration

`collaborate` runs the same query across multiple agents and merges results using configurable strategies.

| Strategy | Behavior |
|---|---|
| `fan_out` | Parallel query to all agents; results concatenated or merged |
| `consensus` | AI-scored voting across agent responses |
| `debate` | Iterative critique and refinement rounds |
| `map_reduce` | Distribute sub-tasks across agents, then aggregate |

**Merge strategies:** `concat`, `best_score`, `majority_vote`, `custom` (LLM merge prompt).

```json
{
  "strategy": "consensus",
  "agents": ["http://localhost:8083", "http://localhost:8082"],
  "skillId": "ask_claude",
  "args": { "prompt": "What is the risk level of X?" },
  "mergeStrategy": "best_score"
}
```

`collaborate` returns a `taskId` for async polling.

---

## Skill Pipelines (Composer)

`compose_pipeline` defines declarative skill chains with pipe() semantics. Each step's output feeds the next.

```json
{
  "name": "research-and-save",
  "steps": [
    { "alias": "search", "skillId": "fetch_url", "args": { "url": "{{input.url}}" } },
    { "alias": "summary", "skillId": "ask_claude", "args": { "prompt": "Summarize: {{steps.search.result}}" } },
    { "alias": "note", "skillId": "create_note", "args": { "title": "{{input.title}}", "content": "{{prev.result}}" }, "onError": "fallback", "fallback": "Could not save note" }
  ]
}
```

Template references: `{{prev.result}}`, `{{input.*}}`, `{{steps.<alias>.result}}`

---

## Project Factory

`factory_workflow` generates complete projects from a vague idea. It coordinates the ai, shell, and code workers through a multi-step pipeline:

1. **Intent normalization** — parse and clarify the request
2. **Template matching** — select the best pipeline type
3. **Scaffolding** — write directory and file structure
4. **Code generation** — fill files via Claude
5. **Quality gate ("Ralph Mode")** — multi-dimension scoring with automatic fix loops

**Pipeline types** (defined in `src/pipelines/`):

| Type | Output |
|---|---|
| `app` | Expo React Native mobile app |
| `website` | Next.js site |
| `mcp-server` | MCP server scaffold (Bun) |
| `agent` | AI agent project |
| `api` | REST API |
| `cli` | CLI tool |

**Template variants** (in `src/templates/`): e-commerce, saas-starter, social-app, portfolio, saas-landing, crud-service, marketplace, devtool, data-connector, dev-tools, api-integration, content-generator.

```json
{
  "idea": "Build a SaaS landing page for a B2B invoicing tool",
  "pipeline": "website",
  "template": "saas-landing"
}
```

---

## Sandbox Execution

`sandbox_execute` runs TypeScript in isolated Bun subprocesses. Code has access to all worker skills via a preloaded `skill()` helper.

```typescript
// Inside a sandbox
const result = await skill("ask_claude", { prompt: "Summarize recent news" });
const prices = await skill("fetch_quote", { symbol: "AAPL" });

// Variables persist across calls (stored in SQLite)
$vars.lastPrice = prices.close;

// Large results (>4KB) are auto-indexed for FTS5 search
const big = await skill("fetch_url", { url: "https://example.com/huge.json" });
const matches = await search("big", "quarterly revenue");
```

**Features:**
- Per-session variable persistence via `~/.a2a-sandbox.db`
- FTS5 full-text search on large results (auto-indexed at >4KB)
- Configurable timeout (default: 30 s)
- `sandbox_vars` tool for managing persisted variables

---

## Memory & Knowledge

All workers share a unified memory layer backed by:

- **SQLite** — `~/.a2a-memory.db` for fast key/value recall
- **Obsidian vault** — `~/Documents/Obsidian/a2a-knowledge/_memory/` for markdown notes

Tools: `remember`, `recall`, `memory_list`, `memory_cleanup`

The **knowledge worker** (port 8085) provides a full note-taking layer on top of the Obsidian vault: `create_note`, `read_note`, `update_note`, `search_notes`, `list_notes`. Override the vault path with `OBSIDIAN_VAULT`.

---

## Event Bus

An in-process pub/sub system with topic wildcards.

| Pattern | Matches |
|---|---|
| `agent.shell.completed` | Exact topic |
| `agent.*.completed` | Any single segment |
| `workflow.#` | Any multi-segment path |

**Features:**
- Event history with configurable retention
- Replay from timestamp (`event_replay`)
- Dead letter queue for failed deliveries
- Auto-published on every agent completion and failure (integrated into the delegate flow)

---

## Distributed Tracing

Every delegation creates an OpenTelemetry-style trace with child spans per worker call.

```
Trace: delegate → run_shell
  ├─ span: skill-router        2 ms
  ├─ span: cache-lookup        1 ms
  ├─ span: circuit-breaker     0 ms
  └─ span: shell:8081/tasks    45 ms
```

MCP tools: `list_traces`, `get_trace` (waterfall view), `search_traces`
Resource: `a2a://traces`

---

## Skill Cache

An LRU cache with per-skill TTL for idempotent skill results.

- Content-addressable keys (deterministic hash of `skillId + args`)
- Side-effect skills (`run_shell`, `write_file`, etc.) are excluded automatically
- Per-skill TTL configuration

MCP tools: `cache_stats`, `cache_invalidate`, `cache_configure`
Resource: `a2a://cache`

---

## Capability Negotiation

Version-aware skill routing with SemVer matching and multi-dimensional scoring.

**Scoring dimensions:** version match, required features, preferred features, worker health, active load, user priority.

```json
{
  "skillId": "ask_claude",
  "version": ">=1.2.0",
  "features": ["streaming"],
  "preferredFeatures": ["vision"]
}
```

MCP tools: `negotiate_capability`, `list_capabilities`, `capability_stats`
Resource: `a2a://capabilities`

---

## Webhooks

Register HTTP endpoints that trigger A2A tasks from external services.

```json
{
  "id": "github-push",
  "secret": "my-hmac-secret",
  "skillId": "run_shell",
  "fieldMap": { "command": "$.head_commit.message" }
}
```

Incoming requests hit `POST /webhooks/:id` on the A2A HTTP server. HMAC-SHA256 signature verification is performed before the payload is forwarded.

MCP tools: `webhook_register`, `webhook_list`, `webhook_delete`

---

## Output Filtering & Token Savings

The output filter runs on every worker response before it reaches the MCP client.

**Default filters:**
- Strip ANSI escape codes
- Collapse git verbose output
- Compress npm/bun install logs
- Trim test runner noise

**Config:**

```json
{
  "outputFilter": {
    "enabled": true,
    "stripAnsi": true,
    "builtinFilters": true,
    "customFiltersPath": "~/.a2a-mcp/filters.json",
    "teeEnabled": true,
    "teeMaxAgeMins": 1440,
    "tokenTrackingEnabled": true,
    "tokenRetentionDays": 90
  }
}
```

The "tee" system preserves raw output alongside filtered output. Token savings are tracked and available via `agency_roi_snapshot`.

---

## Federation

The orchestrator can federate with peer A2A servers for cross-instance skill routing.

```json
{
  "federation": {
    "peers": ["https://peer1.example.com", "https://peer2.example.com"],
    "healthIntervalMs": 60000,
    "discoveryTimeoutMs": 5000
  }
}
```

Remote workers (not federation peers) are added under `remoteWorkers` in config — no local process is spawned; the orchestrator discovers them via their agent card URL.

```json
{
  "remoteWorkers": [
    { "name": "my-remote", "url": "https://my-agent.example.com", "apiKey": "optional" }
  ]
}
```

---

## Security & RBAC

**API key management** (`src/auth.ts`):

```bash
bun src/cli.ts auth-create-key   # prints key + id
bun src/cli.ts auth-list-keys
bun src/cli.ts auth-revoke-key --target <id>
```

**Roles:** `admin`, `operator`, `viewer`

**Per-key skill allow/deny lists:**

```json
{
  "role": "operator",
  "allowedSkills": ["ask_claude", "fetch_url"],
  "deniedSkills": ["run_shell"]
}
```

**SSRF prevention:** All worker URLs are validated against an allowlist (ports 8081–8094). Remote worker URLs are auto-whitelisted on registration.

**Prompt sanitization:** `src/prompt-sanitizer.ts` strips injection patterns before forwarding to Claude.

**Sandbox isolation:** Each `sandbox_execute` call spawns a fresh Bun subprocess with stdin/stdout IPC and an enforced timeout.

---

## Audit Logging

Every skill invocation is written to an immutable SQLite database at `~/.a2a-mcp/audit.db`.

```json
{
  "actor": "key-abc123",
  "skill": "run_shell",
  "workspace": "team-alpha",
  "args": { "command": "ls -la" },
  "result": "success",
  "durationMs": 42,
  "timestamp": "2026-03-14T10:00:00Z"
}
```

MCP tools: `audit_query`, `audit_stats`
Resource: `a2a://audit`

---

## Skill Tiers & Licensing

Skills are gated by tier: `free`, `pro`, `enterprise`.

```bash
export A2A_LICENSE_KEY="base64-encoded-license"
# or
cat ~/.a2a-mcp/license.json
```

MCP tool: `license_info`
Resource: `a2a://license`

---

## Persona System

Each worker can load a persona from `src/personas/<name>.md` that sets its system prompt, model selection, temperature, and max tokens. Personas are hot-reloaded via `watchPersonas()` — no restart required.

---

## Plugin System

Dynamic plugins loaded from `src/plugins/`:

- `oauth.ts` — OAuth token refresh for external services
- `timestamps.ts` — Automatic timestamping of skill results

Add custom plugins by dropping a `.ts` file in `src/plugins/` that exports a `register(server)` function.

---

## ACP Integration (Zed IDE)

Start the ACP server for Zed IDE integration:

```bash
bun run start:acp
```

The ACP server (`src/acp-server.ts`) speaks the stdin/stdout protocol expected by Zed, exposing the same skill routing as the MCP server.

---

## Agency Product Mode

The server ships with productized interfaces for agencies and consultancies running recurring client-delivery operations.

**Packaged v1 workflows:**
- Client reporting pipeline
- Approval gate workflow
- Client handoff sequence

**Commercial offer:** managed onboarding + managed cloud + weekly optimization
**Price anchor:** EUR 1.5k–3k/month + one-time setup fee

**MCP tools:** `agency_workflow_templates`, `agency_roi_snapshot`
**MCP resources:** `a2a://agency-workflows`, `a2a://agency-roi`

Operational runbooks, sales playbooks, and onboarding materials live in [`docs/product/`](docs/product/).

---

## ERP Expansion APIs

The ERP module (`src/erp/`) provides connector tools for quote-to-order, renewal automation, and snapshot export. These are enterprise-tier skills exposed as MCP tools alongside the standard fleet.

Key capabilities: quote pipeline, renewal sweeper, followup writeback, snapshot export.

Config:

```json
{
  "erp": {
    "autoRenewEnabled": true,
    "renewalSweepIntervalMs": 86400000,
    "snapshotExportEnabled": true,
    "followupWritebackEnabled": true
  }
}
```

---

## Configuration

Config file: `~/.a2a-mcp/config.json`

```json
{
  "profile": "lite",
  "server": {
    "port": 8080,
    "apiKey": "optional-shared-secret",
    "healthPollInterval": 30000
  },
  "workers": [
    { "name": "shell", "port": 8081, "enabled": true }
  ],
  "remoteWorkers": [
    { "name": "remote-agent", "url": "https://agent.example.com", "apiKey": "..." }
  ],
  "search": {
    "maxResults": 50,
    "rateLimit": 3,
    "rateLimitBurst": 8
  },
  "sandbox": {
    "timeout": 30000,
    "maxResultSize": 25000,
    "indexThreshold": 4096
  },
  "timeouts": {
    "shell": 15000,
    "fetch": 30000,
    "codex": 120000,
    "peer": 60000
  },
  "web": {
    "rateLimit": 0,
    "maxResponseBytes": 10485760
  },
  "truncation": {
    "maxResponseSize": 25000,
    "maxArrayItems": 100,
    "headRatio": 0.6
  },
  "outputFilter": {
    "enabled": true,
    "stripAnsi": true,
    "builtinFilters": true,
    "tokenTrackingEnabled": true
  },
  "federation": {
    "peers": [],
    "healthIntervalMs": 60000
  }
}
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API key (falls back to Claude Code OAuth) |
| `GOOGLE_API_KEY` | — | Gemini key for design worker |
| `A2A_API_KEY` | — | Shared API key for A2A HTTP server |
| `A2A_PORT` | `8080` | Orchestrator HTTP port |
| `A2A_LICENSE_KEY` | — | Base64 license key for tier gating |
| `A2A_SANDBOX_TIMEOUT` | `30000` | Sandbox execution timeout (ms) |
| `A2A_MAX_RESPONSE_SIZE` | `25000` | Max response size before truncation |
| `A2A_MAX_RESPONSE_BYTES` | `10485760` | Max HTTP response body for web worker |
| `A2A_ASK_CLAUDE_MAX_TOKENS` | `4096` | Max tokens for ask_claude |
| `A2A_WEB_RATE_LIMIT` | `0` | Web worker rate limit (0 = unlimited) |
| `A2A_LOG_LEVEL` | `info` | Log level |
| `OBSIDIAN_VAULT` | `~/Documents/Obsidian/a2a-knowledge` | Override Obsidian vault path |
| `NASA_FIRMS_KEY` | — | NASA FIRMS key for climate worker |

---

## Deployment

### Docker

```bash
docker build -t a2a-mcp-server .
docker run -p 8080-8094:8080-8094 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v a2a-data:/data \
  a2a-mcp-server
```

Or with Compose:

```bash
docker compose up
```

The Dockerfile:
- Base: `oven/bun:1`
- Runs as non-root `bun` user
- Exposes ports 8080–8094
- SQLite databases mounted at `/data`

### Fly.io

```bash
fly launch   # uses fly.toml
fly deploy
```

Config: `primary_region = iad`, `shared-cpu-1x` with 1024 MB RAM, HTTPS enforced, soft concurrency limit 200.

### Railway

```bash
railway up   # uses railway.json
```

Config: `Dockerfile` build, `/healthz` health check, restart on failure.

### Cloud health endpoints

| Path | Purpose |
|---|---|
| `/healthz` | Basic liveness |
| `/readyz` | Readiness (all workers up) |
| `/health` | Detailed (per-worker circuit-breaker state) |

---

## Development

```bash
# Run with watch mode
bun run dev

# Type-check (uses Bun bundler, no tsc required)
bun build src/server.ts --target bun

# Run tests
bun test

# Scaffold a new worker
bun src/cli.ts create-worker <name> --port <port>
```

**Key constraints for contributors:**
- Never use `console.log` — stdout is reserved for MCP JSON-RPC. Use `process.stderr.write(...)` for all logging.
- Use `.js` extensions on all local imports (ESM): `import { foo } from "../bar.js"`
- No build step — Bun runs TypeScript directly.

**Module map:**

| Module | Purpose |
|---|---|
| `src/server.ts` | Orchestrator entry point (MCP + A2A + ACP) |
| `src/a2a.ts` | `sendTask()` and `discoverAgent()` HTTP helpers |
| `src/config.ts` | Config schema (Zod) + loading |
| `src/memory.ts` | Dual-write memory (SQLite + Obsidian) |
| `src/skills.ts` | Built-in skill registry |
| `src/sandbox.ts` | Isolated Bun subprocess executor |
| `src/sandbox-store.ts` | Variable persistence + FTS5 indexing |
| `src/circuit-breaker.ts` | Per-worker circuit breaker |
| `src/metrics.ts` | Execution metrics (p50/p95/p99) |
| `src/workflow-engine.ts` | DAG workflow orchestrator |
| `src/skill-composer.ts` | Declarative pipeline composer |
| `src/agent-collaboration.ts` | Multi-agent collaboration protocols |
| `src/tracing.ts` | OpenTelemetry-style tracing |
| `src/skill-cache.ts` | LRU skill result cache |
| `src/capability-negotiation.ts` | Version-aware skill routing |
| `src/event-bus.ts` | Pub/sub event system |
| `src/webhooks.ts` | Webhook registration and dispatch |
| `src/auth.ts` | API key + RBAC |
| `src/workspace.ts` | Team workspaces |
| `src/audit.ts` | Immutable audit trail |
| `src/skill-tier.ts` | License-based skill gating |
| `src/output-filter.ts` | ANSI + token-saving filters |
| `src/cloud.ts` | Health endpoints + graceful shutdown |
| `src/worker-loader.ts` | User-space worker discovery (`~/.a2a-mcp/workers/`) |
| `src/federation.ts` | Peer A2A server discovery |
| `src/acp-server.ts` | Zed IDE ACP protocol server |

---

## License

[MIT](LICENSE)
