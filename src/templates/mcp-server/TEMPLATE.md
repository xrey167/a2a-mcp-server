# MCP Server Template

**Pipeline**: mcp-server
**Category**: Developer Tools
**Stack**: TypeScript, Bun, @modelcontextprotocol/sdk 1.12

---

## Description

A Model Context Protocol server that exposes tools and resources via stdio transport. Includes a clean tool registry pattern with separate definition and handler files.

---

## Pre-Configured Features

- MCP SDK with stdio transport (works with Claude Code, Claude Desktop)
- Tool registry pattern (registerTools / handleToolCall)
- Resource handler (status endpoint)
- Example tools: hello, echo
- Type-safe tool definitions with JSON Schema input validation
- Inspector-compatible (npx @anthropic-ai/model-context-protocol inspect)

---

## File Structure

```
<project>/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # MCP server entry point (stdio)
│   └── tools/
│       └── index.ts          # Tool registry + handlers
```

---

## Default Tech Stack

| Component | Technology |
|---|---|
| Runtime | Bun |
| Language | TypeScript (strict) |
| MCP SDK | @modelcontextprotocol/sdk ^1.12.0 |
| Transport | stdio (default) |

---

## Usage

The AI generates additional tools and resources based on the spec. Each tool gets a JSON Schema input definition and an async handler.

**Example prompt enhancement:**
- User says: "GitHub MCP server"
- AI adds: list_repos, get_issues, create_issue, search_code tools, repo://owner/name resources, GitHub API client with token auth

---

## Quality Checklist

- [ ] Server starts without errors on stdio
- [ ] All tools listed via ListTools request
- [ ] Tool input schemas are valid JSON Schema
- [ ] Error responses use isError: true
- [ ] No console.log (stdout is reserved for MCP JSON-RPC)
- [ ] Resources return proper MIME types
- [ ] Tool handlers validate required inputs
- [ ] Graceful error messages (not stack traces) for user-facing errors
