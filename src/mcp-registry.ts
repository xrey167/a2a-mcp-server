/**
 * MCP Registry — discover and lazy-connect MCP servers from multiple IDEs.
 *
 * Scans config files from Claude, Cursor, Windsurf, and Codex (in priority
 * order — first-seen server name wins). On startup: reads mcpServers from
 * all configs, builds a unified tool manifest (no connection). On first tool
 * call: opens transport (stdio or HTTP), fetches tools, caches the client.
 * Manifest cached to ~/.a2a-mcp-manifest.json for fast restarts.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getAuthHeaders } from "./mcp-auth.js";

const MANIFEST_PATH = join(homedir(), ".a2a-mcp-manifest.json");
const OWN_NAME = "a2a-mcp-bridge"; // skip ourselves

// ── Multi-IDE config sources ────────────────────────────────────
// Discover MCP servers from all major IDE/tool configurations.
// Each source is tried in order; duplicate server names are skipped
// (first-seen wins), so Claude's config takes priority.

interface ConfigSource {
  ide: string;
  path: string;
  key: string;            // JSON key holding the servers map
}

const CONFIG_SOURCES: ConfigSource[] = [
  { ide: "claude",   path: join(homedir(), ".claude.json"),            key: "mcpServers" },
  { ide: "cursor",   path: join(homedir(), ".cursor", "mcp.json"),     key: "mcpServers" },
  { ide: "windsurf", path: join(homedir(), ".windsurf", "mcp.json"),   key: "mcpServers" },
  { ide: "codex",    path: join(homedir(), ".codex", "mcp.json"),      key: "mcpServers" },
];

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

// ── Load config (multi-IDE) ──────────────────────────────────────

function loadConfig(): Map<string, McpServerConfig> {
  const result = new Map<string, McpServerConfig>();

  for (const source of CONFIG_SOURCES) {
    try {
      if (!existsSync(source.path)) continue;
      const raw = readFileSync(source.path, "utf-8");
      const json = JSON.parse(raw);
      const servers: Record<string, McpServerConfig> = json?.[source.key] ?? {};
      let added = 0;
      for (const [name, cfg] of Object.entries(servers)) {
        if (name === OWN_NAME) continue;
        if (result.has(name)) continue; // first-seen wins (Claude takes priority)
        result.set(name, cfg);
        added++;
      }
      if (added > 0) {
        process.stderr.write(`[mcp-registry] discovered ${added} server(s) from ${source.ide} (${source.path})\n`);
      }
    } catch {
      // Config file unreadable or malformed — skip silently
    }
  }

  return result;
}

// ── Manifest cache ───────────────────────────────────────────────

function loadManifestCache(): ToolDef[] {
  try {
    const raw = readFileSync(MANIFEST_PATH, "utf-8");
    const cached: CachedManifest = JSON.parse(raw);
    const age = Date.now() - cached.updatedAt;
    if (age < 24 * 60 * 60 * 1000) return cached.tools; // use if < 24h old
  } catch (e: any) {
    if (e?.code !== "ENOENT") process.stderr.write(`[mcp-registry] failed to load manifest cache: ${e}\n`);
  }
  return [];
}

function saveManifestCache(tools: ToolDef[]) {
  try {
    const manifest: CachedManifest = { updatedAt: Date.now(), tools };
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  } catch (e) {
    process.stderr.write(`[mcp-registry] failed to save manifest cache: ${e}\n`);
  }
}

// ── Lazy connect ─────────────────────────────────────────────────

async function connectServer(name: string): Promise<Client> {
  const existing = clients.get(name);
  if (existing) return existing;

  const cfg = configs.get(name);
  if (!cfg) throw new Error(`Unknown MCP server: ${name}`);

  const client = new Client({ name: `a2a-proxy-${name}`, version: "1.0.0" });

  // Merge static config headers with dynamic auth headers (mcp-auth.ts)
  const authHeaders = await getAuthHeaders(name);

  let transport;
  if (cfg.type === "stdio") {
    // For stdio, inject bearer token as env var if auth is configured
    const bearerToken = authHeaders["Authorization"]?.replace("Bearer ", "");
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: {
        ...process.env,
        ...(cfg.env ?? {}),
        ...(bearerToken ? { MCP_AUTH_TOKEN: bearerToken } : {}),
      } as Record<string, string>,
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: { ...(cfg.headers ?? {}), ...authHeaders } },
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
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: 120_000 });
    return extractText(result);
  }

  const client = await connectServer(toolDef.server);
  const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: 120_000 });
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
