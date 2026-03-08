// src/config.ts
// Declarative configuration for the A2A MCP server.
// Loads from ~/.a2a-mcp/config.json (or YAML if found), with env overrides.

import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { z } from "zod";

const CONFIG_DIR = join(homedir(), ".a2a-mcp");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// ── Config Schema ─────────────────────────────────────────────

const WorkerConfigSchema = z.object({
  name: z.string(),
  path: z.string(),
  port: z.number().int().positive(),
  enabled: z.boolean().optional().default(true),
});

const SearchConfigSchema = z.object({
  /** Max results per search query */
  maxResults: z.number().int().positive().optional().default(50),
  /** Normal requests per minute before throttling */
  rateLimit: z.number().int().positive().optional().default(3),
  /** Burst requests per minute (hard cap) */
  rateLimitBurst: z.number().int().positive().optional().default(8),
});

const SandboxConfigSchema = z.object({
  /** Default execution timeout in ms */
  timeout: z.number().int().positive().optional().default(30_000),
  /** Max result size in chars before truncation */
  maxResultSize: z.number().int().positive().optional().default(25_000),
  /** Auto-index threshold in bytes */
  indexThreshold: z.number().int().positive().optional().default(4096),
});

const TruncationConfigSchema = z.object({
  /** Max response size in chars */
  maxResponseSize: z.number().int().positive().optional().default(25_000),
  /** Max array items before truncation */
  maxArrayItems: z.number().int().positive().optional().default(100),
  /** Head/tail ratio for line-based truncation (0-1) */
  headRatio: z.number().min(0).max(1).optional().default(0.6),
});

const ServerConfigSchema = z.object({
  /** A2A HTTP port (default: 8080) */
  port: z.number().int().positive().optional().default(8080),
  /** Require API key for non-loopback A2A callers */
  apiKey: z.string().optional(),
  /** Worker health poll interval in ms */
  healthPollInterval: z.number().int().positive().optional().default(30_000),
});

const ConfigSchema = z.object({
  server: ServerConfigSchema.optional().default({}),
  workers: z.array(WorkerConfigSchema).optional(),
  search: SearchConfigSchema.optional().default({}),
  sandbox: SandboxConfigSchema.optional().default({}),
  truncation: TruncationConfigSchema.optional().default({}),
  /** Extra environment variables to pass to workers */
  env: z.record(z.string()).optional().default({}),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

// ── Singleton ─────────────────────────────────────────────────

let __config: Config | null = null;

/**
 * Load config from ~/.a2a-mcp/config.json, creating defaults if not found.
 * Environment variable overrides:
 *   A2A_PORT → server.port
 *   A2A_API_KEY → server.apiKey
 *   A2A_SANDBOX_TIMEOUT → sandbox.timeout
 *   A2A_MAX_RESPONSE_SIZE → truncation.maxResponseSize
 */
export function loadConfig(): Config {
  if (__config) return __config;

  let raw: Record<string, unknown> = {};

  if (existsSync(CONFIG_FILE)) {
    try {
      raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      process.stderr.write(`[config] loaded from ${CONFIG_FILE}\n`);
    } catch (err) {
      process.stderr.write(`[config] failed to parse ${CONFIG_FILE}: ${err}\n`);
    }
  }

  // Environment variable overrides
  if (process.env.A2A_PORT) {
    raw.server = { ...(raw.server as object ?? {}), port: parseInt(process.env.A2A_PORT, 10) };
  }
  if (process.env.A2A_API_KEY) {
    raw.server = { ...(raw.server as object ?? {}), apiKey: process.env.A2A_API_KEY };
  }
  if (process.env.A2A_SANDBOX_TIMEOUT) {
    raw.sandbox = { ...(raw.sandbox as object ?? {}), timeout: parseInt(process.env.A2A_SANDBOX_TIMEOUT, 10) };
  }
  if (process.env.A2A_MAX_RESPONSE_SIZE) {
    raw.truncation = { ...(raw.truncation as object ?? {}), maxResponseSize: parseInt(process.env.A2A_MAX_RESPONSE_SIZE, 10) };
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    process.stderr.write(`[config] validation errors: ${result.error.message}\n`);
    process.stderr.write(`[config] using defaults\n`);
    __config = ConfigSchema.parse({});
  } else {
    __config = result.data;
  }

  return __config;
}

/**
 * Get the current config (loads if not yet loaded).
 */
export function getConfig(): Config {
  return __config ?? loadConfig();
}

/**
 * Reset config (for testing).
 */
export function resetConfig(): void {
  __config = null;
}

/**
 * Ensure the config directory exists and write a default config.json.
 */
export function initConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!existsSync(CONFIG_FILE)) {
    const defaults = JSON.stringify(ConfigSchema.parse({}), null, 2);
    const { writeFileSync } = require("fs");
    writeFileSync(CONFIG_FILE, defaults, "utf-8");
    process.stderr.write(`[config] created default config at ${CONFIG_FILE}\n`);
  }
}
