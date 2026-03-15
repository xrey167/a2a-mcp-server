# a2a-mcp-server Onboarding & Runbook

Welcome to the **a2a-mcp-server** — a multi-protocol automation runtime for orchestrating AI agents, workflows, and distributed skills. This guide walks you through prerequisites, installation, configuration, and common operations.

---

## 1. Prerequisites

Before you start, ensure you have:

### Required
- **Bun ≥ 1.0** — The runtime for this entire project
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
  Verify installation:
  ```bash
  bun --version
  ```

- **Claude Code CLI** — For MCP integration with Claude
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
  Or visit https://claude.ai/code for installation instructions.

### Optional (feature-dependent)
- **ANTHROPIC_API_KEY** — Required for `ai` worker (ask_claude, search_files, etc.)
- **GOOGLE_API_KEY** — Required for `design` worker (Gemini-powered UI suggestions)
- **NASA_FIRMS_KEY** — Required for `climate` worker (wildfire detection)
- **Codex CLI** — Required for `code` worker; uses ChatGPT OAuth from `~/.codex/auth.json`
- **Obsidian vault** — Optional for knowledge base; syncs with `~/Documents/Obsidian/a2a-knowledge`

---

## 2. Installation (Step by Step)

### Clone the Repository
```bash
git clone https://github.com/xrey167/a2a-mcp-server
cd a2a-mcp-server
```

### Install Dependencies
```bash
bun install
```

This installs all dependencies using Bun's fast package manager. No `npm` or `yarn` — just Bun.

### Verify Installation
```bash
bun --version   # should print 1.x.x
```

---

## 3. First-Time Setup

### Step 1: Initialize Configuration
For beginners, start with the **lite** profile (3 workers: shell, web, ai):
```bash
bun src/cli.ts init --lite
```

For advanced users or full features:
```bash
bun src/cli.ts init --full
```

This creates `~/.a2a-mcp/config.json` with sensible defaults.

### Step 2: Set Environment Variables
Set the required API keys in your shell profile or `.zshrc`/`.bashrc`:
```bash
export ANTHROPIC_API_KEY="sk-..."      # required for ai worker
export GOOGLE_API_KEY="AIzaSy..."      # optional, for design worker (Gemini)
export NASA_FIRMS_KEY="..."            # optional, for climate worker wildfire data
```

These can also be set as environment variables at server launch time:
```bash
ANTHROPIC_API_KEY=sk-... bun src/server.ts
```

### Step 3: Register with Claude Code
Register the a2a-mcp-server as an MCP server in Claude Code:
```bash
claude mcp add --scope user a2a-mcp-bridge -- bun $(pwd)/src/server.ts
```

This stores the registration at the **user scope**, so it's available across all Claude Code sessions.

### Step 4: Verify Registration
```bash
claude mcp list
```

You should see `a2a-mcp-bridge` in the list with status "Connected" (or "Pending" if the server hasn't started yet).

---

## 4. Starting the Server

### Full Stack (All Enabled Workers)
```bash
bun src/server.ts
```

This:
1. Reads config from `~/.a2a-mcp/config.json`
2. Spawns local worker processes (filtered by profile and enabled workers)
3. Discovers agent cards via `GET /.well-known/agent.json` (exponential backoff, up to 5 attempts per worker)
4. Builds a unified skill map
5. Starts health polling for circuit breaker tracking
6. Listens on `http://localhost:8080` for MCP and HTTP traffic

### Single Worker (Isolated Testing)
To test a single worker in isolation:
```bash
bun src/workers/shell.ts
```

This starts only the shell worker on port 8081, useful for debugging.

### Development Mode with Hot Reload
```bash
bun --watch src/server.ts
```

Restarts the server automatically when you change files in `src/`.

### What Happens on Startup
1. **Config validation** — Zod schema checks `~/.a2a-mcp/config.json` for correctness
2. **User worker discovery** — Scans `~/.a2a-mcp/workers/` for custom worker directories
3. **SSRF allowlist setup** — Allowed ports computed from the final `WORKERS` array; remote worker URLs added automatically
4. **Worker spawning** — For each enabled local worker, spawns a Bun subprocess via `Bun.spawn()`
5. **Health readiness wait** — Polls each worker's `/healthz` every 500ms (up to 10s each)
6. **Agent discovery** — Fetches `/.well-known/agent.json` with linear backoff (500ms × attempt, 5 attempts max)
7. **Skill mapping** — Builds a `skillId → workerUrl` map from discovered agent cards
8. **Health polling** — Sets up background health checks every 30s for circuit breaker state
9. **Remote workers** — If `remoteWorkers` are configured, discovers and health-checks them too
10. **MCP server ready** — Starts listening for Claude Code requests via stdio

---

## 5. Testing Your Setup

### Test the delegate Tool
Run a simple shell command via Claude Code:
```bash
env -u CLAUDECODE claude -p \
  "Use the delegate tool to run 'echo hello from a2a'" \
  --allowedTools "mcp__a2a-mcp-bridge__delegate"
```

This invokes the `delegate` tool directly without starting Claude Code's full IDE.

### Test async delegation
```bash
env -u CLAUDECODE claude -p \
  "Use delegate_async to run 'echo hello', then poll get_task_result until done" \
  --allowedTools "mcp__a2a-mcp-bridge__delegate_async,mcp__a2a-mcp-bridge__get_task_result"
```

### Check Health Status
```bash
curl http://localhost:8080/healthz
```

Returns `{"status":"alive","timestamp":"2024-01-01T00:00:00.000Z"}` if the server is alive.

### Check Readiness
```bash
curl http://localhost:8080/readyz
```

Returns `{"status":"ready"}` if the server has reached a ready state.

### Type-check the codebase
```bash
bun build src/server.ts --target bun 2>&1 | tail -20
```

There is no `tsc` installed — use the Bun bundler for type checking.

---

## 6. Configuration Deep Dive

### Config Location
All configuration lives in:
```
~/.a2a-mcp/config.json
```

### Example Config
```json
{
  "profile": "lite",
  "server": {
    "port": 8080
  },
  "remoteWorkers": [
    {
      "name": "my-agent",
      "url": "https://my-agent.example.com",
      "apiKey": "optional-bearer-token"
    }
  ],
  "sandbox": {
    "timeout": 30000
  },
  "timeouts": {
    "shell": 15000,
    "fetch": 30000
  }
}
```

The `profile` field is the easiest way to control which workers are active. If `workers` is omitted, the profile determines enabled workers. If `workers` is explicitly set, it takes precedence over `profile`.

### Profiles

| Profile | Workers | Use Case |
|---------|---------|----------|
| **lite** | shell, web, ai | Beginners; local testing |
| **full** | all 14 built-in workers (shell through climate) | Power users; complete feature set |
| **data** | shell, web, ai, data | Data science workflows |
| **osint** | shell, web, ai, news, market, signal, monitor, infra, climate | Intelligence/threat analysis |

Note: `supply-chain` (port 8095) is not included in any profile preset. To enable it, set it explicitly in the `workers` array in config.

Set a profile:
```bash
bun src/cli.ts init --lite    # or --full, --data, --osint
```

### Disable a Specific Worker
To disable a single worker while keeping a profile, use the `workers` array directly (profile is ignored when `workers` is present):
```json
{
  "workers": [
    { "name": "shell", "path": "workers/shell.ts", "port": 8081, "enabled": true },
    { "name": "web",   "path": "workers/web.ts",   "port": 8082, "enabled": true },
    { "name": "ai",    "path": "workers/ai.ts",    "port": 8083, "enabled": true },
    { "name": "design","path": "workers/design.ts","port": 8086, "enabled": false }
  ]
}
```

### Change Server Port
```json
{
  "server": {
    "port": 9090
  }
}
```

Then restart the server and update MCP registration:
```bash
claude mcp add --scope user a2a-mcp-bridge -- bun $(pwd)/src/server.ts
```

### Add Remote Workers
If you have A2A agents running elsewhere, add them to `remoteWorkers`:
```json
{
  "remoteWorkers": [
    {
      "name": "remote-shell",
      "url": "https://worker1.example.com"
    },
    {
      "name": "remote-data",
      "url": "https://worker2.example.com"
    }
  ]
}
```

The orchestrator will discover them, health-check them, and route skills to them just like local workers.

### Environment Variable Overrides
These environment variables override values in `config.json`:

| Variable | Config field | Default |
|---|---|---|
| `A2A_PORT` | `server.port` | `8080` |
| `A2A_API_KEY` | `server.apiKey` | none (no auth) |
| `A2A_SANDBOX_TIMEOUT` | `sandbox.timeout` | `30000` |
| `A2A_MAX_RESPONSE_SIZE` | `truncation.maxResponseSize` | `25000` |
| `A2A_OUTPUT_FILTER_ENABLED` | `outputFilter.enabled` | `true` |
| `ANTHROPIC_API_KEY` | — | Claude API key for ai worker |
| `GOOGLE_API_KEY` | — | Gemini API key for design worker |
| `OBSIDIAN_VAULT` | — | Path to Obsidian vault (default: `~/Documents/Obsidian/a2a-knowledge`) |

For example:
```bash
A2A_PORT=9000 bun src/server.ts
```

Note: There is no `A2A_PROFILE` environment variable. Profile must be set in `config.json` or via `bun src/cli.ts init --<profile>`.

---

## 7. Common Tasks (Walkthroughs)

### Delegating a Skill via Claude Code

Open Claude Code and ask:
```
Use the delegate tool with skillId "run_shell" and args { command: "ls -la /home" }
```

This routes the skill to the shell worker and returns the output.

Or use a specific worker URL:
```
Use the delegate tool to fetch https://example.com/api/data with agentUrl http://localhost:8082
```

### Creating a Custom Worker

Scaffold a new user-space worker:
```bash
bun src/cli.ts create-worker my-tool --port 8100
```

This creates `~/.a2a-mcp/workers/my-tool/` containing:
- `index.ts` — Fastify server with agent card, `/healthz`, and A2A task handler
- `worker.json` — metadata: name, port, description

User-space workers are auto-discovered on server startup — no changes to `src/server.ts` needed. The worker must:
- Export an `AGENT_CARD` with `skills[]` at `GET /.well-known/agent.json`
- Serve a health check at `GET /healthz`
- Handle A2A tasks at `POST /a2a` (as generated by the CLI scaffolder)
- Send all logs to **stderr only** (stdout must be silent)

> **Note on task endpoints:** Built-in workers (in `src/workers/`) use `POST /` with JSON-RPC 2.0 `tasks/send`. User-space workers discovered from `~/.a2a-mcp/workers/` use `POST /a2a` — the path generated by `bun src/cli.ts create-worker`. Both endpoints are valid; the orchestrator routes based on what the worker's agent card advertises.

To add a **built-in** worker instead (checked into the repo):
1. Create `src/workers/<name>.ts`
2. Add `{ name: "<name>", path: join(__dirname, "workers/<name>.ts"), port: <port> }` to `ALL_WORKERS` in `src/server.ts`
3. Optionally create `src/personas/<name>.md` for the worker's system persona

### Running a Workflow

Create a workflow JSON file `workflow.json`:
```json
{
  "steps": [
    {
      "id": "fetch",
      "skillId": "fetch_url",
      "args": { "url": "https://api.example.com/data" },
      "depends_on": []
    },
    {
      "id": "analyze",
      "skillId": "analyze_data",
      "args": { "data": "{{fetch.result}}" },
      "depends_on": ["fetch"]
    },
    {
      "id": "save",
      "skillId": "write_file",
      "args": { "path": "/tmp/result.txt", "content": "{{analyze.result}}" },
      "depends_on": ["analyze"]
    }
  ]
}
```

In Claude Code, ask:
```
Use the delegate tool with skillId "workflow_execute" and args <workflow.json>
```

The orchestrator executes steps in topological order (respecting dependencies) and returns the final result.

### Setting Up RBAC

Create a new API key for a specific role:
```bash
bun src/cli.ts auth-create-key --name prod-key --role operator
bun src/cli.ts auth-create-key --name limited-key --role viewer --allow run_shell,fetch_url --deny write_file
```

List all keys (never prints key material — only metadata):
```bash
bun src/cli.ts auth-list-keys
```

Revoke a key:
```bash
bun src/cli.ts auth-revoke-key --target prod-key
```

Use the key when calling the A2A HTTP API:
```bash
curl -H "Authorization: Bearer <key>" http://localhost:8080/healthz
```

### Using the Sandbox

The sandbox executes isolated TypeScript code with access to all worker skills.

In Claude Code, ask:
```
Use the delegate tool with skillId "sandbox_execute" and args {
  code: "
    const result = await skill('run_shell', { command: 'ls -la' });
    console.log(result);
  "
}
```

Variables persist per session in SQLite (`~/.a2a-sandbox.db`). Larger results (>4KB) are auto-indexed for full-text search.

---

## 8. Troubleshooting

### Worker Not Discovered

**Symptoms:** You see "worker not found" or "skill not available" errors.

**Diagnosis:**
1. Check if the port is in use:
   ```bash
   lsof -i :8081
   ```

2. Check stderr for retry messages (the server logs exclusively to stderr — no log file is written by default). Redirect stderr when starting, then tail the file:
   ```bash
   bun src/server.ts 2>~/.a2a-mcp/server.log
   tail -f ~/.a2a-mcp/server.log
   ```

3. Verify the worker is enabled in config:
   ```bash
   cat ~/.a2a-mcp/config.json | grep -A 3 "workers"
   ```

**Fix:**
- Ensure the worker is listed in `ALL_WORKERS` in `src/server.ts`
- Ensure `enabled: true` in config
- Restart the server: `bun src/server.ts`
- Check the worker's individual health: `curl http://localhost:8081/healthz`

### MCP Connection Fails

**Symptoms:** Claude Code shows "MCP connection refused" or "MCP not available".

**Diagnosis:**
1. Verify registration:
   ```bash
   claude mcp list
   ```

2. Ensure Bun is in PATH:
   ```bash
   which bun
   ```

3. Check stdout isn't polluted (all logging must go to stderr):
   ```bash
   bun src/server.ts 2>/dev/null | head -20
   ```

**Fix:**
- Re-register with Claude Code:
  ```bash
  claude mcp remove a2a-mcp-bridge
  claude mcp add --scope user a2a-mcp-bridge -- bun $(pwd)/src/server.ts
  ```
- Restart Claude Code
- Check that `process.stderr.write()` is used for all logging (no `console.log`)

### "Circuit Open" Errors

**Symptoms:** Calls fail with "circuit breaker is open" or "worker is unhealthy".

**Diagnosis:**
The circuit breaker detected too many failures from a worker and opened to prevent cascading failures.

Check worker health:
```bash
curl http://localhost:8081/healthz
```

**Fix:**
- The circuit auto-recovers after a cooldown (configurable)
- Or manually restart the worker process:
  ```bash
  pkill -f "bun src/workers/shell"
  bun src/server.ts
  ```

### Permission Denied

**Symptoms:** "401 Unauthorized" or "insufficient permissions" errors.

**Diagnosis:**
1. Check your API key role:
   ```bash
   bun src/cli.ts auth-list-keys
   ```

2. Verify the key has permission for the skill:
   ```bash
   bun src/cli.ts auth-show-key --id <key-id>
   ```

**Fix:**
- Use a key with `admin` or `operator` role
- Or grant permission to the specific skill:
  ```bash
  bun src/cli.ts auth-grant-skill --id <key-id> --skill run_shell
  ```

### Sandbox Timeout

**Symptoms:** Sandbox code execution fails with "execution timeout".

**Diagnosis:**
Your code is running longer than the configured timeout (default: 30 seconds).

**Fix:**
Increase the timeout in config:
```json
{
  "sandbox": {
    "timeout": 60000
  }
}
```

Or via environment variable:
```bash
A2A_SANDBOX_TIMEOUT=60000 bun src/server.ts
```

### Memory/Knowledge Not Saving

**Symptoms:** Notes created with `create_note` don't persist.

**Diagnosis:**
1. Check Obsidian vault path exists:
   ```bash
   ls -la ~/Documents/Obsidian/a2a-knowledge
   ```

2. Check for errors in server logs (redirect stderr first):
   ```bash
   grep "memory" ~/.a2a-mcp/server.log
   ```

**Fix:**
- Create the vault directory:
  ```bash
  mkdir -p ~/Documents/Obsidian/a2a-knowledge
  ```
- Or override the vault path in config or `OBSIDIAN_VAULT` environment variable:
  ```bash
  OBSIDIAN_VAULT=/path/to/vault bun src/server.ts
  ```

---

## 9. Deployment Runbook

### Local Deployment (Development)

Already covered above. Just run:
```bash
bun src/server.ts
```

### Docker Deployment

#### Build the Image
```bash
docker build -t a2a-mcp .
```

#### Run a Container
```bash
docker run \
  -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-... \
  -e GOOGLE_API_KEY=AIzaSy... \
  a2a-mcp
```

#### Persist Config and Data
```bash
docker run \
  -p 8080:8080 \
  -v ~/.a2a-mcp:/root/.a2a-mcp \
  -v ~/.a2a-sandbox.db:/root/.a2a-sandbox.db \
  -e ANTHROPIC_API_KEY=sk-... \
  a2a-mcp
```

### Docker Compose Deployment

Create `docker-compose.yml`:
```yaml
version: '3.8'
services:
  a2a-mcp:
    build: .
    ports:
      - "8080:8080"
    environment:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      GOOGLE_API_KEY: ${GOOGLE_API_KEY}
    volumes:
      - ~/.a2a-mcp:/root/.a2a-mcp   # set "profile": "lite" in ~/.a2a-mcp/config.json to restrict workers
      - ~/.a2a-sandbox.db:/root/.a2a-sandbox.db
```

Deploy:
```bash
docker-compose up -d
```

View logs:
```bash
docker-compose logs -f a2a-mcp
```

### Fly.io Deployment

#### Initialize
```bash
fly launch --copy-config
```

#### Set Secrets
```bash
fly secrets set ANTHROPIC_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=AIzaSy...
fly secrets set A2A_API_KEY=prod-key-...
```

**Important:** Always set `A2A_API_KEY` for internet-exposed deployments to require authentication.

#### Deploy
```bash
fly deploy
```

View logs:
```bash
fly logs
```

### Railway Deployment

#### Connect Repository
1. Push your code to GitHub
2. Go to https://railway.app
3. Connect your GitHub repo in the Railway dashboard
4. Railway auto-detects `fly.toml` and Bun runtime

#### Set Secrets
In the Railway dashboard:
1. Go to **Variables**
2. Add:
   - `ANTHROPIC_API_KEY`: sk-...
   - `GOOGLE_API_KEY`: AIzaSy...
   - `A2A_API_KEY`: prod-key-...
   - *(Profile is set via `"profile": "lite"` in `~/.a2a-mcp/config.json`, not an env var)*

#### Deploy
Railway auto-deploys on push to main. Monitor in the dashboard.

---

## 10. Monitoring & Observability

### Health Checks

#### Basic Health
```bash
curl http://localhost:8080/healthz
```

Response: `{"status":"ok"}`

#### Readiness (all workers discovered)
```bash
curl http://localhost:8080/readyz
```

Response: `{"status":"ready"}` or `{"status":"not_ready","reason":"workers not discovered"}`

#### Detailed Health
```bash
curl http://localhost:8080/health
```

Response includes worker status, skill inventory, and circuit breaker states.

### Metrics

Via MCP tool in Claude Code:
```
Use the delegate tool with skillId "get_metrics"
```

Or via HTTP:
```bash
curl http://localhost:8080/metrics
```

Returns execution counts, latencies (p50/p95/p99), error rates, and circuit breaker state per worker.

### Distributed Traces

List all traces:
```
Use the delegate tool with skillId "list_traces"
```

Get a specific trace with waterfall visualization:
```
Use the delegate tool with skillId "get_trace" and args { traceId: "..." }
```

### Circuit Breaker Status

```
Use the delegate tool with skillId "worker_health"
```

Returns the state of each worker's circuit breaker (closed, open, half_open) and health score.

### Audit Log

Query the audit log:
```
Use the delegate tool with skillId "audit_query" and args { 
  actor: "claude-code",
  skill: "run_shell",
  timeRange: { start: "2026-03-14T00:00:00Z", end: "2026-03-14T23:59:59Z" }
}
```

Returns all skill invocations matching the filter.

### Dashboard

Open your browser to:
```
http://localhost:8080/dashboard
```

This shows:
- Real-time worker health and skill inventory
- Recent delegations and their results
- Circuit breaker state
- Execution metrics
- Trace waterfall visualization

---

## 11. Upgrading

### Pull Latest Changes
```bash
git pull
bun install
```

### Check for Breaking Changes
Read `CHANGELOG.md` to see if any config or API changes are needed:
```bash
cat CHANGELOG.md | head -50
```

### Validate Configuration
The server validates your config on startup using Zod. If there are errors, you'll see them immediately:
```bash
bun src/server.ts
# Error: Config validation failed: ...
```

Fix any validation errors before starting.

### Restart the Server
```bash
# Stop the running server (Ctrl+C)
# Then restart:
bun src/server.ts
```

### Test Your Setup
Run the health checks from Section 5:
```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
```

---

## 12. Who to Ask

For specific questions, consult the relevant documentation:

- **Architecture & design decisions** → `docs/ARCHITECTURE.md`
- **API reference & skill catalog** → `docs/API.md`
- **Security internals (SSRF, RBAC, circuit breakers)** → `docs/ARCHITECTURE.md` §13
- **Adding a new worker** → `docs/ARCHITECTURE.md` §19
- **Troubleshooting** → Section 8 of this guide

For bugs or feature requests, open an issue on GitHub.

---

## Quick Reference

### Common Commands

```bash
# Start server
bun src/server.ts

# Dev mode with hot reload
bun --watch src/server.ts

# Run tests
bun test

# Initialize config (lite profile)
bun src/cli.ts init --lite

# Create a custom worker
bun src/cli.ts create-worker my-tool --port 8100

# Create an API key (role: admin|operator|viewer)
bun src/cli.ts auth-create-key --name prod-key --role operator

# Type-check without tsc
bun build src/server.ts --target bun 2>&1 | tail -10

# Check health
curl http://localhost:8080/healthz
```

### File Structure

```
a2a-mcp-server/
├── src/
│   ├── server.ts              # Main entry point (MCP + A2A orchestrator)
│   ├── workers/               # 15 built-in worker processes
│   │   ├── shell.ts           # Port 8081
│   │   ├── web.ts             # Port 8082
│   │   ├── ai.ts              # Port 8083
│   │   └── ... (through supply-chain.ts port 8095)
│   ├── config.ts              # Config loading (Zod)
│   ├── memory.ts              # SQLite + Obsidian dual-write
│   ├── sandbox.ts             # Isolated Bun subprocess executor
│   ├── workflow-engine.ts     # DAG-based workflows
│   └── ... (see ARCHITECTURE.md for full tree)
├── docs/
│   ├── ONBOARDING.md          # This file
│   ├── ARCHITECTURE.md        # System design & internals
│   └── API.md                 # MCP tools, A2A endpoints, schemas
├── fly.toml                   # Fly.io deployment config
├── railway.json               # Railway deployment config
├── bunfig.toml                # Bun configuration
├── tsconfig.json
└── package.json
```

---

Happy automating!
