/**
 * MCP Registry — lazy-connect MCP servers from ~/.claude.json
 *
 * On startup: reads mcpServers from config, builds tool manifest (no connection).
 * On first tool call: opens transport (stdio or HTTP), fetches tools, caches the client.
 * Manifest cached to ~/.a2a-mcp-manifest.json for fast restarts.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CLAUDE_JSON = join(homedir(), ".claude.json");
const MANIFEST_PATH = join(homedir(), ".a2a-mcp-manifest.json");
const OWN_NAME = "a2a-mcp-bridge"; // skip ourselves

// ── Types ────────────────────────────────────────────────────────

interface StdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

type McpServerConfig = StdioServerConfig | HttpServerConfig;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: string; // which MCP server owns this tool
}

interface CachedManifest {
  updatedAt: number;
  tools: ToolDef[];
}

// ── Registry state ───────────────────────────────────────────────

const configs = new Map<string, McpServerConfig>();           // name → config
const clients = new Map<string, Client>();                    // name → connected client
const toolManifest: ToolDef[] = [];                           // flat list of all tools

// ── Load config ──────────────────────────────────────────────────

function loadConfig(): Map<string, McpServerConfig> {
  try {
    const raw = readFileSync(CLAUDE_JSON, "utf-8");
    const json = JSON.parse(raw);
    const servers: Record<string, McpServerConfig> = json?.mcpServers ?? {};
    const result = new Map<string, McpServerConfig>();
    for (const [name, cfg] of Object.entries(servers)) {
      if (name === OWN_NAME) continue;
      result.set(name, cfg);
    }
    return result;
  } catch {
    return new Map();
  }
}

// ── Manifest cache ───────────────────────────────────────────────

function loadManifestCache(): ToolDef[] {
  try {
    const raw = readFileSync(MANIFEST_PATH, "utf-8");
    const cached: CachedManifest = JSON.parse(raw);
    const age = Date.now() - cached.updatedAt;
    if (age < 24 * 60 * 60 * 1000) return cached.tools; // use if < 24h old
  } catch {}
  return [];
}

function saveManifestCache(tools: ToolDef[]) {
  try {
    const manifest: CachedManifest = { updatedAt: Date.now(), tools };
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  } catch {}
}

// ── Lazy connect ─────────────────────────────────────────────────

async function connectServer(name: string): Promise<Client> {
  const existing = clients.get(name);
  if (existing) return existing;

  const cfg = configs.get(name);
  if (!cfg) throw new Error(`Unknown MCP server: ${name}`);

  const client = new Client({ name: `a2a-proxy-${name}`, version: "1.0.0" });

  let transport;
  if (cfg.type === "stdio") {
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers ?? {} },
    });
  }

  await client.connect(transport);
  clients.set(name, client);
  process.stderr.write(`[mcp-registry] connected to ${name}\n`);
  return client;
}

// ── Fetch tools from server (for manifest) ───────────────────────

async function fetchServerTools(name: string): Promise<ToolDef[]> {
  try {
    const client = await connectServer(name);
    const { tools } = await client.listTools();
    return tools.map(t => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      server: name,
    }));
  } catch (err) {
    process.stderr.write(`[mcp-registry] failed to fetch tools from ${name}: ${err}\n`);
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────────

/** Read config on startup. Builds tool list from cache or by lazy-probing servers. */
export async function initRegistry() {
  const loaded = loadConfig();
  for (const [name, cfg] of loaded) {
    configs.set(name, cfg);
  }

  process.stderr.write(`[mcp-registry] found ${configs.size} external MCP servers\n`);

  // Try cache first
  const cached = loadManifestCache();
  if (cached.length > 0) {
    // Only keep tools whose server is still configured
    const validNames = new Set(configs.keys());
    for (const tool of cached) {
      if (validNames.has(tool.server)) toolManifest.push(tool);
    }
    process.stderr.write(`[mcp-registry] loaded ${toolManifest.length} tools from cache\n`);
    return;
  }

  // No cache — probe each server (lazy connect + listTools + disconnect)
  for (const name of configs.keys()) {
    const tools = await fetchServerTools(name);
    for (const t of tools) toolManifest.push(t);
    // Disconnect after manifest fetch to avoid holding idle connections
    const client = clients.get(name);
    if (client) {
      try { await client.close(); } catch {}
      clients.delete(name);
    }
  }

  saveManifestCache(toolManifest);
  process.stderr.write(`[mcp-registry] cached ${toolManifest.length} tools from ${configs.size} servers\n`);
}

/** All tools exposed by external MCP servers. */
export function listMcpTools(): ToolDef[] {
  return [...toolManifest];
}

/** All configured server names. */
export function listMcpServers(): Array<{ name: string; type: string; tools: number }> {
  return Array.from(configs.entries()).map(([name, cfg]) => ({
    name,
    type: cfg.type,
    tools: toolManifest.filter(t => t.server === name).length,
  }));
}

/**
 * Call a tool on an external MCP server.
 * Lazy-connects on first call; connection is cached for subsequent calls.
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  // Find which server owns this tool
  const toolDef = toolManifest.find(t => t.name === toolName);
  if (!toolDef) {
    // Tool not in manifest — maybe user specified server explicitly via args._server
    const serverName = args._server as string | undefined;
    if (!serverName) return `Tool not found in MCP registry: ${toolName}`;

    const client = await connectServer(serverName);
    const result = await client.callTool({ name: toolName, arguments: args });
    return extractText(result);
  }

  const client = await connectServer(toolDef.server);
  const result = await client.callTool({ name: toolName, arguments: args });
  return extractText(result);
}

/** Invalidate manifest cache and re-probe all servers. */
export async function refreshManifest(): Promise<number> {
  // Disconnect all
  for (const [, client] of clients) {
    try { await client.close(); } catch {}
  }
  clients.clear();
  toolManifest.length = 0;

  for (const name of configs.keys()) {
    const tools = await fetchServerTools(name);
    for (const t of tools) toolManifest.push(t);
    const client = clients.get(name);
    if (client) {
      try { await client.close(); } catch {}
      clients.delete(name);
    }
  }

  saveManifestCache(toolManifest);
  return toolManifest.length;
}

// ── Helpers ──────────────────────────────────────────────────────

function extractText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!result.content || result.content.length === 0) return "(no output)";
  return result.content
    .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n");
}
