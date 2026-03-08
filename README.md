<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun_v1-f472b6?logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/protocol-MCP_(Anthropic)-6366f1" alt="MCP" />
  <img src="https://img.shields.io/badge/protocol-A2A_(Google)-10b981" alt="A2A" />
  <img src="https://img.shields.io/badge/agents-7_workers-f59e0b" alt="Agents" />
  <img src="https://img.shields.io/github/license/xrey167/a2a-mcp-server" alt="License" />
</p>

# a2a-mcp-server

A **full multi-agent system** — not just a bridge — that connects Anthropic’s [MCP](https://modelcontextprotocol.io) and Google’s [A2A](https://a2a-protocol.org) protocols. One orchestrator manages six specialized worker agents, routes tasks intelligently, and maintains shared memory across all agents.

Claude Code connects via MCP (stdio). Agents talk to each other via A2A (HTTP + JSON-RPC 2.0). Both protocols, each doing what it’s best at.

-----
| Mechanism | Without | With | Token Reduction |
|-----------|---------|------|-----------------|
| **Sandbox execution** | 100KB API response → Claude reads + filters → returns result | Code runs locally, returns 500 bytes | **~99%** per data operation |
| **FTS5 auto-indexing** | 500KB log file dumped into context | Search index, max 50 matching lines returned | **~90-98%** on large datasets |
| **Persistent memory** | Re-explain project context every session (~2,000 tokens) | Auto-injected preamble (~100 tokens, set once) | **~95%** on repeated context |
| **Bounded sessions** | 100+ turns accumulate in history | Capped at 20 turns (40 messages), older dropped | **~60-80%** on long conversations |
| **Lightweight routing** | Full JSON schemas per agent (~2KB each × 7 agents = ~14KB) | Skill IDs only (~100 bytes per agent = ~700 bytes) | **~95%** on routing metadata |
| **Input truncation** | Unbounded user input / template content | Hard caps: 10K chars (user), 50K chars (templates), 1,024 output tokens | Prevents **100%** context blowout |
| **Isolated agent contexts** | All 7 agents share one context window | Each worker has its own process + context | **~85%** less cross-contamination |

## How it differs from other A2A-MCP projects

Most [A2A-MCP integrations](https://github.com/modelcontextprotocol/servers) are thin clients — they forward MCP tool calls to remote A2A agents. This project is different:

|                 |Thin bridge             |**a2a-mcp-server**                           |
|:----------------|:-----------------------|:--------------------------------------------|
|**Agents**       |Proxy to external agents|7 built-in workers with real logic           |
|**Memory**       |None                    |Dual-write: SQLite (FTS5) + Obsidian markdown|
|**Routing**      |Manual                  |Smart auto-routing via AI agent              |
|**Extensibility**|Code changes            |Hot-reload plugins + personas, no restart    |
|**Auth**         |Basic tokens            |OAuth2 flows + AES-256-GCM credential sync   |
|**Runtime**      |Python (most)           |TypeScript / Bun                             |

-----

## Architecture

```
Claude Code
    │
    │  MCP (stdio)
    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         ORCHESTRATOR · :8080                            │
│          smart routing · project context · sessions · sandbox           │
│             async tasks · memory · agent registry · plugins             │
└──┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬────┘
   │          │          │          │          │          │          │
   │          │       A2A (HTTP + JSON-RPC 2.0)         │          │
   ▼          ▼          ▼          ▼          ▼          ▼          ▼
 :8081      :8082      :8083      :8084      :8085      :8086      :8087
 Shell       Web        AI        Code     Knowledge   Design    Factory
 Agent      Agent      Agent      Agent      Agent      Agent      Agent
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

Every agent shares `remember` / `recall` / `memory_search` — backed by **SQLite** for fast FTS5 queries and **Obsidian** for human-readable persistence.

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

### Register with Claude Code

```bash
claude mcp add --scope user a2a-mcp-bridge -- bun /path/to/a2a-mcp-server/src/server.ts
```

The server starts automatically when Claude Code launches. For standalone:

```bash
bun src/server.ts
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

### 🔐 Security & credential sync

- **Local** — loopback (`127.0.0.1`) always trusted, no auth header needed
- **Remote** — all external callers require `Authorization: Bearer <A2A_API_KEY>`
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

|Pipeline      |Stack                              |Description                          |
|:-------------|:----------------------------------|:------------------------------------|
|`app`         |Expo + React Native + TypeScript   |Mobile app with navigation and state |
|`website`     |Next.js + React + Tailwind CSS     |Website with pages, SEO, and styling |
|`mcp-server`  |TypeScript + Bun + MCP SDK         |MCP server with tool definitions     |
|`agent`       |TypeScript + Claude SDK            |AI agent with tool-calling           |
|`api`         |Fastify + SQLite + TypeScript      |REST/GraphQL API with data layer     |

Each pipeline supports **template variants** (e.g., `saas-starter`, `e-commerce`) and a **quality gate** that scores generated code across multiple dimensions (code quality, type safety, accessibility, etc.) with automatic fix loops.

-----

## Function reference

All functions are exposed as MCP tools to Claude Code and are also callable via the A2A protocol directly.

### Orchestration & routing

|Function          |Description                                                                            |
|:-----------------|:--------------------------------------------------------------------------------------|
|`delegate`        |Route a task to the best worker (sync). Auto-injects project context + session history.|
|`delegate_async`  |Fire-and-forget — returns `taskId`, poll with `get_task_result`                        |
|`get_task_result` |Poll: `pending` / `completed` / `failed` / `canceled` / `not_found`                    |
|`list_agents`     |All agent cards + skills (built-in + external)                                         |
|`register_agent`  |Register external A2A agent by URL (discovers `/.well-known/agent.json`)               |
|`unregister_agent`|Remove external agent from registry                                                    |

### Sessions

|Function             |Parameters |Description                                     |
|:--------------------|:----------|:-----------------------------------------------|
|`get_session_history`|`sessionId`|Last 20 turns (40 messages), auto-expire 30 days|
|`clear_session`      |`sessionId`|Clear conversation history                      |

### Memory (shared across all agents)

|Function        |Parameters        |Description                                   |
|:---------------|:-----------------|:---------------------------------------------|
|`remember`      |`key`, `value`    |Store key-value (dual-write SQLite + Obsidian)|
|`recall`        |`key?`            |Get one value or all memories for agent       |
|`memory_search` |`query`, `agent?` |Full-text search (FTS5) across all agents     |
|`memory_list`   |`agent`, `prefix?`|List keys by agent, optionally filtered       |
|`memory_cleanup`|`maxAgeDays`      |Delete old entries from both stores           |

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

### Prompt templates

|Prompt          |Description                                |
|:---------------|:------------------------------------------|
|`persona-{name}`|System prompt for any agent                |
|`delegate-task` |Delegate with auto-injected project context|

Available personas: `orchestrator`, `shell-agent`, `web-agent`, `ai-agent`, `code-agent`, `knowledge-agent`, `factory-agent`.

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
docker run -p 8080-8087:8080-8087 \
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
1. Add to `WORKERS` array in `src/server.ts`
1. All output → `process.stderr` (stdout reserved for MCP JSON-RPC)

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
│   ├── workers/               # Worker agent implementations (7 agents)
│   ├── pipelines/             # Project generation pipeline definitions
│   ├── templates/             # Scaffolding templates per pipeline
│   ├── personas/              # Agent persona .md files (hot-reload)
│   ├── plugins/               # Skill plugins (hot-reload)
│   ├── sandbox.ts             # Isolated Bun subprocess executor
│   ├── sandbox-store.ts       # Variable persistence + FTS5 indexing
│   ├── sandbox-prelude.ts     # TypeScript prelude injected into sandbox
│   ├── a2a.ts                 # sendTask / discoverAgent helpers
│   ├── memory.ts              # Dual-write: SQLite + Obsidian
│   ├── skills.ts              # Built-in skill registry
│   └── ...
├── scripts/                   # Utility scripts
├── CLAUDE.md                  # Claude Code project context
└── package.json
```

-----

## License

MIT

-----

<p align="center">
  Built with <a href="https://bun.sh">Bun</a> · <a href="https://modelcontextprotocol.io">MCP</a> · <a href="https://a2a-protocol.org">A2A</a>
</p>
