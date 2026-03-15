# a2a-mcp-server API Reference

**Version:** 3.0.0
**Last Updated:** 2026-03-15
**Runtime:** Bun + TypeScript (no Node.js, no build step)
**Protocols:** MCP (Model Context Protocol, stdio JSON-RPC), A2A (Agent-to-Agent HTTP on port 8080, JSON-RPC 2.0)
**OpenAPI Spec:** `docs/openapi.yaml` (OpenAPI 3.1.0)

---

## Table of Contents

1. [MCP Tools (90+)](#mcp-tools)
2. [MCP Resources](#mcp-resources)
3. [MCP Prompts](#mcp-prompts)
4. [A2A HTTP Endpoints (Orchestrator, port 8080)](#a2a-http-endpoints)
5. [Worker A2A Endpoints (per-worker ports)](#worker-a2a-endpoints)
6. [Authentication & RBAC](#authentication--rbac)
7. [Data Models & Schemas](#data-models--schemas)
8. [Examples & Workflows](#examples--workflows)

---

## MCP Tools

### Core Delegation

#### `delegate`
Routes a skill request to the appropriate worker(s) and returns the result synchronously.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `skillId` | string | no* | Skill to invoke (e.g. `run_shell`, `fetch_url`) |
| `args` | object | no | Arguments passed to the skill |
| `agentUrl` | string | no* | Direct worker URL — bypasses skill lookup |
| `message` | string | no | Natural-language context message |
| `sessionId` | string | no | Enables session continuity (history stored in memory) |

*At least one of `skillId` or `agentUrl` must be provided, unless you want AI auto-routing.

**Routing Logic (3-tier):**
1. `agentUrl` provided → SSRF-validate → send directly to worker (circuit breaker + cache + metrics)
2. `skillId` provided → lookup in `buildSkillRouter(workerCards, externalCards)` → send to owning worker; falls back to built-in `SKILL_MAP` if no worker found
3. Neither → sanitize message → ask `ai-agent`'s `ask_claude` to pick `{url, skillId}` from worker cards → SSRF-validate → dispatch

**Response:** Plain string (the worker's text result). For structured data the worker serializes to JSON.

**Example:**
```
delegate skillId="run_shell" args={"command":"ls -la"} message="List directory"
```

---

#### `delegate_async`
Fire-and-forget version of delegate. Returns `taskId` immediately; poll result with `get_task_result`.

**Inputs:** Same as `delegate` (`skillId`, `args`, `agentUrl`, `message`, `sessionId`)

**Response:**
```json
{ "taskId": "uuid" }
```

Use `get_task_result` with the returned `taskId` to poll completion. Task states: `submitted → working → completed | failed | canceled`.

> **Note:** In `src/server.ts`, `delegate` with `async: true` also returns `{"taskId":"uuid"}`. `delegate_async` is a legacy alias.

---

#### `list_agents`
Discover all registered workers and remote agents.

**Inputs:** None

**Response:** A flat JSON array (no envelope):
```json
[
  {
    "name": "shell-agent",
    "url": "http://localhost:8081",
    "skills": ["run_shell", "read_file", "write_file", "remember", "recall"]
  },
  {
    "name": "my-external-agent",
    "url": "http://remote-host:9000",
    "skills": ["custom_skill"],
    "source": "external"
  }
]
```

---

#### `register_agent`
Manually register a remote A2A agent at runtime. The agent's skills are merged into the skill router immediately.

**Inputs:**
```json
{
  "url": "string (required, http://...)",
  "apiKey": "string (optional, Bearer token for auth)"
}
```

**Response:** The agent's `AgentCard` JSON (from `/.well-known/agent.json`), pretty-printed.

---

#### `unregister_agent`
Remove a registered remote agent.

**Inputs:**
```json
{
  "url": "string (required)"
}
```

**Response:** Text confirmation of removal.

---

### Sandbox

#### `sandbox_execute`
Run arbitrary TypeScript code in an isolated Bun subprocess with access to all worker skills.

**Inputs:**
```json
{
  "code": "string (TypeScript, required)",
  "sessionId": "string (optional, scopes $vars persistence)",
  "timeout": "number (ms, optional, default from config sandbox.timeout)"
}
```

**Available in Sandbox (injected via prelude):**
- `skill(id: string, args: object)` — Call any registered worker skill via HTTP
- `search(varName: string, query: string)` — FTS5 search large results indexed in `~/.a2a-sandbox.db`
- `$vars` — Persisted key-value store (SQLite, scoped to `sessionId`)

**Response:**
```json
{
  "result": "any",
  "output": "string (stdout)",
  "errors": "string (stderr)",
  "executionTime": "number (ms)",
  "indexed": "boolean (true if result >4KB auto-indexed)"
}
```

**Example:**
```typescript
const csv = await skill('parse_csv', { file: '/data.csv' });
const summary = csv.slice(0, 10);
$vars.lastCsvSummary = summary;
summary
```

---

#### `sandbox_vars`
Manage persistent sandbox variables.

**Inputs:**
```json
{
  "action": "list|read|delete",
  "name": "string (optional, required for read/delete)"
}
```

**Response (list):**
```json
{
  "variables": [
    {
      "name": "lastCsvSummary",
      "size": "number (bytes)",
      "createdAt": "ISO timestamp",
      "indexed": "boolean"
    }
  ]
}
```

**Response (read):**
```json
{
  "name": "string",
  "value": "any",
  "size": "number (bytes)",
  "indexed": "boolean"
}
```

---

### Memory

#### `remember`
Store a key-value pair in dual-write (SQLite + Obsidian markdown).

**Inputs:**
```json
{
  "key": "string",
  "value": "string"
}
```

**Response:**
```json
{
  "stored": true,
  "key": "string",
  "sqlite": "boolean (write success)",
  "obsidian": "boolean (markdown write success)"
}
```

---

#### `recall`
Retrieve memories by keyword query.

**Inputs:**
```json
{
  "query": "string"
}
```

**Response:**
```json
{
  "results": [
    {
      "key": "string",
      "value": "string",
      "source": "sqlite|obsidian",
      "timestamp": "ISO timestamp",
      "relevance": "number (0-1)"
    }
  ],
  "count": "number"
}
```

---

#### `memory_list`
List all stored memories.

**Inputs:** None

**Response:**
```json
{
  "memories": [
    {
      "key": "string",
      "value": "string (truncated if >500 chars)",
      "size": "number (bytes)",
      "createdAt": "ISO timestamp"
    }
  ],
  "totalCount": "number"
}
```

---

#### `memory_cleanup`
Remove stale and duplicate memories.

**Inputs:**
```json
{
  "olderThan": "ISO timestamp (optional)"
}
```

**Response:**
```json
{
  "removed": "number",
  "deduplicated": "number"
}
```

---

### Workflows & Pipelines

#### `workflow_execute`
Execute a multi-step DAG-based workflow across agents.

**Inputs:**
```json
{
  "workflow": {
    "id": "string",
    "steps": [
      {
        "id": "stepId",
        "skillId": "string",
        "args": "object",
        "depends_on": ["stepId (optional)"],
        "onError": "fail|skip|retry",
        "retries": "number (optional)"
      }
    ],
    "timeout": "number (ms, optional)"
  }
}
```

**Features:**
- Topological sort for parallelism
- Template references: `{{stepId.result}}`, `{{input.*}}`
- Conditional execution with `when` expressions
- Per-step error handling

**Response:**
```json
{
  "workflowId": "uuid",
  "status": "completed|failed|in_progress",
  "steps": [
    {
      "id": "stepId",
      "status": "completed|failed|skipped",
      "result": "any",
      "latency": "number (ms)"
    }
  ],
  "totalTime": "number (ms)"
}
```

---

#### `factory_workflow`
Generate a complete project from a high-level idea.

**Inputs:**
```json
{
  "idea": "string (project description)",
  "pipeline": "app|website|mcp-server|agent|api|cli (optional)",
  "template": "string (optional, override template)"
}
```

**Pipelines & Scaffolds:**
- `app` → Expo (React Native)
- `website` → Next.js
- `mcp-server` → MCP + Bun
- `agent` → AI Agent (Claude)
- `api` → REST API (Express/Fastify)
- `cli` → CLI Tool (Bun)

**Response:**
```json
{
  "projectId": "uuid",
  "status": "completed|in_progress|failed",
  "pipeline": "string",
  "spec": "string (AI-generated spec)",
  "files": {
    "count": "number",
    "paths": ["string"]
  },
  "qualityGate": {
    "score": "number (0-100)",
    "dimensions": {
      "architecture": "number",
      "performance": "number",
      "security": "number",
      "testCoverage": "number"
    }
  }
}
```

---

#### `compose_pipeline`
Create a declarative skill pipeline for chaining operations.

**Inputs:**
```json
{
  "pipeline": {
    "id": "string",
    "steps": [
      {
        "skillId": "string",
        "args": "object (can use {{prev.result}}, {{input.*}})",
        "alias": "string (optional, for reference)",
        "onError": "abort|skip|fallback",
        "fallback": "any (if onError=fallback)"
      }
    ]
  }
}
```

**Response:**
```json
{
  "pipelineId": "uuid",
  "created": true,
  "steps": "number"
}
```

---

#### `execute_pipeline`
Run a previously defined pipeline.

**Inputs:**
```json
{
  "id": "string (pipelineId)",
  "input": "object (pipeline input variables)"
}
```

**Response:**
```json
{
  "pipelineId": "string",
  "status": "completed|failed|in_progress",
  "steps": [
    {
      "stepId": "number",
      "skillId": "string",
      "result": "any",
      "error": "string (if failed)"
    }
  ],
  "finalResult": "any",
  "totalTime": "number (ms)"
}
```

---

#### `list_pipelines`
List all stored pipelines.

**Inputs:** None

**Response:**
```json
{
  "pipelines": [
    {
      "id": "uuid",
      "steps": "number",
      "createdAt": "ISO timestamp",
      "lastExecuted": "ISO timestamp (optional)"
    }
  ],
  "totalCount": "number"
}
```

---

### Event Bus

#### `event_publish`
Publish an event to the agent event bus.

**Inputs:**
```json
{
  "topic": "string (e.g., agent.shell.completed, workflow.#)",
  "data": "object (event payload)"
}
```

**Response:**
```json
{
  "eventId": "uuid",
  "topic": "string",
  "subscribers": "number (count of subscribers notified)",
  "timestamp": "ISO timestamp"
}
```

---

#### `event_subscribe`
Subscribe to event topics with wildcard support.

**Inputs:**
```json
{
  "pattern": "string (topic pattern, * = one segment, # = multi-segment)"
}
```

**Wildcard Examples:**
- `agent.*.completed` → matches `agent.shell.completed`, `agent.web.completed`, etc.
- `workflow.#` → matches `workflow.created`, `workflow.step1.completed`, etc.

**Response:**
```json
{
  "subscriptionId": "uuid",
  "pattern": "string",
  "matchCount": "number (events matching pattern so far)"
}
```

---

#### `event_replay`
Replay historical events from a given timestamp.

**Inputs:**
```json
{
  "from": "ISO timestamp",
  "to": "ISO timestamp (optional)",
  "topic": "string (optional, filter by topic)"
}
```

**Response:**
```json
{
  "eventsReplayed": "number",
  "events": [
    {
      "eventId": "uuid",
      "topic": "string",
      "data": "object",
      "timestamp": "ISO timestamp"
    }
  ]
}
```

---

### Collaboration

#### `collaborate`
Execute a skill across multiple agents with consensus/debate/map-reduce strategies.

**Inputs:**
```json
{
  "strategy": "fan_out|consensus|debate|map_reduce",
  "agents": ["http://localhost:8081", "http://localhost:8082"],
  "skillId": "string",
  "args": "object",
  "mergeStrategy": "concat|best_score|majority_vote|custom",
  "customMergePrompt": "string (if mergeStrategy=custom)"
}
```

**Strategies:**
- `fan_out` → Call all agents in parallel, merge results
- `consensus` → AI-scored voting, return majority consensus
- `debate` → Iterative critique/refinement (3 rounds)
- `map_reduce` → Distribute input across agents, aggregate output

**Response:**
```json
{
  "collaborationId": "uuid",
  "strategy": "string",
  "status": "in_progress|completed|failed",
  "results": [
    {
      "agent": "string (URL)",
      "result": "any",
      "score": "number (consensus score)"
    }
  ],
  "mergedResult": "any",
  "totalTime": "number (ms)"
}
```

---

### Observability

#### `get_metrics`
Retrieve execution metrics across all workers.

**Inputs:** None

**Response:**
```json
{
  "timestamp": "ISO timestamp",
  "workers": [
    {
      "worker": "shell",
      "skills": [
        {
          "skillId": "run_shell",
          "callCount": "number",
          "latency": {
            "p50": "number (ms)",
            "p95": "number (ms)",
            "p99": "number (ms)"
          },
          "errorRate": "number (0-1)",
          "successCount": "number",
          "failureCount": "number"
        }
      ]
    }
  ],
  "aggregated": {
    "totalCalls": "number",
    "avgLatency": "number (ms)",
    "overallErrorRate": "number (0-1)"
  }
}
```

---

#### `worker_health`
Get circuit breaker states and health status for all workers.

**Inputs:** None

**Response:**
```json
{
  "workers": [
    {
      "name": "shell",
      "url": "http://localhost:8081",
      "health": {
        "status": "healthy|degraded|unhealthy",
        "uptime": "number (ms)",
        "lastCheck": "ISO timestamp"
      },
      "circuitBreaker": {
        "state": "closed|open|half_open",
        "failures": "number",
        "lastFailure": "ISO timestamp (optional)",
        "recoveryAt": "ISO timestamp (optional)"
      }
    }
  ]
}
```

---

#### `list_traces`
List recent traces (distributed tracing).

**Inputs:**
```json
{
  "limit": "number (optional, default 100)"
}
```

**Response:**
```json
{
  "traces": [
    {
      "traceId": "uuid",
      "startTime": "ISO timestamp",
      "endTime": "ISO timestamp",
      "duration": "number (ms)",
      "spanCount": "number",
      "status": "success|failure"
    }
  ],
  "totalCount": "number"
}
```

---

#### `get_trace`
Get waterfall view of a trace with all spans.

**Inputs:**
```json
{
  "traceId": "uuid"
}
```

**Response:**
```json
{
  "traceId": "uuid",
  "startTime": "ISO timestamp",
  "endTime": "ISO timestamp",
  "duration": "number (ms)",
  "spans": [
    {
      "spanId": "uuid",
      "name": "string",
      "startTime": "ISO timestamp",
      "endTime": "ISO timestamp",
      "duration": "number (ms)",
      "parentSpanId": "uuid (optional)",
      "tags": "object",
      "events": [
        {
          "name": "string",
          "timestamp": "ISO timestamp",
          "attributes": "object"
        }
      ],
      "status": "success|failure",
      "error": "string (if failed)"
    }
  ]
}
```

---

#### `search_traces`
Search traces by query (skill, worker, status).

**Inputs:**
```json
{
  "query": "string (e.g., 'skillId:run_shell status:failure')"
}
```

**Response:**
```json
{
  "traces": [
    {
      "traceId": "uuid",
      "startTime": "ISO timestamp",
      "duration": "number (ms)",
      "status": "string",
      "matchReason": "string"
    }
  ],
  "count": "number"
}
```

---

### Cache

#### `cache_stats`
Get smart skill cache statistics.

**Inputs:** None

**Response:**
```json
{
  "cacheSize": "number (bytes)",
  "entriesCount": "number",
  "hitRate": "number (0-1)",
  "bySkill": [
    {
      "skillId": "string",
      "hits": "number",
      "misses": "number",
      "ttl": "number (ms)",
      "isCached": "boolean"
    }
  ]
}
```

---

#### `cache_invalidate`
Invalidate cached skill results.

**Inputs:**
```json
{
  "skillId": "string (optional)",
  "all": "boolean (optional, default false)"
}
```

**Response:**
```json
{
  "invalidated": "number (count of entries removed)"
}
```

---

#### `cache_configure`
Set per-skill cache TTL and policies.

**Inputs:**
```json
{
  "skillId": "string",
  "ttl": "number (ms)",
  "enabled": "boolean (optional)"
}
```

**Response:**
```json
{
  "skillId": "string",
  "ttl": "number (ms)",
  "enabled": "boolean"
}
```

---

### Capability Negotiation

#### `negotiate_capability`
Find the best worker for a skill based on version and features.

**Inputs:**
```json
{
  "skillId": "string",
  "version": "string (SemVer range, e.g., ^2.1.0)",
  "features": ["string (required features)"],
  "preferredFeatures": ["string (nice-to-have features)"]
}
```

**Response:**
```json
{
  "selectedWorker": {
    "url": "string",
    "name": "string",
    "version": "string (actual version)",
    "score": "number (0-100, multi-dimensional)",
    "scoringBreakdown": {
      "versionMatch": "number",
      "featureMatch": "number",
      "health": "number",
      "load": "number"
    }
  },
  "alternativeWorkers": [
    {
      "url": "string",
      "score": "number"
    }
  ]
}
```

---

#### `list_capabilities`
List all available skills with versions and features.

**Inputs:** None

**Response:**
```json
{
  "capabilities": [
    {
      "skillId": "string",
      "versions": ["string (SemVer)"],
      "features": ["string"],
      "workers": ["string (URLs)"],
      "latestVersion": "string"
    }
  ]
}
```

---

#### `capability_stats`
Get routing statistics and active call tracking.

**Inputs:** None

**Response:**
```json
{
  "skills": [
    {
      "skillId": "string",
      "routingCount": "number",
      "activeCallCount": "number",
      "preferredWorker": "string (URL)"
    }
  ]
}
```

---

### Auth & Workspaces

#### `workspace_manage`
CRUD operations for team workspaces.

**Inputs:**
```json
{
  "action": "create|update|list|delete|add_member|remove_member",
  "workspaceId": "string (optional, required for update/delete/member ops)",
  "name": "string (for create)",
  "description": "string (optional)",
  "members": [
    {
      "userId": "string",
      "role": "owner|member|readonly"
    }
  ],
  "sharedEnv": "object (optional, shared environment variables)"
}
```

**Response (create):**
```json
{
  "workspaceId": "uuid",
  "name": "string",
  "createdAt": "ISO timestamp",
  "members": "number"
}
```

**Response (list):**
```json
{
  "workspaces": [
    {
      "workspaceId": "uuid",
      "name": "string",
      "members": "number",
      "createdAt": "ISO timestamp"
    }
  ]
}
```

---

#### `license_info`
Get license status and feature tier.

**Inputs:** None

**Response:**
```json
{
  "tier": "free|pro|enterprise",
  "licenseKey": "string (redacted)",
  "expiresAt": "ISO timestamp (optional)",
  "features": {
    "auditLogging": "boolean",
    "customWorkers": "boolean",
    "advancedAnalytics": "boolean",
    "sso": "boolean"
  },
  "isValid": "boolean"
}
```

---

### Audit

#### `audit_query`
Query the immutable audit trail.

**Inputs:**
```json
{
  "actor": "string (optional, user ID)",
  "skill": "string (optional, skillId)",
  "workspace": "string (optional, workspaceId)",
  "from": "ISO timestamp (optional)",
  "to": "ISO timestamp (optional)",
  "limit": "number (optional, default 100)"
}
```

**Response:**
```json
{
  "entries": [
    {
      "timestamp": "ISO timestamp",
      "actor": "string",
      "action": "skill_invocation|workspace_update|auth_change",
      "skillId": "string",
      "workspace": "string",
      "result": "success|failure",
      "details": "object"
    }
  ],
  "totalCount": "number"
}
```

---

#### `audit_stats`
Get aggregated audit statistics.

**Inputs:** None

**Response:**
```json
{
  "totalEntries": "number",
  "skillInvocations": "number",
  "workspaceUpdates": "number",
  "authChanges": "number",
  "topSkills": [
    {
      "skillId": "string",
      "count": "number"
    }
  ]
}
```

---

### Webhooks

#### `webhook_register`
Register an incoming webhook for a skill.

**Inputs:**
```json
{
  "id": "string (webhook ID)",
  "secret": "string (HMAC-SHA256 secret)",
  "skillId": "string (skill to invoke)",
  "fieldMap": {
    "payloadField": "skillArgName"
  }
}
```

**Response:**
```json
{
  "webhookId": "string",
  "url": "string (POST endpoint URL)",
  "skillId": "string",
  "createdAt": "ISO timestamp"
}
```

---

#### `webhook_list`
List all registered webhooks.

**Inputs:** None

**Response:**
```json
{
  "webhooks": [
    {
      "id": "string",
      "url": "string",
      "skillId": "string",
      "createdAt": "ISO timestamp",
      "lastTriggered": "ISO timestamp (optional)"
    }
  ]
}
```

---

#### `webhook_delete`
Delete a registered webhook.

**Inputs:**
```json
{
  "id": "string"
}
```

**Response:**
```json
{
  "deleted": true,
  "id": "string"
}
```

---

#### `unregister_webhook`
Remove a registered webhook.

**Inputs:**
```json
{ "id": "string" }
```

---

#### `webhook_log`
Get delivery log for a specific webhook.

**Inputs:**
```json
{ "webhookId": "string", "limit": "number (optional, default 20)" }
```

---

### Event Bus (Extended)

#### `event_unsubscribe`
Remove an event bus subscription.

**Inputs:**
```json
{ "subscriptionId": "string" }
```

---

#### `event_bus_stats`
Get event bus statistics: subscription count, history size, dead letters, topic counts.

**Inputs:** None

---

#### `dead_letter_replay`
Retry failed event deliveries from the dead letter queue.

**Inputs:**
```json
{
  "limit": "number (optional, default 50)",
  "olderThanMs": "number (optional)"
}
```

---

### Circuit Breakers

#### `get_circuit_breakers`
Get circuit breaker states for all workers.

**Inputs:** None

**Response:**
```json
{
  "shell": { "state": "closed|open|half_open", "failureCount": 0, "successCount": 0 },
  "web": { ... }
}
```

---

#### `reset_circuit_breakers`
Reset all circuit breakers to closed state.

**Inputs:** None

---

### Capability Negotiation (Extended)

#### `list_capabilities`
List all registered agent capabilities in the negotiation registry.

**Inputs:** None

---

#### `capability_stats`
Get capability negotiation statistics: total capabilities, agents, health summary.

**Inputs:** None

---

### Skill Cache (Extended)

#### `cache_configure`
Configure per-skill cache TTL settings.

**Inputs:**
```json
{
  "skillId": "string",
  "ttlMs": "number (0 to disable)"
}
```

---

### Tracing (Extended)

#### `search_traces`
Search distributed traces by skill ID, status, or time range.

**Inputs:**
```json
{
  "skillId": "string (optional)",
  "status": "ok|error (optional)",
  "since": "ISO timestamp (optional)",
  "limit": "number (optional, default 20)"
}
```

---

### Agency

#### `agency_workflow_templates`
List workflow templates for ROI tracking and reports.

**Inputs:** None

**Response:**
```json
{
  "templates": [
    {
      "id": "string",
      "name": "string",
      "description": "string",
      "estimatedHoursPerWeek": "number",
      "skillIds": ["string"]
    }
  ]
}
```

---

#### `agency_roi_snapshot`
Get current ROI snapshot for active workflows.

**Inputs:** None

**Response:**
```json
{
  "snapshot": {
    "weekCount": "number",
    "totalWorkflows": "number",
    "totalHoursSaved": "number",
    "estimatedValueSaved": "number ($)",
    "topWorkflows": [
      {
        "name": "string",
        "hoursSavedPerWeek": "number"
      }
    ]
  }
}
```

---

### S&OP (Sales & Operations Planning)

#### `sop_demand_supply_match`
Reconcile demand (orders + forecasts) vs supply (MRP + inventory + POs) for given periods. Identifies gaps and revenue-at-risk.

**Inputs:**
```json
{ "periods": ["2026-03", "2026-04"] }
```

---

#### `sop_scenario_compare`
Simulate what-if adjustments (demand increase, capacity loss, supply delay) on a base reconciliation.

**Inputs:**
```json
{
  "period": "2026-03",
  "adjustment": { "type": "demand_increase|capacity_loss|supply_delay", "percentage": 20, "items": ["ITEM-001"] }
}
```

---

#### `sop_consensus_plan`
Generate S&OP consensus plan with prioritized recommendations and actions.

**Inputs:**
```json
{ "periods": ["2026-03"] }
```

---

### ESG & Compliance

#### `esg_score_entity`
Calculate ESG score for a supplier/region using OSINT data (climate, conflict, governance). Returns E/S/G sub-scores, overall rating (AAA–C), and regulatory flags (CSRD, LkSG).

**Inputs:**
```json
{
  "entityId": "string",
  "entityType": "supplier|region|product",
  "entityName": "string",
  "country": "string (optional)"
}
```

---

#### `esg_portfolio_overview`
ESG portfolio overview across all scored entities. Rating distribution, worst/best performers.

**Inputs:**
```json
{ "entityIds": ["string"] }
```

---

#### `esg_gap_analysis`
Identify ESG gaps below a target score with prioritized recommendations.

**Inputs:**
```json
{ "targetScore": 70 }
```

---

#### `carbon_footprint`
Calculate CO2e footprint for a product's supply chain (Scope 1/2/3).

**Inputs:**
```json
{ "itemNo": "string", "includeScenarios": true }
```

---

#### `compliance_report`
Generate compliance report: access control audit, audit trail analysis, data protection status, operational metrics, and ESG compliance summary.

**Inputs:**
```json
{ "workspaceId": "string (optional)", "since": "ISO timestamp (optional)", "until": "ISO timestamp (optional)" }
```

---

### Revenue Intelligence

#### `erp_customer360_profile`
Get Customer 360 profile from ERP: full customer record, transaction summary, segment, and key metrics.

**Inputs:**
```json
{ "workspaceId": "string", "customerExternalId": "string" }
```

---

#### `erp_customer360_health`
Get Customer 360 health score: payment health, churn risk, NPS proxy, and engagement level.

**Inputs:**
```json
{ "workspaceId": "string", "customerExternalId": "string" }
```

---

#### `erp_customer360_timeline`
Get Customer 360 timeline: ordered list of orders, quotes, payments, and events.

**Inputs:**
```json
{ "workspaceId": "string", "customerExternalId": "string" }
```

---

#### `erp_customer360_segments`
Get Customer 360 segments: assign customer to value/behavior/lifecycle segments.

**Inputs:**
```json
{ "workspaceId": "string", "customerExternalId": "string" }
```

---

#### `erp_customer360_churn_risk`
Get Customer 360 churn risk: score and contributing factors.

**Inputs:**
```json
{ "workspaceId": "string", "customerExternalId": "string" }
```

---

#### `erp_customer360_clv`
Calculate Customer Lifetime Value from order history. Returns CLV, order frequency, expected lifetime, and segmentation (platinum/gold/silver/bronze).

**Inputs:**
```json
{ "workspaceId": "string", "customerExternalId": "string" }
```

---

#### `q2o_win_loss_analysis`
Analyze won vs lost deals across dimensions (deal size, industry, product group, duration, discount, sentiment).

**Inputs:**
```json
{ "workspaceId": "string", "since": "ISO timestamp (optional)" }
```

---

#### `price_optimize`
Price optimization from historical quote data. Returns price bands, elasticity estimates, and pricing recommendations.

**Inputs:**
```json
{ "workspaceId": "string" }
```

---

#### `erp_revenue_forecast`
Revenue forecasting with confidence intervals using exponential smoothing + trend decomposition.

**Inputs:**
```json
{ "workspaceId": "string", "horizonMonths": 6 }
```

---

### Competitor Intelligence

#### `competitor_monitor`
Monitor a competitor via OSINT news and market signals. Returns classified signals with threat level assessment.

**Inputs:**
```json
{ "name": "string", "domains": ["string"] }
```

---

#### `osint_competitor_brief`
Generate a structured competitor intelligence brief: SWOT analysis, market position, recent moves, and strategic recommendations.

**Inputs:**
```json
{ "name": "string", "domains": ["string"] }
```

---

#### `osint_regulatory_brief`
Scan regulatory feeds for changes affecting supply chain, ESG, automotive, data, and trade.

**Inputs:**
```json
{ "categories": ["supply_chain", "esg", "automotive", "data", "trade"] }
```

---

### Supply Chain (Advanced)

#### `nearshoring_evaluate`
Multi-dimensional nearshoring analysis comparing current supplier location against target countries (labor cost, transport, ESG, carbon, geopolitical risk, quality, IP protection).

**Inputs:**
```json
{
  "vendorId": "string",
  "targetCountries": [{ "country": "string", "region": "string" }]
}
```

---

### Transformation Playbooks

#### `list_transformation_playbooks`
List available transformation playbook templates (PPAP, ERP Go-Live, Kaizen, S&OP, Supplier Qualification, Digital Twin). Filter by industry or category.

**Inputs:**
```json
{ "industry": "string (optional)", "category": "string (optional)" }
```

---

#### `execute_playbook`
Execute a transformation playbook as a multi-step workflow. Returns taskId for progress tracking.

**Inputs:**
```json
{ "playbookId": "string", "params": {} }
```

---

#### `playbook_progress`
Check progress of a running playbook/workflow execution.

**Inputs:**
```json
{ "workflowId": "string" }
```

---

#### `workflow_performance`
Workflow performance analytics: execution stats, step duration percentiles, failure rates.

**Inputs:**
```json
{ "workflowId": "string (optional)" }
```

---

### S&OP (Sales & Operations Planning)

#### `sop_demand_supply_match`
Reconcile demand (orders + forecasts) vs supply (MRP + inventory + POs) for given periods. Identifies gaps and revenue-at-risk.

**Inputs:**
```json
{ "periods": ["2026-01", "2026-02"] }
```

---

#### `sop_scenario_compare`
Simulate what-if S&OP adjustments (demand increase, capacity loss, supply delay) on a base reconciliation.

**Inputs:**
```json
{
  "period": "2026-03",
  "adjustment": {
    "type": "demand_increase",
    "percentage": 15,
    "items": ["SKU-001", "SKU-002"]
  }
}
```

---

#### `sop_consensus_plan`
Generate an S&OP consensus plan with prioritized recommendations and actions across all periods.

**Inputs:**
```json
{ "periods": ["2026-01", "2026-02", "2026-03"] }
```

---

### ESG & Compliance

#### `esg_score_entity`
Calculate ESG score for a supplier/region using OSINT data (climate, conflict, governance). Returns E/S/G sub-scores, overall rating (AAA–C), and regulatory flags (CSRD, LkSG).

**Inputs:**
```json
{
  "entityId": "SUP-001",
  "entityType": "supplier",
  "entityName": "Acme Corp",
  "country": "DE"
}
```

**Response:**
```json
{
  "entityId": "SUP-001",
  "rating": "BBB",
  "scores": { "environmental": 72, "social": 65, "governance": 80 },
  "overallScore": 72.3,
  "csrdRelevant": true,
  "lksgRelevant": true,
  "flags": ["climate_exposure_high"]
}
```

---

#### `esg_portfolio_overview`
ESG portfolio overview — rating distribution, worst/best performers, CSRD/LkSG counts.

**Inputs:**
```json
{ "entityIds": ["SUP-001", "SUP-002"] }
```

---

#### `esg_gap_analysis`
Identify ESG dimensions below target. Returns prioritized recommendations.

**Inputs:**
```json
{ "targetScore": 70 }
```

---

#### `carbon_footprint`
Calculate CO2e footprint for a product's supply chain (Scope 1/2/3). Breakdown by transport/manufacturing/raw material and by supplier. Optionally includes nearshoring scenarios.

**Inputs:**
```json
{ "itemNo": "PROD-4711", "includeScenarios": true }
```

---

#### `compliance_report`
Generate a compliance report covering access control audit, audit trail analysis, data protection status, operational metrics, and ESG compliance summary. Enterprise feature.

**Inputs:**
```json
{
  "workspaceId": "ws-abc123",
  "since": "2026-01-01T00:00:00Z",
  "until": "2026-03-31T23:59:59Z"
}
```

---

### Supply Chain Advanced

#### `nearshoring_evaluate`
Multi-dimensional nearshoring analysis comparing a vendor's current location against target countries across labor cost, transport, ESG, carbon, geopolitical risk, quality, and IP protection.

**Inputs:**
```json
{
  "vendorId": "V-4711",
  "targetCountries": [
    { "country": "PL", "region": "EU" },
    { "country": "MX", "region": "NAFTA" }
  ]
}
```

---

### Revenue Intelligence

#### `erp_revenue_forecast`
Revenue forecasting with confidence intervals using exponential smoothing and trend decomposition for monthly time series.

**Inputs:**
```json
{ "workspaceId": "ws-abc123", "horizonMonths": 6 }
```

---

#### `price_optimize`
Price optimization from historical quote data — returns price bands, elasticity estimates, and pricing recommendations per product group.

**Inputs:**
```json
{ "workspaceId": "ws-abc123" }
```

---

#### `q2o_win_loss_analysis`
Analyze won vs lost deals across dimensions (deal size, industry, product group, duration, discount, sentiment). Identifies winning patterns and recommendations.

**Inputs:**
```json
{ "workspaceId": "ws-abc123", "since": "2026-01-01T00:00:00Z" }
```

---

#### `erp_customer360_clv`
Calculate Customer Lifetime Value using order history. Returns CLV, order frequency, expected lifetime, and customer segmentation (platinum/gold/silver/bronze).

**Inputs:**
```json
{ "workspaceId": "ws-abc123", "customerExternalId": "CUST-001" }
```

---

## MCP Resources

Resources are read-only URIs accessible via the MCP resource protocol.

| URI | Content | Refresh |
|-----|---------|---------|
| `a2a://context` | Current project context (summary, goals, stack, notes) | on write |
| `a2a://health` | Worker health states (healthy/failCount/lastCheck per worker) | 30s |
| `a2a://tasks` | All active and recent async tasks | live |
| `a2a://metrics` | Skill execution metrics (call counts, p50/p95/p99, errors) | 10s |
| `a2a://circuit-breakers` | Circuit breaker states for all workers (closed/open/half_open) | 30s |
| `a2a://traces` | Recent distributed traces (last 20 with waterfall data) | 5s |
| `a2a://cache` | Skill result cache stats (hit/miss rates, size) | 10s |
| `a2a://capabilities` | Agent capability registry and version negotiation stats | 30s |
| `a2a://event-bus` | Event bus stats, subscriptions, and dead letters (last 20) | 5s |
| `a2a://pipelines` | Registered skill composition pipelines | 30s |
| `a2a://webhooks` | Registered webhook endpoints (secrets redacted) | live |
| `a2a://workspaces` | Team workspaces and members | 30s |
| `a2a://audit` | Recent audit log entries (last 20) | 60s |
| `a2a://license` | License tier and skill gates | 60s |
| `a2a://agency-workflows` | Agency workflow templates and product summary | 60s |
| `a2a://agency-roi` | Agency ROI / KPI snapshot | 60s |
| `a2a://osint/dashboard` | OSINT KPI snapshot: data freshness, worker status | live |
| `a2a://osint/workflows` | OSINT workflow templates for intelligence gathering | 60s |
| `a2a://connectors` | ERP connector health and auth status (Odoo, Business Central) | 30s |
| `a2a://connectors-kpis` | ERP connector reliability and renewal KPI snapshot | 60s |
| `a2a://connector-renewals` | Recent connector renewal incidents (success/failure feed) | 30s |
| `a2a://workers/{name}/card` | Agent card for each discovered worker | 30s |

---

## MCP Prompts

Prompts are reusable, Claude-rendered prompts for specific intelligence tasks.

### `osint_brief`
Generate an OSINT intelligence brief.

**Inputs:**
```json
{
  "topic": "string",
  "sources": ["string (optional, worker names)"]
}
```

**Output:** Markdown intelligence brief with sourcing.

---

### `osint_alert_scan`
Scan for threat alerts across multiple intelligence sources.

**Inputs:**
```json
{
  "keywords": ["string"],
  "severity": "critical|high|medium|low (optional)",
  "timeRange": "24h|7d|30d (optional)"
}
```

**Output:** Formatted alert listing with severity scoring.

---

### `osint_threat_assess`
Full threat assessment with confidence scores.

**Inputs:**
```json
{
  "entity": "string (person, organization, IP, domain)",
  "assessmentType": "person|organization|infrastructure|event"
}
```

**Output:** Comprehensive threat assessment report.

---

## A2A HTTP Endpoints

### Orchestrator (Port 8080)

#### `POST /`
Main task dispatch endpoint (tasks/send, JSON-RPC format).

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "tasks/send",
  "params": {
    "skillId": "run_shell",
    "args": {
      "command": "ls -la"
    },
    "message": "List directory"
  },
  "id": "1"
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "result": "total 48\ndrwxr-xr-x ...",
    "latency_ms": 125,
    "worker": "http://localhost:8081",
    "skillId": "run_shell"
  },
  "id": "1"
}
```

---

#### `GET /.well-known/agent.json`
Retrieve orchestrator agent card (A2A AgentCard format).

**Response:**
```json
{
  "name": "Local A2A Orchestrator",
  "version": "3.0.0",
  "description": "Multi-protocol automation orchestrator",
  "skills": [
    {
      "id": "delegate",
      "name": "Delegate",
      "description": "Route skill to worker",
      "inputs": {
        "type": "object",
        "properties": {
          "skillId": { "type": "string" },
          "args": { "type": "object" }
        }
      }
    }
  ],
  "resources": [
    { "uri": "a2a://agents", "name": "Agents" }
  ]
}
```

---

#### `GET /healthz`
Liveness probe (always returns 200 if server is up).

**Response:**
```json
{ "status": "alive", "timestamp": "2024-01-01T00:00:00.000Z" }
```

---

#### `GET /readyz`
Readiness probe (503 if workers not fully healthy).

**Response (200 OK):**
```json
{ "status": "ready", "timestamp": "2024-01-01T00:00:00.000Z" }
```

**Response (503 Service Unavailable):**
```json
{ "status": "not_ready", "timestamp": "2024-01-01T00:00:00.000Z" }
```

---

#### `GET /health`
Detailed health report per worker.

**Response:**
```json
{
  "timestamp": "ISO timestamp",
  "overallHealth": "healthy|degraded|unhealthy",
  "workers": [
    {
      "name": "shell",
      "status": "healthy",
      "uptime": "3600000 (ms)",
      "lastCheck": "ISO timestamp",
      "circuitBreaker": {
        "state": "closed",
        "failureCount": 0
      }
    }
  ]
}
```

---

#### `GET /dashboard`
HTML dashboard for monitoring.

**Response:** Interactive HTML dashboard with:
- Worker health status
- Real-time metrics charts
- Trace waterfall viewer
- Event log viewer
- Cache statistics

---

#### `POST /webhooks/:id`
Incoming webhook handler (HMAC-SHA256 verified).

**Request Headers:**
```
X-Hub-Signature-256: sha256=<HMAC-SHA256 hex>
Content-Type: application/json
```

**Request Body:**
```json
{
  "githubEvent": "push",
  "repository": "my-repo",
  "commits": [...]
}
```

**Verification:**
```
signature = hex(HMAC-SHA256(secret, body))
X-Hub-Signature-256 == "sha256=" + signature
```

**Response:**
```json
{
  "taskId": "uuid",
  "status": "queued",
  "skillId": "string (that was invoked)"
}
```

---

#### `GET /metrics`
JSON metrics snapshot. No authentication required.

**Response (application/json):**
```json
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 3600,
  "system": {
    "totalCalls": 142,
    "totalErrors": 3,
    "errorRate": "2.1%",
    "avgLatencyMs": 287
  },
  "skills": [
    {
      "skillId": "run_shell",
      "worker": "shell-agent",
      "calls": 89,
      "errors": 1,
      "errorRate": "1.1%",
      "latency": { "p50": 124, "p95": 891, "p99": 2103, "max": 4200 },
      "lastCalled": "2024-01-01T00:59:12.000Z"
    }
  ],
  "workers": [
    {
      "name": "shell-agent",
      "url": "http://localhost:8081",
      "totalCalls": 89,
      "totalErrors": 1,
      "errorRate": "1.1%",
      "avgLatencyMs": 312
    }
  ],
  "tokenSavings": {
    "totalInputTokens": 45000,
    "totalOutputTokens": 12000,
    "totalSavedTokens": 8000,
    "savingsRate": "15.4%",
    "topSkills": [{ "skillId": "ask_claude", "saved": 4200, "count": 18 }]
  }
}
```

> `tokenSavings` is optional — only present if token tracking is initialized with data.

---

## Worker A2A Endpoints

Each worker runs a Fastify HTTP server on its designated port.

### Worker Registry

| Worker | Port | Key Skills |
|--------|------|-----------|
| shell | 8081 | run_shell, read_file, write_file, SSE streaming |
| web | 8082 | fetch_url, call_api |
| ai | 8083 | ask_claude, search_files, query_sqlite |
| code | 8084 | codex_exec, codex_review |
| knowledge | 8085 | create_note, read_note, update_note, search_notes, list_notes |
| design | 8086 | enhance_ui_prompt, suggest_screens, design_critique |
| factory | 8087 | normalize_intent, create_project, quality_gate, list_pipelines |
| data | 8088 | parse_csv, parse_json, transform_data, analyze_data, pivot_table |
| news | 8089 | fetch_rss, aggregate_feeds, classify_news, cluster_news, detect_signals |
| market | 8090 | fetch_quote, price_history, technical_analysis, screen_market, detect_anomalies, correlation |
| signal | 8091 | aggregate_signals, classify_threat, detect_convergence, baseline_compare, instability_index |
| monitor | 8092 | track_conflicts, detect_surge, theater_posture, track_vessels, check_freshness, watchlist_check |
| infra | 8093 | cascade_analysis, supply_chain_map, chokepoint_assess, redundancy_score, dependency_graph |
| climate | 8094 | fetch_earthquakes, fetch_wildfires, fetch_natural_events, assess_exposure, climate_anomalies, event_correlate |
| supply-chain | 8095 | connect_erp, analyze_orders, critical_path, assess_risk, recommend_actions, monitor_dashboard, intelligence_report, predict_bottlenecks, deep_bom_analysis, run_mrp, mrp_impact |

All workers also expose `remember` and `recall` skills backed by `src/memory.ts`.

### Common to All Workers

#### `POST /a2a`
Dispatch a task to this specific worker (JSON-RPC 2.0).

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "tasks/send",
  "id": "<uuid>",
  "params": {
    "id": "<task-uuid>",
    "skillId": "run_shell",
    "args": { "command": "pwd" },
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "list current directory" }]
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "result": {
    "id": "<task-uuid>",
    "status": { "state": "completed" },
    "artifacts": [
      { "parts": [{ "kind": "text", "text": "/home/user/project" }] }
    ]
  }
}
```

---

#### `GET /.well-known/agent.json`
Worker agent card (lists available skills).

**Response:**
```json
{
  "name": "shell-worker",
  "version": "1.0.0",
  "port": 8081,
  "skills": [
    {
      "id": "run_shell",
      "description": "Execute shell commands",
      "inputs": {
        "type": "object",
        "properties": {
          "cmd": { "type": "string" }
        },
        "required": ["cmd"]
      },
      "cached": false
    },
    {
      "id": "read_file",
      "description": "Read file contents",
      "inputs": {
        "type": "object",
        "properties": {
          "path": { "type": "string" }
        }
      },
      "cached": true,
      "ttl_ms": 3600000
    }
  ]
}
```

---

#### `GET /healthz`
Worker liveness.

**Response:**
```
OK
```

---

### Shell Worker Only (Port 8081)

#### `GET /stream`
Server-Sent Events (SSE) for real-time streaming output.

**Query Params:**
- `cmdId` (string, optional) — Filter events for a specific command execution

**Response (text/event-stream):**
```
event: start
data: {"cmdId": "uuid", "cmd": "long-running-task", "timestamp": "ISO"}

event: output
data: {"line": "Processing item 1...", "timestamp": "ISO"}

event: output
data: {"line": "Processing item 2...", "timestamp": "ISO"}

event: end
data: {"exitCode": 0, "totalTime": 5000}
```

---

## Authentication & RBAC

### MCP (stdio protocol)
No authentication required. Claude Code passes tasks via stdin/stdout.

### A2A HTTP Endpoints
Bearer token via `Authorization` header only.

**Request:**
```
Authorization: Bearer sk_live_abc123...
```

### API Key Management

**Create API Key (admin only):**
```bash
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer admin_key" \
  -d '{
    "jsonrpc": "2.0",
    "method": "auth/create_key",
    "params": {
      "name": "data-pipeline-key",
      "role": "operator",
      "allowedSkills": ["parse_csv", "parse_json", "analyze_data"],
      "deniedSkills": ["write_file", "run_shell"],
      "expiresAt": "2026-12-31T23:59:59Z"
    },
    "id": "1"
  }'
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "keyId": "uuid",
    "key": "sk_live_abc123... (show once)",
    "role": "operator",
    "createdAt": "ISO timestamp"
  },
  "id": "1"
}
```

### Role Definitions

| Role | Capabilities |
|------|--------------|
| `admin` | All actions (create keys, manage workers, deploy) |
| `operator` | Execute skills, view metrics, manage workflows |
| `viewer` | Read-only access to metrics, logs, status |

### Skill-Level Access Control

Each API key has:
- **allowedSkills** — Explicit allow list (if empty, all skills allowed)
- **deniedSkills** — Explicit deny list (deny overrides allow)

Example:
```json
{
  "keyId": "key_123",
  "role": "operator",
  "allowedSkills": ["parse_csv", "run_shell"],
  "deniedSkills": ["write_file"],
  "restrictions": {
    "maxCallsPerMinute": 1000,
    "maxConcurrency": 10
  }
}
```

---

## Data Models & Schemas

### AgentCard
Returned by `GET /.well-known/agent.json` on each worker. Defined in `src/types.ts`.

```typescript
interface AgentCard {
  name: string;           // e.g. "shell-agent"
  description: string;
  url: string;            // e.g. "http://localhost:8081"
  version: string;
  capabilities: { streaming: boolean };
  skills: AgentSkill[];
}

interface AgentSkill {
  id: string;             // e.g. "run_shell"
  name: string;
  description: string;
}
```

JSON example:
```json
{
  "name": "shell-agent",
  "description": "Shell command execution worker",
  "url": "http://localhost:8081",
  "version": "3.0.0",
  "capabilities": { "streaming": true },
  "skills": [
    {
      "id": "run_shell",
      "name": "Run Shell Command",
      "description": "Execute a shell command and return stdout"
    },
    {
      "id": "read_file",
      "name": "Read File",
      "description": "Read file contents from disk"
    }
  ]
}
```

### WorkflowDefinition
```json
{
  "id": "string (optional, generated if missing)",
  "steps": [
    {
      "id": "string",
      "skillId": "string",
      "args": "object (supports {{templates}})",
      "depends_on": ["stepId (optional)"],
      "onError": "fail|skip|retry (optional, default: fail)",
      "retries": "number (optional, default: 0)",
      "timeout": "number (ms, optional)"
    }
  ],
  "timeout": "number (ms, optional, default: 300000)"
}
```

### Pipeline (Skill Composition)
```json
{
  "id": "string (optional)",
  "steps": [
    {
      "skillId": "string",
      "args": "object (supports {{prev.result}}, {{input.*}})",
      "alias": "string (optional)",
      "onError": "abort|skip|fallback (optional, default: abort)",
      "fallback": "any (optional)"
    }
  ]
}
```

### Span (Distributed Tracing)
```json
{
  "traceId": "uuid",
  "spanId": "uuid",
  "parentSpanId": "uuid (optional)",
  "name": "string",
  "kind": "INTERNAL|SERVER|CLIENT|PRODUCER|CONSUMER",
  "startTime": "ISO timestamp",
  "endTime": "ISO timestamp (optional, if completed)",
  "duration": "number (ms)",
  "attributes": "object (key-value tags)",
  "events": [
    {
      "name": "string",
      "timestamp": "ISO timestamp",
      "attributes": "object"
    }
  ],
  "status": {
    "code": "UNSET|OK|ERROR",
    "message": "string (optional)"
  }
}
```

---

## Examples & Workflows

### Example 1: Simple Skill Delegation

**Task:** Run a shell command and read its output.

**MCP Tool Call:**
```
delegate
  skillId="run_shell"
  args={"cmd":"echo 'Hello World'"}
  message="Test shell execution"
```

**Orchestrator Routing:**
1. Looks up `run_shell` → owned by shell-worker (8081)
2. Sends to `http://localhost:8081/` with JSON-RPC
3. Receives response
4. Returns to caller

**Response:**
```json
{
  "result": "Hello World\n",
  "latency_ms": 52,
  "worker": "http://localhost:8081",
  "skillId": "run_shell"
}
```

---

### Example 2: Multi-Step Workflow

**Task:** Parse CSV, analyze data, save results.

**MCP Tool Call:**
```
workflow_execute
  workflow={
    "steps": [
      {
        "id": "parse",
        "skillId": "parse_csv",
        "args": {"file": "/data/sales.csv"}
      },
      {
        "id": "analyze",
        "skillId": "analyze_data",
        "args": {"data": "{{parse.result}}", "metrics": ["avg", "sum"]},
        "depends_on": ["parse"]
      },
      {
        "id": "save",
        "skillId": "write_file",
        "args": {
          "path": "/output/analysis.json",
          "content": "{{analyze.result}}"
        },
        "depends_on": ["analyze"]
      }
    ]
  }
```

**Execution:**
1. Step "parse" runs on data-worker (8088)
2. Step "analyze" runs on data-worker, receives parse output
3. Step "save" runs on shell-worker, receives analyze output
4. All steps complete in sequence (DAG-ordered)

**Response:**
```json
{
  "workflowId": "wf_uuid",
  "status": "completed",
  "steps": [
    {
      "id": "parse",
      "status": "completed",
      "result": [[header1, header2], [row1_col1, row1_col2], ...],
      "latency": 234
    },
    {
      "id": "analyze",
      "status": "completed",
      "result": {"avg": 45.2, "sum": 1234},
      "latency": 156
    },
    {
      "id": "save",
      "status": "completed",
      "result": { "bytes": 512, "path": "/output/analysis.json" },
      "latency": 89
    }
  ],
  "totalTime": 479
}
```

---

### Example 3: Collaborative Consensus

**Task:** Classify a news article using multiple AI perspectives.

**MCP Tool Call:**
```
collaborate
  strategy="consensus"
  agents=["http://localhost:8083", "http://localhost:8089"]
  skillId="classify_news"
  args={"article": "...article text..."}
  mergeStrategy="majority_vote"
```

**Execution:**
1. Fan-out to ai-worker and news-worker
2. Each applies `classify_news` skill
3. Merge via majority voting on category/sentiment
4. Return consensus result

**Response:**
```json
{
  "collaborationId": "collab_uuid",
  "strategy": "consensus",
  "status": "completed",
  "results": [
    {
      "agent": "http://localhost:8083",
      "result": {"category": "tech", "sentiment": "positive"},
      "score": 0.95
    },
    {
      "agent": "http://localhost:8089",
      "result": {"category": "tech", "sentiment": "neutral"},
      "score": 0.88
    }
  ],
  "mergedResult": {
    "category": "tech",
    "sentiment": "positive",
    "consensus": 0.92
  },
  "totalTime": 1250
}
```

---

### Example 4: Project Generation with Factory Workflow

**Task:** Generate a complete REST API from a high-level idea.

**MCP Tool Call:**
```
factory_workflow
  idea="Build a task management API with authentication, CRUD for tasks, filtering by status and due date"
  pipeline="api"
```

**Execution:**
1. **Intent Normalization** (ai-worker) → structured spec
2. **Code Generation** (code-worker + ai-worker) → API routes, models, middleware
3. **Scaffolding** (shell-worker) → create files, install deps
4. **Quality Gate** (code-worker) → lint, type-check, test
5. **Fix Loop** if scores < threshold

**Response:**
```json
{
  "projectId": "proj_uuid",
  "status": "completed",
  "pipeline": "api",
  "spec": "REST API for task management with JWT auth, CRUD endpoints for tasks (GET, POST, PUT, DELETE), filtering, sorting...",
  "files": {
    "count": 24,
    "paths": [
      "src/server.ts",
      "src/routes/tasks.ts",
      "src/models/task.ts",
      "src/middleware/auth.ts",
      ...
    ]
  },
  "qualityGate": {
    "score": 92,
    "dimensions": {
      "architecture": 95,
      "performance": 90,
      "security": 88,
      "testCoverage": 92
    }
  }
}
```

---

### Example 5: Webhook Integration

**Setup:** Register a GitHub webhook

**1. Create Webhook via MCP:**
```
webhook_register
  id="github_push_processor"
  secret="whsec_my_secret_123"
  skillId="process_commit"
  fieldMap={
    "repository.name": "repoName",
    "commits": "commitList"
  }
```

**Response:**
```json
{
  "webhookId": "github_push_processor",
  "url": "http://my-server:8080/webhooks/github_push_processor",
  "skillId": "process_commit",
  "createdAt": "ISO timestamp"
}
```

**2. GitHub sends webhook to registered URL:**
```bash
curl -X POST http://my-server:8080/webhooks/github_push_processor \
  -H "X-Webhook-Signature: sha256=abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "repository": { "name": "my-repo" },
    "commits": [...]
  }'
```

**3. Orchestrator verifies HMAC, invokes skill:**
```
skill: process_commit
args: {
  "repoName": "my-repo",
  "commitList": [...]
}
```

---

### Example 6: Event Bus Pub/Sub

**Subscribe to events:**
```
event_subscribe
  pattern="workflow.#"
```

**Publish events:**
```
event_publish
  topic="workflow.user123.step1.completed"
  data={
    "stepName": "data_validation",
    "duration_ms": 450,
    "status": "success"
  }
```

**Event received (async):**
```json
{
  "eventId": "evt_uuid",
  "topic": "workflow.user123.step1.completed",
  "data": {
    "stepName": "data_validation",
    "duration_ms": 450,
    "status": "success"
  },
  "timestamp": "ISO timestamp"
}
```

---

### Example 7: Distributed Tracing Waterfall

**Initiate a complex task:**
```
delegate
  skillId="process_order"
  args={"orderId": "123"}
  message="Process order with audit trail"
```

**Traces auto-created (integrated into delegate flow). Retrieve via MCP tool:**

```
get_trace
  traceId="trace_abc123"
```

**Response:**
```json
{
  "traceId": "trace_abc123",
  "startTime": "2026-03-14T10:00:00Z",
  "waterfall": [
    {
      "spanId": "span_1",
      "parentSpanId": null,
      "operationName": "delegate:process_order",
      "durationMs": 1200,
      "status": "ok"
    },
    {
      "spanId": "span_1a",
      "parentSpanId": "span_1",
      "operationName": "worker:data.fetch_order",
      "durationMs": 150,
      "status": "ok"
    },
    {
      "spanId": "span_1b",
      "parentSpanId": "span_1",
      "operationName": "worker:shell.audit_log",
      "durationMs": 80,
      "status": "ok"
    },
    {
      "spanId": "span_1c",
      "parentSpanId": "span_1",
      "operationName": "worker:ai.validate",
      "durationMs": 900,
      "status": "ok"
    }
  ]
}
```

> Tracing is MCP-only. There is no `GET /traces` HTTP endpoint. Use the `list_traces`, `get_trace`, and `search_traces` MCP tools to access trace data.

---

### Example 8: Sandbox Code Execution with Persistence

**Execute TypeScript with persistent variables:**
```
sandbox_execute
  code='
    const data = await skill("fetch_quote", {ticker: "AAPL"});
    const trend = data.close > data.open ? "up" : "down";
    $vars.lastTrend = trend;
    $vars.lastPrice = data.close;
    trend
  '
```

**Response:**
```json
{
  "result": "up",
  "output": "",
  "errors": "",
  "executionTime": 234,
  "indexed": false
}
```

**Later, retrieve persisted variables:**
```
sandbox_vars
  action="list"
```

```json
{
  "variables": [
    {
      "name": "lastTrend",
      "size": 3,
      "createdAt": "2026-03-14T10:00:00Z"
    },
    {
      "name": "lastPrice",
      "size": 8,
      "createdAt": "2026-03-14T10:00:00Z"
    }
  ]
}
```

---

## Configuration

### Server Configuration (`~/.a2a-mcp/config.json`)

```json
{
  "server": {
    "port": 8080,
    "apiKey": "sk_live_...",
    "logLevel": "info"
  },
  "workers": {
    "enabled": ["shell", "web", "ai", "data", "code"],
    "profile": "lite"
  },
  "remoteWorkers": [
    {
      "name": "external-ai",
      "url": "https://external-ai.example.com"
    }
  ],
  "memory": {
    "backend": "sqlite|obsidian|both",
    "obsidianVault": "~/Documents/Obsidian/a2a-knowledge"
  },
  "cache": {
    "defaultTTL": 3600000,
    "maxSize": 1000
  },
  "audit": {
    "enabled": true,
    "retention": 30
  },
  "webhooks": {
    "timeout": 30000
  }
}
```

---

## Troubleshooting

### Circuit Breaker States

| State | Meaning | Auto-Recovery |
|-------|---------|---------------|
| `closed` | Worker healthy, requests flow | N/A |
| `open` | Worker failing, requests blocked | After cooldown (30-60s) |
| `half_open` | Testing recovery, limited requests | Transitions to closed/open based on results |

**Check health:**
```
GET /health → circuitBreaker.state, lastFailure
```

### High Latency

1. Check worker load: `GET /metrics` → `activeCallCount`
2. Check cache hit rate: `cache_stats`
3. Consider capability negotiation: `negotiate_capability` for alternative workers

### Missing Skills

1. List available: `list_agents` → verify skill in worker card
2. Check worker health: `worker_health`
3. Verify RBAC: API key allowed skills vs. denied skills

---

## Versioning & Compatibility

- **MCP Protocol:** Follows Claude Code's MCP spec (current SDK version)
- **A2A Protocol:** HTTP JSON-RPC 2.0 compatible
- **Orchestrator version:** `3.0.0` — reported in `/.well-known/agent.json` and MCP server identity
- **Semantic Versioning:** Workers and skills use SemVer (e.g., 1.2.3). Use `negotiate_capability` with `minVersion` to enforce version constraints at routing time.
- **Backward Compatibility:** Major version changes may break existing task formats. `delegate_async` is a legacy alias for `delegate` with `async: true`.

### API Stability Tiers

| Tier | Description | Change Policy |
|------|-------------|---------------|
| **Stable** | `delegate`, `list_agents`, `sandbox_execute`, all worker skills | Semver-gated breaking changes |
| **Beta** | OSINT orchestration tools, ERP connectors, collaboration | May change in minor versions |
| **Experimental** | S&OP, ESG scoring, revenue intelligence, nearshoring | May change without notice |

---

## OpenAPI Specification & Interactive Docs

A machine-readable OpenAPI 3.1.0 specification is maintained at `docs/openapi.yaml`.

### Viewing Interactive Docs

Using Redoc (no server needed):
```bash
npx @redocly/cli preview-docs docs/openapi.yaml
```

Using Swagger UI:
```bash
npx swagger-ui-watcher docs/openapi.yaml
```

Or open `docs/architecture.html` in a browser for the architecture diagram.

### Linting the Spec

```bash
npx @stoplight/spectral-cli lint docs/openapi.yaml
```

### Generating an SDK

```bash
# TypeScript client
npx @openapitools/openapi-generator-cli generate \
  -i docs/openapi.yaml \
  -g typescript-fetch \
  -o ./sdk/typescript

# Python client
npx @openapitools/openapi-generator-cli generate \
  -i docs/openapi.yaml \
  -g python \
  -o ./sdk/python
```

---

**End of API Reference**