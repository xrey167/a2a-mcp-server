# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime

This project uses **Bun** exclusively — no Node.js, no build step. TypeScript runs directly.

```bash
bun src/server.ts          # start full stack (orchestrator + all workers)
bun src/workers/shell.ts   # start a single worker in isolation
bun build src/server.ts --target bun  # type-check via bundler (no tsc installed)
bun src/cli.ts create-worker my-tool  # scaffold a custom worker
```

## MCP Registration

The server is registered with Claude Code at user scope:

```bash
claude mcp add --scope user a2a-mcp-bridge -- bun $(pwd)/src/server.ts
claude mcp list   # verify connection
```

To test a tool in a fresh session without restarting Claude Code:
```bash
env -u CLAUDECODE claude -p "Use the delegate tool to ..." --allowedTools "mcp__a2a-mcp-bridge__delegate"
```

## Architecture

**Single entry point:** `src/server.ts` is the MCP server AND the A2A orchestrator (port 8080). On startup it spawns local worker processes via `Bun.spawn` (filtered by config `workers.enabled` and `profile`), then discovers their agent cards via `GET /.well-known/agent.json` using exponential-backoff retry (up to 5 attempts per worker). Also discovers `remoteWorkers` configured in `~/.a2a-mcp/config.json` (no local process spawned).

**Profiles:** `full` (all 14 workers), `lite` (shell+web+ai), `data` (shell+web+ai+data), `osint` (shell+web+ai+news+market+signal+monitor+infra+climate). Set via `{ "profile": "lite" }` in config or `bun src/cli.ts init --lite`.

**Remote workers:** Any A2A agent running elsewhere can be added via `remoteWorkers` config. The orchestrator discovers it, health-polls it, and routes skills to it. The URL is whitelisted in SSRF validation automatically.

**Worker agents** (standalone Fastify HTTP servers, each a separate process):
| File | Port | Skills |
|---|---|---|
| `src/workers/shell.ts` | 8081 | run_shell, read_file, write_file + SSE streaming at `/stream` |
| `src/workers/web.ts` | 8082 | fetch_url, call_api, scrape_page |
| `src/workers/ai.ts` | 8083 | ask_claude, search_files, query_sqlite |
| `src/workers/code.ts` | 8084 | codex_exec, codex_review (via `codex exec` subprocess) |
| `src/workers/knowledge.ts` | 8085 | create_note, read_note, update_note, delete_note, search_notes, list_notes, summarize_notes |
| `src/workers/design.ts` | 8086 | enhance_ui_prompt, suggest_screens, design_critique (Gemini-powered) |
| `src/workers/factory.ts` | 8087 | normalize_intent, create_project, quality_gate, list_pipelines, list_templates (AppFactory-style project gen) |
| `src/workers/data.ts` | 8088 | parse_csv, parse_json, transform_data, analyze_data, pivot_table, fetch_dataset |
| `src/workers/news.ts` | 8089 | fetch_rss, aggregate_feeds, classify_news, cluster_news, detect_signals, regulatory_scan |
| `src/workers/market.ts` | 8090 | fetch_quote, price_history, technical_analysis, screen_market, detect_anomalies, correlation, market_composite, market_brief |
| `src/workers/signal.ts` | 8091 | aggregate_signals, classify_threat, detect_convergence, baseline_compare, instability_index, correlate_signals, fetch_cyber_c2, fetch_malicious_urls, fetch_outages |
| `src/workers/monitor.ts` | 8092 | track_conflicts, detect_surge, theater_posture, track_vessels, check_freshness, watchlist_check, fetch_conflicts, fetch_flights, fetch_vessels |
| `src/workers/infra.ts` | 8093 | cascade_analysis, supply_chain_map, chokepoint_assess, redundancy_score, dependency_graph, load_infrastructure, fetch_cables |
| `src/workers/climate.ts` | 8094 | fetch_earthquakes, fetch_wildfires, fetch_natural_events, assess_exposure, climate_anomalies, event_correlate, fetch_weather |
| `src/workers/supply-chain.ts` | 8095 | connect_erp, analyze_orders, critical_path, assess_risk, recommend_actions, monitor_dashboard, intelligence_report, predict_bottlenecks, deep_bom_analysis, run_mrp, mrp_impact, vendor_health, firm_orders, execute_interventions, value_stream_map, smed_analysis, line_balance, supplier_audit_prepare, dual_source_optimize |

All workers also have `remember` / `recall` skills backed by `src/memory.ts`.

**Project Factory (AppFactory-style):** `factory_workflow` is an async orchestrator skill that generates complete projects from a vague idea. Pipeline types defined in `src/pipelines/`: app (Expo), website (Next.js), mcp-server (MCP + Bun), agent (AI agent), api (REST), cli (CLI tool). Each pipeline has: intent normalization prompts, scaffolding templates, code generation steps, and quality gate criteria ("Ralph Mode" — multi-dimension scoring with fix loops). The factory worker coordinates ai-agent (spec + code gen), shell-agent (file I/O), and code-agent (review).

**Sandbox execution:** `sandbox_execute` runs TypeScript in isolated Bun subprocesses with access to all worker skills via `skill(id, args)`. Variables persist per session in SQLite. Results >4KB auto-indexed for FTS5 search via `search(varName, query)`. `sandbox_vars` manages persisted variables.

**Workflow Engine:** `workflow_execute` runs multi-step DAG-based workflows across agents. Steps declare dependencies and the engine executes them in topological order with max parallelism. Supports template references `{{stepId.result}}` for piping outputs, conditional execution, and per-step error handling (fail/skip/retry).

**Resilience:**
- `src/circuit-breaker.ts` — Per-worker circuit breakers (closed→open→half_open) that fail fast when workers are unhealthy, auto-recover after cooldown
- `src/metrics.ts` — Skill execution metrics (call counts, latencies p50/p95/p99, error rates) exposed via `get_metrics` tool and `a2a://metrics` resource

**Webhooks:**
- `src/webhooks.ts` — Register webhook endpoints that trigger A2A tasks from external services (GitHub, Stripe, etc.)
- HMAC-SHA256 signature verification, payload field mapping, async task creation
- Endpoints: `POST /webhooks/:id` on the A2A HTTP server

**Agent Event Bus:**
- `src/event-bus.ts` — Real-time pub/sub between agents with topic-based routing
- Topic patterns with wildcards: `*` (one segment), `#` (multi-segment) — e.g. `agent.*.completed`, `workflow.#`
- Event history with configurable retention, replay from timestamp, dead letter queue for failed deliveries
- MCP tools: `event_publish`, `event_subscribe`, `event_replay`; resource: `a2a://event-bus`
- Events auto-published on agent completion/failure (integrated into delegate flow)

**Skill Composition (Pipeline Engine):**
- `src/skill-composer.ts` — Declarative skill chaining with pipe() semantics
- Each step's output feeds the next; template refs: `{{prev.result}}`, `{{input.*}}`, `{{steps.alias.result}}`
- Error strategies per step: abort (default), skip, or fallback value
- Conditional execution with `when` expressions
- MCP tools: `compose_pipeline`, `execute_pipeline`, `list_pipelines`; resource: `a2a://pipelines`

**Agent Collaboration:**
- `src/agent-collaboration.ts` — Multi-agent consensus and negotiation protocols
- Strategies: `fan_out` (parallel query + merge), `consensus` (AI-scored voting), `debate` (iterative critique/refinement), `map_reduce` (distribute + aggregate)
- Configurable merge strategies: concat, best_score, majority_vote, custom (with LLM merge prompt)
- MCP tool: `collaborate` (returns taskId for async polling)

**Distributed Tracing:**
- `src/tracing.ts` — OpenTelemetry-style trace/span observability across agent calls
- Trace → Span hierarchy with automatic context propagation
- Span tags, events, status tracking, waterfall visualization data
- Integrated into delegate flow: every delegation creates a trace with child spans per worker call
- MCP tools: `list_traces`, `get_trace` (waterfall view), `search_traces`; resource: `a2a://traces`

**Smart Skill Cache:**
- `src/skill-cache.ts` — LRU cache with TTL for idempotent skill results
- Content-addressable keys (deterministic hashing of skillId + args)
- Per-skill TTL configuration; auto-excludes side-effect skills (run_shell, write_file, etc.)
- Integrated into delegate flow: cache check before worker call, auto-cache on success
- MCP tools: `cache_stats`, `cache_invalidate`, `cache_configure`; resource: `a2a://cache`

**Capability Negotiation:**
- `src/capability-negotiation.ts` — Version-aware skill routing with SemVer matching
- Multi-dimensional scoring: version, required/preferred features, health, load, priority
- Auto-populated from worker discovery; health synced from health polling
- Active call tracking for load-aware routing
- MCP tools: `negotiate_capability`, `list_capabilities`, `capability_stats`; resource: `a2a://capabilities`

**Auth & RBAC:**
- `src/auth.ts` — API key management with SHA-256 hashing, role-based access (admin/operator/viewer), per-key skill allow/deny lists
- `src/workspace.ts` — Team workspaces with members, roles (owner/member/readonly), shared env, knowledge dirs
- MCP tools: `workspace_manage` (CRUD); resource: `a2a://workspaces`

**Audit Logging (Enterprise):**
- `src/audit.ts` — Immutable SQLite audit trail (`~/.a2a-mcp/audit.db`) of all skill invocations
- Queryable by actor, skill, workspace, time range; auto-indexed
- MCP tools: `audit_query`, `audit_stats`; resource: `a2a://audit`

**Skill Tiers (Open-Core):**
- `src/skill-tier.ts` — Free/pro/enterprise skill gating with base64-encoded license keys
- License via `~/.a2a-mcp/license.json` or `A2A_LICENSE_KEY` env var
- MCP tools: `license_info`; resource: `a2a://license`

**Cloud Deployment:**
- `src/cloud.ts` — Health endpoints (`/healthz`, `/readyz`, `/health`), graceful shutdown, readiness probes
- `fly.toml` — Fly.io deployment config
- `railway.json` — Railway deployment config

**Shared modules:**
- `src/a2a.ts` — `sendTask(url, params)` and `discoverAgent(url)` helpers
- `src/memory.ts` — dual-write: SQLite (`~/.a2a-memory.db`) + Obsidian markdown (`~/Documents/Obsidian/a2a-knowledge/_memory/`)
- `src/skills.ts` — built-in skill registry; also used as fallback routing when no worker owns a skill
- `src/sandbox.ts` — sandbox executor: spawns isolated Bun subprocesses, handles stdin/stdout IPC for skill calls, manages timeout/cleanup
- `src/sandbox-store.ts` — `~/.a2a-sandbox.db`: variable persistence (SQLite) + FTS5 auto-indexing for large results (>4KB)
- `src/sandbox-prelude.ts` — TypeScript prelude template injected into sandbox code (skill(), search(), helpers, $vars)
- `src/circuit-breaker.ts` — circuit breaker pattern for worker calls
- `src/metrics.ts` — execution metrics collection
- `src/workflow-engine.ts` — DAG-based multi-agent workflow orchestration
- `src/webhooks.ts` — webhook registration, verification, and payload transformation
- `src/event-bus.ts` — agent event bus (pub/sub with topic wildcards)
- `src/skill-composer.ts` — declarative skill pipeline composition
- `src/agent-collaboration.ts` — multi-agent collaboration protocols
- `src/tracing.ts` — distributed tracing with waterfall visualization
- `src/skill-cache.ts` — LRU skill result cache with per-skill TTL
- `src/capability-negotiation.ts` — version-aware capability negotiation for skill routing
- `src/worker-loader.ts` — discovers and scaffolds user-space workers from `~/.a2a-mcp/workers/`

**Routing in `delegate` skill (server.ts):**
1. `agentUrl` provided → send directly (through circuit breaker)
2. `skillId` provided → look up which worker owns it → forward (through circuit breaker)
3. Neither → ask ai-agent's `ask_claude` to pick `{url, skillId}` from worker cards

## Key Constraints

**stdout is reserved for MCP JSON-RPC.** All logging must use `process.stderr.write(...)`. Never use `console.log` in any file — it will corrupt the MCP protocol stream.

**Imports must use `.js` extensions** (ESM), e.g. `import { memory } from "../memory.js"`.

**Auth:**
- Claude API: tries `ANTHROPIC_API_KEY` first, falls back to spawning `claude -p` subprocess with `CLAUDECODE` env var unset (uses Claude Code's OAuth automatically)
- Codex CLI: uses ChatGPT OAuth from `~/.codex/auth.json` (already authenticated, no API key needed)
- Obsidian vault: direct filesystem access at `~/Documents/Obsidian/a2a-knowledge` (override with `OBSIDIAN_VAULT` env)

## Adding a New Worker

1. Create `src/workers/<name>.ts` — Fastify on a new port, export an `AGENT_CARD` and implement skills
2. Add an entry to `ALL_WORKERS` array in `src/server.ts` (ALLOWED_PORTS is auto-derived)
3. Optionally create a persona file at `src/personas/<name>.md`
4. All worker output must go to stderr only
