# Data Connector — MCP Server Variant

**Pipeline**: mcp-server
**Category**: Data / Integration
**Complexity**: Medium

---

## Description

An MCP server that connects to external data sources (APIs, databases, files) and exposes them as tools and resources. Handles authentication, caching, and rate limiting.

---

## Ideal For

- API wrappers (GitHub, Jira, Notion, Slack)
- Database connectors (Postgres, MySQL, MongoDB)
- File system browsers
- Cloud service integrations (AWS, GCP, Azure)
- CRM connectors (Salesforce, HubSpot)
- Analytics data access

---

## Pre-Configured Features

- HTTP client with retry and rate limiting
- Response caching with TTL
- Authentication helpers (API key, Bearer token, OAuth)
- Pagination handling for list endpoints
- Resource URIs that map to data entities
- Error wrapping with user-friendly messages

---

## Usage

**Prompt Enhancement:**
- Add typed API client with base URL and auth header
- Add request caching with configurable TTL per endpoint
- Add rate limiter (token bucket) to prevent API throttling
- Add pagination helper that auto-fetches all pages
- Add resource URIs for browsable entities (e.g. github://repos/owner/name)
- Add search tool with query parameter mapping
- Add list/get/create/update tools per resource type

---

## Quality Checklist

- [ ] API client handles 401/403 with clear error messages
- [ ] Rate limiting prevents API throttling
- [ ] Cache reduces redundant API calls
- [ ] Pagination fetches all results correctly
- [ ] Resource URIs resolve to correct data
- [ ] Auth credentials read from environment variables (not hardcoded)
- [ ] Network errors wrapped with retry context
- [ ] All tools have accurate input schemas
