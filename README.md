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
    ├── Knowledge Agent 8085  create_note · read_note · update_note · search_notes · list_notes
    └── Design Agent    8086  design_workflow · enhance_ui_prompt · suggest_screens
```

Every agent shares `remember` / `recall` skills backed by dual-write memory:
- **SQLite** `~/.a2a-memory.db` — fast hot cache with FTS5 full-text search
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

---

## Function Reference

All functions below are exposed as MCP tools to Claude Code. They can also be called directly via the A2A protocol (JSON-RPC 2.0 over HTTP).

### Orchestrator — Delegation & Routing

#### `delegate`

Route a task to the best worker agent. The orchestrator automatically prepends project context and session history to every message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | Task message to send to the worker |
| `skillId` | string | No | Skill ID to route to (e.g. `run_shell`, `ask_claude`) |
| `agentUrl` | string | No | Direct URL of the target agent (bypasses routing) |
| `args` | object | No | Arguments for the target skill |
| `sessionId` | string | No | Session ID for multi-turn conversation continuity |

**Routing priority:**
1. If `agentUrl` is provided, send directly to that agent
2. If `skillId` is provided, look up which worker owns that skill
3. If neither, ask the AI agent to pick the best worker automatically

```bash
# Route by skill ID
delegate { message: "list all TypeScript files", skillId: "search_files", args: { pattern: "**/*.ts" } }

# Route by agent URL
delegate { message: "run uname", agentUrl: "http://localhost:8081", skillId: "run_shell", args: { command: "uname -m" } }

# Auto-route (AI picks the best worker)
delegate { message: "find all TODO comments in the codebase" }

# With session continuity
delegate { message: "now refactor that function", sessionId: "my-session-123" }
```

**Returns:** The text result from the worker agent.

---

#### `delegate_async`

Fire-and-forget version of `delegate`. Returns a task ID immediately; poll with `get_task_result`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | Task message |
| `skillId` | string | No | Skill ID to route to |
| `agentUrl` | string | No | Direct URL of the target agent |
| `args` | object | No | Arguments for the target skill |
| `sessionId` | string | No | Session ID for conversation continuity |

```bash
# Start a long-running task
delegate_async { message: "run the full test suite", skillId: "run_shell", args: { command: "bun test" } }
# Returns: { "taskId": "abc-123" }

# Poll for result
get_task_result { taskId: "abc-123" }
# Returns: { "status": "pending", "state": "working" }  — or —
# Returns: { "status": "completed", "result": "..." }
```

**Returns:** `{ taskId: string }`

---

#### `get_task_result`

Poll the result of a task started with `delegate_async`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | Task ID returned by `delegate_async` |

**Returns:** One of:
- `{ status: "pending", state: "submitted" | "working" }` — still running
- `{ status: "completed", result: "..." }` — finished successfully
- `{ status: "failed", error: { code, message } }` — error occurred
- `{ status: "canceled" }` — task was canceled
- `{ status: "not_found" }` — unknown task ID

---

### Session Management

#### `get_session_history`

Retrieve the conversation history for a session. Sessions store the last 20 turns (40 messages) and auto-expire after 30 days.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | Yes | Session ID |

**Returns:** JSON array of `{ role: "user" | "assistant", text: string, ts: number, skillId?: string }`.

---

#### `clear_session`

Clear the conversation history for a session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | Yes | Session ID to clear |

**Returns:** Confirmation message.

---

### Agent Management

#### `list_agents`

Return all worker agent cards (built-in + externally registered) and their skills. Takes no parameters.

```bash
list_agents
# Returns JSON array of agent cards with: name, url, description, skills[], source ("builtin" | "external")
```

---

#### `register_agent`

Register an external A2A agent by URL. Discovers its agent card via `GET /.well-known/agent.json` and persists it to `~/.a2a-agent-registry.json`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Base URL of the agent (e.g. `http://host:8080`) |
| `apiKey` | string | No | Bearer token to include when routing tasks to this agent |

```bash
register_agent { url: "http://my-server:9090", apiKey: "secret-token" }
```

**Returns:** The discovered agent card as JSON.

---

#### `unregister_agent`

Remove an external agent from the registry.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Base URL of the agent to remove |

**Returns:** Confirmation or "not found".

---

### Memory

All agents share a dual-write memory system: SQLite for fast access + Obsidian markdown for persistence.

#### `remember`

Store a key-value pair in persistent memory. Available on every worker agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Memory key |
| `value` | string | Yes | Value to store |

```bash
delegate { skillId: "remember", args: { key: "project-name", value: "a2a-mcp-server" } }
```

**Returns:** Confirmation message.

---

#### `recall`

Retrieve a value from persistent memory. If no key is provided, returns all memories for the agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | No | Memory key to retrieve (omit for all memories) |

```bash
delegate { skillId: "recall", args: { key: "project-name" } }
# Returns: "a2a-mcp-server"

delegate { skillId: "recall" }
# Returns: JSON of all stored memories
```

---

#### `memory_search`

Full-text search across all agent memories using FTS5.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (FTS5 syntax supported) |
| `agent` | string | No | Filter results to a specific agent |

```bash
memory_search { query: "typescript config" }
memory_search { query: "deploy", agent: "shell-agent" }
```

**Returns:** JSON array of `{ agent, key, value, rank }` sorted by relevance.

---

#### `memory_list`

List all memory keys for an agent, optionally filtered by prefix.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | Yes | Agent name (e.g. `shell-agent`, `ai-agent`) |
| `prefix` | string | No | Key prefix filter |

```bash
memory_list { agent: "shell-agent" }
memory_list { agent: "knowledge-agent", prefix: "project-" }
```

**Returns:** JSON array of key strings.

---

#### `memory_cleanup`

Delete memories older than a given number of days. Removes from both SQLite and Obsidian.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `maxAgeDays` | number | Yes | Delete memories older than this many days |

```bash
memory_cleanup { maxAgeDays: 90 }
```

**Returns:** `"Deleted N memories older than X days"`

---

### Shell Agent (Port 8081)

#### `run_shell`

Execute a shell command and return its output. Timeout: 15 seconds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |

```bash
delegate { skillId: "run_shell", args: { command: "ls -la" } }
delegate { skillId: "run_shell", args: { command: "git status" } }
```

**Returns:** stdout on success, or `"Exit N: stderr"` on failure.

---

#### `run_shell_stream`

Execute a shell command with real-time stdout/stderr streamed as MCP progress notifications. Returns complete output when done.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to run |
| `timeoutMs` | number | No | Timeout in milliseconds (default: 120000) |

```bash
run_shell_stream { command: "npm test", timeoutMs: 300000 }
```

**Returns:** Complete accumulated stdout+stderr output.

---

#### `read_file`

Read the contents of a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Absolute or relative file path |

```bash
delegate { skillId: "read_file", args: { path: "/etc/hosts" } }
```

**Returns:** File content as UTF-8 string, or `"File not found: ..."`.

---

#### `write_file`

Write content to a file. Creates the file if it doesn't exist, overwrites if it does.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path to write to |
| `content` | string | Yes | Content to write |

```bash
delegate { skillId: "write_file", args: { path: "output.txt", content: "Hello world" } }
```

**Returns:** `"Written N bytes to path"`

---

### Web Agent (Port 8082)

#### `fetch_url`

Fetch content from a URL. Supports plain text and JSON response formats.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to fetch |
| `format` | string | No | `"text"` (default) or `"json"` for pretty-printed JSON |

```bash
delegate { skillId: "fetch_url", args: { url: "https://api.github.com/zen" } }
delegate { skillId: "fetch_url", args: { url: "https://api.example.com/data", format: "json" } }
```

**Returns:** Response body as text or formatted JSON, or `"HTTP N: status"` on error.

---

#### `call_api`

Make an HTTP request to an external API with full control over method, headers, and body.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | API endpoint URL |
| `method` | string | Yes | HTTP method: `GET`, `POST`, `PUT`, `DELETE` |
| `headers` | object | No | Request headers (merged with default `Content-Type: application/json`) |
| `body` | object | No | JSON request body (automatically serialized) |

```bash
delegate { skillId: "call_api", args: {
  url: "https://api.example.com/items",
  method: "POST",
  headers: { "Authorization": "Bearer token123" },
  body: { name: "New Item", status: "active" }
} }
```

**Returns:** `"HTTP {status}\n{response body}"`

---

### AI Agent (Port 8083)

#### `ask_claude`

Send a prompt to Claude and return the response. Tries the Anthropic SDK first (using `ANTHROPIC_API_KEY`), falls back to the `claude` CLI subprocess with OAuth.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | The prompt to send to Claude |
| `model` | string | No | Model ID (default: `claude-sonnet-4-6`, or from persona config) |

```bash
delegate { skillId: "ask_claude", args: { prompt: "Explain the builder pattern in TypeScript" } }
delegate { skillId: "ask_claude", args: { prompt: "Review this code", model: "claude-opus-4-6" } }
```

**Returns:** Claude's response text.

---

#### `search_files`

Find files matching a glob pattern using Bun's native Glob API.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Glob pattern (e.g. `src/**/*.ts`, `*.json`) |
| `directory` | string | No | Base directory to search from (default: `.`) |

```bash
delegate { skillId: "search_files", args: { pattern: "**/*.test.ts" } }
delegate { skillId: "search_files", args: { pattern: "*.md", directory: "docs" } }
```

**Returns:** Matching file paths (one per line), or `"No files found"`.

---

#### `query_sqlite`

Run a read-only SQL query against any SQLite database file. Only `SELECT` statements are permitted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `database` | string | Yes | Path to the `.db` file |
| `sql` | string | Yes | SQL `SELECT` query to execute |

```bash
delegate { skillId: "query_sqlite", args: {
  database: "~/.a2a-memory.db",
  sql: "SELECT agent, key, value FROM memory WHERE agent = 'shell-agent' LIMIT 10"
} }
```

**Returns:** JSON array of row objects, or `"Only SELECT queries are allowed"`.

---

### Code Agent (Port 8084)

#### `codex_exec`

Execute a coding task via OpenAI's Codex CLI in full-auto mode. Has full disk read and network access. Timeout: 120 seconds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Coding task description |

```bash
delegate { skillId: "codex_exec", args: { prompt: "Add error handling to the fetchData function in src/api.ts" } }
```

**Returns:** Codex output text, or error message.

---

#### `codex_review`

Review the current codebase via Codex CLI with full disk read access. Takes no special parameters (reviews the working directory). Timeout: 120 seconds.

```bash
delegate { skillId: "codex_review" }
```

**Returns:** Code review output.

---

### Knowledge Agent (Port 8085)

All note operations target the Obsidian vault at `~/Documents/Obsidian/a2a-knowledge` (override with `OBSIDIAN_VAULT` env var). Paths are validated to prevent directory traversal.

#### `create_note`

Create a new Obsidian note with optional YAML frontmatter tags.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Note title (becomes the filename: `{title}.md`) |
| `content` | string | Yes | Markdown content of the note |
| `tags` | string[] | No | Tags added as YAML frontmatter |

```bash
delegate { skillId: "create_note", args: {
  title: "Architecture Decision: Auth Flow",
  content: "We chose OAuth2 with PKCE for the mobile app...",
  tags: ["architecture", "auth"]
} }
```

**Returns:** `"Created note: {title}"`

---

#### `read_note`

Read an Obsidian note by title.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Note title (without `.md` extension) |

```bash
delegate { skillId: "read_note", args: { title: "Architecture Decision: Auth Flow" } }
```

**Returns:** Full markdown content of the note, or `"Note not found: {title}"`.

---

#### `update_note`

Replace the content of an existing Obsidian note. The note must already exist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Note title |
| `content` | string | Yes | New markdown content (full replacement) |

```bash
delegate { skillId: "update_note", args: {
  title: "Architecture Decision: Auth Flow",
  content: "# Updated Decision\n\nWe switched to JWT..."
} }
```

**Returns:** `"Updated note: {title}"`, or `"Note not found: {title}"`.

---

#### `search_notes`

Search notes by content (case-insensitive substring match across all `.md` files in the vault).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search text |

```bash
delegate { skillId: "search_notes", args: { query: "OAuth" } }
```

**Returns:** Matching filenames (one per line), or `"No matching notes found"`.

---

#### `list_notes`

List all notes in the vault or a subfolder.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | No | Subfolder to list (default: entire vault) |

```bash
delegate { skillId: "list_notes" }
delegate { skillId: "list_notes", args: { folder: "_memory" } }
```

**Returns:** All `.md` filenames (one per line), or `"No notes found"`.

---

### External MCP Integration

#### `list_mcp_servers`

List all external MCP servers registered in `~/.claude.json` and their tool counts. Takes no parameters.

```bash
list_mcp_servers
# Returns: { servers: [...], tools: [...] }
```

---

#### `use_mcp_tool`

Call a tool on any external MCP server. The server is lazy-connected on first use. OAuth tokens are auto-refreshed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `toolName` | string | Yes | Name of the MCP tool to call |
| `args` | object | No | Arguments to pass to the tool |

```bash
use_mcp_tool { toolName: "create_project", args: { title: "My Design" } }
```

**Returns:** Tool result text.

---

### Project Context

#### `get_project_context`

Return the current project context. Takes no parameters. Context is stored in `~/.a2a-project-context.json` (cache) and `~/Documents/Obsidian/a2a-knowledge/_context/project.md` (persistent).

**Returns:** JSON object:
```json
{
  "summary": "A multi-agent MCP bridge for Claude Code",
  "goals": ["Ship v3.0", "Add streaming support"],
  "stack": ["TypeScript", "Bun", "MCP", "Fastify"],
  "notes": "Using A2A protocol for inter-agent communication",
  "updatedAt": "2026-02-28T10:00:00.000Z"
}
```

---

#### `set_project_context`

Set or update the project context. This context is automatically injected into every `delegate` call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `summary` | string | No | 1-3 sentence project summary |
| `goals` | string[] | No | Current sprint goals |
| `stack` | string[] | No | Tech stack tags |
| `notes` | string | No | Freeform context notes |

```bash
set_project_context {
  summary: "Building a multi-agent orchestration platform",
  goals: ["Add WebSocket support", "Write integration tests"],
  stack: ["TypeScript", "Bun", "MCP"],
  notes: "Workers auto-respawn on crash with exponential backoff"
}
```

**Returns:** The updated context object.

---

### Design Workflow

#### `design_workflow`

End-to-end UI design pipeline: Gemini suggests screens, creates a Stitch project, and generates each screen. Requires the Stitch MCP server to be configured.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `appConcept` | string | Yes | App or feature concept (e.g. "a meditation timer for iOS") |
| `title` | string | No | Stitch project title (defaults to `appConcept`) |
| `deviceType` | string | No | `MOBILE` (default), `DESKTOP`, `TABLET`, or `AGNOSTIC` |
| `screensOnly` | boolean | No | Generate a single enhanced screen instead of a full multi-screen flow (default: `false`) |
| `modelId` | string | No | `GEMINI_3_FLASH` (default) or `GEMINI_3_PRO` |

```bash
design_workflow { appConcept: "a meditation timer for iOS", deviceType: "MOBILE" }
design_workflow { appConcept: "dashboard settings page", screensOnly: true, deviceType: "DESKTOP" }
```

**Returns:** Project ID and per-screen generation results.

---

### Direct A2A Bridge

#### `call_a2a_agent`

Send a task directly to any A2A agent by URL, bypassing the orchestrator's routing logic.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_url` | string | Yes | Target A2A agent URL |
| `message` | string | Yes | Message to send |
| `skill_id` | string | No | Skill ID to invoke |
| `args` | object | No | Arguments for the remote skill |

```bash
call_a2a_agent {
  agent_url: "http://localhost:8081",
  message: "check disk space",
  skill_id: "run_shell",
  args: { command: "df -h" }
}
```

**Returns:** Result text from the remote agent.

---

### Plugins (Hot-Reloaded)

Plugins are loaded from `src/plugins/<name>/index.ts` and hot-reloaded on file change. No server restart needed.

#### `get_timestamp`

Return the current time as ISO 8601 and Unix epoch. Takes no parameters.

```bash
get_timestamp
# Returns: { "iso": "2026-02-28T17:30:00.000Z", "epoch": 1772236200 }
```

---

#### `sync_secrets`

Cross-platform credential sync. Encrypts OAuth tokens and API keys with AES-256-GCM before storing them on the a2a-server's own memory endpoint.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `push`, `pull`, `status`, or `configure` |
| `passphrase` | string | No | Encryption passphrase (required for push/pull, or set `SYNC_PASSPHRASE` env) |
| `serverUrl` | string | No | a2a-server URL (default: `http://localhost:8080`, or set `SYNC_SERVER_URL` env) |

**Actions:**
- **`configure`** — Save `serverUrl` and `passphrase` to `~/.a2a-sync.json`
- **`push`** — Encrypt local credentials and upload to the server
- **`pull`** — Download and decrypt credentials to local files
- **`status`** — Show local and remote credential state

**Services synced:** `~/.claude/credentials.json`, `~/.gemini/oauth_creds.json`, `~/.codex/auth.json`, `~/.a2a-mcp-auth.json`

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

---

#### `oauth_setup`

Browser-based OAuth2 flow for any provider. Opens the system browser, captures the authorization code redirect, exchanges it for tokens, and saves them to `~/.a2a-mcp-auth.json`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `start`, `refresh`, `list`, or `revoke` |
| `provider` | string | No | Built-in preset: `google`, `github`, or `linear` (default: `google`) |
| `serverName` | string | Varies | Key in `~/.a2a-mcp-auth.json` (required for start/refresh/revoke) |
| `clientId` | string | Varies | OAuth2 client ID (required for start) |
| `clientSecret` | string | No | OAuth2 client secret (optional for PKCE flows) |
| `scopes` | string[] | No | Additional scopes (merged with provider defaults) |

**Actions:**
- **`start`** — Open browser for OAuth flow (requires `serverName`, `clientId`)
- **`refresh`** — Use stored refresh token to get a new access token
- **`list`** — Show all stored OAuth entries
- **`revoke`** — Remove an entry from the auth file

```bash
# Google OAuth for Stitch
oauth_setup { action: "start", provider: "google", serverName: "stitch",
              clientId: "YOUR_CLIENT_ID.apps.googleusercontent.com",
              clientSecret: "YOUR_CLIENT_SECRET" }

# Refresh an expired token
oauth_setup { action: "refresh", serverName: "stitch" }

# List all stored credentials
oauth_setup { action: "list" }

# Remove a credential
oauth_setup { action: "revoke", serverName: "stitch" }
```

**Flow:** Opens browser → user authenticates → redirect captured at `http://localhost:9876/callback` → tokens saved. The `mcp-auth.ts` layer auto-refreshes expired tokens on every `use_mcp_tool` call.

---

## MCP Resources

The orchestrator exposes read-only resources that MCP clients can query for system state:

| URI | Description |
|-----|-------------|
| `a2a://context` | Current project context (summary, goals, stack, notes) |
| `a2a://health` | Health status of all worker agents (healthy, failCount, uptime) |
| `a2a://tasks` | List of all active and recent tasks |
| `a2a://workers/{name}/card` | Agent card for a specific worker |

---

## MCP Prompts

Pre-built prompt templates available to MCP clients:

| Prompt | Description | Arguments |
|--------|-------------|-----------|
| `persona-{name}` | System prompt for any agent persona | (none) |
| `delegate-task` | Delegate with project context auto-injected | `message` (required), `skillId` (optional) |

Available persona names: `orchestrator`, `shell-agent`, `web-agent`, `ai-agent`, `code-agent`, `knowledge-agent`.

---

## A2A Protocol

Each agent exposes:
- `GET /.well-known/agent.json` — agent card with skill list
- `GET /healthz` — health check (status, uptime, skill IDs)
- `POST /` — `tasks/send` JSON-RPC 2.0 request

### Request Format

```json
{
  "jsonrpc": "2.0",
  "method": "tasks/send",
  "id": "unique-id",
  "params": {
    "id": "task-id",
    "skillId": "run_shell",
    "args": { "command": "uname -m" },
    "message": { "role": "user", "parts": [{ "text": "" }] }
  }
}
```

### Response Format

```json
{
  "jsonrpc": "2.0",
  "id": "unique-id",
  "result": {
    "id": "task-id",
    "status": { "state": "completed" },
    "artifacts": [{ "parts": [{ "kind": "text", "text": "x86_64" }] }]
  }
}
```

### Examples

```bash
# Discover orchestrator
curl http://localhost:8080/.well-known/agent.json

# Call a skill directly on the shell agent
curl -X POST http://localhost:8081 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tasks/send","id":"1","params":{"id":"t1","skillId":"run_shell","args":{"command":"uname -m"},"message":{"role":"user","parts":[{"text":""}]}}}'
```

### SSE Streaming (Shell Agent)

The shell agent supports Server-Sent Events for real-time output streaming:

```bash
curl -X POST http://localhost:8081/stream \
  -H "Content-Type: application/json" \
  -d '{"params":{"skillId":"run_shell","args":{"command":"ping -c 3 1.1.1.1"}}}'
```

Events arrive as `data: {"type":"stdout"|"stderr","text":"..."}` followed by `data: {"type":"done","exitCode":0}`.

---

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

---

## Plugins

Drop a new skill into `src/plugins/<name>/index.ts` and export `skills: Skill[]` — it loads automatically within seconds.

```typescript
import type { Skill } from "../../skills.js";
export const skills: Skill[] = [{
  id: "my_skill",
  name: "My Skill",
  description: "Does something useful",
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Input value" },
    },
    required: ["input"],
  },
  run: async (args) => "result",
}];
```

Declarative (prompt-based) skills can also be defined in your Obsidian vault under `_plugins/<name>/plugin.md`.

---

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Claude SDK authentication | Falls back to Claude Code OAuth |
| `A2A_API_KEY` | Bearer token for remote A2A access | Open mode (no auth) |
| `OBSIDIAN_VAULT` | Override Obsidian vault path | `~/Documents/Obsidian/a2a-knowledge` |
| `SYNC_SERVER_URL` | Remote server for credential sync | `http://localhost:8080` |
| `SYNC_PASSPHRASE` | Encryption passphrase for credential sync | (none) |

---

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

---

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

---

## Adding a Worker

1. Create `src/workers/<name>.ts` — Fastify on a new port with an `AGENT_CARD` and skill handlers
2. Add to `WORKERS` array in `src/server.ts`
3. All output must go to `process.stderr` — stdout is reserved for MCP JSON-RPC
