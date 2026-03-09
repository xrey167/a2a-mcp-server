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
import { discoverUserWorkers, scaffoldWorker, getWorkersDir, ensureWorkersDir } from "./worker-loader.js";
import { searchRegistry, getRegistryEntry, loadRegistry } from "./worker-registry.js";
import { join } from "path";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { homedir } from "os";

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  process.stderr.write(`
a2a-mcp-server — Multi-agent orchestrator bridging MCP and A2A protocols

Commands:
  (none)          Start the server (MCP stdio + A2A HTTP)
  init            Create default config at ~/.a2a-mcp/config.json
                  --lite    Only shell + web + ai workers
                  --data    Shell + web + ai + data workers
                  --full    All 8 workers (default)
  config          Show current configuration
  workers         List available workers and their status
  create-worker   Scaffold a new custom worker
                  Usage: create-worker <name> [--port <port>]
  search          Search the worker registry
                  Usage: search <query>
  install         Install a worker from the registry
                  Usage: install <name> [--port <port>]
  registry        List all workers in the registry
  help            Show this help message

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

  // Show user-space workers
  const userWorkers = discoverUserWorkers();
  if (userWorkers.length > 0) {
    process.stderr.write("\nUser workers (~/.a2a-mcp/workers/):\n");
    for (const uw of userWorkers) {
      process.stderr.write(`  * ${uw.name.padEnd(12)} :${uw.port}  ${uw.path}\n`);
    }
  }

  process.stderr.write("\nEdit ~/.a2a-mcp/config.json to configure.\n");
  process.stderr.write(`Create a new worker: bun src/cli.ts create-worker <name>\n\n`);
}

function createWorkerCommand() {
  const name = args[1];
  if (!name) {
    process.stderr.write("Usage: bun src/cli.ts create-worker <name> [--port <port>]\n");
    process.exit(1);
  }

  // Validate name: alphanumeric + hyphens only
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    process.stderr.write(`Invalid worker name "${name}". Use lowercase letters, numbers, and hyphens.\n`);
    process.exit(1);
  }

  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : undefined;

  try {
    ensureWorkersDir();
    const dir = scaffoldWorker(name, port);
    process.stderr.write(`Created worker "${name}" at ${dir}\n`);
    process.stderr.write(`\nNext steps:\n`);
    process.stderr.write(`  1. Edit ${dir}/index.ts to add your skills\n`);
    process.stderr.write(`  2. Start the server: bun src/server.ts\n`);
    process.stderr.write(`  3. Your worker will be auto-discovered and spawned\n\n`);
  } catch (err: any) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

function searchCommand() {
  const query = args.slice(1).join(" ");
  if (!query) {
    process.stderr.write("Usage: bun src/cli.ts search <query>\n");
    process.stderr.write("Example: bun src/cli.ts search database\n");
    process.exit(1);
  }

  const results = searchRegistry(query);
  if (results.length === 0) {
    process.stderr.write(`No workers found matching "${query}"\n`);
    return;
  }

  process.stderr.write(`\nFound ${results.length} worker(s) matching "${query}":\n\n`);
  for (const w of results) {
    process.stderr.write(`  ${w.name} (v${w.version}) by ${w.author}\n`);
    process.stderr.write(`    ${w.description}\n`);
    process.stderr.write(`    Skills: ${w.skills.join(", ")}\n`);
    process.stderr.write(`    Tags: ${w.tags.join(", ")}\n`);
    process.stderr.write(`    Repo: ${w.repo}\n\n`);
  }
  process.stderr.write(`Install with: bun src/cli.ts install <name>\n\n`);
}

function installCommand() {
  const name = args[1];
  if (!name) {
    process.stderr.write("Usage: bun src/cli.ts install <name>\n");
    process.stderr.write("Search first: bun src/cli.ts search <query>\n");
    process.exit(1);
  }

  const entry = getRegistryEntry(name);
  if (!entry) {
    process.stderr.write(`Worker "${name}" not found in registry.\n`);
    process.stderr.write(`Search available workers: bun src/cli.ts search <query>\n`);
    process.exit(1);
  }

  // Check if already installed
  const existing = discoverUserWorkers().find(w => w.name === name);
  if (existing) {
    process.stderr.write(`Worker "${name}" is already installed at ${existing.path}\n`);
    process.exit(1);
  }

  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : entry.port;

  try {
    ensureWorkersDir();
    const dir = scaffoldWorker(name, port);

    // Enhance the scaffolded worker.json with registry metadata
    const workerJsonPath = join(dir, "worker.json");
    const workerJson = JSON.parse(readFileSync(workerJsonPath, "utf-8"));
    workerJson.description = entry.description;
    workerJson.author = entry.author;
    workerJson.version = entry.version;
    workerJson.repo = entry.repo;
    workerJson.skills = entry.skills;
    writeFileSync(workerJsonPath, JSON.stringify(workerJson, null, 2));

    process.stderr.write(`\nInstalled "${name}" worker at ${dir}\n\n`);
    process.stderr.write(`  Description: ${entry.description}\n`);
    process.stderr.write(`  Skills: ${entry.skills.join(", ")}\n`);
    process.stderr.write(`  Repo: ${entry.repo}\n\n`);
    process.stderr.write(`Next steps:\n`);
    process.stderr.write(`  1. Edit ${dir}/index.ts to implement the skills\n`);
    process.stderr.write(`     (or clone the repo: git clone ${entry.repo} ${dir})\n`);
    process.stderr.write(`  2. Install deps if needed: cd ${dir} && bun install\n`);
    process.stderr.write(`  3. Start the server: bun src/server.ts\n\n`);
  } catch (err: any) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

function registryCommand() {
  const registry = loadRegistry();
  process.stderr.write(`\nWorker Registry (${registry.workers.length} workers available)\n`);
  process.stderr.write(`Updated: ${registry.updated}\n\n`);

  // Check which are already installed
  const installed = new Set(discoverUserWorkers().map(w => w.name));

  for (const w of registry.workers) {
    const status = installed.has(w.name) ? " [installed]" : "";
    process.stderr.write(`  ${w.name.padEnd(20)} ${w.description}${status}\n`);
  }
  process.stderr.write(`\nSearch: bun src/cli.ts search <query>\n`);
  process.stderr.write(`Install: bun src/cli.ts install <name>\n\n`);
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
  case "create-worker":
    createWorkerCommand();
    break;
  case "search":
    searchCommand();
    break;
  case "install":
    installCommand();
    break;
  case "registry":
    registryCommand();
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
