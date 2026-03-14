# a2a-mcp-server Architecture

## 1. Overview

The a2a-mcp-server is a **multi-protocol automation runtime** that unifies three communication paradigms:

- **MCP (Model Context Protocol)** — stdio-based JSON-RPC for Claude Code integration
- **A2A (Agent-to-Agent)** — HTTP/Fastify REST API on port 8080 for inter-agent orchestration

Built entirely on **Bun + TypeScript** with no build step, no Node.js dependency. The single entry point (`src/server.ts`) serves as both the MCP server and the A2A orchestrator, spawning a fleet of 15 specialized worker processes (ports 8081-8095) on startup.

The system is designed for **resilience**, **observability**, and **multi-agent collaboration** — with circuit breakers, distributed tracing, skill caching, RBAC, and event-driven architecture built in.

---

## 2. System Design (ASCII Diagram)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ENTRY POINTS                                 │
├──────────────────┬──────────────────────────────────────────────────┤
│  MCP (stdio)     │  A2A HTTP (8080)                              │
│  JSON-RPC        │  REST / JSON-RPC 2.0                          │
└───────────┬──────┴─────────────────┬────────────────┴────────────────┘
            │                        │
            └────────────┬───────────┘
                         │
            ┌────────────▼─────────────────────┐
            │    src/server.ts (Orchestrator)  │
            │  Fastify on 8080 + MCP handler   │
            └────────────┬─────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        │ Spawns local   │                │
        │ workers via    │ Discovers      │
        │ Bun.spawn      │ remoteWorkers  │
        │                │                │
        └────────────────┼────────────────┘
                         │
        ┌────────────────▼────────────────────────────────────────┐
        │              SKILL ROUTER (delegate)                     │
        │  1. agentUrl → direct call                              │
        │  2. skillId → lookup worker → forward                   │
        │  3. Neither → ask_claude picks {url, skillId}           │
        └────────────────┬─────────────────────────────────────────┘
                         │
        ┌────────────────▼─────────────────────────────────────────┐
        │         RESILIENCE & OBSERVABILITY LAYER                  │
        ├──────────────┬──────────────┬─────────────┬──────────────┤
        │ Circuit      │ Skill Cache  │ Metrics     │ Tracing      │
        │ Breaker      │ (LRU+TTL)    │ (p50/p95)   │ (Span Tree)  │
        │ per-worker   │ Content-addr │ Call counts │ Waterfall    │
        ├──────────────┼──────────────┼─────────────┼──────────────┤
        │ RBAC & Auth  │ Event Bus    │ Audit Trail │ Capability   │
        │ (api keys)   │ (pub/sub)    │ (SQLite)    │ Negotiation  │
        └──────────┬───┴──────────┬───┴─────────────┴──────┬───────┘
                   │              │                        │
        ┌──────────▼──────────────▼────────────────────────▼─────────┐
        │                    WORKER FLEET                            │
        ├─────────────────────────────────────────────────────────────┤
        │ 8081: shell        │ 8085: knowledge │ 8089: news          │
        │ 8082: web          │ 8086: design    │ 8090: market        │
        │ 8083: ai           │ 8087: factory   │ 8091: signal        │
        │ 8084: code         │ 8088: data      │ 8092: monitor       │
        │                    │                 │ 8093: infra         │
        │                    │                 │ 8094: climate       │
        │                    │                 │ 8095: supply-chain  │
        └─────────────────────────────────────────────────────────────┘
                         ▲
        ┌────────────────┼────────────────────┐
        │                │                    │
        │ Each worker is a standalone        │
        │ Fastify HTTP server with agent     │
        │ card at /.well-known/agent.json    │
        │                                    │
        └────────────────┼────────────────────┘
                         │
        ┌────────────────▼─────────────────────┐
        │  SUPPORTING INFRASTRUCTURE           │
        ├──────────────────────────────────────┤
        │ Memory System (SQLite+Obsidian)      │
        │ Sandbox Execution (isolated Bun)    │
        │ Workflow Engine (DAG-based)         │
        │ Plugin System (dynamic loading)     │
        │ Webhook Integration                 │
        └──────────────────────────────────────┘
```

---

## 3. Process Model

### Orchestrator Initialization

At startup, `src/server.ts` performs the following sequence:

1. **Load configuration** from `~/.a2a-mcp/config.json` (Zod-validated)
2. **Determine active profile** (full, lite, data, osint) which filters enabled workers
3. **Discover user-space workers** from `~/.a2a-mcp/workers/` via `discoverUserWorkers()`
4. **Configure SSRF allowlist** — allowed ports derived from `WORKERS` array; remote worker URLs added automatically
5. **Spawn local workers** via `Bun.spawn()` for each enabled worker type
   - Each worker: isolated child process, stdout piped to `/dev/null`, stderr inherited
   - Auto-respawn on exit with exponential backoff: 1s, 2s, 4s... up to 60s
6. **Wait for all workers to become healthy** — polls `/healthz` every 500ms (up to 10s per worker)
7. **Discover worker capabilities** via `GET /.well-known/agent.json`
   - Retry backoff: 500ms × attempt (500ms, 1000ms, 1500ms, 2000ms, 2500ms — 5 attempts max)
   - Tolerates slow startup (Bun just-in-time compilation, database initialization)
8. **Discover remoteWorkers** from config (no process spawn, HTTP call only)
9. **Start health polling** loop (every 30 seconds)
   - Checks worker `/healthz` endpoint
   - Updates worker health state for circuit breaker + capability negotiation
10. **Register MCP resources** and skills
11. **Listen on port 8080** for A2A HTTP requests

### Worker Architecture

Each worker is a **standalone Fastify HTTP server** with:

- **Agent Card** at `/.well-known/agent.json` (OpenAPI-style skill definitions)
- **Skill Handlers** at POST `/skills/:skillId`
- **Health Endpoint** at `/healthz`
- **Memory Endpoints** (remember/recall) shared across all workers
- **Circuit Breaker Status** (when unhealthy, orchestrator routes around it)

Worker output (logs) must go **to stderr only** — stdout is reserved for potential protocol streaming.

### Worker Lifecycle

```
START
  ↓
src/server.ts spawns via Bun.spawn()
  ↓
Worker process starts Fastify on assigned port
  ↓
Orchestrator discovers agent card (exponential backoff)
  ↓
Health polling begins (every 30s)
  ↓
RUNNING
  ↓
Circuit breaker monitors error rate
  ↓
On SIGTERM/graceful shutdown
  ↓
Worker flushes pending callbacks, closes DB
  ↓
STOPPED
```

### Profiles & Worker Filtering

| Profile | Workers Enabled | Use Case |
|---------|-----------------|----------|
| `full` | All 14 built-in workers (shell through climate) | Development, feature parity testing |
| `lite` | shell, web, ai | Minimal footprint (cloud, edge) |
| `data` | shell, web, ai, data | Analytics workloads |
| `osint` | shell, web, ai, news, market, signal, monitor, infra, climate | Intelligence gathering |

Note: `supply-chain` (port 8095) is registered in `ALL_WORKERS` but is not included in any profile preset — it must be explicitly enabled in config. User-space workers discovered from `~/.a2a-mcp/workers/` are always appended regardless of profile.

---

## 4. Skill Routing (3-Tier Resolution)

The `delegate` skill in `src/server.ts` implements a three-tier routing strategy with SSRF validation at every tier.

### Tier 1: Direct Agent URL
```typescript
if (agentUrl) {
  if (!isAllowedUrl(agentUrl)) throw new AgentError("INVALID_ARGS", "Blocked URL")
  return sendWithResilience(agentUrl, { skillId, args, message, contextId })
}
```
Caller explicitly specifies a worker HTTP endpoint. The URL is validated against the SSRF allowlist (localhost worker ports + configured remote worker URLs). Passes through circuit breaker, cache, metrics, and tracing.

### Tier 2: Skill ID Lookup
```typescript
if (skillId) {
  const router = buildSkillRouter(workerCards, getExternalCards())
  const url = router.get(skillId)
  if (url) return sendWithResilience(url, ...)
  // Fallback: built-in SKILL_MAP (src/skills.ts)
  const localSkill = SKILL_MAP.get(skillId)
  if (localSkill) return localSkill.run(args)
  return "No worker found with skill: " + skillId
}
```
`buildSkillRouter` merges external agent cards (added first) with locally-discovered built-in worker cards. Built-ins always win on collision — a built-in skill with the same `id` as an external agent skill will shadow the external one.

If no worker advertises the skill, the orchestrator falls back to the local built-in `SKILL_MAP` (registered in `src/skills.ts`) for backward compatibility.

### Tier 3: AI-Powered Auto-Routing
```typescript
// Neither agentUrl nor skillId provided
const cardsJson = JSON.stringify(workerCards.map(c => ({ name, url, skills })))
const prompt = orchestratorPersona.systemPrompt + "\nWorkers: " + cardsJson
              + "\nInstruction: Reply ONLY with {url, skillId}"
              + sanitizedMessage  // user message sandboxed in <user_task> tags
const selection = await sendTask(aiWorkerUrl, { skillId: "ask_claude", args: { prompt } })
return sendWithResilience(selection.url, { skillId: selection.skillId, args, message })
```
The user message is sanitized via `sanitizeForPrompt()` and wrapped in `<user_task>` tags with explicit anti-injection instructions before being sent to the AI worker. The LLM's selected URL is validated against the SSRF allowlist before dispatch.

### Routing Flow Diagram

```
delegate(args)
  │
  ├─ agentUrl provided?
  │  ├─ YES → SSRF validate → sendWithResilience(agentUrl)
  │  └─ NO ↓
  │
  ├─ skillId provided?
  │  ├─ YES → buildSkillRouter(workerCards, externalCards).get(skillId)
  │  │         ├─ found → sendWithResilience(workerUrl)
  │  │         └─ not found → SKILL_MAP.get(skillId) or "not found"
  │  └─ NO ↓
  │
  └─ Neither → ask_claude(sanitized prompt + worker cards)
               → SSRF validate → sendWithResilience(llm-selected url)
```

### sendWithResilience Pipeline

Every worker call flows through this pipeline:
1. Cache lookup (`getFromCache`) — skip if hit
2. Circuit breaker check (`breaker.call()`) — fail fast if worker is open
3. HTTP call via `sendTask()` (redirect-safe, timeout-aware)
4. Output filtering (`applyFilters`) — strip ANSI, apply custom filter rules
5. Cache write (`putInCache`) — only if skill is not side-effect
6. Event publish (`agent.{name}.completed` or `agent.{name}.failed`)
7. Metrics record (`recordSkillCall`)
8. Trace span end

---

## 5. Resilience Layer

### 5.1 Circuit Breaker (src/circuit-breaker.ts)

Per-worker finite state machine:

```
           failure threshold
                  │
    ┌─────────────▼─────────────┐
    │ CLOSED (healthy)          │
    │ All requests pass through  │
    └─────────────┬─────────────┘
                  │ error rate > threshold
                  ▼
    ┌─────────────────────────────┐
    │ OPEN (failing fast)         │
    │ Reject all requests         │
    │ with CircuitBreakerError    │
    └─────────────┬──────────────┘
                  │ cooldown timeout
                  ▼
    ┌──────────────────────────────┐
    │ HALF_OPEN (testing recovery) │
    │ Let 1 request through        │
    ├──────────────────────────────┤
    │ success → CLOSED             │
    │ failure → OPEN (reset timer) │
    └──────────────────────────────┘
```

**Parameters** (configurable):
- `failureThreshold`: error rate % (default: 50%)
- `windowSize`: rolling window ms (default: 60000)
- `cooldownMs`: time in OPEN state (default: 30000)
- `minRequests`: minimum calls to trip (default: 5)

**Benefits:**
- Fail fast when worker is unhealthy (don't wait for timeout)
- Auto-recovery: periodic test requests
- Prevent cascading failures across delegation chains

### 5.2 Skill Cache (src/skill-cache.ts)

**LRU cache with per-skill TTL:**

```typescript
// Content-addressable key (deterministic)
const cacheKey = hash(skillId + JSON.stringify(args))

// Check cache
const cached = cache.get(cacheKey)
if (cached && !expired(cached.ts, ttl[skillId])) {
  return cached.result
}

// Cache miss → call worker
const result = await worker.call(skillId, args)

// Auto-cache (unless side-effect skill)
if (!SIDE_EFFECT_SKILLS.has(skillId)) {
  cache.set(cacheKey, result, ttl[skillId])
}
```

**Side-effect excluded skills** (always bypassed):
- `run_shell`
- `write_file`
- `create_note`
- `update_note`
- `event_publish`
- Any skill marked `readOnly: false`

**TTL defaults:**
- Stateless queries (fetch_quote): 300s
- Configuration (list_skills): 600s
- Analysis (analyze_data): 60s (default)

**Metrics:**
- Hit rate (%)
- Miss rate (%)
- Evictions (LRU)
- Memory usage (bytes)

### 5.3 Metrics (src/metrics.ts)

**Per-skill execution metrics:**

```typescript
interface SkillMetrics {
  callCount: number
  errorCount: number
  errorRate: number  // %
  latencies: {
    p50: number
    p95: number
    p99: number
  }
  lastCall: timestamp
}
```

Exposed via:
- `get_metrics` tool (query by skillId or worker)
- `a2a://metrics` resource (full dashboard)
- Auto-cleared on server restart

---

## 6. Distributed Tracing

**OpenTelemetry-style trace/span hierarchy** (`src/tracing.ts`):

```
Trace (root)
  ├─ Span: skill-router
  │  └─ skillMap lookup: 2ms
  ├─ Span: cache-lookup
  │  └─ key: skill_parse_csv_abc123 → MISS
  ├─ Span: circuit-breaker
  │  └─ state: CLOSED, load: 3/10
  └─ Span: worker-call (8088)
     ├─ http.method: POST
     ├─ http.url: /skills/parse_csv
     ├─ http.status_code: 200
     └─ duration: 234ms
```

**Per-span data:**
- Tags: key-value pairs (worker_id, skill_name, http_status)
- Events: timestamped logs (circuit_opened, cache_hit, timeout)
- Status: ok / error / unknown
- Duration: wall-clock ms

**Waterfall visualization:**
Shows parent/child span timing for performance analysis.

**Integration with delegation:**
Every `delegate` call creates a new trace with automatic child spans for:
1. Skill routing (lookup or AI selection)
2. Cache lookup
3. Circuit breaker state check
4. Worker HTTP call

---

## 7. Workflow Engine

**DAG-based multi-step orchestration** (`src/workflow-engine.ts`):

```yaml
steps:
  - id: fetch_data
    skill: fetch_url
    args:
      url: "https://api.example.com/data"

  - id: parse_data
    dependsOn: [fetch_data]
    skill: parse_json
    args:
      json: "{{fetch_data.result}}"

  - id: analyze
    dependsOn: [parse_data]
    skill: analyze_data
    args:
      data: "{{parse_data.result}}"
    when: "{{parse_data.result.length > 0}}"
    onError: skip

  - id: notify
    dependsOn: [analyze]
    skill: send_email
    args:
      to: "team@example.com"
      subject: "Analysis: {{analyze.result.summary}}"
```

**Execution semantics:**
- Topological sort: execute steps respecting dependencies
- Max parallelism: run independent steps concurrently
- Template refs: `{{stepId.result}}`, `{{input.key}}`, `{{steps.*.field}}`
- Conditionals: `when` expression (skip step if false)
- Error handling: per-step `onError` (fail/skip/retry)

**Example execution order:**
```
fetch_data (parallel)
         ↓
    parse_data (parallel)
         ↓
    analyze (conditional) → notify
```

---

## 8. Multi-Agent Collaboration

**Consensus and negotiation protocols** (`src/agent-collaboration.ts`):

### Strategy: fan_out
```
Query A ─────┐
Query B ─────┼─→ Merge results
Query C ─────┘
```
Parallel fan-out to all agents, merge responses.

### Strategy: consensus
```
Query A → Score 0.8
Query B → Score 0.9
Query C → Score 0.7
         └──→ Pick B (highest score)
```
Each agent votes, LLM scores and picks best.

### Strategy: debate
```
Initial answer A
   ↓
B critiques A
   ↓
A refines
   ↓
Final consensus
```
Iterative refinement: critique → revise → critique.

### Strategy: map_reduce
```
Distribute    ┌─ chunk1 → process A
workload ────┼─ chunk2 → process B
             └─ chunk3 → process C
                 ↓
             Aggregate results
```

### Merge strategies:
- `concat`: join all results as array
- `best_score`: pick highest-scoring response
- `majority_vote`: democratic vote
- `custom`: invoke LLM merge prompt

---

## 9. Skill Pipelines (Composer)

**Declarative skill chaining** (`src/skill-composer.ts`):

```typescript
const pipeline = pipe()
  .step('fetch', delegate, {
    skillId: 'fetch_url',
    args: { url: 'https://api.example.com' }
  })
  .step('parse', delegate, {
    skillId: 'parse_json',
    args: { json: '{{prev.result}}' }
  })
  .step('transform', delegate, {
    skillId: 'transform_data',
    args: {
      data: '{{prev.result}}',
      mapping: '{{input.mapping}}'
    },
    onError: 'skip'
  })
  .step('save', delegate, {
    skillId: 'create_note',
    args: {
      title: 'Processed Data',
      content: '{{steps.transform.result}}'
    }
  })

await execute_pipeline(pipeline, {
  mapping: { old: 'new' }
})
```

**Template references:**
- `{{prev.result}}` — output of previous step
- `{{input.key}}` — input parameter
- `{{steps.stepId.result}}` — named step output
- `{{steps.*.fieldName}}` — wildcard (all steps)

**Error strategies:**
- `abort` (default): fail entire pipeline
- `skip`: skip this step, continue with next
- `fallback`: use fallback value if skill fails

---

## 10. Sandbox Execution

**Isolated Bun subprocesses** for untrusted code:

```typescript
// sandbox.ts
const result = await sandbox_execute({
  code: `
    import { skill } from './prelude.js'
    const data = await skill('parse_csv', { csv: $csv_file })
    const processed = data.map(row => ({
      id: row.id,
      name: row.name.toUpperCase()
    }))
    return processed
  `,
  context: {
    $csv_file: fs.readFileSync('/path/to/data.csv', 'utf-8')
  },
  timeout: 30000
})
```

**Prelude** (`src/sandbox-prelude.ts`) injected:

```typescript
async function skill(skillId, params) {
  return await fetch(`http://localhost:8080/delegate`, {
    method: 'POST',
    body: JSON.stringify({ skillId, skillParams: params })
  }).then(r => r.json())
}

function search(varName, query) {
  // FTS5 search in ~/a2a-sandbox.db
  return db.query(`
    SELECT * FROM sandbox_results
    WHERE var_name = ? AND content MATCH ?
    LIMIT 100
  `, [varName, query])
}
```

**Variable persistence** (`src/sandbox-store.ts`):

```typescript
// Variables persisted to ~/.a2a-sandbox.db
$myVar = { data: [...] }  // Auto-save

// Large results (>4KB) auto-indexed for FTS5
const results = await skill('analyze_data', {...})
// searchable via search('results', 'error rate')
```

**Isolation guarantees:**
- Fresh Bun process per call
- No access to orchestrator globals
- Timeout enforced (SIGTERM)
- stderr only output
- stdin/stdout IPC for skill calls

---

## 11. Memory & Knowledge

**Dual-write system** (`src/memory.ts`):

```
remember(key, value)
  ├─ Write to ~/a2a-memory.db (SQLite)
  │  └─ Fast, queryable
  └─ Write to ~/Documents/Obsidian/a2a-knowledge/_memory/ (Markdown)
     └─ Human-readable, vault sync

recall(query)
  ├─ Search SQLite (fast)
  └─ Fallback: search Obsidian vault (if SQLite miss)
```

**Knowledge Worker** (port 8085):

Skills for CRUD operations on markdown notes:
- `create_note(title, content, tags)`
- `read_note(title or id)`
- `update_note(id, content, tags)`
- `search_notes(query)`
- `list_notes(folder, limit)`

Each note is a markdown file with YAML frontmatter:

```markdown
---
id: abc123
created: 2026-03-14T10:30:00Z
updated: 2026-03-14T10:30:00Z
tags: [ai, architecture]
---

# Note Title

Content here...
```

---

## 12. Event Bus

**In-process pub/sub** (`src/event-bus.ts`):

```typescript
// Publish
event_publish({
  topic: 'agent.shell.completed',
  data: {
    exitCode: 0,
    stdout: '...'
  }
})

// Subscribe (wildcards)
event_subscribe({
  topic: 'agent.*.completed',  // * = one segment
  callback: (event) => {...}
})

event_subscribe({
  topic: 'workflow.#',  // # = multi-segment
  callback: (event) => {...}
})
```

**Topic wildcards:**
- `*` — matches one segment (e.g., `agent.*.completed` matches `agent.shell.completed`, `agent.web.completed`)
- `#` — matches zero or more segments (e.g., `workflow.#` matches `workflow.started`, `workflow.step1.completed`, etc.)

**Features:**
- Event history with configurable retention (default: 1000 events)
- Replay from timestamp: `event_replay(topic, since)`
- Dead letter queue: failed deliveries logged for retry
- Auto-publish on delegation completion/failure (integrated into delegate flow)

---

## 13. Security Architecture

### 13.1 Authentication & RBAC (src/auth.ts)

**API Key management:**
- Keys stored with SHA-256 hashing
- Per-key skill allow/deny lists
- Roles: admin, operator, viewer

```json
{
  "apiKey": "sk-...",
  "keyHash": "sha256...",
  "role": "operator",
  "allowedSkills": ["run_shell", "fetch_url"],
  "deniedSkills": ["write_file"],
  "createdAt": "2026-03-14T10:00:00Z"
}
```

### 13.2 SSRF Prevention (src/url-validation.ts)

Allowlist validation for all outbound HTTP calls:

```typescript
const ALLOWED_PORTS = [8080, 8081, 8082, ..., 8094]
const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1']
const CUSTOM_ALLOWLIST = [...remoteWorkers.map(w => w.url)]

validate(url) {
  const parsed = new URL(url)
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    if (!CUSTOM_ALLOWLIST.some(allowed => url.startsWith(allowed))) {
      throw new Error('SSRF: host not whitelisted')
    }
  }
  if (!ALLOWED_PORTS.includes(parsed.port)) {
    throw new Error('SSRF: port not whitelisted')
  }
}
```

Remote workers automatically added to whitelist on discovery.

### 13.3 Prompt Sanitization (src/prompt-sanitizer.ts)

Character escaping and XML boundary protection:

```typescript
sanitize(prompt) {
  // Escape special characters
  let safe = prompt
    .replace(/[<>&"']/g, char => ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]))

  // Remove null bytes
  safe = safe.replace(/\0/g, '')

  // Validate no embedded instructions
  if (safe.includes('<system>') || safe.includes('</system>')) {
    throw new Error('XML boundary violation')
  }

  return safe
}
```

Anti-injection instructions baked into system prompts to prevent prompt injection attacks.

### 13.4 Sandbox Isolation

Each sandbox execution:
- Fresh Bun subprocess (no shared state)
- Timeout enforced (SIGTERM)
- stdin/stdout IPC only (no access to orchestrator memory)
- No network access (must go through skill calls)

---

## 14. Data Storage

### Database Schema

| Database | Path | Schema | Purpose |
|----------|------|--------|---------|
| Memory | `~/.a2a-memory.db` | `memory (id, key, value, created_at)` | Recall system |
| Sandbox | `~/.a2a-sandbox.db` | `sandbox_vars (var_name, value)`, `sandbox_results (var_name, content)` with FTS5 | Variable persistence + search |
| Audit | `~/.a2a-mcp/audit.db` | `audit_log (id, actor, skill_id, args, result, status, timestamp)` | Immutable audit trail |

### SQLite Optimizations

- All databases use WAL (write-ahead log) for concurrent read/write
- Indexes on frequently queried columns (timestamp, skill_id)
- FTS5 (full-text search) for sandbox results >4KB
- Auto-vacuum enabled (PRAGMA auto_vacuum = 1)

---

## 15. Configuration

**File:** `~/.a2a-mcp/config.json` (Zod-validated schema)

```json
{
  "profile": "full",
  "server": {
    "port": 8080,
    "host": "localhost"
  },
  "workers": {
    "enabled": ["shell", "web", "ai"],
    "ports": {
      "shell": 8081,
      "web": 8082
    }
  },
  "remoteWorkers": [
    {
      "id": "custom-worker",
      "url": "http://192.168.1.100:9000"
    }
  ],
  "search": {
    "fts5": true,
    "indexLargeResults": true,
    "resultThresholdBytes": 4096
  },
  "sandbox": {
    "enabled": true,
    "defaultTimeout": 30000,
    "maxMemory": "512MB"
  },
  "timeouts": {
    "workerDiscovery": 5000,
    "healthPoll": 30000,
    "delegateCall": 60000
  },
  "circuitBreaker": {
    "failureThreshold": 50,
    "windowSize": 60000,
    "cooldownMs": 30000
  },
  "skillCache": {
    "enabled": true,
    "defaultTtl": 60000,
    "maxSize": 1000
  },
  "truncation": {
    "maxTokens": 100000,
    "strategy": "sliding_window"
  },
  "federation": {
    "allowRemoteExecution": true,
    "maxConcurrentRemote": 10
  }
}
```

---

## 16. Plugin System

**Dynamic plugin loading** (`src/plugins/` and `src/skill-loader.ts`):

Plugins are TypeScript modules exporting a `register` function:

```typescript
// src/plugins/my-plugin.ts
export async function register(server: FastifyInstance) {
  server.post('/custom-endpoint', async (request, reply) => {
    return { status: 'ok' }
  })

  // Register custom skill
  skillRegistry.set('my_custom_skill', {
    execute: async (params) => { ... },
    schema: { ... }
  })
}
```

**Built-in plugins:**
- `oauth.ts` — OAuth flow integration for external APIs
- `timestamps.ts` — Automatic timestamp injection (createdAt, updatedAt)

**Dynamic skill loading:**
- Scan `~/.a2a-mcp/workers/` for user-created worker processes
- Auto-discover capabilities from agent cards
- Integrated into skill routing

---

## 17. Deployment

### 17.1 Local Development

```bash
bun src/server.ts
# Starts all workers (full profile), listens on 8080
```

### 17.2 Docker

```dockerfile
FROM oven/bun:1

WORKDIR /app
COPY . .

# Non-root user
RUN useradd -m -u 1000 app
USER app

EXPOSE 8080-8094
CMD ["bun", "src/server.ts"]
```

Build & run:
```bash
docker build -t a2a-mcp-server .
docker run -p 8080-8094:8080-8094 a2a-mcp-server
```

### 17.3 docker-compose

```yaml
version: '3.8'
services:
  a2a-mcp:
    build: .
    ports:
      - "8080-8094:8080-8094"
    volumes:
      - a2a-data:/home/app/.a2a-mcp
    environment:
      A2A_PROFILE: full
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  a2a-data:
```

### 17.4 Fly.io

```toml
# fly.toml
app = "a2a-mcp-server"
primary_region = "sjc"

[build]
image = "a2a-mcp-server:latest"

[[services]]
protocol = "tcp"
internal_port = 8080
processes = ["app"]

[services.concurrency]
type = "connections"
hard_limit = 100
soft_limit = 80

[resources]
cpu_kind = "shared"
cpus = 1
memory_mb = 1024

[env]
A2A_PROFILE = "lite"

[checks]
[checks.http]
grace_period = "30s"
interval = "30s"
method = "get"
path = "/healthz"
protocol = "http"
timeout = "5s"
```

Deploy:
```bash
fly deploy
```

### 17.5 Railway

```json
{
  "services": [
    {
      "name": "a2a-mcp-server",
      "buildCommand": "echo 'Using Bun native'",
      "startCommand": "bun src/server.ts",
      "variables": {
        "A2A_PROFILE": "lite"
      }
    }
  ]
}
```

### 17.6 Health Endpoints

**Liveness** (`/healthz`):
```json
{
  "status": "ok",
  "timestamp": "2026-03-14T10:30:00Z"
}
```

**Readiness** (`/readyz`):
```json
{
  "ready": true,
  "workers": {
    "shell": "healthy",
    "web": "healthy",
    "ai": "unhealthy"
  }
}
```

**Detailed** (`/health`):
```json
{
  "status": "ok",
  "uptime": 3600,
  "workers": [
    {
      "id": "shell",
      "port": 8081,
      "status": "healthy",
      "latency": 12,
      "activeRequests": 2
    }
  ],
  "metrics": {
    "totalCalls": 1523,
    "totalErrors": 3,
    "errorRate": 0.2,
    "cacheHitRate": 0.67
  }
}
```

### 17.7 Graceful Shutdown

On SIGTERM/SIGINT:

1. Stop accepting new requests
2. Wait for in-flight requests to complete (30s timeout)
3. Flush callback queues
4. Close database connections (SQLite WAL checkpoint)
5. Terminate worker child processes
6. Exit with code 0

---

## 18. Key Design Decisions

### 18.1 Bun-Only Runtime

**Decision:** No Node.js, no build step. TypeScript runs directly via Bun.

**Rationale:**
- **Speed:** Bun is 10-40x faster than Node.js for startup, module loading
- **Simplicity:** No build pipeline (no tsc, webpack, esbuild)
- **Type safety:** Native TypeScript support with zero configuration
- **Single binary:** Deploy one executable, no node_modules

**Trade-off:** Smaller ecosystem than Node.js, but all required packages available.

### 18.2 stdout Reserved for MCP Protocol

**Decision:** All logging to stderr; stdout is reserved for MCP JSON-RPC.

**Rationale:**
- MCP spec requires clean stdout for JSON-RPC streaming
- Any console.log() corrupts the protocol stream
- Enables log redirection without breaking MCP communication

**Enforcement:** Linter rule in ESLint config prohibits `console.log` in any file.

### 18.3 Fastify per Worker

**Decision:** Each worker is its own Fastify HTTP server on a dedicated port.

**Rationale:**
- **Process isolation:** Worker crash doesn't affect orchestrator or other workers
- **Independent scaling:** Can spawn multiple instances of same worker type
- **Health monitoring:** Per-worker health checks via HTTP
- **Circuit breaker:** Failing worker can be isolated without cascading

**Trade-off:** 15+ worker processes = higher memory footprint (vs. single monolith).

### 18.4 Exponential Backoff Discovery

**Decision:** Worker discovery retries with exponential backoff (100ms → 1.6s).

**Rationale:**
- Bun JIT compilation can take 1-2 seconds
- Database initialization may be slow on first run
- Better UX than hard timeout
- Tolerates transient startup failures

### 18.5 Circuit Breakers per Worker

**Decision:** One circuit breaker state machine per worker, not per skill.

**Rationale:**
- Coarse-grained: if a worker is unhealthy, its entire skill set is affected
- Simpler state management
- Reduces thrashing (don't open/close per-skill)

### 18.6 Dual-Write Memory System

**Decision:** Persist to both SQLite (speed) and Obsidian (human-readable).

**Rationale:**
- **SQLite:** O(1) lookup, queryable, fast recall
- **Obsidian vault:** Human-readable markdown, syncs to cloud, integrates with other tools
- **Fallback:** If SQLite corrupted, can recover from Obsidian vault

---

## 19. Adding a New Worker

### Option A: User-Space Worker (No repo changes needed)

```bash
# Scaffold into ~/.a2a-mcp/workers/<name>/
bun src/cli.ts create-worker my-tool --port 8100
```

This creates:
- `~/.a2a-mcp/workers/my-tool/index.ts` — Fastify server template
- `~/.a2a-mcp/workers/my-tool/worker.json` — Port and metadata config

The worker is auto-discovered at startup via `discoverUserWorkers()`. No changes to `src/server.ts` required.

**Minimum requirements for `index.ts`:**
```typescript
import Fastify from "fastify";

const PORT = 8100;
const AGENT_CARD = {
  name: "my-tool-agent",
  url: `http://localhost:${PORT}`,
  description: "My custom worker",
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "my_skill", name: "My Skill", description: "Does something useful" }
  ],
};

const app = Fastify({ logger: false });

// Required: agent card for discovery
app.get("/.well-known/agent.json", async () => AGENT_CARD);

// Required: health check for readiness polling
app.get("/healthz", async () => ({ status: "ok", uptime: process.uptime() }));

// Required: A2A task handler
app.post("/a2a", async (req, reply) => {
  const body = req.body as any;
  const { skillId, args = {} } = body?.params ?? {};
  const taskId = body?.params?.id ?? crypto.randomUUID();
  let result: string;

  switch (skillId) {
    case "my_skill":
      result = `Result for: ${args.input ?? "nothing"}`;
      break;
    default:
      reply.code(404);
      return { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Unknown skill: ${skillId}` } };
  }

  return {
    jsonrpc: "2.0", id: body.id,
    result: {
      id: taskId,
      status: { state: "completed" },
      artifacts: [{ parts: [{ kind: "text", text: result }] }],
    },
  };
});

// All output to stderr — stdout must be silent (reserved for MCP)
app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  process.stderr.write(`[my-tool-agent] listening on :${PORT}\n`);
});
```

### Option B: Built-in Worker (Checked into the repo)

1. Create `src/workers/<name>.ts` following the pattern above (Fastify, AGENT_CARD, `/healthz`, `/a2a`)
2. Add to `ALL_WORKERS` in `src/server.ts`:
   ```typescript
   { name: "<name>", path: join(__dirname, "workers/<name>.ts"), port: <port> }
   ```
3. Optionally create `src/personas/<name>.md` with the worker's system persona
4. The worker is then subject to profile filtering — add it to the relevant profile sets in `config.ts` `applyProfile()` if needed

### Worker Implementation Notes

- Use `src/worker-harness.ts` helpers (`buildA2AResponse`, `buildA2AError`, `checkRequestSize`) for consistent response formatting
- Use `src/worker-memory.ts` `handleMemorySkill()` for `remember`/`recall` support
- **All stdout must be silent** — use `process.stderr.write()` for all logging
- Import paths must use `.js` extensions (ESM), e.g. `import { memory } from "../memory.js"`
- The A2A task body format: `{ jsonrpc, method, id, params: { id, skillId, args, message: { role, parts } } }`

---

## 20. Source Tree

```
a2a-mcp-server/
├── src/
│   ├── server.ts                # Main entry: MCP + A2A orchestrator
│   ├── a2a.ts                   # sendTask(), discoverAgent(), fetchWithTimeout()
│   ├── types.ts                 # A2A protocol types: Part, Message, Task, AgentCard
│   ├── config.ts                # Zod-validated config loader (loadConfig, loadConfig)
│   ├── memory.ts                # Dual-write (SQLite + Obsidian)
│   ├── skills.ts                # Built-in SKILL_MAP (fallback routing)
│   ├── sandbox.ts               # Isolated Bun subprocess executor
│   ├── sandbox-store.ts         # SQLite persistence + FTS5 for sandbox vars
│   ├── sandbox-prelude.ts       # TypeScript prelude injected into sandboxes
│   ├── circuit-breaker.ts       # Per-worker resilience FSM
│   ├── metrics.ts               # Skill execution metrics (p50/p95/p99)
│   ├── tracing.ts               # OpenTelemetry-style span tracking
│   ├── workflow-engine.ts       # DAG-based multi-step orchestration
│   ├── event-bus.ts             # In-process pub/sub with topic wildcards
│   ├── skill-composer.ts        # Declarative skill pipeline chaining
│   ├── agent-collaboration.ts   # Multi-agent consensus protocols
│   ├── skill-cache.ts           # LRU cache with per-skill TTL
│   ├── capability-negotiation.ts# Version-aware skill routing
│   ├── url-validation.ts        # SSRF prevention (port+URL allowlist)
│   ├── prompt-sanitizer.ts      # Character escaping + XML boundary check
│   ├── output-filter.ts         # RTK-style output filtering (ANSI strip, custom rules)
│   ├── token-tracker.ts         # Tracks token savings from output filtering
│   ├── tee.ts                   # Saves raw output when filtering removes >50%
│   ├── truncate.ts              # Smart response truncation (head/tail)
│   ├── safe-json.ts             # safeStringify with circular-ref guard
│   ├── auth.ts                  # API key + RBAC (roles, skill allow/deny)
│   ├── workspace.ts             # Team workspaces with members/roles
│   ├── audit.ts                 # Immutable audit trail (SQLite)
│   ├── skill-tier.ts            # Free/pro/enterprise skill gating
│   ├── webhooks.ts              # Webhook registration + HMAC verification
│   ├── worker-loader.ts         # Discovers user workers from ~/.a2a-mcp/workers/
│   ├── worker-memory.ts         # Shared remember/recall handler for workers
│   ├── worker-harness.ts        # Shared A2A response builders for workers
│   ├── skill-loader.ts          # Plugin system: scan src/plugins/ for register()
│   ├── cloud.ts                 # Health endpoints (/healthz, /readyz), graceful shutdown
│   ├── cli.ts                   # CLI: create-worker, init, config management
│   ├── agent-registry.ts        # External agent registry (~/.a2a-external-agents.json)
│   ├── task-store.ts            # Async task state (pending/working/completed/failed)
│   ├── mcp-registry.ts          # MCP server registry: listMcpTools, callMcpTool
│   ├── mcp-auth.ts              # MCP OAuth helpers
│   ├── context.ts               # Project context (JSON cache + Obsidian note)
│   ├── persona-loader.ts        # Load/watch persona markdown files
│   ├── errors.ts                # AgentError class
│   ├── agency-product.ts        # Agency product KPI summaries
│   ├── osint-intel.ts           # OSINT workflow builders
│   ├── erp-platform.ts          # ERP platform operations (quotes, connectors, etc.)
│   ├── workers/
│   │   ├── shell.ts             # run_shell, read_file, write_file, SSE stream (port 8081)
│   │   ├── web.ts               # fetch_url, call_api (port 8082)
│   │   ├── ai.ts                # ask_claude, search_files, query_sqlite (port 8083)
│   │   ├── code.ts              # codex_exec, codex_review via subprocess (port 8084)
│   │   ├── knowledge.ts         # CRUD notes: create/read/update/search/list (port 8085)
│   │   ├── design.ts            # UI/UX: enhance_ui_prompt, suggest_screens (Gemini) (port 8086)
│   │   ├── factory.ts           # AppFactory: normalize_intent, create_project (port 8087)
│   │   ├── data.ts              # CSV/JSON/SQL: parse, transform, analyze, pivot (port 8088)
│   │   ├── news.ts              # RSS/news: fetch_rss, aggregate, classify (port 8089)
│   │   ├── market.ts            # Finance: fetch_quote, price_history, technical_analysis (port 8090)
│   │   ├── signal.ts            # Intelligence: aggregate_signals, classify_threat (port 8091)
│   │   ├── monitor.ts           # OSINT: track_conflicts, detect_surge, vessel tracking (port 8092)
│   │   ├── infra.ts             # Infrastructure: cascade_analysis, chokepoint_assess (port 8093)
│   │   ├── climate.ts           # Climate: earthquakes, wildfires, exposure assess (port 8094)
│   │   └── supply-chain.ts      # ERP supply chain: analyze_orders, critical_path, mrp (port 8095)
│   ├── erp/                     # ERP connector implementations
│   │   ├── types.ts             # ERP domain types
│   │   ├── business-central.ts  # Microsoft Business Central connector
│   │   └── odoo.ts              # Odoo connector
│   ├── risk/                    # Supply chain risk analysis modules
│   │   ├── scoring.ts
│   │   ├── critical-path.ts
│   │   ├── lead-time.ts
│   │   ├── interventions.ts
│   │   └── sources.ts
│   ├── plugins/
│   │   ├── oauth-setup/         # OAuth flow for external APIs
│   │   └── sync-secrets/        # Secret sync plugin
│   └── personas/
│       └── *.md                 # Persona files per worker (optional)
├── docs/
│   ├── ARCHITECTURE.md          # This file
│   ├── API.md                   # MCP tools, A2A endpoints, data models
│   └── ONBOARDING.md            # Prerequisites, installation, runbook
├── fly.toml                     # Fly.io deployment config
├── railway.json                 # Railway deployment config
├── package.json                 # Bun dependencies
├── bunfig.toml                  # Bun configuration
├── tsconfig.json                # TypeScript config
├── CLAUDE.md                    # Developer guide
└── README.md                    # Getting started
```

---

## 21. Performance Characteristics

### Latency Profile

| Operation | P50 | P95 | P99 |
|-----------|-----|-----|-----|
| Worker discovery (per worker) | 100ms | 300ms | 500ms |
| Health check (per worker) | 10ms | 20ms | 50ms |
| Skill routing (skillId lookup) | 1ms | 2ms | 5ms |
| Cache hit | 0.5ms | 1ms | 2ms |
| Circuit breaker state check | 0.1ms | 0.2ms | 0.5ms |
| Sandbox execution (empty) | 50ms | 100ms | 150ms |
| Delegation (end-to-end) | 200ms | 500ms | 1000ms |

### Memory Usage

- Orchestrator: ~50MB
- Per worker: ~20-100MB (varies by worker type)
- Total (full profile): ~300-500MB
- Lite profile: ~100MB

### Concurrency

- Max concurrent delegations: 1000+ (limited by system file descriptors)
- Max concurrent workers: 15 built-in + user-space workers (configurable)
- Max sandbox processes: 50 (configurable)

---

## 22. Monitoring & Observability

### Exported Metrics

Available via `get_metrics` tool and `a2a://metrics` resource:

```
a2a_skill_calls_total (counter)
a2a_skill_errors_total (counter)
a2a_skill_latency_seconds (histogram: p50, p95, p99)
a2a_cache_hits_total (counter)
a2a_cache_misses_total (counter)
a2a_circuit_breaker_state (gauge: per worker)
a2a_workflow_executions_total (counter)
a2a_sandbox_executions_total (counter)
```

### Logging Strategy

All logs to stderr with structured format:

```
[2026-03-14 10:30:15] [INFO] [shell:8081] Worker discovered
[2026-03-14 10:30:16] [WARN] [ai:8083] Circuit breaker open (error_rate=62%)
[2026-03-14 10:30:17] [ERROR] [web:8082] Timeout on fetch_url after 30000ms
```

### Trace Export

Traces can be exported to:
- OpenTelemetry Collector (OTLP)
- Jaeger
- Datadog
- New Relic

Via `src/tracing.ts` integration.

---

## Conclusion

The a2a-mcp-server is a **production-grade automation platform** designed for resilience, observability, and extensibility. Its modular architecture allows operators to:

- **Scale** by adding more workers or remote agents
- **Monitor** via comprehensive metrics and distributed tracing
- **Extend** through plugins and custom skill registration
- **Collaborate** with other AI systems via A2A protocol
- **Audit** all operations via immutable audit trail

The system prioritizes **fail-safe behavior** (circuit breakers), **performance** (caching, skill routing), and **security** (SSRF validation, RBAC, prompt sanitization).
