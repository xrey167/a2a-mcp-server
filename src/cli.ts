#!/usr/bin/env bun
/**
 * CLI entry point for a2a-mcp-server.
 * Usage:
 *   bunx a2a-mcp-server              # start the server
 *   bunx a2a-mcp-server init         # create default config
 *   bunx a2a-mcp-server init --lite   # create config with lite profile
 *   bunx a2a-mcp-server config       # show current config
 *   bunx a2a-mcp-server workers      # list available workers
 */

import { initConfigDir, loadConfig } from "./config.js";
import { join } from "path";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { homedir } from "os";

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  process.stderr.write(`
a2a-mcp-server — Multi-agent orchestrator bridging MCP and A2A protocols

Commands:
  (none)     Start the server (MCP stdio + A2A HTTP)
  init       Create default config at ~/.a2a-mcp/config.json
             --lite    Only shell + web + ai workers
             --data    Shell + web + ai + data workers
             --full    All 8 workers (default)
  config     Show current configuration
  workers    List available workers and their status
  help       Show this help message

Profiles:
  full       All 8 workers (shell, web, ai, code, knowledge, design, factory, data)
  lite       Minimal: shell + web + ai (3 workers, fastest startup)
  data       Data-focused: shell + web + ai + data (4 workers)

Environment variables:
  ANTHROPIC_API_KEY    Claude API key (optional — falls back to Claude Code OAuth)
  GOOGLE_API_KEY       Gemini API key for design worker (optional)
  A2A_PORT             HTTP server port (default: 8080)
  A2A_API_KEY          Require Bearer token for remote A2A callers
  OBSIDIAN_VAULT       Knowledge base directory (default: ~/Documents/Obsidian/a2a-knowledge)

Config file: ~/.a2a-mcp/config.json
  Disable workers:     { "workers": [{ "name": "design", "enabled": false }] }
  Use a profile:       { "profile": "lite" }
  Change ports:        { "server": { "port": 9090 } }
  Add remote workers:  { "remoteWorkers": [{ "name": "my-agent", "url": "https://agent.example.com" }] }

Dashboard: http://localhost:8080/dashboard (while server is running)

`);
}

function initCommand() {
  // Check for profile flag
  const profile = args.includes("--lite") ? "lite"
    : args.includes("--data") ? "data"
    : args.includes("--full") ? "full"
    : undefined;

  initConfigDir();

  // If a profile was specified, update the config file
  if (profile) {
    const configFile = join(homedir(), ".a2a-mcp", "config.json");
    try {
      const config = JSON.parse(readFileSync(configFile, "utf-8"));
      config.profile = profile;
      delete config.workers; // profile overrides workers
      writeFileSync(configFile, JSON.stringify(config, null, 2), "utf-8");
      process.stderr.write(`[init] set profile: ${profile}\n`);
    } catch (err) {
      process.stderr.write(`[init] failed to update config: ${err}\n`);
    }
  }

  process.stderr.write(`[init] done! Start with: bun src/server.ts\n`);
  process.stderr.write(`[init] dashboard at: http://localhost:8080/dashboard\n`);
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

  process.stderr.write(`\nProfile: ${config.profile ?? "full"}\n`);
  process.stderr.write("\nLocal workers:\n");
  for (const w of ALL_WORKERS) {
    const cw = configMap.get(w.name);
    const enabled = cw ? cw.enabled !== false : true;
    const port = cw?.port ?? w.port;
    const status = enabled ? "enabled" : "disabled";
    process.stderr.write(`  ${enabled ? "+" : "-"} ${w.name.padEnd(12)} :${port}  ${w.description}  [${status}]\n`);
  }

  if (config.remoteWorkers && config.remoteWorkers.length > 0) {
    process.stderr.write("\nRemote workers:\n");
    for (const rw of config.remoteWorkers) {
      const hasKey = rw.apiKey ? " [auth]" : "";
      process.stderr.write(`  > ${rw.name.padEnd(12)} ${rw.url}${hasKey}\n`);
    }
  }

  process.stderr.write("\nEdit ~/.a2a-mcp/config.json to configure.\n\n");
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
