# API Integration — Agent Variant

**Pipeline**: agent
**Category**: Automation / Integration
**Complexity**: Medium

---

## Description

An AI agent specialized in connecting to multiple external APIs, aggregating data, and performing multi-step workflows. Handles authentication, data transformation, and error recovery.

---

## Ideal For

- Data aggregation agents
- Webhook processors
- API monitoring agents
- Report generation agents
- ETL pipeline agents
- Notification routing agents

---

## Pre-Configured Features

- Multi-API tool set with typed request/response
- Request caching and deduplication
- Retry logic with exponential backoff
- Data transformation and merging
- Structured output formatting (tables, summaries)
- Rate limit awareness per API

---

## Usage

**Prompt Enhancement:**
- Add typed API client tools (one per external service)
- Add data transformation tool for merging/filtering results
- Add output formatting tool (markdown tables, JSON summaries)
- Add caching layer to prevent redundant API calls
- Add retry with backoff for transient failures
- Add health check tool that validates all API connections
- Add scheduling support for periodic data fetches

---

## Quality Checklist

- [ ] All API tools handle auth errors gracefully
- [ ] Rate limiting prevents API throttling
- [ ] Data transformation produces consistent output format
- [ ] Agent completes multi-step workflows without losing context
- [ ] Retry logic handles transient failures
- [ ] Cache invalidation works correctly
- [ ] Health check reports status per API connection
