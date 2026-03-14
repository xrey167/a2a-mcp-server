// src/config.ts
// Declarative configuration for the A2A MCP server.
// Loads from ~/.a2a-mcp/config.json (or YAML if found), with env overrides.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { z } from "zod";

function getConfigDir(): string {
  return join(process.env.HOME ?? homedir(), ".a2a-mcp");
}

function getConfigFile(): string {
  return join(getConfigDir(), "config.json");
}

// ── Config Schema ─────────────────────────────────────────────

const WorkerConfigSchema = z.object({
  name: z.string(),
  path: z.string(),
  port: z.number().int().positive(),
  enabled: z.boolean().optional().default(true),
});

const RemoteWorkerSchema = z.object({
  /** Display name for the remote worker */
  name: z.string(),
  /** Full URL of the remote A2A agent (e.g. "https://my-agent.example.com:9090") */
  url: z.string().url(),
  /** API key for authenticating with the remote agent */
  apiKey: z.string().optional(),
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

const TimeoutsConfigSchema = z.object({
  /** Shell command timeout in ms */
  shell: z.number().int().positive().optional().default(15_000),
  /** HTTP fetch timeout in ms */
  fetch: z.number().int().positive().optional().default(30_000),
  /** Codex CLI timeout in ms */
  codex: z.number().int().positive().optional().default(120_000),
  /** Peer-to-peer worker call timeout in ms */
  peer: z.number().int().positive().optional().default(60_000),
});

const WebConfigSchema = z.object({
  /** Requests per minute for outbound fetch/API calls (0 = unlimited) */
  rateLimit: z.number().int().min(0).optional().default(0),
  /** Max response body size in bytes */
  maxResponseBytes: z.number().int().positive().optional().default(10 * 1024 * 1024),
});

const TruncationConfigSchema = z.object({
  /** Max response size in chars */
  maxResponseSize: z.number().int().positive().optional().default(25_000),
  /** Max array items before truncation */
  maxArrayItems: z.number().int().positive().optional().default(100),
  /** Head/tail ratio for line-based truncation (0-1) */
  headRatio: z.number().min(0).max(1).optional().default(0.6),
});

const OutputFilterConfigSchema = z.object({
  /** Master switch for output filtering */
  enabled: z.boolean().optional().default(true),
  /** Strip ANSI escape codes from all output */
  stripAnsi: z.boolean().optional().default(true),
  /** Use built-in filter rules (git, npm, test runners, etc.) */
  builtinFilters: z.boolean().optional().default(true),
  /** Path to custom filters JSON file */
  customFiltersPath: z.string().optional(),
  /** Save raw output when filtering removes >50% */
  teeEnabled: z.boolean().optional().default(true),
  /** Max age for tee files in minutes (default 24h) */
  teeMaxAgeMins: z.number().int().positive().optional().default(1440),
  /** Track token savings in SQLite */
  tokenTrackingEnabled: z.boolean().optional().default(true),
  /** Retention period for token savings records in days */
  tokenRetentionDays: z.number().int().positive().optional().default(90),
});

const ServerConfigSchema = z.object({
  /** A2A HTTP port (default: 8080) */
  port: z.number().int().positive().optional().default(8080),
  /** Require API key for non-loopback A2A callers */
  apiKey: z.string().optional(),
  /** Worker health poll interval in ms */
  healthPollInterval: z.number().int().positive().optional().default(30_000),
});

const ErpConfigSchema = z.object({
  /** Enable periodic connector renewal sweeps */
  autoRenewEnabled: z.boolean().optional().default(true),
  /** Renewal sweep interval in ms (default: 1h) */
  renewalSweepIntervalMs: z.number().int().positive().optional().default(60 * 60 * 1000),
  /** Random jitter added to each sweep in ms (default: 5m) */
  renewalSweepJitterMs: z.number().int().min(0).optional().default(5 * 60 * 1000),
  /** Enable periodic CSV+JSON renewal snapshot exports */
  snapshotExportEnabled: z.boolean().optional().default(false),
  /** Snapshot export interval in ms (default: 24h) */
  snapshotExportIntervalMs: z.number().int().positive().optional().default(24 * 60 * 60 * 1000),
  /** Snapshot retention in days */
  snapshotRetentionDays: z.number().int().positive().optional().default(30),
  /** Snapshot output directory */
  snapshotOutputDir: z.string().optional().default(join(getConfigDir(), "reports", "connector-renewals")),
  /** Optional HMAC signing key for snapshot manifests (prefer env in production) */
  snapshotSigningKey: z.string().optional(),
  /** Enable periodic quote follow-up writeback sweeps */
  followupWritebackEnabled: z.boolean().optional().default(false),
  /** Follow-up writeback sweep interval in ms (default: 15m) */
  followupWritebackIntervalMs: z.number().int().positive().optional().default(15 * 60 * 1000),
  /** Random jitter added to follow-up writeback sweep in ms (default: 60s) */
  followupWritebackJitterMs: z.number().int().min(0).optional().default(60_000),
  /** Max actions per workspace per follow-up writeback sweep */
  followupWritebackBatchLimit: z.number().int().positive().optional().default(20),
});

const FederationConfigSchema = z.object({
  /** Peer A2A agent URLs to discover via /.well-known/agent.json */
  peers: z.array(z.string().url()).optional().default([]),
  /** Health check interval in ms (default: 30s) */
  healthIntervalMs: z.number().int().positive().optional().default(30_000),
  /** Discovery timeout in ms (default: 5s) */
  discoveryTimeoutMs: z.number().int().positive().optional().default(5_000),
});

const NotificationsConfigSchema = z.object({
  slack: z.object({
    webhookUrl: z.string().url(),
    channel: z.string().optional(),
    username: z.string().optional(),
  }).optional(),
  telegram: z.object({
    botToken: z.string(),
    chatId: z.string(),
    parseMode: z.string().optional(),
  }).optional(),
  email: z.object({
    smtpUrl: z.string(),
    from: z.string(),
    to: z.string(),
    subjectPrefix: z.string().optional(),
  }).optional(),
});

const SchedulerConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  jobs: z.array(z.object({
    id: z.string(),
    intervalMs: z.number().int().positive(),
    skillId: z.string().optional(),
    workflow: z.string().optional(),
    args: z.record(z.unknown()).optional().default({}),
    enabled: z.boolean().optional().default(true),
  })).optional().default([]),
});

const ConfigSchema = z.object({
  server: ServerConfigSchema.optional(),
  erp: ErpConfigSchema.optional(),
  workers: z.array(WorkerConfigSchema).optional(),
  /** Remote A2A agents to discover and route to (no local process spawned) */
  remoteWorkers: z.array(RemoteWorkerSchema).optional(),
  search: SearchConfigSchema.optional(),
  sandbox: SandboxConfigSchema.optional(),
  truncation: TruncationConfigSchema.optional(),
  timeouts: TimeoutsConfigSchema.optional(),
  web: WebConfigSchema.optional(),
  /** Worker profile preset: "full" (all), "lite" (shell+web+ai), "data" (shell+web+ai+data) */
  profile: z.enum(["full", "lite", "data", "osint"]).optional(),
  /** A2A federation — connect to external A2A agents */
  federation: FederationConfigSchema.optional(),
  /** Output filter settings (RTK-style token reduction) */
  outputFilter: OutputFilterConfigSchema.optional(),
  /** Notification channels for alerting (Slack, Telegram, Email) */
  notifications: NotificationsConfigSchema.optional(),
  /** Scheduler for recurring OSINT monitoring jobs */
  scheduler: SchedulerConfigSchema.optional(),
  /** Extra environment variables to pass to workers */
  env: z.record(z.string()).optional(),
}).strict();

// Zod 4 doesn't apply inner field defaults when the outer default is {};
// we apply defaults manually after parsing.
const DEFAULTS = {
  server: ServerConfigSchema.parse({}),
  erp: ErpConfigSchema.parse({}),
  search: SearchConfigSchema.parse({}),
  sandbox: SandboxConfigSchema.parse({}),
  truncation: TruncationConfigSchema.parse({}),
  timeouts: TimeoutsConfigSchema.parse({}),
  web: WebConfigSchema.parse({}),
  federation: FederationConfigSchema.parse({}),
  outputFilter: OutputFilterConfigSchema.parse({}),
  env: {} as Record<string, string>,
};

function applyDefaults(raw: z.infer<typeof ConfigSchema>): Config {
  // Apply profile presets — these set workers.enabled based on the profile name.
  // Explicit workers config always takes priority over profile.
  let workers = raw.workers;
  if (!workers && raw.profile) {
    workers = applyProfile(raw.profile);
  }

  return {
    server: { ...DEFAULTS.server, ...raw.server },
    erp: { ...DEFAULTS.erp, ...raw.erp },
    workers,
    remoteWorkers: raw.remoteWorkers,
    profile: raw.profile,
    federation: { ...DEFAULTS.federation, ...raw.federation },
    search: { ...DEFAULTS.search, ...raw.search },
    sandbox: { ...DEFAULTS.sandbox, ...raw.sandbox },
    truncation: { ...DEFAULTS.truncation, ...raw.truncation },
    timeouts: { ...DEFAULTS.timeouts, ...raw.timeouts },
    web: { ...DEFAULTS.web, ...raw.web },
    outputFilter: { ...DEFAULTS.outputFilter, ...raw.outputFilter },
    env: { ...DEFAULTS.env, ...raw.env },
  };
}

/** Map profile names to worker enabled/disabled configs */
function applyProfile(profile: string): z.infer<typeof WorkerConfigSchema>[] {
  const all = ["shell", "web", "ai", "code", "knowledge", "design", "factory", "data", "news", "market", "signal", "monitor", "infra", "climate"];
  const ports: Record<string, number> = { shell: 8081, web: 8082, ai: 8083, code: 8084, knowledge: 8085, design: 8086, factory: 8087, data: 8088, news: 8089, market: 8090, signal: 8091, monitor: 8092, infra: 8093, climate: 8094 };

  let enabled: Set<string>;
  switch (profile) {
    case "lite":
      enabled = new Set(["shell", "web", "ai"]);
      break;
    case "data":
      enabled = new Set(["shell", "web", "ai", "data"]);
      break;
    case "osint":
      enabled = new Set(["shell", "web", "ai", "news", "market", "signal", "monitor", "infra", "climate"]);
      break;
    case "full":
    default:
      enabled = new Set(all);
      break;
  }

  return all.map(name => ({
    name,
    path: `workers/${name}.ts`,
    port: ports[name],
    enabled: enabled.has(name),
  }));
}

export type RemoteWorkerConfig = z.infer<typeof RemoteWorkerSchema>;

export type FederationConfig = z.infer<typeof FederationConfigSchema>;

export type OutputFilterConfig = z.infer<typeof OutputFilterConfigSchema>;

export type Config = {
  server: z.infer<typeof ServerConfigSchema>;
  erp: z.infer<typeof ErpConfigSchema>;
  workers?: z.infer<typeof WorkerConfigSchema>[];
  remoteWorkers?: RemoteWorkerConfig[];
  profile?: string;
  federation: FederationConfig;
  search: z.infer<typeof SearchConfigSchema>;
  sandbox: z.infer<typeof SandboxConfigSchema>;
  truncation: z.infer<typeof TruncationConfigSchema>;
  timeouts: z.infer<typeof TimeoutsConfigSchema>;
  web: z.infer<typeof WebConfigSchema>;
  outputFilter: OutputFilterConfig;
  env: Record<string, string>;
};

// ── Singleton ─────────────────────────────────────────────────

let __config: Config | null = null;

/**
 * Load config from ~/.a2a-mcp/config.json, creating defaults if not found.
 * Environment variable overrides:
 *   A2A_PORT → server.port
 *   A2A_API_KEY → server.apiKey
 *   A2A_ERP_AUTO_RENEW_ENABLED → erp.autoRenewEnabled
 *   A2A_ERP_SWEEP_INTERVAL_MS → erp.renewalSweepIntervalMs
 *   A2A_ERP_SWEEP_JITTER_MS → erp.renewalSweepJitterMs
 *   A2A_ERP_SNAPSHOT_EXPORT_ENABLED → erp.snapshotExportEnabled
 *   A2A_ERP_SNAPSHOT_INTERVAL_MS → erp.snapshotExportIntervalMs
 *   A2A_ERP_SNAPSHOT_RETENTION_DAYS → erp.snapshotRetentionDays
 *   A2A_ERP_SNAPSHOT_OUTPUT_DIR → erp.snapshotOutputDir
 *   A2A_ERP_SNAPSHOT_SIGNING_KEY → erp.snapshotSigningKey
 *   A2A_ERP_FOLLOWUP_WRITEBACK_ENABLED → erp.followupWritebackEnabled
 *   A2A_ERP_FOLLOWUP_WRITEBACK_INTERVAL_MS → erp.followupWritebackIntervalMs
 *   A2A_ERP_FOLLOWUP_WRITEBACK_JITTER_MS → erp.followupWritebackJitterMs
 *   A2A_ERP_FOLLOWUP_WRITEBACK_LIMIT → erp.followupWritebackBatchLimit
 *   A2A_SANDBOX_TIMEOUT → sandbox.timeout
 *   A2A_MAX_RESPONSE_SIZE → truncation.maxResponseSize
 */
export function loadConfig(): Config {
  if (__config) return __config;

  let raw: Record<string, unknown> = {};

  if (existsSync(getConfigFile())) {
    try {
      raw = JSON.parse(readFileSync(getConfigFile(), "utf-8"));
      process.stderr.write(`[config] loaded from ${getConfigFile()}\n`);
    } catch (err) {
      process.stderr.write(`[config] failed to parse ${getConfigFile()}: ${err}\n`);
    }
  }

  // Environment variable overrides
  if (process.env.A2A_PORT) {
    raw.server = { ...(raw.server as object ?? {}), port: parseInt(process.env.A2A_PORT, 10) };
  }
  if (process.env.A2A_ERP_AUTO_RENEW_ENABLED) {
    raw.erp = {
      ...(raw.erp as object ?? {}),
      autoRenewEnabled: String(process.env.A2A_ERP_AUTO_RENEW_ENABLED).toLowerCase() !== "false",
    };
  }
  if (process.env.A2A_ERP_SWEEP_INTERVAL_MS) {
    raw.erp = { ...(raw.erp as object ?? {}), renewalSweepIntervalMs: parseInt(process.env.A2A_ERP_SWEEP_INTERVAL_MS, 10) };
  }
  if (process.env.A2A_ERP_SWEEP_JITTER_MS) {
    raw.erp = { ...(raw.erp as object ?? {}), renewalSweepJitterMs: parseInt(process.env.A2A_ERP_SWEEP_JITTER_MS, 10) };
  }
  if (process.env.A2A_ERP_SNAPSHOT_EXPORT_ENABLED) {
    raw.erp = {
      ...(raw.erp as object ?? {}),
      snapshotExportEnabled: String(process.env.A2A_ERP_SNAPSHOT_EXPORT_ENABLED).toLowerCase() !== "false",
    };
  }
  if (process.env.A2A_ERP_SNAPSHOT_INTERVAL_MS) {
    raw.erp = { ...(raw.erp as object ?? {}), snapshotExportIntervalMs: parseInt(process.env.A2A_ERP_SNAPSHOT_INTERVAL_MS, 10) };
  }
  if (process.env.A2A_ERP_SNAPSHOT_RETENTION_DAYS) {
    raw.erp = { ...(raw.erp as object ?? {}), snapshotRetentionDays: parseInt(process.env.A2A_ERP_SNAPSHOT_RETENTION_DAYS, 10) };
  }
  if (process.env.A2A_ERP_SNAPSHOT_OUTPUT_DIR) {
    raw.erp = { ...(raw.erp as object ?? {}), snapshotOutputDir: process.env.A2A_ERP_SNAPSHOT_OUTPUT_DIR };
  }
  if (process.env.A2A_ERP_SNAPSHOT_SIGNING_KEY) {
    raw.erp = { ...(raw.erp as object ?? {}), snapshotSigningKey: process.env.A2A_ERP_SNAPSHOT_SIGNING_KEY };
  }
  if (process.env.A2A_ERP_FOLLOWUP_WRITEBACK_ENABLED) {
    raw.erp = {
      ...(raw.erp as object ?? {}),
      followupWritebackEnabled: String(process.env.A2A_ERP_FOLLOWUP_WRITEBACK_ENABLED).toLowerCase() !== "false",
    };
  }
  if (process.env.A2A_ERP_FOLLOWUP_WRITEBACK_INTERVAL_MS) {
    raw.erp = { ...(raw.erp as object ?? {}), followupWritebackIntervalMs: parseInt(process.env.A2A_ERP_FOLLOWUP_WRITEBACK_INTERVAL_MS, 10) };
  }
  if (process.env.A2A_ERP_FOLLOWUP_WRITEBACK_JITTER_MS) {
    raw.erp = { ...(raw.erp as object ?? {}), followupWritebackJitterMs: parseInt(process.env.A2A_ERP_FOLLOWUP_WRITEBACK_JITTER_MS, 10) };
  }
  if (process.env.A2A_ERP_FOLLOWUP_WRITEBACK_LIMIT) {
    raw.erp = { ...(raw.erp as object ?? {}), followupWritebackBatchLimit: parseInt(process.env.A2A_ERP_FOLLOWUP_WRITEBACK_LIMIT, 10) };
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
  if (process.env.A2A_OUTPUT_FILTER_ENABLED !== undefined) {
    raw.outputFilter = { ...(raw.outputFilter as object ?? {}), enabled: process.env.A2A_OUTPUT_FILTER_ENABLED !== "false" };
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    process.stderr.write(`[config] validation errors: ${result.error.message}\n`);
    process.stderr.write(`[config] using defaults\n`);
    __config = applyDefaults(ConfigSchema.parse({}));
  } else {
    __config = applyDefaults(result.data);
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
  if (!existsSync(getConfigDir())) {
    mkdirSync(getConfigDir(), { recursive: true });
  }
  if (!existsSync(getConfigFile())) {
    const defaults = JSON.stringify(applyDefaults(ConfigSchema.parse({})), null, 2);
    writeFileSync(getConfigFile(), defaults, "utf-8");
    process.stderr.write(`[config] created default config at ${getConfigFile()}\n`);
  }
}
