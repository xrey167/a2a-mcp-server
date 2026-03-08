<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun_v1-f472b6?logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/protocol-MCP_(Anthropic)-6366f1" alt="MCP" />
  <img src="https://img.shields.io/badge/protocol-A2A_(Google)-10b981" alt="A2A" />
  <img src="https://img.shields.io/badge/protocol-ACP_(Zed)-ef4444" alt="ACP" />
  <img src="https://img.shields.io/badge/agents-8_workers-f59e0b" alt="Agents" />
  <img src="https://img.shields.io/badge/MCP_tools-10_consolidated-8b5cf6" alt="Tools" />
  <img src="https://img.shields.io/github/license/xrey167/a2a-mcp-server" alt="License" />
</p>

# a2a-mcp-server

A **full multi-agent system** — not just a bridge — that connects Anthropic’s [MCP](https://modelcontextprotocol.io) and Google’s [A2A](https://a2a-protocol.org) protocols. One orchestrator manages eight specialized worker agents, routes tasks intelligently, and maintains shared memory across all agents. Includes circuit breakers for resilience, a DAG workflow engine, webhook ingestion, per-skill metrics, and a data processing pipeline.

Claude Code connects via MCP (stdio), Zed connects via ACP (stdin/stdout NDJSON). Agents talk to each other via A2A (HTTP + JSON-RPC 2.0). Three protocols, each doing what it’s best at.

-----
| Mechanism | Without | With | Token Reduction |
|-----------|---------|------|-----------------|
| **Sandbox execution** | 100KB API response → Claude reads + filters → returns result | Code runs locally, returns 500 bytes | **~99%** per data operation |
| **FTS5 auto-indexing** | 500KB log file dumped into context | Search index, max 50 matching lines returned | **~90-98%** on large datasets |
| **Persistent memory** | Re-explain project context every session (~2,000 tokens) | Auto-injected preamble (~100 tokens, set once) | **~95%** on repeated context |
| **Bounded sessions** | 100+ turns accumulate in history | Capped at 20 turns (40 messages), older dropped | **~60-80%** on long conversations |
| **Lightweight routing** | Full JSON schemas per agent (~2KB each × 8 agents = ~16KB) | Skill IDs only (~100 bytes per agent = ~800 bytes) | **~95%** on routing metadata |
| **Input truncation** | Unbounded user input / template content | Hard caps: 10K chars (user), 50K chars (templates), 1,024 output tokens | Prevents **100%** context blowout |
| **Isolated agent contexts** | All 8 agents share one context window | Each worker has its own process + context | **~85%** less cross-contamination |

## How it differs from other A2A-MCP projects

Most [A2A-MCP integrations](https://github.com/modelcontextprotocol/servers) are thin clients — they forward MCP tool calls to remote A2A agents. This project is different:

|                 |Thin bridge             |**a2a-mcp-server**                           |
|:----------------|:-----------------------|:--------------------------------------------|
|**Agents**       |Proxy to external agents|8 built-in workers with real logic           |
|**Memory**       |None                    |Dual-write: SQLite (FTS5) + Obsidian markdown|
|**Routing**      |Manual                  |Smart auto-routing via AI agent              |
|**MCP surface**  |One tool per skill      |10 consolidated tools (MCX-inspired)         |
|**Extensibility**|Code changes            |Hot-reload plugins + personas, no restart    |
|**Resilience**   |None                    |Circuit breakers, retry with backoff, cascading failure isolation|
|**Observability**|None                    |Per-skill latency percentiles (p50/p95/p99), error rates, worker utilization|
|**Workflows**    |None                    |DAG workflow engine with parallel steps, template refs, retry/skip/fail policies|
|**Webhooks**     |None                    |HMAC-SHA256 verified webhook ingestion with payload mapping|
|**Security**     |Basic tokens            |Prompt injection prevention, SSRF guards, path traversal protection, OAuth2, AES-256-GCM credential sync|
|**Protocols**    |MCP only                |MCP + ACP (Zed) + A2A                        |
|**Runtime**      |Python (most)           |TypeScript / Bun                             |

-----

## Architecture

```
Claude Code                Zed Editor
    │                          │
    │  MCP (stdio)             │  ACP (stdin/stdout NDJSON)
    ▼                          ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              ORCHESTRATOR · :8080                                │
│     smart routing · project context · sessions · sandbox · workflow engine        │
│   circuit breakers · metrics · webhooks · memory · plugins · security            │
└──┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬───┘
   │          │          │          │          │          │          │          │
   │          │          │    A2A (HTTP + JSON-RPC 2.0)  │          │          │
   ▼          ▼          ▼          ▼          ▼          ▼          ▼          ▼
 :8081      :8082      :8083      :8084      :8085      :8086      :8087      :8088
 Shell       Web        AI        Code     Knowledge   Design    Factory     Data
 Agent      Agent      Agent      Agent      Agent      Agent      Agent     Agent
```

|Agent        |Port|What it does                                                   |
|:------------|:--:|:--------------------------------------------------------------|
|**Shell**    |8081|Run commands, read/write files, stream output via SSE          |
|**Web**      |8082|Fetch URLs, call external REST APIs                            |
|**AI**       |8083|Prompt Claude (SDK or CLI fallback), search files, query SQLite|
|**Code**     |8084|Autonomous coding via OpenAI Codex CLI                         |
|**Knowledge**|8085|Full CRUD on an Obsidian vault — notes, search, tags           |
|**Design**   |8086|End-to-end UI design pipeline (Gemini + Stitch MCP)            |
|**Factory**  |8087|Turn ideas into production-ready projects via multi-agent pipelines|
|**Data**     |8088|CSV/JSON parsing, transforms, statistical analysis, pivot tables|

Every agent shares `remember` / `recall` / `memory_search` — backed by **SQLite** for fast FTS5 queries and **Obsidian** for human-readable persistence. Workers auto-respawn on crash with exponential backoff. All inter-agent calls are wrapped in **circuit breakers** for resilience.

-----

## Quick start

### Prerequisites

- [Bun](https://bun.sh) v1.x
- [Claude Code](https://claude.ai/code) — MCP host + OAuth
- [Codex CLI](https://github.com/openai/codex) — `codex login` (for Code Agent)
- [Obsidian](https://obsidian.md) — vault at `~/Documents/Obsidian/a2a-knowledge` (or set `OBSIDIAN_VAULT`)

### Install

```bash
git clone https://github.com/xrey167/a2a-mcp-server
cd a2a-mcp-server
bun install
```

### Register with Claude Code (MCP)

```bash
claude mcp add --scope user a2a-mcp-bridge -- bun /path/to/a2a-mcp-server/src/server.ts
```

The server starts automatically when Claude Code launches. For standalone:

```bash
bun src/server.ts
```

### Register with Zed (ACP)

Add to your Zed `settings.json`:

```json
{
  "agent": {
    "profiles": {
      "a2a-bridge": {
        "binary": { "path": "bun", "args": ["/path/to/a2a-mcp-server/src/acp-server.ts"] }
      }
    }
  }
}
```

-----

## Key features

### 🔀 Smart task routing

The orchestrator decides where your task goes — three levels of control:

1. **Direct** — set `agentUrl` to send to a specific agent
1. **By skill** — set `skillId` and the orchestrator finds the owner
1. **Auto** — omit both and the AI agent picks the best worker

```
# Auto-route — AI picks the best agent
delegate { message: "find all TODO comments in the codebase" }

# Route by skill
delegate { message: "list all TypeScript files", skillId: "search_files" }

# Direct to an agent
delegate { message: "run uname", agentUrl: "http://localhost:8081", skillId: "run_shell" }

# Session continuity across calls
delegate { message: "now refactor that function", sessionId: "my-session-123" }
```

### 🧠 Dual-write memory

Every `remember` call writes to **both** backends simultaneously:

- **SQLite** (`~/.a2a-memory.db`) — FTS5 full-text search, fast key-value access
- **Obsidian** (`_memory/` folder) — human-readable markdown, inspectable in your vault

```
# Store
delegate { skillId: "remember", args: { key: "api-key-rotation", value: "Every 90 days" } }

# Search across all agents
memory_search { query: "api key" }

# Cleanup old entries
memory_cleanup { maxAgeDays: 90 }
```

### 🔌 Hot-reload plugins & personas

No server restart needed — drop a file and it loads in seconds:

**Personas** control agent behavior via markdown + YAML frontmatter:

```markdown
<!-- src/personas/ai-agent.md -->
---
model: claude-sonnet-4-6
temperature: 0.3
---
You are the AI specialist in a local multi-agent system...
```

**Plugins** add new skills via TypeScript modules:

```typescript
// src/plugins/my-plugin/index.ts
import type { Skill } from "../../skills.js";

export const skills: Skill[] = [{
  id: "my_skill",
  name: "My Skill",
  description: "Does something useful",
  inputSchema: {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
  },
  run: async (args) => "result",
}];
```

**Declarative skills** can also be defined as `_plugins/<n>/plugin.md` in your Obsidian vault.

### 🔐 Security

Defense-in-depth across all layers (see [SECURITY.md](SECURITY.md) for full details):

- **Prompt injection prevention** — all user input sanitized via `prompt-sanitizer.ts` (character escaping, XML tag boundaries, anti-injection instructions)
- **SSRF protection** — URL validation restricts requests to allowed worker ports; orchestrator port excluded to prevent recursion
- **Path traversal prevention** — `path-utils.ts` blocks `../` escapes and symlink attacks
- **Input truncation** — hard caps on user input (10K chars), templates (50K chars), and output tokens (1,024)
- **Local trust** — loopback (`127.0.0.1`) always trusted, no auth header needed
- **Remote auth** — all external callers require `Authorization: Bearer <A2A_API_KEY>`
- **OAuth2** — browser-based flow for Google, GitHub, Linear (or custom providers)
- **Cross-machine sync** — push/pull credentials encrypted with AES-256-GCM

```bash
# Set up on primary machine
export A2A_API_KEY="your-secret"
sync_secrets { action: "configure", passphrase: "encryption-secret" }
sync_secrets { action: "push" }

# Pull on any new machine
sync_secrets { action: "pull" }
```

### ⚡ Async task execution

Fire-and-forget for long-running operations:

```
delegate_async { message: "run the full test suite", skillId: "run_shell" }
# → { "taskId": "abc-123" }

get_task_result { taskId: "abc-123" }
# → { "status": "completed", "result": "..." }
```

### 🧪 Sandbox execution

Run TypeScript in isolated Bun subprocesses with full access to all worker skills. Variables persist per session in SQLite, and large results (>4KB) are auto-indexed for FTS5 search.

```
# Execute code that calls worker skills directly
sandbox_execute {
  code: "const files = await skill('search_files', { pattern: '**/*.ts' }); return files.length;",
  sessionId: "my-session"
}

# Search over auto-indexed results
sandbox_execute {
  code: "const matches = await search('files', 'server'); return matches;",
  sessionId: "my-session"
}

# Manage persisted variables
sandbox_vars { action: "list_vars", sessionId: "my-session" }
```

**Sandbox API** (available inside `sandbox_execute` code):

|Function                    |Description                                                |
|:---------------------------|:----------------------------------------------------------|
|`skill(id, args)`           |Call any worker skill                                      |
|`search(varName, query)`    |FTS5 full-text search over stored variables                |
|`adapters()`                |List all available skill IDs + descriptions                |
|`describe(skillId)`         |Get full input schema for a skill                          |
|`batch(items, fn, opts?)`   |Process array with concurrency control (default 5)         |
|`$vars`                     |Persistent key-value store (survives across calls)         |
|`pick(arr, ...keys)`        |Project array of objects to selected keys                  |
|`sum(arr, key)`             |Sum numeric field across array                             |
|`count(arr, key)`           |Count occurrences by field value                           |
|`first(arr, n?)` / `last()` |Take first/last N items                                    |
|`table(arr)`                |Format array of objects as ASCII table                     |

### 🛡️ Circuit breakers

All inter-agent calls are wrapped in circuit breakers that prevent cascading failures. Each worker gets its own breaker with configurable thresholds.

```
# View all breaker states
get_metrics   # includes circuit breaker status

# Or via MCP resource
# a2a://circuit-breakers
```

States: **closed** (normal) → **open** (failing, fast-reject) → **half_open** (testing recovery). Defaults: 5 failures to open, 30s cooldown, 2 successes to close.

### 📊 Metrics & observability

Per-skill latency percentiles, error rates, and worker utilization — collected automatically on every skill call.

```
# Snapshot of all metrics
get_metrics

# HTTP endpoint
curl http://localhost:8080/metrics
```

Tracks: call count, error count, error rate, latency (p50/p95/p99/max) per skill, plus per-worker totals. Available as MCP resource at `a2a://metrics`.

### 🔄 Workflow engine

Define multi-step DAG workflows with parallel execution, template references, and error policies.

```
workflow_execute {
  workflow: {
    id: "analyze-and-report",
    steps: [
      { id: "fetch", skillId: "fetch_url", args: { url: "https://api.example.com/data" } },
      { id: "parse", skillId: "parse_json", args: { data: "{{fetch.result}}" }, dependsOn: ["fetch"] },
      { id: "analyze", skillId: "analyze_data", args: { data: "{{parse.result}}" }, dependsOn: ["parse"] }
    ]
  }
}
```

Features:
- **Parallel execution** — independent steps run concurrently
- **Template references** — `{{stepId.result}}` resolves to previous step output
- **Error policies** — `onError: "fail"` (cascade), `"skip"` (continue), `"retry"` (with backoff)
- **Retry with backoff** — `maxRetries: 3` with exponential delay
- **Conditional execution** — `when: "{{stepId.result}}"` guards
- **Cycle detection** — validates DAG structure before execution
- **Progress callbacks** — real-time step status updates

### 🪝 Webhooks

Receive external events via HMAC-SHA256 verified webhooks that auto-dispatch to worker skills.

```
# Register a webhook
register_webhook {
  id: "github-push",
  secret: "whsec_...",
  skillId: "run_shell",
  fieldMap: { command: "head_commit.message" }
}

# Incoming webhook triggers the skill
# POST http://localhost:8080/webhooks/github-push
# X-Hub-Signature-256: sha256=...

# View webhook activity
list_webhooks
```

Features: constant-time HMAC signature verification, dot-notation payload field mapping, enable/disable toggle, activity logging with auto-pruning (last 1000 per webhook). Available as MCP resource at `a2a://webhooks`.

### 🏭 Project Factory

Generate complete, production-ready projects from a vague idea. The Factory Agent orchestrates multiple workers through a multi-phase pipeline: intent normalization, template scaffolding, AI code generation, and quality gate review ("Ralph Mode").

```
# Generate a project end-to-end
factory_workflow { idea: "habit tracker with streaks", pipeline: "app" }

# Or use individual skills
delegate { skillId: "normalize_intent", message: "expand this idea", args: { idea: "recipe app", pipeline: "website" } }
delegate { skillId: "list_pipelines", message: "show available pipelines" }
```

**Available pipelines:**

|Pipeline      |Stack                              |Variants                         |
|:-------------|:----------------------------------|:--------------------------------|
|`app`         |Expo + React Native + TypeScript   |`saas-starter`, `e-commerce`, `social-app`|
|`website`     |Next.js + React + Tailwind CSS     |`portfolio`, `saas-landing`      |
|`mcp-server`  |TypeScript + Bun + MCP SDK         |`dev-tools`, `data-connector`    |
|`agent`       |TypeScript + Claude SDK            |`api-integration`, `content-generator`|
|`api`         |Fastify + SQLite + TypeScript      |`marketplace`, `crud-service`    |
|`cli`         |Bun + TypeScript + Zod             |`devtool`                        |

Each pipeline supports **template variants** and a **quality gate** ("Ralph Mode") that scores generated code across multiple dimensions (code quality, type safety, accessibility, etc.) with automatic fix loops.

-----

## Function reference

The MCP surface is consolidated into **10 core tools** (MCX-inspired: minimal tool count, maximum capability). All underlying worker skills remain callable via `sandbox_execute` with `skill(id, args)` or `delegate` with `skillId`.

### MCP tools (exposed to Claude Code / ACP)

|Tool               |Description                                                                      |
|:-------------------|:--------------------------------------------------------------------------------|
|`sandbox_execute`   |Execute TypeScript in an isolated sandbox with access to all skills via `skill(id, args)`. Supports var management (`list_vars`, `get_var`, `delete_var`).|
|`delegate`          |Route a task to a worker agent (sync by default). Set `async: true` for fire-and-forget (returns `taskId`). Pass `taskId` to poll result.|
|`list_agents`       |List all worker agents, external agents, and their skills.                       |
|`run_shell_stream`  |Execute shell command with real-time streaming output.                           |
|`design_workflow`   |Full design pipeline: suggest screens, generate each. Returns `taskId`.          |
|`factory_workflow`  |Full project generation pipeline. Returns `taskId`.                              |
|`workflow_execute`  |Execute a DAG workflow with parallel steps, template refs, and error policies.   |
|`get_metrics`       |Snapshot of per-skill latency percentiles, error rates, and worker utilization.  |
|`register_webhook`  |Register HMAC-SHA256 verified webhook that dispatches to a skill.               |
|`list_webhooks`     |List all registered webhooks with activity stats.                                |

### Skills (callable via sandbox or delegate)

All skills below are accessible through `sandbox_execute` using `skill(id, args)` or through `delegate` with `skillId`.

#### Orchestration & memory

|Skill             |Description                                                                      |
|:-----------------|:--------------------------------------------------------------------------------|
|`remember`        |Store key-value (dual-write SQLite + Obsidian)                                   |
|`recall`          |Get one value or all memories for agent                                          |
|`memory_search`   |Full-text search (FTS5) across all agents                                        |
|`memory_list`     |List keys by agent, optionally filtered                                          |
|`memory_cleanup`  |Delete old entries from both stores                                              |
|`register_agent`  |Register external A2A agent by URL (discovers `/.well-known/agent.json`)         |
|`unregister_agent`|Remove external agent from registry                                              |
|`get_session_history`|Last 20 turns (40 messages), auto-expire 30 days                              |
|`clear_session`   |Clear conversation history                                                       |
|`get_project_context`|Return project summary, goals, stack, notes                                   |
|`set_project_context`|Update project context — auto-injected into `delegate` calls                  |

<details>
<summary><strong>Shell Agent · :8081</strong></summary>

|Function          |Parameters             |Description                         |
|:-----------------|:----------------------|:-----------------------------------|
|`run_shell`       |`command`              |Execute command (15s timeout)       |
|`run_shell_stream`|`command`, `timeoutMs?`|Stream output via SSE (default 120s)|
|`read_file`       |`path`                 |Read file contents (UTF-8)          |
|`write_file`      |`path`, `content`      |Write/overwrite file                |

</details>

<details>
<summary><strong>Web Agent · :8082</strong></summary>

|Function   |Parameters                          |Description                     |
|:----------|:-----------------------------------|:-------------------------------|
|`fetch_url`|`url`, `format?`                    |Fetch URL as `text` or `json`   |
|`call_api` |`url`, `method`, `headers?`, `body?`|Full HTTP request with JSON body|

</details>

<details>
<summary><strong>AI Agent · :8083</strong></summary>

|Function      |Parameters             |Description                                      |
|:-------------|:----------------------|:------------------------------------------------|
|`ask_claude`  |`prompt`, `model?`     |Prompt Claude (SDK → CLI OAuth fallback)         |
|`search_files`|`pattern`, `directory?`|Glob file search (Bun native)                    |
|`query_sqlite`|`database`, `sql`      |Read-only `SELECT` queries against any `.db` file|

</details>

<details>
<summary><strong>Code Agent · :8084</strong></summary>

|Function      |Parameters|Description                                        |
|:-------------|:---------|:--------------------------------------------------|
|`codex_exec`  |`prompt`  |Execute coding task via Codex CLI (full-auto, 120s)|
|`codex_review`|—         |Review codebase via Codex CLI                      |

</details>

<details>
<summary><strong>Knowledge Agent · :8085</strong></summary>

|Function      |Parameters                 |Description                               |
|:-------------|:--------------------------|:-----------------------------------------|
|`create_note` |`title`, `content`, `tags?`|Create Obsidian note with YAML frontmatter|
|`read_note`   |`title`                    |Read note by title                        |
|`update_note` |`title`, `content`         |Replace note content                      |
|`search_notes`|`query`                    |Case-insensitive substring search         |
|`list_notes`  |`folder?`                  |List all `.md` files in vault/subfolder   |

</details>

<details>
<summary><strong>Design Agent · :8086</strong></summary>

|Function           |Parameters                                                       |Description                                      |
|:------------------|:----------------------------------------------------------------|:------------------------------------------------|
|`design_workflow`  |`appConcept`, `title?`, `deviceType?`, `screensOnly?`, `modelId?`|End-to-end UI: Gemini screens → Stitch generation|
|`enhance_ui_prompt`|—                                                                |Enhance a UI prompt for better generation        |
|`suggest_screens`  |—                                                                |Suggest screen flow for app concept              |

</details>

<details>
<summary><strong>Factory Agent · :8087</strong></summary>

|Function          |Parameters                                  |Description                                              |
|:-----------------|:-------------------------------------------|:--------------------------------------------------------|
|`normalize_intent`|`idea`, `pipeline?`                         |Expand vague idea into detailed JSON spec                |
|`create_project`  |`idea`, `pipeline?`, `outputDir?`, `variant?`|Full pipeline: match → normalize → scaffold → generate → QA|
|`quality_gate`    |`code`, `spec?`, `pipeline?`, `variant?`    |"Ralph Mode" multi-dimension code review with scoring    |
|`list_pipelines`  |—                                           |Available pipeline types (app, website, mcp-server, etc.)|
|`list_templates`  |`pipeline?`                                 |Template variants per pipeline                           |

</details>

<details>
<summary><strong>Data Agent · :8088</strong></summary>

|Function        |Parameters                                          |Description                                       |
|:---------------|:---------------------------------------------------|:-------------------------------------------------|
|`parse_csv`     |`data`, `delimiter?`, `headers?`                    |Parse CSV text to array of objects                |
|`parse_json`    |`data`                                              |Parse JSON string with error handling             |
|`transform_data`|`data`, `operations`                                |Chain transforms: filter, sort, group, aggregate, flatten, unique, take, skip, pick, omit, rename|
|`analyze_data`  |`data`, `fields?`                                   |Statistical analysis: mean, median, stddev, percentiles, distributions|
|`pivot_table`   |`data`, `rowField`, `valueField`, `columnField?`, `aggregation?`|Pivot with sum/count/avg/min/max aggregation|

</details>

<details>
<summary><strong>Project context</strong></summary>

|Function             |Parameters                              |Description                                 |
|:--------------------|:---------------------------------------|:-------------------------------------------|
|`get_project_context`|—                                       |Return summary, goals, stack, notes         |
|`set_project_context`|`summary?`, `goals?`, `stack?`, `notes?`|Update — auto-injected into `delegate` calls|

</details>

<details>
<summary><strong>External MCP integration</strong></summary>

|Function          |Parameters         |Description                                            |
|:-----------------|:------------------|:------------------------------------------------------|
|`list_mcp_servers`|—                  |List from `~/.claude.json` + tool counts               |
|`use_mcp_tool`    |`toolName`, `args?`|Call any external MCP tool (lazy-connect, auto-refresh)|

</details>

<details>
<summary><strong>Plugins (hot-reloaded)</strong></summary>

|Function       |Parameters                                          |Description                                 |
|:--------------|:---------------------------------------------------|:-------------------------------------------|
|`get_timestamp`|—                                                   |Current time (ISO 8601 + Unix epoch)        |
|`sync_secrets` |`action`, `passphrase?`, `serverUrl?`               |Cross-platform credential sync (AES-256-GCM)|
|`oauth_setup`  |`action`, `provider?`, `serverName?`, `clientId?`, …|Browser-based OAuth2 for any provider       |

</details>

-----

## MCP resources & prompts

### Resources (read-only)

|URI                        |Description                              |
|:--------------------------|:----------------------------------------|
|`a2a://context`            |Current project context                  |
|`a2a://health`             |Worker health: status, fail count, uptime|
|`a2a://tasks`              |Active and recent task list              |
|`a2a://workers/{name}/card`|Agent card for a specific worker         |
|`a2a://metrics`            |Per-skill latency percentiles and error rates|
|`a2a://circuit-breakers`   |Circuit breaker states for all workers   |
|`a2a://webhooks`           |Registered webhooks and activity stats   |

### Prompt templates

|Prompt          |Description                                |
|:---------------|:------------------------------------------|
|`persona-{name}`|System prompt for any agent                |
|`delegate-task` |Delegate with auto-injected project context|

Available personas: `orchestrator`, `shell-agent`, `web-agent`, `ai-agent`, `code-agent`, `knowledge-agent`, `factory-agent`, `data-agent`.

-----

## A2A protocol details

Every worker exposes three HTTP endpoints:

|Method|Endpoint                 |Purpose                                   |
|:-----|:------------------------|:-----------------------------------------|
|`GET` |`/.well-known/agent.json`|Agent card with capabilities + skills     |
|`GET` |`/healthz`               |Health check (status, uptime, skill IDs)  |
|`POST`|`/`                      |`tasks/send` — JSON-RPC 2.0 task execution|

<details>
<summary><strong>Example request / response</strong></summary>

```jsonc
// POST http://localhost:8081
{
  "jsonrpc": "2.0",
  "method": "tasks/send",
  "id": "req-001",
  "params": {
    "id": "task-001",
    "skillId": "run_shell",
    "args": { "command": "uname -m" },
    "message": { "role": "user", "parts": [{ "text": "" }] }
  }
}
```

```jsonc
// Response
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "result": {
    "id": "task-001",
    "status": { "state": "completed" },
    "artifacts": [{ "parts": [{ "kind": "text", "text": "x86_64" }] }]
  }
}
```

</details>

<details>
<summary><strong>SSE streaming (Shell Agent)</strong></summary>

```bash
curl -X POST http://localhost:8081/stream \
  -H "Content-Type: application/json" \
  -d '{"params":{"skillId":"run_shell","args":{"command":"ping -c 3 1.1.1.1"}}}'
```

Events: `data: {"type":"stdout","text":"..."}` → `data: {"type":"done","exitCode":0}`

</details>

-----

## Configuration

### Environment variables

|Variable                    |Purpose                          |Default                             |
|:---------------------------|:--------------------------------|:-----------------------------------|
|`ANTHROPIC_API_KEY`         |Claude SDK auth                  |Falls back to Claude Code OAuth     |
|`GOOGLE_API_KEY`            |Gemini SDK auth (design-agent)   |Falls back to gemini CLI            |
|`A2A_API_KEY`               |Bearer token for remote access   |Open mode (no auth)                 |
|`OBSIDIAN_VAULT`            |Override vault path              |`~/Documents/Obsidian/a2a-knowledge`|
|`A2A_PORT`                  |Orchestrator HTTP port           |`8080`                              |
|`A2A_FETCH_TIMEOUT`         |HTTP fetch timeout (ms)          |`30000`                             |
|`A2A_CODEX_TIMEOUT`         |Codex CLI timeout (ms)           |`120000`                            |
|`A2A_SANDBOX_TIMEOUT`       |Sandbox execution timeout (ms)   |`30000`                             |
|`A2A_MAX_RESPONSE_SIZE`     |Max response size (chars)        |`25000`                             |
|`A2A_WEB_RATE_LIMIT`        |Outbound fetch rate limit (RPM)  |`0` (unlimited)                     |
|`A2A_ASK_CLAUDE_MAX_TOKENS` |Default max tokens for ask_claude|`4096`                              |
|`A2A_LOG_LEVEL`             |Structured log level             |`info`                              |
|`SYNC_SERVER_URL`           |Remote server for credential sync|`http://localhost:8080`             |
|`SYNC_PASSPHRASE`           |Encryption passphrase            |—                                   |

### Config file (`~/.a2a-mcp/config.json`)

Fine-grained control via JSON (see `.env.example` for quick setup):

```json
{
  "server": { "port": 8080, "healthPollInterval": 30000 },
  "timeouts": { "shell": 15000, "fetch": 30000, "codex": 120000, "peer": 60000 },
  "web": { "rateLimit": 60, "maxResponseBytes": 10485760 },
  "sandbox": { "timeout": 30000, "maxResultSize": 25000 },
  "truncation": { "maxResponseSize": 25000, "maxArrayItems": 100 }
}
```

### Auth methods

|Service       |How                                                         |
|:-------------|:-----------------------------------------------------------|
|Claude API    |`ANTHROPIC_API_KEY` env var, or auto OAuth via Claude Code  |
|OpenAI / Codex|ChatGPT OAuth via `codex login` → `~/.codex/auth.json`      |
|External MCPs |API keys, bearer tokens, or OAuth2 in `~/.a2a-mcp-auth.json`|

<details>
<summary><strong>External MCP auth file format</strong></summary>

```json
{
  "my-server": { "type": "bearer", "token": "tok_..." },
  "other-server": { "type": "header", "headers": { "X-API-Key": "..." } },
  "oauth-server": {
    "type": "oauth2",
    "accessToken": "...",
    "refreshToken": "...",
    "clientId": "...",
    "clientSecret": "...",
    "tokenUrl": "https://...",
    "expiresAt": 1234567890
  }
}
```

</details>

-----

## Docker

```bash
docker build -t a2a-mcp-server .
docker run -p 8080-8088:8080-8088 \
  -e ANTHROPIC_API_KEY=sk-... \
  -e GOOGLE_API_KEY=... \
  a2a-mcp-server
```

## CI

GitHub Actions runs on every push/PR to `main`:
- **Type check** via `bun build`
- **Tests** via `bun test`

-----

## Extending

### Add a new worker agent

1. Create `src/workers/<n>.ts` — Fastify server with `AGENT_CARD` and skill handlers
2. Add to `WORKERS` array in `src/server.ts` (and `src/acp-server.ts` for ACP support)
3. Add port to `ALLOWED_PORTS` in `src/server.ts`
4. All output → `process.stderr` (stdout reserved for MCP/ACP JSON-RPC)

### Add a plugin (hot-reloaded)

Drop a module into `src/plugins/<n>/index.ts` — loads in seconds, no restart.

### Register external A2A agents

```
register_agent { url: "http://my-server:9090", apiKey: "secret-token" }
```

Discovers the agent card via `GET /.well-known/agent.json` and persists to `~/.a2a-agent-registry.json`.

-----

## Project structure

```
a2a-mcp-server/
├── src/
│   ├── server.ts              # MCP entry + orchestrator (port 8080)
│   ├── acp-server.ts          # ACP entry for Zed editor
│   ├── acp-transport.ts       # ACP NDJSON JSON-RPC 2.0 transport
│   ├── acp-types.ts           # ACP protocol type definitions
│   ├── workers/               # Worker agent implementations (8 agents)
│   ├── pipelines/             # Project generation pipeline definitions
│   ├── templates/             # Scaffolding templates + variants per pipeline
│   ├── personas/              # Agent persona .md files (hot-reload)
│   ├── plugins/               # Skill plugins (hot-reload)
│   ├── sandbox.ts             # Isolated Bun subprocess executor
│   ├── sandbox-store.ts       # Variable persistence + FTS5 indexing
│   ├── sandbox-prelude.ts     # TypeScript prelude injected into sandbox
│   ├── a2a.ts                 # sendTask / discoverAgent helpers
│   ├── memory.ts              # Dual-write: SQLite + Obsidian
│   ├── skills.ts              # Built-in skill registry
│   ├── circuit-breaker.ts     # Circuit breaker pattern for worker resilience
│   ├── metrics.ts             # Per-skill latency percentiles + error tracking
│   ├── workflow-engine.ts     # DAG workflow executor with parallel steps
│   ├── webhooks.ts            # HMAC-SHA256 webhook ingestion + dispatch
│   ├── config.ts              # Unified config loader (~/.a2a-mcp/config.json + env)
│   ├── prompt-sanitizer.ts    # Prompt injection prevention
│   ├── path-utils.ts          # Path traversal prevention
│   ├── env-filter.ts          # Safe environment variable filtering
│   ├── truncate.ts            # Smart response truncation
│   ├── safe-json.ts           # Circular-reference-safe JSON serialization
│   ├── logger.ts              # Structured logging (stderr only)
│   └── ...
├── scripts/                   # Utility scripts
├── CLAUDE.md                  # Claude Code project context
├── SECURITY.md                # Security architecture documentation
└── package.json
```

-----

## License

MIT

-----

<p align="center">
  Built with <a href="https://bun.sh">Bun</a> · <a href="https://modelcontextprotocol.io">MCP</a> · <a href="https://a2a-protocol.org">A2A</a> · ACP
</p>
