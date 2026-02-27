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

#### Orchestrator

| Tool | Description |
|---|---|
| `delegate` | Route a task to the best worker — by `agentUrl`, `skillId`, or AI auto-pick. Project context prepended automatically. |
| `list_agents` | Return all worker agent cards and their skills |
| `list_mcp_servers` | List all external MCP servers from `~/.claude.json` and their tool counts |
| `use_mcp_tool` | Call a tool on any external MCP server (lazy-connected on first use) |
| `get_project_context` | Return the current project context (summary, goals, stack, notes) |
| `set_project_context` | Set project context injected into every `delegate` call — persisted to Obsidian + cache |

#### System / Web / AI / Data

| Tool | Description |
|---|---|
| `run_shell` | Execute a shell command |
| `read_file` / `write_file` | Read or write a file |
| `fetch_url` | Fetch content from a URL |
| `call_api` | HTTP request with method, headers, JSON body |
| `ask_claude` | Send a prompt to Claude (OAuth or API key) |
| `search_files` | Glob file search |
| `query_sqlite` | Read-only SQL query against a `.db` file |
| `call_a2a_agent` | Send a task directly to any A2A agent URL |

#### Workers (also callable directly)

| Tool | Description |
|---|---|
| `codex_exec` | Execute a coding task via OpenAI Codex |
| `codex_review` | Code review via Codex CLI |
| `create_note` / `read_note` / `update_note` | Manage notes in the Obsidian vault |
| `search_notes` / `list_notes` | Search or list vault notes |
| `remember` / `recall` | Persistent key-value memory (SQLite + Obsidian dual-write) |

#### Plugins (hot-reloaded, no restart needed)

| Tool | Description |
|---|---|
| `get_timestamp` | Current time as ISO 8601 and Unix epoch |
| `sync_secrets` | Cross-platform credential sync — AES-256-GCM encrypted push/pull of Claude, Gemini, Codex OAuth tokens and MCP API keys via the a2a-server's own memory endpoint |
| `oauth_setup` | Browser OAuth2 flow for any provider (Google, GitHub, Linear). Opens browser, captures redirect, exchanges code for tokens, saves to `~/.a2a-mcp-auth.json`. Actions: start, refresh, list, revoke. |

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

## Personas

Each agent loads a persona from `src/personas/<agent-name>.md` on startup and hot-reloads on file change (no restart needed). Frontmatter controls `model` and `temperature`; the body is the system prompt.

```markdown
---
model: claude-sonnet-4-6
temperature: 0.3
---
You are the orchestrator of a local multi-agent system...
```

Persona files: `orchestrator`, `shell-agent`, `web-agent`, `ai-agent`, `code-agent`, `knowledge-agent`.

## Plugins

Drop a new skill into `src/plugins/<name>/index.ts` and export `skills: Skill[]` — it loads automatically within seconds.

```typescript
import type { Skill } from "../../skills.js";
export const skills: Skill[] = [{
  id: "my_skill",
  name: "My Skill",
  description: "Does something useful",
  run: async (args) => "result",
}];
```

Declarative (prompt-based) skills can also be defined in your Obsidian vault under `_plugins/<name>/plugin.md`.

## Auth

| Service | Method |
|---|---|
| Claude API | `ANTHROPIC_API_KEY` env, or automatic OAuth via Claude Code |
| OpenAI / Codex | ChatGPT OAuth via `codex login` — stored in `~/.codex/auth.json` |
| External MCPs | API keys, bearer tokens, or OAuth2 configured in `~/.a2a-mcp-auth.json` |

### External MCP Auth (`~/.a2a-mcp-auth.json`)

```json
{
  "my-mcp-server": { "type": "bearer", "token": "tok_..." },
  "other-server": { "type": "header", "headers": { "X-API-Key": "..." } },
  "oauth-server": {
    "type": "oauth2",
    "accessToken": "...", "refreshToken": "...",
    "clientId": "...", "clientSecret": "...",
    "tokenUrl": "https://...", "expiresAt": 1234567890
  }
}
```

### OAuth Setup (`oauth_setup`)

Authenticate to any OAuth2 MCP server without leaving Claude:

```bash
# Google OAuth for Stitch (requires Google Cloud OAuth2 client)
oauth_setup { action: "start", provider: "google", serverName: "stitch",
              clientId: "YOUR_CLIENT_ID.apps.googleusercontent.com",
              clientSecret: "YOUR_CLIENT_SECRET" }

# Refresh an expired token automatically
oauth_setup { action: "refresh", serverName: "stitch" }

# List all stored credentials
oauth_setup { action: "list" }
```

Flow: opens browser → user authenticates → redirect captured at `http://localhost:9876/callback` → tokens saved to `~/.a2a-mcp-auth.json`. The `mcp-auth.ts` layer auto-refreshes expired tokens on every `use_mcp_tool` call.

For Google/Stitch you need a Google Cloud project with the Cloud Platform API enabled and an OAuth2 web client with `http://localhost:9876/callback` as an authorized redirect URI.

### Credential Sync (`sync_secrets`)

Sync OAuth tokens and API keys across machines using the a2a-server's own memory as an encrypted central store:

```bash
# Configure once per machine
sync_secrets { action: "configure", serverUrl: "http://your-server:8080", passphrase: "secret" }

# Push from primary machine
sync_secrets { action: "push" }

# Pull on every new machine
sync_secrets { action: "pull" }

# Check sync state
sync_secrets { action: "status" }
```

Services synced: `~/.claude/credentials.json`, `~/.gemini/oauth_creds.json`, `~/.codex/auth.json`, `~/.a2a-mcp-auth.json`. All encrypted with AES-256-GCM before storage.

## Remote Deployment & Security

The A2A HTTP server binds to `0.0.0.0:8080`. To expose it safely over Tailscale, a VPS, or ngrok:

```bash
# Set a secret before starting the server
export A2A_API_KEY="your-secret-key"
bun src/server.ts
```

- **Loopback (127.0.0.1 / ::1)** is always trusted — local plugins, workers, and `sync_secrets` continue to work without any header.
- **All other callers** must send `Authorization: Bearer <A2A_API_KEY>`.
- If `A2A_API_KEY` is not set, the server runs in open mode (same as before — fine for local-only use).

Combine with `sync_secrets` to push the key to other machines:

```bash
# On primary machine:
sync_secrets { action: "configure", passphrase: "encryption-secret" }
sync_secrets { action: "push" }

# On new machine (after setting SYNC_SERVER_URL):
sync_secrets { action: "pull" }
# ~/.a2a-mcp-auth.json now has credentials; set A2A_API_KEY from it
```

## Adding a Worker

1. Create `src/workers/<name>.ts` — Fastify on a new port with an `AGENT_CARD` and skill handlers
2. Add to `WORKERS` array in `src/server.ts`
3. All output must go to `process.stderr` — stdout is reserved for MCP JSON-RPC
