#!/usr/bin/env bun
/**
 * CLI entry point for a2a-mcp-server.
 * Usage:
 *   bunx a2a-mcp-server          # start the server
 *   bunx a2a-mcp-server init     # create default config
 *   bunx a2a-mcp-server config   # show current config
 *   bunx a2a-mcp-server workers  # list available workers
 */

import { initConfigDir, loadConfig } from "./config.js";
import { join } from "path";
import { homedir } from "os";
import { existsSync, writeFileSync, mkdirSync } from "fs";

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  process.stderr.write(`
a2a-mcp-server — Multi-agent orchestrator bridging MCP and A2A protocols

Commands:
  (none)     Start the server (MCP stdio + A2A HTTP)
  init       Create default config at ~/.a2a-mcp/config.json
  config     Show current configuration
  workers    List available workers and their status
  help       Show this help message

Environment variables:
  ANTHROPIC_API_KEY    Claude API key (optional — falls back to Claude Code OAuth)
  GOOGLE_API_KEY       Gemini API key for design worker (optional)
  A2A_PORT             HTTP server port (default: 8080)
  A2A_API_KEY          Require Bearer token for remote A2A callers
  OBSIDIAN_VAULT       Knowledge base directory (default: ~/Documents/Obsidian/a2a-knowledge)

Config file: ~/.a2a-mcp/config.json
  Disable workers:     { "workers": [{ "name": "design", "enabled": false }] }
  Change ports:        { "server": { "port": 9090 } }

`);
}

function initCommand() {
  initConfigDir();

  // Also create .env.example in current directory if it doesn't exist
  const envExample = join(process.cwd(), ".env.example");
  if (!existsSync(envExample)) {
    writeFileSync(envExample, `# a2a-mcp-server environment variables
# Copy to .env and fill in your values

# Claude API key (optional — falls back to Claude Code OAuth)
# ANTHROPIC_API_KEY=sk-ant-...

# Gemini API key for design worker (optional)
# GOOGLE_API_KEY=...

# A2A HTTP server port
# A2A_PORT=8080

# Require API key for remote A2A callers
# A2A_API_KEY=

# Knowledge base directory
# OBSIDIAN_VAULT=~/Documents/Obsidian/a2a-knowledge
`);
    process.stderr.write(`[init] created ${envExample}\n`);
  }

  process.stderr.write(`[init] done! Start with: bun src/server.ts\n`);
}

function configCommand() {
  const config = loadConfig();
  process.stderr.write(JSON.stringify(config, null, 2) + "\n");
}

function workersCommand() {
  const ALL_WORKERS = [
    { name: "shell",     port: 8081, description: "Shell commands, file I/O" },
    { name: "web",       port: 8082, description: "HTTP fetch, API calls" },
    { name: "ai",        port: 8083, description: "Claude AI, file search, SQLite" },
    { name: "code",      port: 8084, description: "Codex exec, code review" },
    { name: "knowledge", port: 8085, description: "Notes CRUD, knowledge base" },
    { name: "design",    port: 8086, description: "UI prompt, screen design (Gemini)" },
    { name: "factory",   port: 8087, description: "Project scaffolding, quality gates" },
    { name: "data",      port: 8088, description: "CSV/JSON parsing, data analysis" },
  ];

  const config = loadConfig();
  const configWorkers = config.workers;
  const configMap = configWorkers ? new Map(configWorkers.map(w => [w.name, w])) : new Map();

  process.stderr.write("\nAvailable workers:\n");
  for (const w of ALL_WORKERS) {
    const cw = configMap.get(w.name);
    const enabled = cw ? cw.enabled !== false : true;
    const port = cw?.port ?? w.port;
    const status = enabled ? "enabled" : "disabled";
    process.stderr.write(`  ${enabled ? "✓" : "✗"} ${w.name.padEnd(12)} :${port}  ${w.description}  [${status}]\n`);
  }
  process.stderr.write("\nEdit ~/.a2a-mcp/config.json to enable/disable workers.\n\n");
}

switch (command) {
  case "init":
    initCommand();
    break;
  case "config":
    configCommand();
    break;
  case "workers":
    workersCommand();
    break;
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  case undefined:
    // Start the server
    await import("./server.js");
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
}
