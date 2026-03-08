# a2a-mcp-server

**A multi-agent orchestration platform that bridges MCP and A2A protocols — designed to dramatically reduce token consumption when working with Claude Code.**

---

## Why This Exists

Every message you send through Claude costs tokens — and the default workflow is wasteful. Query an API, get 50KB of JSON back, Claude reads all of it, you ask it to filter three fields, it reads it again. Run a shell command, pipe the output through Claude just to count lines. Repeat context about your project in every conversation because there's no memory between sessions.

**This project exists to keep data out of Claude's context window unless it actually needs to be there.**

## How It Reduces Token Spending

The core idea: offload computation, filtering, and state management to **local processes** so Claude only sees the small, relevant results — not the raw data.

### 1. Sandbox Execution — Process Data Locally, Not Through Claude

The biggest token saver. Instead of sending a 100KB API response through Claude and asking it to "extract the names", you run TypeScript locally in an isolated Bun subprocess:

```typescript
// This runs LOCALLY — Claude never sees the raw 100KB
sandbox_execute {
  code: `
    const data = await skill('call_api', { url: 'https://api.example.com/users', method: 'GET' });
    const parsed = JSON.parse(data);
    return parsed.map(u => u.name).join('\\n');  // Only ~500 bytes returned to Claude
  `
}
```

Data helpers like `pick()`, `first()`, `last()`, `sum()`, `count()` reduce datasets before they ever touch Claude's context. A 1000-row result becomes 10 rows or a single number.

### 2. FTS5 Auto-Indexing — Search Large Results Instead of Reading Them

When a sandbox variable exceeds **4KB**, it's automatically indexed into SQLite FTS5. Instead of dumping the full dataset back into Claude's context, you search it:

```typescript
// First call: fetch and store (Claude sees "stored", not the data)
$vars.logs = await skill('run_shell', { command: 'cat /var/log/app.log' });

// Later: search locally, only matching lines go to Claude
return search('logs', 'ERROR timeout');  // Returns max 50 matches
```

A 500KB log file becomes a search index. Claude only sees the 50 matching lines.

### 3. Persistent Memory — Stop Re-Explaining Your Project

Every agent shares dual-write memory (SQLite + Obsidian markdown). Project context, decisions, and accumulated knowledge survive across sessions:

- **`remember` / `recall`** — key-value store available on every agent
- **Project context preamble** — summary, goals, and tech stack auto-injected into every `delegate` call (~200-500 chars, set once)
- **Knowledge agent** — full Obsidian vault as persistent knowledge base with search

Instead of spending 2,000 tokens re-explaining your project architecture every session, `set_project_context` stores it once and it's injected automatically as a ~100-token preamble.

### 4. Bounded Session History — Context Doesn't Grow Forever

Session history is capped at **20 turns (40 messages)**. Older turns are permanently dropped, preventing the context window from filling up with stale conversation history on long-running tasks.

### 5. Lightweight Routing — Minimal Metadata in Context

When the orchestrator routes a task to a worker, it sends only **skill IDs** — not full JSON schemas. Agent discovery returns names and IDs (~100 bytes per agent), not kilobytes of input schemas. Full schemas are only fetched on-demand via `describe(skillId)`.

### 6. Input Truncation — Hard Caps on What Enters the Context

All user-provided content is truncated before being sent to Claude:
- User inputs: **10,000 chars** max
- Template content: **50,000 chars** max
- Claude API calls: capped at **1,024 output tokens** per skill invocation

This prevents a single oversized input from consuming the entire context budget.

### 7. Multi-Agent Architecture — Separate Context Per Worker

Each worker agent runs as its own process with its own context. The shell agent doesn't carry the knowledge agent's conversation history. The AI agent doesn't see the design agent's prompts. Work is isolated — only the orchestrator's routing context is shared, and that's kept minimal.

---

## The Agents

7 specialist workers, each a separate process, coordinated by a single MCP orchestrator:

| Agent | Port | Skills |
|-------|------|--------|
| **Shell** | 8081 | `run_shell`, `read_file`, `write_file`, SSE streaming |
| **Web** | 8082 | `fetch_url`, `call_api` |
| **AI** | 8083 | `ask_claude`, `search_files`, `query_sqlite` |
| **Code** | 8084 | `codex_exec`, `codex_review` (OpenAI Codex CLI) |
| **Knowledge** | 8085 | `create_note`, `read_note`, `update_note`, `search_notes`, `list_notes` |
| **Design** | 8086 | `enhance_ui_prompt`, `suggest_screens`, `design_critique` (Gemini) |
| **Factory** | 8087 | `create_project`, `list_templates`, `list_pipelines`, `quality_gate` |

All agents share `remember` / `recall` skills backed by SQLite (`~/.a2a-memory.db`) + Obsidian (`~/Documents/Obsidian/a2a-knowledge/_memory/`).

Agents communicate via Google's [A2A protocol](https://github.com/google/A2A) — JSON-RPC 2.0 over HTTP. You can register external A2A agents too.

---

## Architecture

```
Claude Code
    │ MCP (stdio)
    ▼
Orchestrator — port 8080
    │ A2A (HTTP + JSON-RPC 2.0)
    ├── Shell Agent     8081  run_shell · read_file · write_file · SSE streaming
    ├── Web Agent       8082  fetch_url · call_api
    ├── AI Agent        8083  ask_claude · search_files · query_sqlite
    ├── Code Agent      8084  codex_exec · codex_review  (OpenAI Codex CLI)
    ├── Knowledge Agent 8085  create_note · read_note · update_note · search_notes · list_notes
    ├── Design Agent    8086  enhance_ui_prompt · suggest_screens · design_critique
    └── Factory Agent   8087  create_project · list_templates · list_pipelines · quality_gate
```

All agents share `remember` / `recall` backed by dual-write memory:
- **SQLite** `~/.a2a-memory.db` — FTS5 full-text search
- **Obsidian** `~/Documents/Obsidian/a2a-knowledge/_memory/` — persistent markdown

## Quick Start

```bash
git clone https://github.com/xrey167/a2a-mcp-server
cd a2a-mcp-server && bun install

# Register with Claude Code
claude mcp add --scope user a2a-mcp-bridge -- bun /path/to/a2a-mcp-server/src/server.ts
```

**Requirements:** [Bun](https://bun.sh) v1.x, [Claude Code](https://claude.ai/code), [Codex CLI](https://github.com/openai/codex) (`codex login`), [Obsidian](https://obsidian.md) vault at `~/Documents/Obsidian/a2a-knowledge`

---

## Skills Reference

All skills are exposed as MCP tools and callable via A2A (JSON-RPC 2.0 over HTTP).

### Orchestrator

| Skill | Description |
|-------|-------------|
| `delegate` | Route a task to the best worker. Params: `message` (required), `skillId`, `agentUrl`, `args`, `sessionId`. Routing: agentUrl → skillId lookup → AI auto-route. |
| `delegate_async` | Fire-and-forget `delegate`. Returns `{ taskId }`. Poll with `get_task_result`. |
| `get_task_result` | Poll async task status: `pending`, `completed`, `failed`, `canceled`, `not_found`. |
| `get_session_history` | Get conversation history for a `sessionId` (last 20 turns, 30-day expiry). |
| `clear_session` | Clear session history. |
| `list_agents` | List all worker agent cards and their skills. |
| `register_agent` | Register external A2A agent by URL. Discovers via `/.well-known/agent.json`. |
| `unregister_agent` | Remove an external agent by URL. |

### Memory (available on all agents)

| Skill | Description |
|-------|-------------|
| `remember` | Store `key`/`value` pair in persistent memory. |
| `recall` | Retrieve by `key`, or omit for all memories. |
| `memory_search` | FTS5 search across all agent memories. Params: `query`, `agent` (optional). |
| `memory_list` | List keys for an `agent`, optionally filtered by `prefix`. |
| `memory_cleanup` | Delete memories older than `maxAgeDays`. |

### Shell Agent (8081)

| Skill | Description |
|-------|-------------|
| `run_shell` | Execute a shell `command` (15s timeout). Returns stdout or `"Exit N: stderr"`. |
| `run_shell_stream` | Execute with real-time SSE streaming. Params: `command`, `timeoutMs` (default 120s). |
| `read_file` | Read file at `path`. |
| `write_file` | Write `content` to `path`. |

### Web Agent (8082)

| Skill | Description |
|-------|-------------|
| `fetch_url` | Fetch `url` content. `format`: `"text"` (default) or `"json"`. |
| `call_api` | HTTP request with `url`, `method`, `headers`, `body`. |

### AI Agent (8083)

| Skill | Description |
|-------|-------------|
| `ask_claude` | Send `prompt` to Claude. Optional `model` (default: `claude-sonnet-4-6`). |
| `search_files` | Glob `pattern` search. Optional `directory`. |
| `query_sqlite` | Read-only SQL against a `database` file. SELECT only. |

### Code Agent (8084)

| Skill | Description |
|-------|-------------|
| `codex_exec` | Execute coding task via Codex CLI (full-auto, 120s timeout). |
| `codex_review` | Review working directory via Codex CLI. |

### Knowledge Agent (8085)

Notes stored in Obsidian vault (override with `OBSIDIAN_VAULT` env).

| Skill | Description |
|-------|-------------|
| `create_note` | Create note with `title`, `content`, optional `tags` (YAML frontmatter). |
| `read_note` | Read note by `title`. |
| `update_note` | Replace `content` of existing note by `title`. |
| `search_notes` | Case-insensitive search by `query` across all notes. |
| `list_notes` | List all notes, optionally in a `folder`. |

### Design Agent (8086)

| Skill | Description |
|-------|-------------|
| `design_workflow` | End-to-end UI pipeline: `appConcept`, `deviceType`, `screensOnly`, `modelId`. Returns async task. |
| `design_critique` | Critique a UI `description`, return actionable improvements. |

### Factory Agent (8087)

Generates complete projects from a vague idea via a 5-phase pipeline: template matching → intent normalization → scaffold → code generation → quality gate ("Ralph Mode", 97% threshold).

| Pipeline | Stack | Variants |
|----------|-------|----------|
| `app` | Expo SDK 52 + React Native | `saas-starter`, `e-commerce`, `social-app` |
| `website` | Next.js 15 + Tailwind v4 | `portfolio`, `saas-landing` |
| `mcp-server` | MCP SDK 1.12 + Bun | `data-connector`, `dev-tools` |
| `agent` | Anthropic SDK 0.78 + Fastify | `api-integration`, `content-generator` |
| `api` | Fastify 5 + SQLite | `crud-service`, `marketplace` |

| Skill | Description |
|-------|-------------|
| `create_project` | Generate project from `idea` + `outputDir`. Optional `variant`. |
| `list_templates` | List pipelines and their template variants. |
| `list_pipelines` | List pipeline types with intent prompts and quality config. |

Templates in `src/templates/<pipeline>/` with `TEMPLATE.md` specs and `{{variable}}` placeholders. Variants in `src/templates/variants/`.

### External MCP Integration

| Skill | Description |
|-------|-------------|
| `list_mcp_servers` | List external MCP servers from `~/.claude.json`. |
| `use_mcp_tool` | Call `toolName` on any external MCP server (lazy-connect, auto-refresh OAuth). |

### Project Context

| Skill | Description |
|-------|-------------|
| `get_project_context` | Return current context (summary, goals, stack, notes). |
| `set_project_context` | Update `summary`, `goals`, `stack`, `notes`. Auto-injected into every `delegate`. |

### Sandbox

| Skill | Description |
|-------|-------------|
| `sandbox_execute` | Run TypeScript `code` in isolated Bun subprocess. Access `skill()`, `$vars`, `search()`, `batch()`. Variables persist per `sessionId` in SQLite. Large results auto-indexed for FTS5. |
| `sandbox_vars` | List/get/delete persisted sandbox variables for a `sessionId`. |

### Direct A2A Bridge

| Skill | Description |
|-------|-------------|
| `call_a2a_agent` | Send task directly to any A2A agent by `agent_url`, bypassing routing. |

### Plugins (Hot-Reloaded)

Drop skills into `src/plugins/<name>/index.ts` — auto-loaded within seconds, no restart.

| Skill | Description |
|-------|-------------|
| `get_timestamp` | Current time as ISO 8601 + Unix epoch. |
| `sync_secrets` | Encrypted credential sync (`push`/`pull`/`status`/`configure`) via AES-256-GCM. |
| `oauth_setup` | Browser-based OAuth2 flow (`start`/`refresh`/`list`/`revoke`). Presets: google, github, linear. |

---

## MCP Resources & Prompts

**Resources** (read-only):

| URI | Description |
|-----|-------------|
| `a2a://context` | Project context |
| `a2a://health` | Worker agent health status |
| `a2a://tasks` | Active and recent tasks |
| `a2a://workers/{name}/card` | Agent card for a specific worker |

**Prompts:** `persona-{name}` (system prompt for any agent), `delegate-task` (with auto-injected context).

---

## A2A Protocol

Each agent exposes: `GET /.well-known/agent.json` (agent card), `GET /healthz` (health), `POST /` (tasks/send JSON-RPC 2.0).

```bash
# Discover
curl http://localhost:8080/.well-known/agent.json

# Call skill directly
curl -X POST http://localhost:8081 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tasks/send","id":"1","params":{"id":"t1","skillId":"run_shell","args":{"command":"uname -m"},"message":{"role":"user","parts":[{"text":""}]}}}'
```

SSE streaming: `POST http://localhost:8081/stream` → events `stdout`/`stderr`/`done`.

---

## Configuration

### Personas

Loaded from `src/personas/<agent-name>.md`, hot-reloaded on change. YAML frontmatter sets `model` and `temperature`.

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Claude SDK auth | Claude Code OAuth fallback |
| `GOOGLE_API_KEY` / `GEMINI_API_KEY` | Gemini SDK auth | `gemini` CLI OAuth fallback |
| `A2A_API_KEY` | Bearer token for remote access | Open mode |
| `OBSIDIAN_VAULT` | Obsidian vault path | `~/Documents/Obsidian/a2a-knowledge` |
| `SYNC_SERVER_URL` | Credential sync server | `http://localhost:8080` |
| `SYNC_PASSPHRASE` | Sync encryption passphrase | (none) |

### Auth

| Service | Method |
|---------|--------|
| Claude | `ANTHROPIC_API_KEY` or Claude Code OAuth |
| Gemini | `GOOGLE_API_KEY` or `gemini` CLI OAuth |
| Codex | ChatGPT OAuth via `codex login` (`~/.codex/auth.json`) |
| External MCPs | Bearer, header, or OAuth2 in `~/.a2a-mcp-auth.json` |

### Security

Set `A2A_API_KEY` env before starting for remote access. Loopback (127.0.0.1/::1) is always trusted. Use `sync_secrets` to distribute credentials across machines.

---

## Extending

**Add a worker:** Create `src/workers/<name>.ts` (Fastify + `AGENT_CARD`), add to `WORKERS` in `src/server.ts`. All output to stderr.

**Add a plugin:** Export `skills: Skill[]` from `src/plugins/<name>/index.ts`. Hot-reloaded automatically.

**Register external agent:** `register_agent { url: "http://host:port" }`. Discovered via `/.well-known/agent.json`.
