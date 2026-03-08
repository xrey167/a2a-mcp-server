# a2a-mcp-server

**A multi-agent orchestration platform that bridges MCP and A2A protocols — giving Claude Code a team of specialist agents instead of a single monolithic tool.**

---

## The Problem

AI coding assistants like Claude Code are powerful, but they hit walls:

- **One tool, one brain.** Claude Code talks to one MCP server at a time. If you need shell access, web fetching, AI reasoning, code review, and knowledge management, you're either chaining tools manually or cramming everything into a single bloated server.
- **No agent collaboration.** There's no standard way for AI agents to talk to *each other*. You end up being the human router — copy-pasting outputs between tools, losing context at every hop.
- **No persistent memory.** Every session starts from zero. Project context, previous decisions, and accumulated knowledge vanish when the conversation ends.
- **Project scaffolding is tedious.** Going from "I want a habit tracker app" to a runnable project with proper structure, quality checks, and best practices still requires hours of boilerplate work.
- **Credential chaos across machines.** OAuth tokens, API keys, and auth configs are scattered across dotfiles. Setting up a new dev machine means re-authenticating everything from scratch.

## The Solution

This project spins up **7 specialist worker agents** — each running as its own process, each owning a focused set of skills — all coordinated by a single MCP orchestrator. Claude Code sees one `delegate` tool; behind it, the right agent picks up the task automatically.

- **Shell Agent** runs commands and streams output in real-time
- **Web Agent** fetches URLs and calls external APIs
- **AI Agent** queries Claude (or falls back to CLI OAuth) and searches files
- **Code Agent** runs OpenAI Codex for code generation and review
- **Knowledge Agent** manages an Obsidian vault as a persistent knowledge base
- **Design Agent** uses Gemini to critique UI designs and suggest screen flows
- **Factory Agent** generates complete, runnable projects from a vague idea — Expo apps, Next.js sites, MCP servers, AI agents, and REST APIs — with automated quality gates

Every agent shares **dual-write memory** (SQLite + Obsidian), so context persists across sessions. A **sandbox executor** lets you run TypeScript that calls any agent skill programmatically. And a **credential sync system** encrypts and transfers OAuth tokens between machines.

The agents communicate via Google's [A2A (Agent-to-Agent) protocol](https://github.com/google/A2A) — an open standard for inter-agent communication over HTTP + JSON-RPC 2.0. You can register external A2A agents too, extending the system without touching the core.

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
