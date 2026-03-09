# API Backend Template

**Pipeline**: api
**Category**: Backend
**Stack**: TypeScript, Bun, Fastify, SQLite

---

## Description

A REST API backend with Fastify, SQLite database, and typed CRUD operations. Includes health check, CORS, error handling, and a complete items resource as a starting pattern.

---

## Pre-Configured Features

- Fastify 5 with CORS enabled
- SQLite via Bun's built-in driver (WAL mode, foreign keys)
- Typed CRUD operations (list, get, create, update, delete)
- Health check endpoint
- Input validation on all routes
- Proper HTTP status codes (201 for create, 404 for not found)
- Centralized error handler
- Auto-created data directory

---

## File Structure

```
<project>/
├── package.json
├── tsconfig.json
├── src/
│   ├── server.ts             # Fastify entry point
│   ├── routes/
│   │   ├── health.ts         # GET /health
│   │   └── items.ts          # CRUD /api/items
│   └── db/
│       └── schema.ts         # SQLite schema + query helpers
├── data/                     # SQLite database files (auto-created)
```

---

## Default Tech Stack

| Component | Technology |
|---|---|
| Runtime | Bun |
| Language | TypeScript (strict) |
| HTTP | Fastify ^5.0.0 |
| CORS | @fastify/cors ^10.0.0 |
| Database | SQLite (bun:sqlite) |
| Mode | WAL (write-ahead logging) |

---

## Usage

The AI generates additional entities, routes, and middleware based on the spec. The items resource serves as a pattern to follow.

**Example prompt enhancement:**
- User says: "recipe API"
- AI adds: recipes table with ingredients/steps, categories with nested routes, search with FTS5, image URL handling, pagination, rate limiting

---

## Quality Checklist

- [ ] Server starts and responds to GET /health
- [ ] All CRUD operations work (create, read, update, delete)
- [ ] Invalid IDs return 400, missing entities return 404
- [ ] POST validates required fields
- [ ] SQLite database is created automatically
- [ ] CORS headers present in responses
- [ ] Error handler returns structured JSON errors
- [ ] No SQL injection vulnerabilities (parameterized queries only)
