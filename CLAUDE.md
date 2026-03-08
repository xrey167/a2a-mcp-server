# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime

This project uses **Bun** exclusively — no Node.js, no build step. TypeScript runs directly.

```bash
bun src/server.ts          # start full stack (orchestrator + all workers)
bun src/workers/shell.ts   # start a single worker in isolation
bun build src/server.ts --target bun  # type-check via bundler (no tsc installed)
```

## MCP Registration

The server is registered with Claude Code at user scope:

```bash
claude mcp add --scope user a2a-mcp-bridge -- bun /Users/xrey/Developer/a2a-mcp-server/src/server.ts
claude mcp list   # verify connection
```

To test a tool in a fresh session without restarting Claude Code:
```bash
env -u CLAUDECODE claude -p "Use the delegate tool to ..." --allowedTools "mcp__a2a-mcp-bridge__delegate"
```

## Architecture

**Single entry point:** `src/server.ts` is the MCP server AND the A2A orchestrator (port 8080). On startup it spawns all 7 worker processes via `Bun.spawn`, then discovers their agent cards via `GET /.well-known/agent.json` using exponential-backoff retry (up to 5 attempts per worker).

**Worker agents** (standalone Fastify HTTP servers, each a separate process):
| File | Port | Skills |
|---|---|---|
| `src/workers/shell.ts` | 8081 | run_shell, read_file, write_file + SSE streaming at `/stream` |
| `src/workers/web.ts` | 8082 | fetch_url, call_api |
| `src/workers/ai.ts` | 8083 | ask_claude, search_files, query_sqlite |
| `src/workers/code.ts` | 8084 | codex_exec, codex_review (via `codex exec` subprocess) |
| `src/workers/knowledge.ts` | 8085 | create_note, read_note, update_note, search_notes, list_notes |
| `src/workers/design.ts` | 8086 | enhance_ui_prompt, suggest_screens, design_critique (Gemini-powered) |
| `src/workers/factory.ts` | 8087 | normalize_intent, create_project, quality_gate, list_pipelines (AppFactory-style project gen) |

All workers also have `remember` / `recall` skills backed by `src/memory.ts`.

**Project Factory (AppFactory-style):** `factory_workflow` is an async orchestrator skill that generates complete projects from a vague idea. Pipeline types defined in `src/pipelines/`: app (Expo), website (Next.js), mcp-server (MCP + Bun), agent (AI agent), api (REST). Each pipeline has: intent normalization prompts, scaffolding templates, code generation steps, and quality gate criteria ("Ralph Mode" — multi-dimension scoring with fix loops). The factory worker coordinates ai-agent (spec + code gen), shell-agent (file I/O), and code-agent (review).

**Sandbox execution:** `sandbox_execute` runs TypeScript in isolated Bun subprocesses with access to all worker skills via `skill(id, args)`. Variables persist per session in SQLite. Results >4KB auto-indexed for FTS5 search via `search(varName, query)`. `sandbox_vars` manages persisted variables.

**Shared modules:**
- `src/a2a.ts` — `sendTask(url, params)` and `discoverAgent(url)` helpers
- `src/memory.ts` — dual-write: SQLite (`~/.a2a-memory.db`) + Obsidian markdown (`~/Documents/Obsidian/a2a-knowledge/_memory/`)
- `src/skills.ts` — built-in skill registry; also used as fallback routing when no worker owns a skill
- `src/sandbox.ts` — sandbox executor: spawns isolated Bun subprocesses, handles stdin/stdout IPC for skill calls, manages timeout/cleanup
- `src/sandbox-store.ts` — `~/.a2a-sandbox.db`: variable persistence (SQLite) + FTS5 auto-indexing for large results (>4KB)
- `src/sandbox-prelude.ts` — TypeScript prelude template injected into sandbox code (skill(), search(), helpers, $vars)

**Routing in `delegate` skill (server.ts):**
1. `agentUrl` provided → send directly
2. `skillId` provided → look up which worker owns it → forward
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
2. Add an entry to `WORKERS` array in `src/server.ts`
3. All worker output must go to stderr only
