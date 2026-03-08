# AI Agent Template

**Pipeline**: agent
**Category**: AI / Automation
**Stack**: TypeScript, Bun, @anthropic-ai/sdk, Fastify

---

## Description

An AI agent with a tool-calling loop powered by Claude. Includes a Fastify HTTP API server and CLI mode. The agent autonomously selects and invokes tools until the task is complete.

---

## Pre-Configured Features

- Claude tool-use loop with automatic tool dispatch
- Tool registry pattern (spec + execute per tool)
- Fastify API server (POST /ask, GET /health)
- CLI mode (bun src/agent.ts "question")
- System prompt with configurable personality
- Max-turns safety limit (10 by default)
- Error handling for tool failures
- Example tools: get_time, calculate

---

## File Structure

```
<project>/
├── package.json
├── tsconfig.json
├── src/
│   ├── agent.ts              # Agent core: tool-use loop
│   ├── server.ts             # Fastify HTTP API
│   └── tools/
│       └── index.ts          # Tool registry (spec + handler)
```

---

## Default Tech Stack

| Component | Technology |
|---|---|
| Runtime | Bun |
| Language | TypeScript (strict) |
| AI SDK | @anthropic-ai/sdk ^0.39.0 |
| Model | claude-sonnet-4-6 |
| HTTP | Fastify ^5.0.0 |

---

## Usage

The AI generates domain-specific tools based on the spec. Each tool defines an Anthropic-format spec and an async execute handler.

**Example prompt enhancement:**
- User says: "research agent"
- AI adds: web_search, extract_content, summarize, save_notes tools, research memory with SQLite, structured output formatting, citation tracking

---

## Quality Checklist

- [ ] Agent completes a basic tool-use loop without errors
- [ ] All tools return string results (not objects)
- [ ] Tool errors don't crash the agent loop
- [ ] System prompt matches the spec's personality
- [ ] API server responds to POST /ask with JSON
- [ ] Health endpoint returns status and uptime
- [ ] Max-turns limit prevents infinite loops
- [ ] Tool input schemas match Anthropic's format
