# a2a-mcp-server

Multi-agent system that bridges **MCP** (Model Context Protocol) and **A2A** (Agent-to-Agent) protocols. Claude Code connects via MCP; agents talk to each other via A2A over HTTP.

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
    └── Knowledge Agent 8085  create_note · read_note · update_note · search_notes · list_notes
```

Every agent shares `remember` / `recall` skills backed by dual-write memory:
- **SQLite** `~/.a2a-memory.db` — fast hot cache
- **Obsidian** `~/Documents/Obsidian/a2a-knowledge/_memory/` — persistent markdown notes

## Requirements

- [Bun](https://bun.sh) v1.x
- [Claude Code](https://claude.ai/code) (for MCP registration + OAuth auth)
- [Codex CLI](https://github.com/openai/codex) — `codex login` with ChatGPT account
- [Obsidian](https://obsidian.md) — vault at `~/Documents/Obsidian/a2a-knowledge` (or set `OBSIDIAN_VAULT`)

## Setup

```bash
git clone https://github.com/xrey167/a2a-mcp-server
cd a2a-mcp-server
bun install

# Register with Claude Code
claude mcp add --scope user a2a-mcp-bridge -- bun /path/to/a2a-mcp-server/src/server.ts
```

## Usage

The server starts automatically when Claude Code launches. To run standalone:

```bash
bun src/server.ts
```

### MCP Tools

| Tool | Description |
|---|---|
| `delegate` | Route a task to the best worker — by `agentUrl`, `skillId`, or AI auto-pick |
| `list_agents` | Return all worker agent cards and their skills |
| `run_shell` | Execute a shell command |
| `fetch_url` | Fetch content from a URL |
| `ask_claude` | Send a prompt to Claude (OAuth or API key) |
| `codex_exec` | Execute a coding task via OpenAI Codex |
| `create_note` | Create a note in the Obsidian vault |
| `search_notes` | Full-text search across all vault notes |
| `remember` / `recall` | Persistent key-value memory |
| *(+ all worker skills directly)* | |

### A2A Protocol

Each agent exposes:
- `GET /.well-known/agent.json` — agent card with skill list
- `POST /` — `tasks/send` JSON-RPC 2.0 request

```bash
# Discover orchestrator
curl http://localhost:8080/.well-known/agent.json

# Call a skill directly
curl -X POST http://localhost:8081 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tasks/send","id":"1","params":{"id":"t1","skillId":"run_shell","args":{"command":"uname -m"},"message":{"role":"user","parts":[{"text":""}]}}}'
```

### SSE Streaming (Shell Agent)

```bash
curl -X POST http://localhost:8081/stream \
  -H "Content-Type: application/json" \
  -d '{"params":{"skillId":"run_shell","args":{"command":"ping -c 3 1.1.1.1"}}}'
```

## Auth

| Service | Method |
|---|---|
| Claude API | `ANTHROPIC_API_KEY` env, or automatic OAuth via Claude Code |
| OpenAI / Codex | ChatGPT OAuth via `codex login` — stored in `~/.codex/auth.json` |

## Adding a Worker

1. Create `src/workers/<name>.ts` — Fastify on a new port with an `AGENT_CARD` and skill handlers
2. Add to `WORKERS` array in `src/server.ts`
3. All output must go to `process.stderr` — stdout is reserved for MCP JSON-RPC
