import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import type { WorkflowDefinition } from "./workflow-engine.js";

export type ConnectorType = "odoo" | "business-central" | "dynamics";
export type ProductType = "quote-to-order" | "lead-to-cash" | "collections";

const ConnectorTypeSchema = z.enum(["odoo", "business-central", "dynamics"]);
const ProductTypeSchema = z.enum(["quote-to-order", "lead-to-cash", "collections"]);

const ConnectPayloadSchema = z.object({
  authMode: z.enum(["oauth", "api-key"]),
  config: z.record(z.string(), z.unknown()).default({}),
  metadata: z.object({
    tenantId: z.string().optional(),
    instanceUrl: z.string().url().optional(),
    odooPlan: z.string().optional(),
    tokenExpiresAt: z.string().optional(),
    webhookExpiresAt: z.string().optional(),
  }).default({}),
  enabled: z.boolean().optional().default(true),
}).strict();

const SyncPayloadSchema = z.object({
  direction: z.enum(["ingest", "writeback", "two-way"]).default("two-way"),
  entityType: z.enum(["lead", "deal", "invoice", "quote", "order"]).default("lead"),
  externalId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  maxRetries: z.number().int().min(0).max(5).default(3),
}).strict();

const KpiFilterSchema = z.object({
  since: z.string().optional(),
}).strict();

const ConnectorKpiFilterSchema = z.object({
  since: z.string().optional(),
}).strict();

const ConnectorRenewalFeedFilterSchema = z.object({
  connector: ConnectorTypeSchema.optional(),
  status: z.enum(["success", "failed"]).optional(),
  since: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
}).strict();

const ConnectorRenewalExportFilterSchema = z.object({
  connector: ConnectorTypeSchema.optional(),
  status: z.enum(["success", "failed"]).optional(),
  since: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().int().min(1).max(2000).optional().default(1000),
}).strict();

const ConnectorRenewalSnapshotFilterSchema = z.object({
  since: z.string().optional(),
  limit: z.number().int().min(1).max(2000).optional().default(1000),
}).strict();

interface ConnectorRow {
  type: ConnectorType;
  auth_mode: "oauth" | "api-key";
  config_json: string;
  metadata_json: string;
  enabled: number;
  health: "healthy" | "degraded" | "unhealthy";
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SyncRunRow {
  id: string;
  connector_type: ConnectorType;
  direction: "ingest" | "writeback" | "two-way";
  entity_type: "lead" | "deal" | "invoice" | "quote" | "order";
  external_id: string | null;
  idempotency_key: string;
  payload_json: string;
  status: "pending" | "success" | "failed";
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
  source_system: string;
  sync_state: string;
  last_sync_error: string | null;
  last_synced_at: string | null;
}

interface WorkflowRunRow {
  id: string;
  product: ProductType;
  status: "queued" | "running" | "completed" | "failed";
  task_id: string | null;
  context_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ConnectorRenewalRunRow {
  id: string;
  connector_type: ConnectorType;
  status: "success" | "failed";
  error: string | null;
  previous_expires_at: string | null;
  renewed_expires_at: string | null;
  created_at: string;
}

interface PilotLaunchRunRow {
  id: string;
  status: "blocked" | "ready" | "launched" | "delivery_failed" | "dry_run";
  readiness_json: string;
  sales_packet_json: string | null;
  delivery_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RetryableSyncError extends Error {
  retryAfterMs?: number;
  statusCode?: number;
}

export interface ConnectorSyncRequest {
  connectorType: ConnectorType;
  direction: "ingest" | "writeback" | "two-way";
  entityType: "lead" | "deal" | "invoice" | "quote" | "order";
  externalId?: string;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
  maxRetries: number;
}

export interface ConnectorSyncResult {
  runId: string;
  connectorType: ConnectorType;
  status: "success" | "failed";
  attempts: number;
  idempotencyKey: string;
  sourceSystem: string;
  entity: {
    source_system: string;
    external_id: string | null;
    sync_state: "success" | "failed";
    last_synced_at: string | null;
    last_sync_error: string | null;
  };
  result?: Record<string, unknown>;
  error?: string;
}

export interface ConnectorStatus {
  connector: ConnectorType;
  enabled: boolean;
  authMode: "oauth" | "api-key";
  health: "healthy" | "degraded" | "unhealthy";
  lastError?: string;
  lastSyncedAt?: string;
  tokenStatus: "ok" | "expiring" | "expired" | "unknown";
  renewalDue: boolean;
}

export interface ConnectorRenewalSweepResult {
  scanned: number;
  due: number;
  renewed: number;
  failed: number;
  skipped: number;
  dryRun: boolean;
  details: Array<{ connector: ConnectorType; action: "renewed" | "failed" | "skipped"; error?: string }>;
}

export interface ConnectorRenewalFeedItem {
  id: string;
  connectorType: ConnectorType;
  status: "success" | "failed";
  error: string | null;
  previousExpiresAt: string | null;
  renewedExpiresAt: string | null;
  createdAt: string;
}

export interface ConnectorRenewalSnapshot {
  generatedAt: string;
  since?: string;
  limit: number;
  rowCount: number;
  failedCount: number;
  kpis: Record<string, unknown>;
  csv: string;
}

export interface PilotLaunchRun {
  id: string;
  status: "blocked" | "ready" | "launched" | "delivery_failed" | "dry_run";
  readiness: Record<string, unknown>;
  salesPacket?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const dbPath = process.env.A2A_ERP_DB ?? join(homedir(), ".a2a-mcp", "erp-platform.db");
const db = new Database(dbPath);
db.run("PRAGMA journal_mode=WAL");
db.run("PRAGMA synchronous=NORMAL");
db.run(`CREATE TABLE IF NOT EXISTS connector_configs (
  type TEXT PRIMARY KEY,
  auth_mode TEXT NOT NULL,
  config_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  health TEXT NOT NULL DEFAULT 'healthy',
  last_error TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS connector_sync_runs (
  id TEXT PRIMARY KEY,
  connector_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  external_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_system TEXT NOT NULL,
  sync_state TEXT NOT NULL,
  last_sync_error TEXT,
  last_synced_at TEXT
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_connector_runs_type_created ON connector_sync_runs(connector_type, created_at DESC)");
db.run("CREATE INDEX IF NOT EXISTS idx_connector_runs_status ON connector_sync_runs(status)");
db.run(`CREATE TABLE IF NOT EXISTS connector_dead_letters (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  error TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS product_workflow_runs (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT,
  context_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS connector_renewal_runs (
  id TEXT PRIMARY KEY,
  connector_type TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  previous_expires_at TEXT,
  renewed_expires_at TEXT,
  created_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_connector_renewal_runs_type_created ON connector_renewal_runs(connector_type, created_at DESC)");
db.run(`CREATE TABLE IF NOT EXISTS pilot_launch_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  readiness_json TEXT NOT NULL,
  sales_packet_json TEXT,
  delivery_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_pilot_launch_runs_created ON pilot_launch_runs(created_at DESC)");

function nowIso(): string {
  return new Date().toISOString();
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getConnectorRow(connector: ConnectorType): ConnectorRow | null {
  return db.query<ConnectorRow, [ConnectorType]>(
    `SELECT type, auth_mode, config_json, metadata_json, enabled, health, last_error, last_synced_at, created_at, updated_at
     FROM connector_configs WHERE type = ?`
  ).get(connector) ?? null;
}

function computeTokenStatus(metadata: Record<string, unknown>): "ok" | "expiring" | "expired" | "unknown" {
  const raw = metadata.tokenExpiresAt;
  if (typeof raw !== "string") return "unknown";
  const expiresAt = Date.parse(raw);
  if (Number.isNaN(expiresAt)) return "unknown";
  const now = Date.now();
  if (expiresAt <= now) return "expired";
  if (expiresAt - now < 24 * 60 * 60 * 1000) return "expiring";
  return "ok";
}

function isRenewalDue(connector: ConnectorType, metadata: Record<string, unknown>): boolean {
  if (connector !== "business-central") return false;
  const raw = metadata.webhookExpiresAt;
  if (typeof raw !== "string") return false;
  const expiresAt = Date.parse(raw);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt - Date.now() < 24 * 60 * 60 * 1000;
}

function retryDelayMs(attempt: number, err: unknown): number {
  if (typeof err === "object" && err !== null) {
    const retryAfter = (err as RetryableSyncError).retryAfterMs;
    if (typeof retryAfter === "number" && retryAfter > 0) {
      return Math.min(retryAfter, 60_000);
    }
  }
  const base = 500;
  return Math.min(base * (2 ** Math.max(0, attempt - 1)), 10_000);
}

async function waitMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const statusCode = (err as RetryableSyncError).statusCode;
  if (typeof statusCode === "number") {
    return statusCode === 429 || statusCode >= 500;
  }
  const retryAfter = (err as RetryableSyncError).retryAfterMs;
  return typeof retryAfter === "number" && retryAfter > 0;
}

function validateOdooPlan(connector: ConnectorType, metadata: Record<string, unknown>): void {
  if (connector !== "odoo") return;
  const plan = String(metadata.odooPlan ?? "").toLowerCase();
  if (plan !== "custom") {
    throw new Error("Odoo onboarding requires API-capable Custom plan. Set metadata.odooPlan='custom'.");
  }
}

export function connectConnector(connectorInput: unknown, bodyInput: unknown): ConnectorStatus {
  const connector = ConnectorTypeSchema.parse(connectorInput);
  const body = ConnectPayloadSchema.parse(bodyInput);
  validateOdooPlan(connector, body.metadata);

  const now = nowIso();
  db.run(
    `INSERT INTO connector_configs (type, auth_mode, config_json, metadata_json, enabled, health, last_error, last_synced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'healthy', NULL, NULL, ?, ?)
     ON CONFLICT(type) DO UPDATE SET
       auth_mode = excluded.auth_mode,
       config_json = excluded.config_json,
       metadata_json = excluded.metadata_json,
       enabled = excluded.enabled,
       health = 'healthy',
       last_error = NULL,
       updated_at = excluded.updated_at`,
    [
      connector,
      body.authMode,
      JSON.stringify(body.config),
      JSON.stringify(body.metadata),
      body.enabled ? 1 : 0,
      now,
      now,
    ],
  );

  return getConnectorStatus(connector);
}

export function getConnectorStatus(connectorInput: unknown): ConnectorStatus {
  const connector = ConnectorTypeSchema.parse(connectorInput);
  const row = getConnectorRow(connector);
  if (!row) {
    return {
      connector,
      enabled: false,
      authMode: "api-key",
      health: "unhealthy",
      tokenStatus: "unknown",
      renewalDue: false,
      lastError: "Connector not configured",
    };
  }
  const metadata = parseMetadata(row.metadata_json);
  return {
    connector,
    enabled: row.enabled === 1,
    authMode: row.auth_mode,
    health: row.health,
    lastError: row.last_error ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
    tokenStatus: computeTokenStatus(metadata),
    renewalDue: isRenewalDue(connector, metadata),
  };
}

export function listConnectorStatuses(): ConnectorStatus[] {
  const rows = db.query<ConnectorRow, []>(
    `SELECT type, auth_mode, config_json, metadata_json, enabled, health, last_error, last_synced_at, created_at, updated_at FROM connector_configs`
  ).all();
  if (rows.length === 0) {
    return ["odoo", "business-central", "dynamics"].map(c => getConnectorStatus(c));
  }
  return rows.map(row => {
    const metadata = parseMetadata(row.metadata_json);
    return {
      connector: row.type,
      enabled: row.enabled === 1,
      authMode: row.auth_mode,
      health: row.health,
      lastError: row.last_error ?? undefined,
      lastSyncedAt: row.last_synced_at ?? undefined,
      tokenStatus: computeTokenStatus(metadata),
      renewalDue: isRenewalDue(row.type, metadata),
    } satisfies ConnectorStatus;
  });
}

export async function renewBusinessCentralSubscription(input?: {
  webhookExpiresAt?: string;
  notificationUrl?: string;
  resource?: string;
}): Promise<ConnectorStatus> {
  const row = getConnectorRow("business-central");
  if (!row || row.enabled !== 1) {
    throw new Error("Business Central connector is not connected or is disabled.");
  }
  const metadata = parseMetadata(row.metadata_json);
  const config = parseConfig(row.config_json);
  const previousExpiry = typeof metadata.webhookExpiresAt === "string" ? metadata.webhookExpiresAt : null;
  const nextExpiry = input?.webhookExpiresAt
    ? new Date(input.webhookExpiresAt).toISOString()
    : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  if (Number.isNaN(Date.parse(nextExpiry))) {
    throw new Error("Invalid webhookExpiresAt timestamp");
  }

  const mergedMetadata = { ...metadata };
  const baseUrl = resolveConnectorBaseUrl(config, mergedMetadata);
  const accessToken = typeof config.accessToken === "string" ? config.accessToken : "";
  const configuredNotificationUrl = typeof input?.notificationUrl === "string"
    ? input.notificationUrl
    : typeof config.notificationUrl === "string"
      ? config.notificationUrl
      : typeof mergedMetadata.notificationUrl === "string"
        ? mergedMetadata.notificationUrl
        : "";
  const configuredResource = typeof input?.resource === "string"
    ? input.resource
    : typeof config.resource === "string"
      ? config.resource
      : typeof mergedMetadata.resource === "string"
        ? mergedMetadata.resource
        : "";

  const shouldCallNative = Boolean(baseUrl && accessToken && configuredNotificationUrl && configuredResource);
  if (shouldCallNative) {
    const subscriptionId = typeof mergedMetadata.webhookSubscriptionId === "string"
      ? mergedMetadata.webhookSubscriptionId
      : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
    const endpoint = subscriptionId
      ? `${baseUrl}/api/v2.0/subscriptions(${subscriptionId})`
      : `${baseUrl}/api/v2.0/subscriptions`;
    const body = {
      notificationUrl: configuredNotificationUrl,
      resource: configuredResource,
      expirationDateTime: nextExpiry,
      clientState: typeof config.clientState === "string" ? config.clientState : "a2a-bc-renewal",
    };
    const method = subscriptionId ? "PATCH" : "POST";
    const req = new Request(endpoint, { method, headers, body: JSON.stringify(body) });
    let nativeSubscriptionId = subscriptionId;
    try {
      const res = await fetch(req);
      if (!res.ok) {
        throw new Error(`Business Central renewal failed: HTTP ${res.status}`);
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const data = await res.json() as Record<string, unknown>;
        const id = data.id;
        if (typeof id === "string" && id.length > 0) {
          nativeSubscriptionId = id;
        }
      }
      if (nativeSubscriptionId) {
        mergedMetadata.webhookSubscriptionId = nativeSubscriptionId;
      }
      mergedMetadata.webhookRenewedAt = nowIso();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.run(
        `UPDATE connector_configs SET health = 'degraded', last_error = ?, updated_at = ? WHERE type = 'business-central'`,
        [message, nowIso()],
      );
      db.run(
        `INSERT INTO connector_renewal_runs (id, connector_type, status, error, previous_expires_at, renewed_expires_at, created_at)
         VALUES (?, 'business-central', 'failed', ?, ?, ?, ?)`,
        [randomUUID(), message, previousExpiry, nextExpiry, nowIso()],
      );
      throw new Error(message);
    }
  }

  const now = nowIso();
  mergedMetadata.webhookExpiresAt = nextExpiry;
  if (configuredNotificationUrl) mergedMetadata.notificationUrl = configuredNotificationUrl;
  if (configuredResource) mergedMetadata.resource = configuredResource;
  db.run(
    `UPDATE connector_configs
     SET metadata_json = ?, health = 'healthy', last_error = NULL, updated_at = ?
     WHERE type = 'business-central'`,
    [JSON.stringify(mergedMetadata), now],
  );
  db.run(
    `INSERT INTO connector_renewal_runs (id, connector_type, status, error, previous_expires_at, renewed_expires_at, created_at)
     VALUES (?, 'business-central', 'success', NULL, ?, ?, ?)`,
    [randomUUID(), previousExpiry, nextExpiry, now],
  );
  return getConnectorStatus("business-central");
}

export async function renewDueConnectors(input: { dryRun?: boolean } = {}): Promise<ConnectorRenewalSweepResult> {
  const dryRun = input.dryRun === true;
  const statuses = listConnectorStatuses();
  const dueConnectors = statuses.filter(s => s.enabled && s.renewalDue);
  const result: ConnectorRenewalSweepResult = {
    scanned: statuses.length,
    due: dueConnectors.length,
    renewed: 0,
    failed: 0,
    skipped: 0,
    dryRun,
    details: [],
  };

  for (const status of dueConnectors) {
    if (status.connector !== "business-central") {
      result.skipped += 1;
      result.details.push({ connector: status.connector, action: "skipped", error: "No renewal handler for connector" });
      continue;
    }
    if (dryRun) {
      result.skipped += 1;
      result.details.push({ connector: status.connector, action: "skipped", error: "dryRun enabled" });
      continue;
    }
    try {
      await renewBusinessCentralSubscription();
      result.renewed += 1;
      result.details.push({ connector: status.connector, action: "renewed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed += 1;
      result.details.push({ connector: status.connector, action: "failed", error: message });
    }
  }
  return result;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveConnectorBaseUrl(config: Record<string, unknown>, metadata: Record<string, unknown>): string | null {
  const candidates = [config.baseUrl, config.instanceUrl, metadata.instanceUrl];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return stripTrailingSlash(c);
  }
  return null;
}

function resolveAuthHeader(
  authMode: "oauth" | "api-key",
  config: Record<string, unknown>,
): Record<string, string> {
  if (authMode === "oauth") {
    const accessToken = typeof config.accessToken === "string" ? config.accessToken : "";
    if (!accessToken) return {};
    return { Authorization: `Bearer ${accessToken}` };
  }
  const apiKey = typeof config.apiKey === "string" ? config.apiKey : "";
  if (!apiKey) return {};
  return { "X-API-Key": apiKey };
}

function mapDynamicsEntity(entityType: ConnectorSyncRequest["entityType"]): string {
  const table: Record<ConnectorSyncRequest["entityType"], string> = {
    lead: "leads",
    deal: "opportunities",
    invoice: "invoices",
    quote: "quotes",
    order: "salesorders",
  };
  return table[entityType];
}

function mapBusinessCentralEntity(entityType: ConnectorSyncRequest["entityType"]): string {
  const table: Record<ConnectorSyncRequest["entityType"], string> = {
    lead: "customers",
    deal: "salesQuotes",
    invoice: "salesInvoices",
    quote: "salesQuotes",
    order: "salesOrders",
  };
  return table[entityType];
}

function mapOdooModel(entityType: ConnectorSyncRequest["entityType"]): string {
  const table: Record<ConnectorSyncRequest["entityType"], string> = {
    lead: "crm.lead",
    deal: "crm.lead",
    invoice: "account.move",
    quote: "sale.order",
    order: "sale.order",
  };
  return table[entityType];
}

function buildNativeRequest(
  connectorType: ConnectorType,
  request: ConnectorSyncRequest,
  baseUrl: string,
): { url: string; method: "GET" | "POST" | "PATCH"; body?: string } {
  const idSuffix = request.externalId ? `(${request.externalId})` : "";

  if (connectorType === "dynamics") {
    const entity = mapDynamicsEntity(request.entityType);
    const url = `${baseUrl}/api/data/v9.2/${entity}${request.direction === "ingest" ? "" : idSuffix}`;
    if (request.direction === "ingest") return { url, method: "GET" };
    return { url, method: request.externalId ? "PATCH" : "POST", body: JSON.stringify(request.payload) };
  }

  if (connectorType === "business-central") {
    const entity = mapBusinessCentralEntity(request.entityType);
    const url = `${baseUrl}/api/v2.0/${entity}${request.direction === "ingest" ? "" : idSuffix}`;
    if (request.direction === "ingest") return { url, method: "GET" };
    return { url, method: request.externalId ? "PATCH" : "POST", body: JSON.stringify(request.payload) };
  }

  const model = mapOdooModel(request.entityType);
  if (request.direction === "ingest") {
    return {
      url: `${baseUrl}/json/2/${model}/search_read`,
      method: "POST",
      body: JSON.stringify({ domain: [], limit: 50 }),
    };
  }
  const methodName = request.externalId ? "write" : "create";
  return {
    url: `${baseUrl}/json/2/${model}/${methodName}`,
    method: "POST",
    body: request.externalId
      ? JSON.stringify({ ids: [request.externalId], values: request.payload })
      : JSON.stringify(request.payload),
  };
}

async function runNativeConnectorSync(
  row: ConnectorRow,
  request: ConnectorSyncRequest,
): Promise<Record<string, unknown>> {
  const config = parseConfig(row.config_json);
  const metadata = parseMetadata(row.metadata_json);
  const baseUrl = resolveConnectorBaseUrl(config, metadata);
  if (!baseUrl) {
    return {
      mode: "simulated",
      connector: request.connectorType,
      reason: "No connector base URL configured",
      direction: request.direction,
      entityType: request.entityType,
      externalId: request.externalId ?? null,
      syncedAt: nowIso(),
    };
  }

  const nativeReq = buildNativeRequest(request.connectorType, request, baseUrl);
  const res = await fetch(nativeReq.url, {
    method: nativeReq.method,
    headers: {
      "Content-Type": "application/json",
      ...resolveAuthHeader(row.auth_mode, config),
    },
    body: nativeReq.body,
  });

  if (!res.ok) {
    const err = new Error(`Connector ${request.connectorType} sync failed: HTTP ${res.status}`) as RetryableSyncError;
    err.statusCode = res.status;
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        err.retryAfterMs = seconds * 1000;
      }
    }
    throw err;
  }

  let upstream: unknown = null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) upstream = await res.json();
  else upstream = await res.text();

  return {
    mode: "native",
    connector: request.connectorType,
    direction: request.direction,
    entityType: request.entityType,
    externalId: request.externalId ?? null,
    syncedAt: nowIso(),
    upstream,
  };
}

export async function syncConnector(
  connectorInput: unknown,
  bodyInput: unknown,
  executor?: (req: ConnectorSyncRequest) => Promise<Record<string, unknown>>,
): Promise<ConnectorSyncResult> {
  const connectorType = ConnectorTypeSchema.parse(connectorInput);
  const body = SyncPayloadSchema.parse(bodyInput);
  const row = getConnectorRow(connectorType);
  if (!row || row.enabled !== 1) {
    throw new Error(`Connector '${connectorType}' is not connected or disabled.`);
  }

  const idempotencyKey = body.idempotencyKey ?? `${connectorType}:${body.entityType}:${body.externalId ?? randomUUID()}`;
  const existing = db.query<SyncRunRow, [string]>(
    `SELECT id, connector_type, direction, entity_type, external_id, idempotency_key, payload_json, status, attempts, last_error, next_retry_at, created_at, updated_at, source_system, sync_state, last_sync_error, last_synced_at
     FROM connector_sync_runs WHERE idempotency_key = ?`
  ).get(idempotencyKey);

  if (existing) {
    return {
      runId: existing.id,
      connectorType: existing.connector_type,
      status: existing.status === "success" ? "success" : "failed",
      attempts: existing.attempts,
      idempotencyKey: existing.idempotency_key,
      sourceSystem: existing.source_system,
      entity: {
        source_system: existing.source_system,
        external_id: existing.external_id,
        sync_state: existing.sync_state === "success" ? "success" : "failed",
        last_synced_at: existing.last_synced_at,
        last_sync_error: existing.last_sync_error,
      },
      result: existing.status === "success" ? JSON.parse(existing.payload_json) : undefined,
      error: existing.status === "failed" ? existing.last_error ?? undefined : undefined,
    };
  }

  const runId = randomUUID();
  const createdAt = nowIso();
  db.run(
    `INSERT INTO connector_sync_runs (id, connector_type, direction, entity_type, external_id, idempotency_key, payload_json, status, attempts, last_error, next_retry_at, created_at, updated_at, source_system, sync_state, last_sync_error, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, ?, 'pending', NULL, NULL)`,
    [
      runId,
      connectorType,
      body.direction,
      body.entityType,
      body.externalId ?? null,
      idempotencyKey,
      JSON.stringify(body.payload),
      createdAt,
      createdAt,
      connectorType,
    ],
  );

  const request: ConnectorSyncRequest = {
    connectorType,
    direction: body.direction,
    entityType: body.entityType,
    externalId: body.externalId,
    idempotencyKey,
    payload: body.payload,
    maxRetries: body.maxRetries,
  };

  const runSync = executor ?? ((req: ConnectorSyncRequest) => runNativeConnectorSync(row, req));

  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      const result = await runSync(request);
      const syncedAt = nowIso();
      db.run(
        `UPDATE connector_sync_runs
         SET status = 'success', attempts = ?, payload_json = ?, last_error = NULL, next_retry_at = NULL, updated_at = ?, sync_state = 'success', last_sync_error = NULL, last_synced_at = ?
         WHERE id = ?`,
        [attempts, JSON.stringify(result), syncedAt, syncedAt, runId],
      );
      db.run(
        `UPDATE connector_configs SET health = 'healthy', last_error = NULL, last_synced_at = ?, updated_at = ? WHERE type = ?`,
        [syncedAt, syncedAt, connectorType],
      );

      return {
        runId,
        connectorType,
        status: "success",
        attempts,
        idempotencyKey,
        sourceSystem: connectorType,
        entity: {
          source_system: connectorType,
          external_id: body.externalId ?? null,
          sync_state: "success",
          last_synced_at: syncedAt,
          last_sync_error: null,
        },
        result,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const retryable = isRetryable(err);
      const exhausted = attempts > body.maxRetries;
      if (retryable && !exhausted) {
        const delay = retryDelayMs(attempts, err);
        const nextRetryAt = new Date(Date.now() + delay).toISOString();
        db.run(
          `UPDATE connector_sync_runs
           SET attempts = ?, last_error = ?, next_retry_at = ?, updated_at = ?, sync_state = 'retrying', last_sync_error = ?
           WHERE id = ?`,
          [attempts, errMsg, nextRetryAt, nowIso(), errMsg, runId],
        );
        db.run(
          `UPDATE connector_configs SET health = 'degraded', last_error = ?, updated_at = ? WHERE type = ?`,
          [errMsg, nowIso(), connectorType],
        );
        await waitMs(delay);
        continue;
      }

      const failedAt = nowIso();
      db.run(
        `UPDATE connector_sync_runs
         SET status = 'failed', attempts = ?, last_error = ?, next_retry_at = NULL, updated_at = ?, sync_state = 'failed', last_sync_error = ?
         WHERE id = ?`,
        [attempts, errMsg, failedAt, errMsg, runId],
      );
      db.run(
        `UPDATE connector_configs SET health = 'unhealthy', last_error = ?, updated_at = ? WHERE type = ?`,
        [errMsg, failedAt, connectorType],
      );
      db.run(
        `INSERT INTO connector_dead_letters (id, run_id, connector_type, error, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), runId, connectorType, errMsg, JSON.stringify(body.payload), failedAt],
      );

      return {
        runId,
        connectorType,
        status: "failed",
        attempts,
        idempotencyKey,
        sourceSystem: connectorType,
        entity: {
          source_system: connectorType,
          external_id: body.externalId ?? null,
          sync_state: "failed",
          last_synced_at: null,
          last_sync_error: errMsg,
        },
        error: errMsg,
      };
    }
  }
}

export function replayDeadLetter(runId: string): { found: boolean; payload?: Record<string, unknown>; connectorType?: ConnectorType } {
  const row = db.query<{ connector_type: ConnectorType; payload_json: string }, [string]>(
    `SELECT connector_type, payload_json FROM connector_dead_letters WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(runId);
  if (!row) return { found: false };
  return { found: true, payload: JSON.parse(row.payload_json) as Record<string, unknown>, connectorType: row.connector_type };
}

export function workflowDefinitionFor(productInput: unknown, context: Record<string, unknown> = {}): WorkflowDefinition {
  const product = ProductTypeSchema.parse(productInput);
  const customerName = typeof context.customerName === "string" ? context.customerName : "Customer";

  switch (product) {
    case "quote-to-order":
      return {
        id: `quote-to-order-${randomUUID().slice(0, 8)}`,
        name: "Quote to Order Accelerator",
        description: "Quote approval SLA, order sync, stakeholder notification",
        maxConcurrency: 3,
        steps: [
          {
            id: "fetch_quote",
            skillId: "fetch_url",
            label: "Fetch quote payload",
            args: { url: String(context.quoteUrl ?? "https://example.com/quote"), format: "json" },
            onError: "retry",
            maxRetries: 2,
          },
          {
            id: "approval_gate",
            skillId: "event_publish",
            label: "Publish quote approval request",
            dependsOn: ["fetch_quote"],
            args: { topic: "user.quote.approval.requested", data: { customer: customerName, quote: "{{fetch_quote.result}}" } },
          },
          {
            id: "sync_order",
            skillId: "agency_roi_snapshot",
            label: "Record sync checkpoint",
            dependsOn: ["approval_gate"],
          },
        ],
      };

    case "lead-to-cash":
      return {
        id: `lead-to-cash-${randomUUID().slice(0, 8)}`,
        name: "Lead to Cash Sync Hub",
        description: "Lead intake SLA, stage sync, and handoff controls",
        maxConcurrency: 4,
        steps: [
          {
            id: "ingest_lead",
            skillId: "fetch_url",
            label: "Ingest lead payload",
            args: { url: String(context.leadUrl ?? "https://example.com/lead"), format: "json" },
            onError: "retry",
            maxRetries: 2,
          },
          {
            id: "notify_owner",
            skillId: "event_publish",
            label: "Notify lead owner",
            dependsOn: ["ingest_lead"],
            args: { topic: "user.lead.ingested", data: { customer: customerName, lead: "{{ingest_lead.result}}" } },
          },
          {
            id: "handoff_checkpoint",
            skillId: "agency_roi_snapshot",
            label: "Record handoff KPI checkpoint",
            dependsOn: ["notify_owner"],
          },
        ],
      };

    case "collections":
      return {
        id: `collections-${randomUUID().slice(0, 8)}`,
        name: "Collections Copilot",
        description: "Overdue detection, sequence automation, and promise-to-pay tracking",
        maxConcurrency: 3,
        steps: [
          {
            id: "fetch_overdue",
            skillId: "fetch_url",
            label: "Fetch overdue invoices",
            args: { url: String(context.invoiceUrl ?? "https://example.com/invoices/overdue"), format: "json" },
            onError: "retry",
            maxRetries: 2,
          },
          {
            id: "sequence_alert",
            skillId: "event_publish",
            label: "Publish collections follow-up signal",
            dependsOn: ["fetch_overdue"],
            args: { topic: "user.collections.sequence.triggered", data: { customer: customerName, invoices: "{{fetch_overdue.result}}" } },
          },
          {
            id: "collections_kpi",
            skillId: "agency_roi_snapshot",
            label: "Capture collections KPI snapshot",
            dependsOn: ["sequence_alert"],
          },
        ],
      };
  }
}

export function recordWorkflowRun(productInput: unknown, status: WorkflowRunRow["status"], taskId: string | null, context: Record<string, unknown>, error?: string): string {
  const product = ProductTypeSchema.parse(productInput);
  const id = randomUUID();
  const now = nowIso();
  db.run(
    `INSERT INTO product_workflow_runs (id, product, status, task_id, context_json, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, product, status, taskId, JSON.stringify(context), error ?? null, now, now],
  );
  return id;
}

export function updateWorkflowRun(id: string, status: WorkflowRunRow["status"], error?: string): void {
  db.run(
    `UPDATE product_workflow_runs SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
    [status, error ?? null, nowIso(), id],
  );
}

export function getProductKpis(productInput: unknown, filtersInput: unknown = {}): Record<string, unknown> {
  const product = ProductTypeSchema.parse(productInput);
  const filters = KpiFilterSchema.parse(filtersInput);

  const where = filters.since ? "WHERE created_at >= ?" : "";
  const params = filters.since ? [filters.since] : [];

  const workflowStats = db.query<{ total: number; completed: number; failed: number }, unknown[]>(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM product_workflow_runs
     WHERE product = ? ${filters.since ? "AND created_at >= ?" : ""}`
  ).get(product, ...params) ?? { total: 0, completed: 0, failed: 0 };

  const syncStats = db.query<{ synced: number; failed: number; entities: number }, unknown[]>(
    `SELECT
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as synced,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      COUNT(DISTINCT external_id) as entities
     FROM connector_sync_runs ${where}`
  ).get(...params) ?? { synced: 0, failed: 0, entities: 0 };

  const successRate = workflowStats.total > 0
    ? Number(((workflowStats.completed / workflowStats.total) * 100).toFixed(1))
    : 0;

  const revenueSignals = {
    "quote-to-order": {
      kpi: "Quote conversion acceleration",
      proxyValue: workflowStats.completed,
      unit: "approved quote-to-order flows",
    },
    "lead-to-cash": {
      kpi: "Lead leakage prevention",
      proxyValue: syncStats.synced,
      unit: "lead/deal sync successes",
    },
    "collections": {
      kpi: "Cash recovery acceleration",
      proxyValue: syncStats.synced,
      unit: "collections sync actions",
    },
  } as const;

  return {
    product,
    timeframe: { since: filters.since ?? "all_time" },
    workflowRuns: {
      total: workflowStats.total,
      completed: workflowStats.completed,
      failed: workflowStats.failed,
      successRatePct: successRate,
    },
    sync: {
      successfulRuns: syncStats.synced,
      failedRuns: syncStats.failed,
      distinctEntitiesTouched: syncStats.entities,
    },
    revenueSignal: revenueSignals[product],
  };
}

export function getConnectorKpis(filtersInput: unknown = {}): Record<string, unknown> {
  const filters = ConnectorKpiFilterSchema.parse(filtersInput);
  const params = filters.since ? [filters.since] : [];
  const where = filters.since ? "WHERE created_at >= ?" : "";

  const totals = db.query<{ total: number; healthy: number; degraded: number; unhealthy: number }, []>(
    `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN health = 'healthy' THEN 1 ELSE 0 END) as healthy,
      SUM(CASE WHEN health = 'degraded' THEN 1 ELSE 0 END) as degraded,
      SUM(CASE WHEN health = 'unhealthy' THEN 1 ELSE 0 END) as unhealthy
     FROM connector_configs`
  ).get() ?? { total: 0, healthy: 0, degraded: 0, unhealthy: 0 };

  const renewalRuns = db.query<{ total: number; success: number; failed: number }, unknown[]>(
    `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM connector_renewal_runs ${where}`
  ).get(...params) ?? { total: 0, success: 0, failed: 0 };

  const renewalDue = listConnectorStatuses().filter(s => s.enabled && s.renewalDue).length;
  const renewalSuccessRate = renewalRuns.total > 0
    ? Number(((renewalRuns.success / renewalRuns.total) * 100).toFixed(1))
    : 0;

  return {
    timeframe: { since: filters.since ?? "all_time" },
    connectors: {
      total: totals.total,
      healthy: totals.healthy,
      degraded: totals.degraded,
      unhealthy: totals.unhealthy,
      renewalDue,
    },
    renewals: {
      totalRuns: renewalRuns.total,
      successfulRuns: renewalRuns.success,
      failedRuns: renewalRuns.failed,
      successRatePct: renewalSuccessRate,
    },
    alerting: {
      renewalBacklog: renewalDue > 0,
      unhealthyConnectors: totals.unhealthy,
      degradedConnectors: totals.degraded,
    },
  };
}

export function listConnectorRenewals(filtersInput: unknown = {}): {
  items: ConnectorRenewalFeedItem[];
  nextBefore?: string;
} {
  const filters = ConnectorRenewalFeedFilterSchema.parse(filtersInput);
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.connector) {
    where.push("connector_type = ?");
    params.push(filters.connector);
  }
  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  if (filters.since) {
    where.push("created_at >= ?");
    params.push(filters.since);
  }
  if (filters.before) {
    const cursor = filters.before;
    const cursorParts = cursor.split("|");
    if (cursorParts.length === 2) {
      const [cursorTs, cursorId] = cursorParts;
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(cursorTs, cursorTs, cursorId);
    } else {
      where.push("created_at < ?");
      params.push(cursor);
    }
  }

  const sql = `SELECT id, connector_type, status, error, previous_expires_at, renewed_expires_at, created_at
               FROM connector_renewal_runs
               ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC, id DESC
               LIMIT ?`;
  params.push(filters.limit + 1);

  const rows = db.query<ConnectorRenewalRunRow, unknown[]>(sql).all(...params);
  const hasMore = rows.length > filters.limit;
  const sliced = hasMore ? rows.slice(0, filters.limit) : rows;

  return {
    items: sliced.map((row) => ({
      id: row.id,
      connectorType: row.connector_type,
      status: row.status,
      error: row.error,
      previousExpiresAt: row.previous_expires_at,
      renewedExpiresAt: row.renewed_expires_at,
      createdAt: row.created_at,
    })),
    nextBefore: hasMore
      ? (() => {
          const last = sliced[sliced.length - 1];
          return last ? `${last.createdAt}|${last.id}` : undefined;
        })()
      : undefined,
  };
}

function escapeCsvField(value: string | null): string {
  if (value === null) return "";
  if (/[",\n]/.test(value)) return `"${value.replaceAll("\"", "\"\"")}"`;
  return value;
}

export function exportConnectorRenewalsCsv(filtersInput: unknown = {}): string {
  const filters = ConnectorRenewalExportFilterSchema.parse(filtersInput);
  const feed = listConnectorRenewals(filters);
  const header = [
    "id",
    "connector_type",
    "status",
    "error",
    "previous_expires_at",
    "renewed_expires_at",
    "created_at",
  ].join(",");
  const lines = feed.items.map((item) => ([
    escapeCsvField(item.id),
    escapeCsvField(item.connectorType),
    escapeCsvField(item.status),
    escapeCsvField(item.error),
    escapeCsvField(item.previousExpiresAt),
    escapeCsvField(item.renewedExpiresAt),
    escapeCsvField(item.createdAt),
  ]).join(","));
  return `${header}\n${lines.join("\n")}`;
}

export function buildConnectorRenewalSnapshot(filtersInput: unknown = {}): ConnectorRenewalSnapshot {
  const filters = ConnectorRenewalSnapshotFilterSchema.parse(filtersInput);
  const feed = listConnectorRenewals({ since: filters.since, limit: filters.limit });
  const csv = exportConnectorRenewalsCsv({ since: filters.since, limit: filters.limit });
  const failedCount = feed.items.filter(i => i.status === "failed").length;
  return {
    generatedAt: nowIso(),
    since: filters.since,
    limit: filters.limit,
    rowCount: feed.items.length,
    failedCount,
    kpis: getConnectorKpis({ since: filters.since }),
    csv,
  };
}

export function createPilotLaunchRun(input: {
  status: PilotLaunchRun["status"];
  readiness: Record<string, unknown>;
  salesPacket?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  error?: string;
}): string {
  const id = randomUUID();
  const now = nowIso();
  db.run(
    `INSERT INTO pilot_launch_runs (id, status, readiness_json, sales_packet_json, delivery_json, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.status,
      JSON.stringify(input.readiness),
      input.salesPacket ? JSON.stringify(input.salesPacket) : null,
      input.delivery ? JSON.stringify(input.delivery) : null,
      input.error ?? null,
      now,
      now,
    ],
  );
  return id;
}

export function updatePilotLaunchRun(id: string, input: {
  status?: PilotLaunchRun["status"];
  salesPacket?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  error?: string;
}): void {
  const row = db.query<PilotLaunchRunRow, [string]>(
    `SELECT id, status, readiness_json, sales_packet_json, delivery_json, error, created_at, updated_at
     FROM pilot_launch_runs WHERE id = ?`
  ).get(id);
  if (!row) return;
  db.run(
    `UPDATE pilot_launch_runs
     SET status = ?, sales_packet_json = ?, delivery_json = ?, error = ?, updated_at = ?
     WHERE id = ?`,
    [
      input.status ?? row.status,
      input.salesPacket ? JSON.stringify(input.salesPacket) : row.sales_packet_json,
      input.delivery ? JSON.stringify(input.delivery) : row.delivery_json,
      input.error ?? row.error,
      nowIso(),
      id,
    ],
  );
}

export function listPilotLaunchRuns(filtersInput: unknown = {}): { items: PilotLaunchRun[] } {
  const schema = z.object({
    status: z.enum(["blocked", "ready", "launched", "delivery_failed", "dry_run"]).optional(),
    since: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional().default(50),
  }).strict();
  const filters = schema.parse(filtersInput);

  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  if (filters.since) {
    where.push("created_at >= ?");
    params.push(filters.since);
  }
  const sql = `SELECT id, status, readiness_json, sales_packet_json, delivery_json, error, created_at, updated_at
               FROM pilot_launch_runs
               ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC
               LIMIT ?`;
  params.push(filters.limit);
  const rows = db.query<PilotLaunchRunRow, unknown[]>(sql).all(...params);
  return {
    items: rows.map((row) => ({
      id: row.id,
      status: row.status,
      readiness: JSON.parse(row.readiness_json) as Record<string, unknown>,
      salesPacket: row.sales_packet_json ? JSON.parse(row.sales_packet_json) as Record<string, unknown> : undefined,
      delivery: row.delivery_json ? JSON.parse(row.delivery_json) as Record<string, unknown> : undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

export function validateProductType(input: unknown): ProductType {
  return ProductTypeSchema.parse(input);
}

export function validateConnectorType(input: unknown): ConnectorType {
  return ConnectorTypeSchema.parse(input);
}

export function resetErpPlatformForTests(): void {
  db.run(`DELETE FROM pilot_launch_runs`);
  db.run(`DELETE FROM connector_dead_letters`);
  db.run(`DELETE FROM connector_renewal_runs`);
  db.run(`DELETE FROM connector_sync_runs`);
  db.run(`DELETE FROM product_workflow_runs`);
  db.run(`DELETE FROM connector_configs`);
}
