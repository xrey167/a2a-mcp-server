import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import type { WorkflowDefinition } from "./workflow-engine.js";

export type ConnectorType = "odoo" | "business-central" | "dynamics";
export type ProductType = "quote-to-order" | "lead-to-cash" | "collections";
export type QuoteToOrderState = "draft" | "submitted" | "approved" | "rejected" | "converted_to_order" | "fulfilled";
export type MasterDataEntity = "customer" | "product" | "price" | "tax";

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

const OnboardingCreateSchema = z.object({
  customerName: z.string().min(1),
  product: ProductTypeSchema,
  connector: ConnectorTypeSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

const OnboardingCaptureSchema = z.object({
  onboardingId: z.string().min(1),
  phase: z.enum(["baseline", "current"]).optional().default("current"),
  since: z.string().optional(),
}).strict();

const OnboardingListSchema = z.object({
  status: z.enum(["active", "completed", "paused"]).optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
}).strict();

const CommercialEventSchema = z.object({
  product: ProductTypeSchema,
  stage: z.enum(["qualified_call", "proposal_sent", "pilot_signed"]),
  customerName: z.string().min(1),
  onboardingId: z.string().optional(),
  valueEur: z.number().nonnegative().optional(),
  notes: z.string().optional(),
  occurredAt: z.string().optional(),
}).strict();

const CommercialKpiFilterSchema = z.object({
  product: ProductTypeSchema.optional(),
  since: z.string().optional(),
}).strict();

const WorkflowSlaFilterSchema = z.object({
  product: ProductTypeSchema.optional(),
  since: z.string().optional(),
}).strict();

const WorkflowSlaEscalateSchema = z.object({
  product: ProductTypeSchema.optional(),
  since: z.string().optional(),
  minIntervalMinutes: z.number().int().min(1).max(24 * 60).optional().default(60),
}).strict();

const QuoteToOrderQuoteSyncSchema = z.object({
  connectorType: ConnectorTypeSchema,
  quoteExternalId: z.string().min(1),
  approvalExternalId: z.string().optional(),
  customerExternalId: z.string().optional(),
  amount: z.number().nonnegative().optional().default(0),
  currency: z.string().optional().default("EUR"),
  state: z.enum(["draft", "submitted", "approved", "rejected", "converted_to_order", "fulfilled"]).optional().default("draft"),
  approvalDeadlineAt: z.string().optional(),
  conversionDeadlineAt: z.string().optional(),
  expectedVersion: z.number().int().min(1).optional(),
  idempotencyKey: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

const QuoteToOrderOrderSyncSchema = z.object({
  connectorType: ConnectorTypeSchema,
  quoteExternalId: z.string().min(1),
  orderExternalId: z.string().min(1),
  amount: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  state: z.enum(["converted_to_order", "fulfilled"]).optional().default("converted_to_order"),
  expectedVersion: z.number().int().min(1).optional(),
  idempotencyKey: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

const QuoteToOrderApprovalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  decidedBy: z.string().optional(),
  quoteExternalId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

const MasterDataEntitySchema = z.enum(["customer", "product", "price", "tax"]);

const MasterDataSyncSchema = z.object({
  connectorType: ConnectorTypeSchema,
  idempotencyKey: z.string().optional(),
  records: z.array(z.object({
    externalId: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).default({}),
  }).strict()).optional().default([]),
  externalId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).strict();

const MasterDataMappingListSchema = z.object({
  workspaceId: z.string().min(1),
  connectorType: ConnectorTypeSchema.optional(),
  entity: MasterDataEntitySchema.optional(),
  limit: z.number().int().min(1).max(500).optional().default(200),
}).strict();

const MasterDataMappingUpdateSchema = z.object({
  unifiedField: z.string().min(1).optional(),
  externalField: z.string().min(1).optional(),
  driftStatus: z.enum(["ok", "changed"]).optional(),
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

interface OnboardingSessionRow {
  id: string;
  customer_name: string;
  product: ProductType;
  connector_type: ConnectorType | null;
  status: "active" | "completed" | "paused";
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface OnboardingSnapshotRow {
  id: string;
  onboarding_id: string;
  phase: "baseline" | "current";
  since: string | null;
  metrics_json: string;
  created_at: string;
}

interface CommercialPipelineEventRow {
  id: string;
  product: ProductType;
  stage: "qualified_call" | "proposal_sent" | "pilot_signed";
  customer_name: string;
  onboarding_id: string | null;
  value_eur: number | null;
  notes: string | null;
  occurred_at: string;
  created_at: string;
}

interface WorkflowSlaIncidentRow {
  id: string;
  product: ProductType;
  severity: "warning" | "critical";
  reason: string;
  fingerprint: string;
  status: "open" | "acknowledged" | "resolved";
  created_at: string;
  resolved_at: string | null;
}

interface QuoteToOrderRecordRow {
  id: string;
  workspace_id: string;
  source_system: ConnectorType;
  quote_external_id: string;
  order_external_id: string | null;
  approval_external_id: string | null;
  customer_external_id: string | null;
  state: QuoteToOrderState;
  amount: number;
  currency: string;
  external_id: string;
  sync_state: "success" | "failed" | "conflict";
  last_synced_at: string | null;
  last_sync_error: string | null;
  conflict_marker: string | null;
  payload_json: string;
  approval_deadline_at: string | null;
  approval_decided_at: string | null;
  conversion_deadline_at: string | null;
  converted_at: string | null;
  fulfilled_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface QuoteToOrderEventRow {
  id: string;
  workspace_id: string;
  event_type: "quote_sync" | "order_sync" | "approval_decision" | "master_data_sync";
  idempotency_key: string;
  status: "applied" | "ignored";
  created_at: string;
}

interface MasterDataMappingRow {
  id: string;
  workspace_id: string;
  connector_type: ConnectorType;
  entity: MasterDataEntity;
  external_field: string;
  unified_field: string;
  mapping_version: number;
  drift_status: "ok" | "changed";
  created_at: string;
  updated_at: string;
}

interface MasterDataRecordRow {
  id: string;
  workspace_id: string;
  connector_type: ConnectorType;
  entity: MasterDataEntity;
  external_id: string;
  source_system: ConnectorType;
  sync_state: "success" | "failed";
  last_synced_at: string | null;
  last_sync_error: string | null;
  schema_hash: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface ConnectorReplayRow {
  id: string;
  run_id: string;
  connector_type: ConnectorType;
  created_at: string;
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

export interface OnboardingSession {
  id: string;
  customerName: string;
  product: ProductType;
  connector?: ConnectorType;
  status: "active" | "completed" | "paused";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingSnapshot {
  id: string;
  onboardingId: string;
  phase: "baseline" | "current";
  since?: string;
  metrics: Record<string, unknown>;
  createdAt: string;
}

export interface CommercialPipelineEvent {
  id: string;
  product: ProductType;
  stage: "qualified_call" | "proposal_sent" | "pilot_signed";
  customerName: string;
  onboardingId?: string;
  valueEur?: number;
  notes?: string;
  occurredAt: string;
  createdAt: string;
}

export interface WorkflowSlaStatusItem {
  product: ProductType;
  thresholds: {
    maxFailureRatePct: number;
    minCompletedRuns: number;
  };
  stats: {
    totalRuns: number;
    completedRuns: number;
    failedRuns: number;
    failureRatePct: number;
  };
  breach: boolean;
  severity: "ok" | "warning" | "critical";
  reasons: string[];
  breachBreakdown: Array<{ type: "approval_overdue" | "conversion_stalled" | "sync_failure_burst"; count: number }>;
}

export interface WorkflowSlaIncident {
  id: string;
  product: ProductType;
  severity: "warning" | "critical";
  reason: string;
  status: "open" | "acknowledged" | "resolved";
  createdAt: string;
  resolvedAt?: string;
}

export interface QuoteToOrderRecord {
  id: string;
  workspaceId: string;
  sourceSystem: ConnectorType;
  quoteExternalId: string;
  orderExternalId?: string;
  approvalExternalId?: string;
  customerExternalId?: string;
  state: QuoteToOrderState;
  amount: number;
  currency: string;
  traceability: {
    source_system: string;
    external_id: string;
    sync_state: "success" | "failed" | "conflict";
    last_synced_at: string | null;
    last_sync_error: string | null;
  };
  conflictMarker?: string;
  approvalDeadlineAt?: string;
  approvalDecidedAt?: string;
  conversionDeadlineAt?: string;
  convertedAt?: string;
  fulfilledAt?: string;
  version: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MasterDataMapping {
  id: string;
  workspaceId: string;
  connectorType: ConnectorType;
  entity: MasterDataEntity;
  externalField: string;
  unifiedField: string;
  mappingVersion: number;
  driftStatus: "ok" | "changed";
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
db.run(`CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  product TEXT NOT NULL,
  connector_type TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS onboarding_snapshots (
  id TEXT PRIMARY KEY,
  onboarding_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  since TEXT,
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_created ON onboarding_sessions(created_at DESC)");
db.run("CREATE INDEX IF NOT EXISTS idx_onboarding_snapshots_session_created ON onboarding_snapshots(onboarding_id, created_at DESC)");
db.run(`CREATE TABLE IF NOT EXISTS commercial_pipeline_events (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  stage TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  onboarding_id TEXT,
  value_eur REAL,
  notes TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_commercial_events_product_stage ON commercial_pipeline_events(product, stage)");
db.run("CREATE INDEX IF NOT EXISTS idx_commercial_events_occurred ON commercial_pipeline_events(occurred_at DESC)");
db.run(`CREATE TABLE IF NOT EXISTS workflow_sla_incidents (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  severity TEXT NOT NULL,
  reason TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_workflow_sla_incidents_product_created ON workflow_sla_incidents(product, created_at DESC)");
db.run("CREATE INDEX IF NOT EXISTS idx_workflow_sla_incidents_fingerprint ON workflow_sla_incidents(fingerprint)");
db.run(`CREATE TABLE IF NOT EXISTS quote_to_order_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  quote_external_id TEXT NOT NULL,
  order_external_id TEXT,
  approval_external_id TEXT,
  customer_external_id TEXT,
  state TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  external_id TEXT NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'success',
  last_synced_at TEXT,
  last_sync_error TEXT,
  conflict_marker TEXT,
  payload_json TEXT NOT NULL,
  approval_deadline_at TEXT,
  approval_decided_at TEXT,
  conversion_deadline_at TEXT,
  converted_at TEXT,
  fulfilled_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, quote_external_id)
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_q2o_workspace_state ON quote_to_order_records(workspace_id, state)");
db.run("CREATE INDEX IF NOT EXISTS idx_q2o_conversion_deadline ON quote_to_order_records(conversion_deadline_at)");
db.run(`CREATE TABLE IF NOT EXISTS quote_to_order_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS erp_master_data_mappings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  entity TEXT NOT NULL,
  external_field TEXT NOT NULL,
  unified_field TEXT NOT NULL,
  mapping_version INTEGER NOT NULL DEFAULT 1,
  drift_status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_master_data_mapping_scope ON erp_master_data_mappings(workspace_id, connector_type, entity)");
db.run(`CREATE TABLE IF NOT EXISTS erp_master_data_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  entity TEXT NOT NULL,
  external_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  sync_state TEXT NOT NULL,
  last_synced_at TEXT,
  last_sync_error TEXT,
  schema_hash TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, connector_type, entity, external_id)
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_master_data_records_scope ON erp_master_data_records(workspace_id, connector_type, entity)");
db.run(`CREATE TABLE IF NOT EXISTS connector_replay_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_connector_replay_runs_created ON connector_replay_runs(created_at DESC)");

function ensureColumn(table: string, column: string, alterSql: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.run(alterSql);
  }
}

ensureColumn("workflow_sla_incidents", "resolved_at", "ALTER TABLE workflow_sla_incidents ADD COLUMN resolved_at TEXT");

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
  db.run(
    `INSERT INTO connector_replay_runs (id, run_id, connector_type, created_at)
     VALUES (?, ?, ?, ?)`,
    [randomUUID(), runId, row.connector_type, nowIso()],
  );
  return { found: true, payload: JSON.parse(row.payload_json) as Record<string, unknown>, connectorType: row.connector_type };
}

function toQuoteToOrderRecord(row: QuoteToOrderRecordRow): QuoteToOrderRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceSystem: row.source_system,
    quoteExternalId: row.quote_external_id,
    orderExternalId: row.order_external_id ?? undefined,
    approvalExternalId: row.approval_external_id ?? undefined,
    customerExternalId: row.customer_external_id ?? undefined,
    state: row.state,
    amount: row.amount,
    currency: row.currency,
    traceability: {
      source_system: row.source_system,
      external_id: row.external_id,
      sync_state: row.sync_state,
      last_synced_at: row.last_synced_at,
      last_sync_error: row.last_sync_error,
    },
    conflictMarker: row.conflict_marker ?? undefined,
    approvalDeadlineAt: row.approval_deadline_at ?? undefined,
    approvalDecidedAt: row.approval_decided_at ?? undefined,
    conversionDeadlineAt: row.conversion_deadline_at ?? undefined,
    convertedAt: row.converted_at ?? undefined,
    fulfilledAt: row.fulfilled_at ?? undefined,
    version: row.version,
    payload: parseMetadata(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMasterDataMapping(row: MasterDataMappingRow): MasterDataMapping {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectorType: row.connector_type,
    entity: row.entity,
    externalField: row.external_field,
    unifiedField: row.unified_field,
    mappingVersion: row.mapping_version,
    driftStatus: row.drift_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function registerQ2oEvent(workspaceId: string, eventType: QuoteToOrderEventRow["event_type"] | "master_data_sync", idempotencyKey?: string): boolean {
  if (!idempotencyKey || idempotencyKey.length === 0) return false;
  const existing = db.query<QuoteToOrderEventRow, [string]>(
    `SELECT id, workspace_id, event_type, idempotency_key, status, created_at
     FROM quote_to_order_events WHERE idempotency_key = ?`
  ).get(idempotencyKey);
  if (existing) return true;
  db.run(
    `INSERT INTO quote_to_order_events (id, workspace_id, event_type, idempotency_key, status, created_at)
     VALUES (?, ?, ?, ?, 'applied', ?)`,
    [randomUUID(), workspaceId, eventType, idempotencyKey, nowIso()],
  );
  return false;
}

function getQ2oRow(workspaceId: string, quoteExternalId: string): QuoteToOrderRecordRow | null {
  return db.query<QuoteToOrderRecordRow, [string, string]>(
    `SELECT id, workspace_id, source_system, quote_external_id, order_external_id, approval_external_id, customer_external_id, state, amount, currency,
            external_id, sync_state, last_synced_at, last_sync_error, conflict_marker, payload_json, approval_deadline_at, approval_decided_at,
            conversion_deadline_at, converted_at, fulfilled_at, version, created_at, updated_at
     FROM quote_to_order_records
     WHERE workspace_id = ? AND quote_external_id = ?`
  ).get(workspaceId, quoteExternalId) ?? null;
}

function isValidQ2oTransition(from: QuoteToOrderState, to: QuoteToOrderState): boolean {
  if (from === to) return true;
  const transitions: Record<QuoteToOrderState, QuoteToOrderState[]> = {
    draft: ["submitted", "rejected"],
    submitted: ["approved", "rejected"],
    approved: ["converted_to_order"],
    rejected: [],
    converted_to_order: ["fulfilled"],
    fulfilled: [],
  };
  return transitions[from].includes(to);
}

function mergePayload(existingRaw: string, incoming: Record<string, unknown>): string {
  const existing = parseMetadata(existingRaw);
  return JSON.stringify({ ...existing, ...incoming });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
  return Number(sorted[mid].toFixed(2));
}

export function syncQuoteToOrderQuote(workspaceIdInput: unknown, bodyInput: unknown): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const body = QuoteToOrderQuoteSyncSchema.parse(bodyInput);
  const duplicate = registerQ2oEvent(workspaceId, "quote_sync", body.idempotencyKey);
  if (duplicate) {
    return { duplicate: true, workspaceId, quoteExternalId: body.quoteExternalId };
  }

  const existing = getQ2oRow(workspaceId, body.quoteExternalId);
  const now = nowIso();
  if (!existing) {
    const id = randomUUID();
    db.run(
      `INSERT INTO quote_to_order_records (
         id, workspace_id, source_system, quote_external_id, order_external_id, approval_external_id, customer_external_id, state, amount, currency,
         external_id, sync_state, last_synced_at, last_sync_error, conflict_marker, payload_json, approval_deadline_at, approval_decided_at,
         conversion_deadline_at, converted_at, fulfilled_at, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'success', ?, NULL, NULL, ?, ?, NULL, ?, NULL, NULL, 1, ?, ?)`,
      [
        id,
        workspaceId,
        body.connectorType,
        body.quoteExternalId,
        body.approvalExternalId ?? null,
        body.customerExternalId ?? null,
        body.state,
        body.amount,
        body.currency,
        body.quoteExternalId,
        now,
        JSON.stringify(body.payload),
        body.approvalDeadlineAt ?? null,
        body.conversionDeadlineAt ?? null,
        now,
        now,
      ],
    );
    const row = getQ2oRow(workspaceId, body.quoteExternalId);
    if (!row) throw new Error("Failed to persist quote");
    return { duplicate: false, record: toQuoteToOrderRecord(row) };
  }

  if (body.expectedVersion !== undefined && existing.version !== body.expectedVersion) {
    const marker = `version_conflict:${body.expectedVersion}->${existing.version}`;
    db.run(
      `UPDATE quote_to_order_records
       SET sync_state = 'conflict', conflict_marker = ?, last_sync_error = ?, last_synced_at = ?, updated_at = ?
       WHERE id = ?`,
      [marker, marker, now, now, existing.id],
    );
    return { duplicate: false, conflict: true, conflictMarker: marker, record: toQuoteToOrderRecord({ ...existing, sync_state: "conflict", conflict_marker: marker, last_sync_error: marker, last_synced_at: now, updated_at: now }) };
  }

  if (!isValidQ2oTransition(existing.state, body.state)) {
    const marker = `invalid_transition:${existing.state}->${body.state}`;
    db.run(
      `UPDATE quote_to_order_records
       SET sync_state = 'conflict', conflict_marker = ?, last_sync_error = ?, last_synced_at = ?, updated_at = ?
       WHERE id = ?`,
      [marker, marker, now, now, existing.id],
    );
    return { duplicate: false, conflict: true, conflictMarker: marker, record: toQuoteToOrderRecord({ ...existing, sync_state: "conflict", conflict_marker: marker, last_sync_error: marker, last_synced_at: now, updated_at: now }) };
  }

  const approvalDecidedAt = body.state === "approved" || body.state === "rejected"
    ? (existing.approval_decided_at ?? now)
    : existing.approval_decided_at;
  const convertedAt = body.state === "converted_to_order" || body.state === "fulfilled"
    ? (existing.converted_at ?? now)
    : existing.converted_at;
  const fulfilledAt = body.state === "fulfilled" ? (existing.fulfilled_at ?? now) : existing.fulfilled_at;
  db.run(
    `UPDATE quote_to_order_records
     SET source_system = ?, approval_external_id = COALESCE(?, approval_external_id), customer_external_id = COALESCE(?, customer_external_id),
         state = ?, amount = ?, currency = ?, sync_state = 'success', last_synced_at = ?, last_sync_error = NULL, conflict_marker = NULL,
         payload_json = ?, approval_deadline_at = COALESCE(?, approval_deadline_at), approval_decided_at = ?, conversion_deadline_at = COALESCE(?, conversion_deadline_at),
         converted_at = ?, fulfilled_at = ?, version = version + 1, updated_at = ?
     WHERE id = ?`,
    [
      body.connectorType,
      body.approvalExternalId ?? null,
      body.customerExternalId ?? null,
      body.state,
      body.amount,
      body.currency,
      now,
      mergePayload(existing.payload_json, body.payload),
      body.approvalDeadlineAt ?? null,
      approvalDecidedAt,
      body.conversionDeadlineAt ?? null,
      convertedAt,
      fulfilledAt,
      now,
      existing.id,
    ],
  );
  const row = getQ2oRow(workspaceId, body.quoteExternalId);
  if (!row) throw new Error("Failed to update quote");
  return { duplicate: false, record: toQuoteToOrderRecord(row) };
}

export function syncQuoteToOrderOrder(workspaceIdInput: unknown, bodyInput: unknown): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const body = QuoteToOrderOrderSyncSchema.parse(bodyInput);
  const duplicate = registerQ2oEvent(workspaceId, "order_sync", body.idempotencyKey);
  if (duplicate) {
    return { duplicate: true, workspaceId, quoteExternalId: body.quoteExternalId, orderExternalId: body.orderExternalId };
  }
  const existing = getQ2oRow(workspaceId, body.quoteExternalId);
  const now = nowIso();
  if (!existing) {
    if (body.state === "fulfilled") {
      throw new Error("Cannot fulfill quote without prior conversion state");
    }
    const id = randomUUID();
    db.run(
      `INSERT INTO quote_to_order_records (
         id, workspace_id, source_system, quote_external_id, order_external_id, approval_external_id, customer_external_id, state, amount, currency,
         external_id, sync_state, last_synced_at, last_sync_error, conflict_marker, payload_json, approval_deadline_at, approval_decided_at,
         conversion_deadline_at, converted_at, fulfilled_at, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'success', ?, NULL, NULL, ?, NULL, NULL, NULL, ?, NULL, 1, ?, ?)`,
      [
        id,
        workspaceId,
        body.connectorType,
        body.quoteExternalId,
        body.orderExternalId,
        body.state,
        body.amount ?? 0,
        body.currency ?? "EUR",
        body.quoteExternalId,
        now,
        JSON.stringify(body.payload),
        now,
        now,
        now,
      ],
    );
    const row = getQ2oRow(workspaceId, body.quoteExternalId);
    if (!row) throw new Error("Failed to persist order sync");
    return { duplicate: false, record: toQuoteToOrderRecord(row) };
  }

  if (body.expectedVersion !== undefined && existing.version !== body.expectedVersion) {
    const marker = `version_conflict:${body.expectedVersion}->${existing.version}`;
    db.run(
      `UPDATE quote_to_order_records
       SET sync_state = 'conflict', conflict_marker = ?, last_sync_error = ?, last_synced_at = ?, updated_at = ?
       WHERE id = ?`,
      [marker, marker, now, now, existing.id],
    );
    return { duplicate: false, conflict: true, conflictMarker: marker };
  }

  if (!isValidQ2oTransition(existing.state, body.state)) {
    const marker = `invalid_transition:${existing.state}->${body.state}`;
    db.run(
      `UPDATE quote_to_order_records
       SET sync_state = 'conflict', conflict_marker = ?, last_sync_error = ?, last_synced_at = ?, updated_at = ?
       WHERE id = ?`,
      [marker, marker, now, now, existing.id],
    );
    return { duplicate: false, conflict: true, conflictMarker: marker };
  }

  const convertedAt = existing.converted_at ?? now;
  const fulfilledAt = body.state === "fulfilled" ? (existing.fulfilled_at ?? now) : existing.fulfilled_at;
  db.run(
    `UPDATE quote_to_order_records
     SET source_system = ?, order_external_id = ?, state = ?, amount = COALESCE(?, amount), currency = COALESCE(?, currency),
         sync_state = 'success', last_synced_at = ?, last_sync_error = NULL, conflict_marker = NULL, payload_json = ?,
         converted_at = ?, fulfilled_at = ?, version = version + 1, updated_at = ?
     WHERE id = ?`,
    [
      body.connectorType,
      body.orderExternalId,
      body.state,
      body.amount ?? null,
      body.currency ?? null,
      now,
      mergePayload(existing.payload_json, body.payload),
      convertedAt,
      fulfilledAt,
      now,
      existing.id,
    ],
  );
  const row = getQ2oRow(workspaceId, body.quoteExternalId);
  if (!row) throw new Error("Failed to update order sync");
  return { duplicate: false, record: toQuoteToOrderRecord(row) };
}

export function decideQuoteToOrderApproval(workspaceIdInput: unknown, approvalExternalIdInput: unknown, bodyInput: unknown): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const approvalExternalId = z.string().min(1).parse(approvalExternalIdInput);
  const body = QuoteToOrderApprovalDecisionSchema.parse(bodyInput);
  const duplicate = registerQ2oEvent(workspaceId, "approval_decision", body.idempotencyKey);
  if (duplicate) return { duplicate: true, approvalExternalId };

  const byApproval = db.query<QuoteToOrderRecordRow, [string, string]>(
    `SELECT id, workspace_id, source_system, quote_external_id, order_external_id, approval_external_id, customer_external_id, state, amount, currency,
            external_id, sync_state, last_synced_at, last_sync_error, conflict_marker, payload_json, approval_deadline_at, approval_decided_at,
            conversion_deadline_at, converted_at, fulfilled_at, version, created_at, updated_at
     FROM quote_to_order_records WHERE workspace_id = ? AND approval_external_id = ?`
  ).get(workspaceId, approvalExternalId);
  const existing = byApproval ?? (body.quoteExternalId ? getQ2oRow(workspaceId, body.quoteExternalId) : null);
  if (!existing) throw new Error(`Approval '${approvalExternalId}' not found for workspace '${workspaceId}'`);

  const targetState: QuoteToOrderState = body.decision === "approved" ? "approved" : "rejected";
  if (!isValidQ2oTransition(existing.state, targetState)) {
    const marker = `invalid_transition:${existing.state}->${targetState}`;
    db.run(
      `UPDATE quote_to_order_records
       SET sync_state = 'conflict', conflict_marker = ?, last_sync_error = ?, last_synced_at = ?, updated_at = ?
       WHERE id = ?`,
      [marker, marker, nowIso(), nowIso(), existing.id],
    );
    return { duplicate: false, conflict: true, conflictMarker: marker };
  }

  const decidedAt = nowIso();
  db.run(
    `UPDATE quote_to_order_records
     SET state = ?, approval_external_id = COALESCE(?, approval_external_id), approval_decided_at = ?,
         sync_state = 'success', last_synced_at = ?, last_sync_error = NULL, conflict_marker = NULL,
         payload_json = ?, version = version + 1, updated_at = ?
     WHERE id = ?`,
    [
      targetState,
      approvalExternalId,
      decidedAt,
      decidedAt,
      mergePayload(existing.payload_json, { ...body.payload, decidedBy: body.decidedBy, decision: body.decision, decisionAt: decidedAt }),
      decidedAt,
      existing.id,
    ],
  );
  const updated = getQ2oRow(workspaceId, existing.quote_external_id);
  if (!updated) throw new Error("Failed to update approval decision");
  return { duplicate: false, record: toQuoteToOrderRecord(updated) };
}

export function getQuoteToOrderPipeline(workspaceIdInput: unknown, filtersInput: unknown = {}): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const filters = z.object({ since: z.string().optional() }).strict().parse(filtersInput);
  const params: unknown[] = [workspaceId];
  const whereSince = filters.since ? "AND created_at >= ?" : "";
  if (filters.since) params.push(filters.since);

  const stateRows = db.query<{ state: QuoteToOrderState; cnt: number; amount: number | null }, unknown[]>(
    `SELECT state, COUNT(*) as cnt, SUM(amount) as amount
     FROM quote_to_order_records
     WHERE workspace_id = ? ${whereSince}
     GROUP BY state`
  ).all(...params);
  const states: Record<QuoteToOrderState, { count: number; amount: number }> = {
    draft: { count: 0, amount: 0 },
    submitted: { count: 0, amount: 0 },
    approved: { count: 0, amount: 0 },
    rejected: { count: 0, amount: 0 },
    converted_to_order: { count: 0, amount: 0 },
    fulfilled: { count: 0, amount: 0 },
  };
  for (const row of stateRows) states[row.state] = { count: row.cnt, amount: num(row.amount) };

  const submitted = states.submitted.count + states.approved.count + states.converted_to_order.count + states.fulfilled.count + states.rejected.count;
  const converted = states.converted_to_order.count + states.fulfilled.count;
  const conversionRatePct = submitted > 0 ? Number(((converted / submitted) * 100).toFixed(1)) : 0;
  const revenueAtRisk = states.submitted.amount + states.approved.amount;

  const approvalRows = db.query<{ mins: number }, unknown[]>(
    `SELECT ((julianday(approval_decided_at) - julianday(created_at)) * 24 * 60) as mins
     FROM quote_to_order_records
     WHERE workspace_id = ? AND approval_decided_at IS NOT NULL ${whereSince}`
  ).all(...params);
  const medianApprovalMinutes = median(approvalRows.map((r) => num(r.mins)).filter((v) => v > 0));

  const first = db.query<{ submittedAt: string | null; convertedAt: string | null }, [string]>(
    `SELECT MIN(created_at) as submittedAt, MIN(converted_at) as convertedAt
     FROM quote_to_order_records
     WHERE workspace_id = ? AND converted_at IS NOT NULL`
  ).get(workspaceId);
  const timeToFirstOrderConversionHours = first?.submittedAt && first?.convertedAt
    ? Number((((Date.parse(first.convertedAt) - Date.parse(first.submittedAt)) / 3600000)).toFixed(2))
    : null;

  const stalledRecovered = db.query<{ value: number | null }, [string]>(
    `SELECT SUM(amount) as value
     FROM quote_to_order_records
     WHERE workspace_id = ? AND converted_at IS NOT NULL AND conversion_deadline_at IS NOT NULL AND converted_at > conversion_deadline_at`
  ).get(workspaceId);

  return {
    workspaceId,
    timeframe: { since: filters.since ?? "all_time" },
    states,
    metrics: {
      quoteToOrderConversionRatePct: conversionRatePct,
      medianApprovalTimeMinutes: medianApprovalMinutes,
      revenueAtRisk: Math.round(revenueAtRisk),
      timeToFirstOrderConversionHours,
      valueRecoveredFromStalledQuotes: Math.round(num(stalledRecovered?.value)),
    },
  };
}

function detectSchemaDrift(payload: Record<string, unknown>, mappings: MasterDataMappingRow[]): { drift: boolean; unmappedFields: string[] } {
  const mapped = new Set(mappings.map((m) => m.external_field));
  const fields = Object.keys(payload);
  const unmapped = fields.filter((f) => !mapped.has(f));
  return { drift: unmapped.length > 0, unmappedFields: unmapped };
}

function currentMappingVersion(workspaceId: string, connectorType: ConnectorType, entity: MasterDataEntity): number {
  const row = db.query<{ maxVersion: number | null }, [string, ConnectorType, MasterDataEntity]>(
    `SELECT MAX(mapping_version) as maxVersion
     FROM erp_master_data_mappings
     WHERE workspace_id = ? AND connector_type = ? AND entity = ?`
  ).get(workspaceId, connectorType, entity);
  return Math.max(1, num(row?.maxVersion));
}

export function syncMasterDataEntity(workspaceIdInput: unknown, entityInput: unknown, bodyInput: unknown): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const entity = MasterDataEntitySchema.parse(entityInput);
  const body = MasterDataSyncSchema.parse(bodyInput);
  const duplicate = registerQ2oEvent(workspaceId, "master_data_sync", body.idempotencyKey);
  if (duplicate) return { duplicate: true, workspaceId, entity };

  const inputRecords = body.records.length > 0
    ? body.records
    : (body.externalId && body.payload ? [{ externalId: body.externalId, payload: body.payload }] : []);
  if (inputRecords.length === 0) {
    throw new Error("No master data records provided. Use records[] or externalId+payload.");
  }

  const now = nowIso();
  const mappings = db.query<MasterDataMappingRow, [string, ConnectorType, MasterDataEntity]>(
    `SELECT id, workspace_id, connector_type, entity, external_field, unified_field, mapping_version, drift_status, created_at, updated_at
     FROM erp_master_data_mappings
     WHERE workspace_id = ? AND connector_type = ? AND entity = ?`
  ).all(workspaceId, body.connectorType, entity);

  let driftDetected = false;
  const driftFields = new Set<string>();
  for (const item of inputRecords) {
    const payload = item.payload;
    const schemaHash = Bun.hash(Object.keys(payload).sort().join("|")).toString(16);
    const drift = detectSchemaDrift(payload, mappings);
    if (drift.drift) {
      driftDetected = true;
      for (const f of drift.unmappedFields) driftFields.add(f);
      const version = currentMappingVersion(workspaceId, body.connectorType, entity);
      for (const field of drift.unmappedFields) {
        db.run(
          `INSERT INTO erp_master_data_mappings (id, workspace_id, connector_type, entity, external_field, unified_field, mapping_version, drift_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'changed', ?, ?)`,
          [randomUUID(), workspaceId, body.connectorType, entity, field, field, version, now, now],
        );
      }
    }
    db.run(
      `INSERT INTO erp_master_data_records (
         id, workspace_id, connector_type, entity, external_id, source_system, sync_state, last_synced_at, last_sync_error, schema_hash, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'success', ?, NULL, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, connector_type, entity, external_id) DO UPDATE SET
         sync_state = 'success',
         last_synced_at = excluded.last_synced_at,
         last_sync_error = NULL,
         schema_hash = excluded.schema_hash,
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      [
        randomUUID(),
        workspaceId,
        body.connectorType,
        entity,
        item.externalId,
        body.connectorType,
        now,
        schemaHash,
        JSON.stringify(payload),
        now,
        now,
      ],
    );
  }

  return {
    duplicate: false,
    workspaceId,
    connectorType: body.connectorType,
    entity,
    syncedRecords: inputRecords.length,
    driftDetected,
    driftFields: Array.from(driftFields.values()),
    mappingVersion: currentMappingVersion(workspaceId, body.connectorType, entity),
  };
}

export function listMasterDataMappings(filtersInput: unknown): { items: MasterDataMapping[] } {
  const filters = MasterDataMappingListSchema.parse(filtersInput);
  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [filters.workspaceId];
  if (filters.connectorType) {
    where.push("connector_type = ?");
    params.push(filters.connectorType);
  }
  if (filters.entity) {
    where.push("entity = ?");
    params.push(filters.entity);
  }
  const sql = `SELECT id, workspace_id, connector_type, entity, external_field, unified_field, mapping_version, drift_status, created_at, updated_at
               FROM erp_master_data_mappings
               WHERE ${where.join(" AND ")}
               ORDER BY updated_at DESC
               LIMIT ?`;
  params.push(filters.limit);
  const rows = db.query<MasterDataMappingRow, unknown[]>(sql).all(...params);
  return { items: rows.map(toMasterDataMapping) };
}

export function updateMasterDataMapping(mappingIdInput: unknown, bodyInput: unknown): MasterDataMapping {
  const mappingId = z.string().min(1).parse(mappingIdInput);
  const body = MasterDataMappingUpdateSchema.parse(bodyInput);
  const existing = db.query<MasterDataMappingRow, [string]>(
    `SELECT id, workspace_id, connector_type, entity, external_field, unified_field, mapping_version, drift_status, created_at, updated_at
     FROM erp_master_data_mappings WHERE id = ?`
  ).get(mappingId);
  if (!existing) throw new Error(`Master data mapping '${mappingId}' not found`);

  const nextVersion = existing.mapping_version + 1;
  const now = nowIso();
  db.run(
    `UPDATE erp_master_data_mappings
     SET external_field = ?, unified_field = ?, mapping_version = ?, drift_status = ?, updated_at = ?
     WHERE id = ?`,
    [
      body.externalField ?? existing.external_field,
      body.unifiedField ?? existing.unified_field,
      nextVersion,
      body.driftStatus ?? "ok",
      now,
      mappingId,
    ],
  );
  const updated = db.query<MasterDataMappingRow, [string]>(
    `SELECT id, workspace_id, connector_type, entity, external_field, unified_field, mapping_version, drift_status, created_at, updated_at
     FROM erp_master_data_mappings WHERE id = ?`
  ).get(mappingId);
  if (!updated) throw new Error("Failed to update master data mapping");
  return toMasterDataMapping(updated);
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

function toOnboardingSession(row: OnboardingSessionRow): OnboardingSession {
  return {
    id: row.id,
    customerName: row.customer_name,
    product: row.product,
    connector: row.connector_type ?? undefined,
    status: row.status,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOnboardingSnapshot(row: OnboardingSnapshotRow): OnboardingSnapshot {
  return {
    id: row.id,
    onboardingId: row.onboarding_id,
    phase: row.phase,
    since: row.since ?? undefined,
    metrics: JSON.parse(row.metrics_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function computeOnboardingDerivedMetrics(product: ProductType, productKpis: Record<string, unknown>): Record<string, unknown> {
  const workflowRuns = (productKpis.workflowRuns as Record<string, unknown> | undefined) ?? {};
  const sync = (productKpis.sync as Record<string, unknown> | undefined) ?? {};
  const completed = num(workflowRuns.completed);
  const failed = num(workflowRuns.failed);
  const total = num(workflowRuns.total);
  const syncSuccess = num(sync.successfulRuns);

  const hoursPerRun = product === "quote-to-order" ? 1.6 : product === "lead-to-cash" ? 1.3 : 1.1;
  const stepsPerRun = product === "quote-to-order" ? 4 : 3;
  const failureRatePct = total > 0 ? Number(((failed / total) * 100).toFixed(1)) : 0;
  const timeSavedHours = Number((completed * hoursPerRun).toFixed(1));
  const manualStepsRemoved = Math.round(completed * stepsPerRun);
  const estimatedValueEur = Math.round(timeSavedHours * 85);

  return {
    completedRuns: completed,
    failedRuns: failed,
    totalRuns: total,
    failureRatePct,
    successfulSyncs: syncSuccess,
    manualStepsRemoved,
    timeSavedHours,
    estimatedValueEur,
  };
}

function getOnboardingSessionRow(id: string): OnboardingSessionRow | null {
  return db.query<OnboardingSessionRow, [string]>(
    `SELECT id, customer_name, product, connector_type, status, metadata_json, created_at, updated_at
     FROM onboarding_sessions WHERE id = ?`
  ).get(id) ?? null;
}

export function createOnboardingSession(input: unknown): OnboardingSession {
  const parsed = OnboardingCreateSchema.parse(input);
  const id = randomUUID();
  const now = nowIso();
  db.run(
    `INSERT INTO onboarding_sessions (id, customer_name, product, connector_type, status, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      id,
      parsed.customerName,
      parsed.product,
      parsed.connector ?? null,
      JSON.stringify(parsed.metadata),
      now,
      now,
    ],
  );
  const row = getOnboardingSessionRow(id);
  if (!row) throw new Error("Failed to create onboarding session");
  return toOnboardingSession(row);
}

export function listOnboardingSessions(filtersInput: unknown = {}): { items: OnboardingSession[] } {
  const filters = OnboardingListSchema.parse(filtersInput);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  const sql = `SELECT id, customer_name, product, connector_type, status, metadata_json, created_at, updated_at
               FROM onboarding_sessions
               ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC
               LIMIT ?`;
  params.push(filters.limit);
  const rows = db.query<OnboardingSessionRow, unknown[]>(sql).all(...params);
  return { items: rows.map(toOnboardingSession) };
}

export function captureOnboardingSnapshot(input: unknown): OnboardingSnapshot {
  const parsed = OnboardingCaptureSchema.parse(input);
  const session = getOnboardingSessionRow(parsed.onboardingId);
  if (!session) throw new Error(`Onboarding session '${parsed.onboardingId}' not found`);

  const since = parsed.since ?? session.created_at;
  const productKpis = getProductKpis(session.product, { since });
  const connectorKpis = getConnectorKpis({ since });
  const connectors = listConnectorStatuses();
  const derived = computeOnboardingDerivedMetrics(session.product, productKpis);

  const metrics = {
    capturedAt: nowIso(),
    since,
    product: session.product,
    connectorScope: session.connector_type ?? "all",
    productKpis,
    connectorKpis,
    connectors,
    derived,
  };

  const id = randomUUID();
  db.run(
    `INSERT INTO onboarding_snapshots (id, onboarding_id, phase, since, metrics_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, session.id, parsed.phase, parsed.since ?? null, JSON.stringify(metrics), nowIso()],
  );

  const row = db.query<OnboardingSnapshotRow, [string]>(
    `SELECT id, onboarding_id, phase, since, metrics_json, created_at
     FROM onboarding_snapshots WHERE id = ?`
  ).get(id);
  if (!row) throw new Error("Failed to persist onboarding snapshot");
  return toOnboardingSnapshot(row);
}

function deltaNumber(current: number, baseline: number): { current: number; baseline: number; deltaAbs: number; deltaPct: number | null } {
  const deltaAbs = Number((current - baseline).toFixed(2));
  if (baseline === 0) return { current, baseline, deltaAbs, deltaPct: null };
  return {
    current,
    baseline,
    deltaAbs,
    deltaPct: Number((((current - baseline) / baseline) * 100).toFixed(1)),
  };
}

export function buildOnboardingReport(input: { onboardingId: string; autoCaptureCurrent?: boolean } | unknown): Record<string, unknown> {
  const schema = z.object({
    onboardingId: z.string().min(1),
    autoCaptureCurrent: z.boolean().optional().default(true),
  }).strict();
  const parsed = schema.parse(input);
  const row = getOnboardingSessionRow(parsed.onboardingId);
  if (!row) throw new Error(`Onboarding session '${parsed.onboardingId}' not found`);
  const session = toOnboardingSession(row);

  const baselineRow = db.query<OnboardingSnapshotRow, [string]>(
    `SELECT id, onboarding_id, phase, since, metrics_json, created_at
     FROM onboarding_snapshots
     WHERE onboarding_id = ? AND phase = 'baseline'
     ORDER BY created_at ASC
     LIMIT 1`
  ).get(parsed.onboardingId) ?? null;

  let currentRow = db.query<OnboardingSnapshotRow, [string]>(
    `SELECT id, onboarding_id, phase, since, metrics_json, created_at
     FROM onboarding_snapshots
     WHERE onboarding_id = ? AND phase = 'current'
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(parsed.onboardingId) ?? null;

  if (!currentRow && parsed.autoCaptureCurrent) {
    captureOnboardingSnapshot({ onboardingId: parsed.onboardingId, phase: "current" });
    currentRow = db.query<OnboardingSnapshotRow, [string]>(
      `SELECT id, onboarding_id, phase, since, metrics_json, created_at
       FROM onboarding_snapshots
       WHERE onboarding_id = ? AND phase = 'current'
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(parsed.onboardingId) ?? null;
  }

  const baseline = baselineRow ? toOnboardingSnapshot(baselineRow) : null;
  const current = currentRow ? toOnboardingSnapshot(currentRow) : null;
  const baselineDerived = ((baseline?.metrics.derived as Record<string, unknown> | undefined) ?? {});
  const currentDerived = ((current?.metrics.derived as Record<string, unknown> | undefined) ?? {});

  const delta = current
    ? {
        completedRuns: deltaNumber(num(currentDerived.completedRuns), num(baselineDerived.completedRuns)),
        failureRatePct: deltaNumber(num(currentDerived.failureRatePct), num(baselineDerived.failureRatePct)),
        manualStepsRemoved: deltaNumber(num(currentDerived.manualStepsRemoved), num(baselineDerived.manualStepsRemoved)),
        timeSavedHours: deltaNumber(num(currentDerived.timeSavedHours), num(baselineDerived.timeSavedHours)),
        estimatedValueEur: deltaNumber(num(currentDerived.estimatedValueEur), num(baselineDerived.estimatedValueEur)),
      }
    : null;

  const readyForExpansion = current
    ? num(currentDerived.completedRuns) >= 5 &&
      num(currentDerived.failureRatePct) <= 20 &&
      num(currentDerived.timeSavedHours) >= 8
    : false;

  return {
    session,
    baseline,
    current,
    delta,
    recommendation: {
      readyForExpansion,
      nextAction: readyForExpansion
        ? "Offer second workflow module and annual contract path."
        : "Continue optimization and run weekly KPI review until thresholds are met.",
    },
  };
}

function toCommercialEvent(row: CommercialPipelineEventRow): CommercialPipelineEvent {
  return {
    id: row.id,
    product: row.product,
    stage: row.stage,
    customerName: row.customer_name,
    onboardingId: row.onboarding_id ?? undefined,
    valueEur: row.value_eur ?? undefined,
    notes: row.notes ?? undefined,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

export function recordCommercialEvent(input: unknown): CommercialPipelineEvent {
  const parsed = CommercialEventSchema.parse(input);
  const id = randomUUID();
  const now = nowIso();
  const occurredAt = parsed.occurredAt ? new Date(parsed.occurredAt).toISOString() : now;
  db.run(
    `INSERT INTO commercial_pipeline_events
     (id, product, stage, customer_name, onboarding_id, value_eur, notes, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      parsed.product,
      parsed.stage,
      parsed.customerName,
      parsed.onboardingId ?? null,
      parsed.valueEur ?? null,
      parsed.notes ?? null,
      occurredAt,
      now,
    ],
  );
  const row = db.query<CommercialPipelineEventRow, [string]>(
    `SELECT id, product, stage, customer_name, onboarding_id, value_eur, notes, occurred_at, created_at
     FROM commercial_pipeline_events WHERE id = ?`
  ).get(id);
  if (!row) throw new Error("Failed to persist commercial event");
  return toCommercialEvent(row);
}

export function getCommercialKpis(filtersInput: unknown = {}): Record<string, unknown> {
  const filters = CommercialKpiFilterSchema.parse(filtersInput);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.product) {
    where.push("product = ?");
    params.push(filters.product);
  }
  if (filters.since) {
    where.push("occurred_at >= ?");
    params.push(filters.since);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db.query<{
    stage: "qualified_call" | "proposal_sent" | "pilot_signed";
    cnt: number;
    pipelineValueEur: number | null;
  }, unknown[]>(
    `SELECT stage, COUNT(*) as cnt, SUM(COALESCE(value_eur, 0)) as pipelineValueEur
     FROM commercial_pipeline_events
     ${clause}
     GROUP BY stage`
  ).all(...params);

  const stageCounts: Record<string, number> = {
    qualified_call: 0,
    proposal_sent: 0,
    pilot_signed: 0,
  };
  let pipelineValueEur = 0;
  for (const row of rows) {
    stageCounts[row.stage] = row.cnt;
    pipelineValueEur += num(row.pipelineValueEur);
  }

  const calls = stageCounts.qualified_call;
  const proposals = stageCounts.proposal_sent;
  const signed = stageCounts.pilot_signed;
  const proposalRate = calls > 0 ? Number(((proposals / calls) * 100).toFixed(1)) : 0;
  const winRate = proposals > 0 ? Number(((signed / proposals) * 100).toFixed(1)) : 0;

  const targets = { qualifiedCalls: 10, pilotProposals: 3, signedPilots: 1 };
  const conversionRow = db.query<{ submittedAt: string | null; convertedAt: string | null }, []>(
    `SELECT MIN(created_at) as submittedAt, MIN(converted_at) as convertedAt
     FROM quote_to_order_records
     WHERE converted_at IS NOT NULL`
  ).get();
  const timeToFirstOrderConversionHours = conversionRow?.submittedAt && conversionRow?.convertedAt
    ? Number(((Date.parse(conversionRow.convertedAt) - Date.parse(conversionRow.submittedAt)) / 3600000).toFixed(2))
    : null;
  const recoveredRow = db.query<{ value: number | null }, []>(
    `SELECT SUM(amount) as value
     FROM quote_to_order_records
     WHERE converted_at IS NOT NULL AND conversion_deadline_at IS NOT NULL AND converted_at > conversion_deadline_at`
  ).get();
  const resolvedBreaches = db.query<{ cnt: number }, []>(
    `SELECT COUNT(*) as cnt
     FROM workflow_sla_incidents
     WHERE status = 'resolved'`
  ).get();
  const breachCostAvoided = num(resolvedBreaches?.cnt) * 150;

  return {
    timeframe: { since: filters.since ?? "all_time" },
    product: filters.product ?? "all",
    funnel: {
      qualifiedCalls: calls,
      proposalsSent: proposals,
      pilotsSigned: signed,
      proposalRatePct: proposalRate,
      winRatePct: winRate,
    },
    targets,
    progress: {
      qualifiedCallsPct: Number(((calls / targets.qualifiedCalls) * 100).toFixed(1)),
      pilotProposalsPct: Number(((proposals / targets.pilotProposals) * 100).toFixed(1)),
      signedPilotsPct: Number(((signed / targets.signedPilots) * 100).toFixed(1)),
      targetReached: calls >= targets.qualifiedCalls && proposals >= targets.pilotProposals && signed >= targets.signedPilots,
    },
    pipelineValueEur: Math.round(pipelineValueEur),
    mustHaveMetrics: {
      timeToFirstOrderConversionHours,
      valueRecoveredFromStalledQuotes: Math.round(num(recoveredRow?.value)),
      breachCostAvoidedEur: breachCostAvoided,
    },
  };
}

export function getExecutiveAnalytics(filtersInput: unknown = {}): Record<string, unknown> {
  const filters = z.object({
    workspaceId: z.string().optional(),
    since: z.string().optional(),
  }).strict().parse(filtersInput);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.workspaceId) {
    where.push("workspace_id = ?");
    params.push(filters.workspaceId);
  }
  if (filters.since) {
    where.push("created_at >= ?");
    params.push(filters.since);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const totals = db.query<{ submitted: number; converted: number; revenueRisk: number | null }, unknown[]>(
    `SELECT
       SUM(CASE WHEN state IN ('submitted','approved','converted_to_order','fulfilled','rejected') THEN 1 ELSE 0 END) as submitted,
       SUM(CASE WHEN state IN ('converted_to_order','fulfilled') THEN 1 ELSE 0 END) as converted,
       SUM(CASE WHEN state IN ('submitted','approved') THEN amount ELSE 0 END) as revenueRisk
     FROM quote_to_order_records
     ${clause}`
  ).get(...params);
  const approvalRows = db.query<{ mins: number }, unknown[]>(
    `SELECT ((julianday(approval_decided_at) - julianday(created_at)) * 24 * 60) as mins
     FROM quote_to_order_records
     ${clause.length > 0 ? `${clause} AND approval_decided_at IS NOT NULL` : "WHERE approval_decided_at IS NOT NULL"}`
  ).all(...params);
  const conversionRate = num(totals?.submitted) > 0 ? Number(((num(totals?.converted) / num(totals?.submitted)) * 100).toFixed(1)) : 0;

  const onboardingRows = db.query<{ metrics_json: string }, []>(
    `SELECT metrics_json
     FROM onboarding_snapshots
     WHERE phase = 'current'
     ORDER BY created_at DESC`
  ).all();
  let timeSavedHours = 0;
  let manualStepsRemoved = 0;
  let estimatedValue = 0;
  for (const row of onboardingRows) {
    const parsed = parseMetadata(row.metrics_json);
    const derived = (parsed.derived as Record<string, unknown> | undefined) ?? {};
    timeSavedHours += num(derived.timeSavedHours);
    manualStepsRemoved += num(derived.manualStepsRemoved);
    estimatedValue += num(derived.estimatedValueEur);
  }

  return {
    timeframe: { since: filters.since ?? "all_time" },
    workspaceId: filters.workspaceId ?? "all",
    quoteToOrderConversionRatePct: conversionRate,
    medianApprovalTimeMinutes: median(approvalRows.map((r) => num(r.mins)).filter((v) => v > 0)),
    revenueAtRiskEur: Math.round(num(totals?.revenueRisk)),
    timeSavedHours: Number(timeSavedHours.toFixed(1)),
    manualStepsRemoved: Math.round(manualStepsRemoved),
    estimatedValueEur: Math.round(estimatedValue),
  };
}

export function getOpsAnalytics(filtersInput: unknown = {}): Record<string, unknown> {
  const filters = z.object({
    since: z.string().optional(),
  }).strict().parse(filtersInput);
  const params: unknown[] = [];
  const where = filters.since ? "WHERE created_at >= ?" : "";
  if (filters.since) params.push(filters.since);

  const throughput = db.query<{
    connector_type: ConnectorType;
    entity_type: "lead" | "deal" | "invoice" | "quote" | "order";
    total: number;
    failed: number;
  }, unknown[]>(
    `SELECT connector_type, entity_type, COUNT(*) as total,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM connector_sync_runs
     ${where}
     GROUP BY connector_type, entity_type`
  ).all(...params).map((row) => ({
    connectorType: row.connector_type,
    entityType: row.entity_type,
    totalRuns: row.total,
    failedRuns: row.failed,
    failureRatePct: row.total > 0 ? Number(((row.failed / row.total) * 100).toFixed(1)) : 0,
  }));

  const retryRow = db.query<{ retries: number }, unknown[]>(
    `SELECT COUNT(*) as retries
     FROM connector_sync_runs
     ${where.length > 0 ? `${where} AND attempts > 1` : "WHERE attempts > 1"}`
  ).get(...params);
  const deadLetterRow = db.query<{ cnt: number }, unknown[]>(
    `SELECT COUNT(*) as cnt FROM connector_dead_letters ${where}`
  ).get(...params);
  const replayRow = db.query<{ cnt: number }, unknown[]>(
    `SELECT COUNT(*) as cnt FROM connector_replay_runs ${where}`
  ).get(...params);
  const incidentTimeline = db.query<{ day: string; openCnt: number; resolvedCnt: number }, unknown[]>(
    `SELECT substr(created_at, 1, 10) as day,
            SUM(CASE WHEN status IN ('open','acknowledged') THEN 1 ELSE 0 END) as openCnt,
            SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolvedCnt
     FROM workflow_sla_incidents
     ${where}
     GROUP BY substr(created_at, 1, 10)
     ORDER BY day ASC`
  ).all(...params);
  const mttrRows = db.query<{ mins: number }, []>(
    `SELECT ((julianday(resolved_at) - julianday(created_at)) * 24 * 60) as mins
     FROM workflow_sla_incidents
     WHERE status = 'resolved' AND resolved_at IS NOT NULL`
  ).all();

  return {
    timeframe: { since: filters.since ?? "all_time" },
    syncThroughput: throughput,
    reliability: {
      retries: num(retryRow?.retries),
      deadLetters: num(deadLetterRow?.cnt),
      replays: num(replayRow?.cnt),
    },
    sla: {
      breachTimeline: incidentTimeline,
      mttrMinutes: median(mttrRows.map((r) => num(r.mins)).filter((v) => v > 0)),
    },
  };
}

const WORKFLOW_SLA_TARGETS: Record<ProductType, { maxFailureRatePct: number; minCompletedRuns: number }> = {
  "quote-to-order": { maxFailureRatePct: 15, minCompletedRuns: 3 },
  "lead-to-cash": { maxFailureRatePct: 20, minCompletedRuns: 3 },
  collections: { maxFailureRatePct: 25, minCompletedRuns: 2 },
};

function hashFingerprint(value: string): string {
  return Bun.hash(value).toString(16);
}

function computeWorkflowSlaStatus(product: ProductType, since?: string): WorkflowSlaStatusItem {
  const params: unknown[] = [product];
  const whereSince = since ? "AND created_at >= ?" : "";
  if (since) params.push(since);

  const row = db.query<{ total: number; completed: number; failed: number }, unknown[]>(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM product_workflow_runs
     WHERE product = ? ${whereSince}`
  ).get(...params) ?? { total: 0, completed: 0, failed: 0 };

  const totalRuns = num(row.total);
  const completedRuns = num(row.completed);
  const failedRuns = num(row.failed);
  const failureRatePct = totalRuns > 0 ? Number(((failedRuns / totalRuns) * 100).toFixed(1)) : 0;
  const thresholds = WORKFLOW_SLA_TARGETS[product];

  const reasons: string[] = [];
  const breachBreakdown: WorkflowSlaStatusItem["breachBreakdown"] = [];
  if (totalRuns > 0 && failureRatePct > thresholds.maxFailureRatePct) {
    reasons.push(`Failure rate ${failureRatePct}% exceeds SLA max ${thresholds.maxFailureRatePct}%.`);
  }
  if (totalRuns > 0 && completedRuns < thresholds.minCompletedRuns) {
    reasons.push(`Completed runs ${completedRuns} below SLA minimum ${thresholds.minCompletedRuns}.`);
  }
  if (totalRuns === 0) {
    reasons.push("No workflow runs observed in selected timeframe.");
  }

  if (product === "quote-to-order") {
    const approvalOverdue = db.query<{ cnt: number }, [string]>(
      `SELECT COUNT(*) as cnt
       FROM quote_to_order_records
       WHERE state = 'submitted'
         AND approval_deadline_at IS NOT NULL
         AND approval_decided_at IS NULL
         AND approval_deadline_at < ?`
    ).get(nowIso());
    const conversionStalled = db.query<{ cnt: number }, [string]>(
      `SELECT COUNT(*) as cnt
       FROM quote_to_order_records
       WHERE state = 'approved'
         AND conversion_deadline_at IS NOT NULL
         AND converted_at IS NULL
         AND conversion_deadline_at < ?`
    ).get(nowIso());
    const approvalCnt = num(approvalOverdue?.cnt);
    const stalledCnt = num(conversionStalled?.cnt);
    if (approvalCnt > 0) {
      breachBreakdown.push({ type: "approval_overdue", count: approvalCnt });
      reasons.push(`approval_overdue detected (${approvalCnt})`);
    }
    if (stalledCnt > 0) {
      breachBreakdown.push({ type: "conversion_stalled", count: stalledCnt });
      reasons.push(`conversion_stalled detected (${stalledCnt})`);
    }
  }

  const syncParams: unknown[] = [];
  const syncWhere = since ? "AND created_at >= ?" : "";
  if (since) syncParams.push(since);
  const syncFailure = db.query<{ cnt: number }, unknown[]>(
    `SELECT COUNT(*) as cnt
     FROM connector_sync_runs
     WHERE status = 'failed' AND entity_type IN ('quote', 'order') ${syncWhere}`
  ).get(...syncParams);
  const syncFailureCnt = num(syncFailure?.cnt);
  if (syncFailureCnt >= 3) {
    breachBreakdown.push({ type: "sync_failure_burst", count: syncFailureCnt });
    reasons.push(`sync_failure_burst detected (${syncFailureCnt})`);
  }

  const breach = reasons.length > 0;
  const severity: "ok" | "warning" | "critical" = !breach
    ? "ok"
    : (failureRatePct > thresholds.maxFailureRatePct + 10 || completedRuns === 0 || breachBreakdown.some((b) => b.type !== "sync_failure_burst")) ? "critical" : "warning";

  return {
    product,
    thresholds,
    stats: { totalRuns, completedRuns, failedRuns, failureRatePct },
    breach,
    severity,
    reasons,
    breachBreakdown,
  };
}

export function getWorkflowSlaStatus(filtersInput: unknown = {}): Record<string, unknown> {
  const filters = WorkflowSlaFilterSchema.parse(filtersInput);
  const products = filters.product ? [filters.product] : (["quote-to-order", "lead-to-cash", "collections"] as ProductType[]);
  const items = products.map((p) => computeWorkflowSlaStatus(p, filters.since));
  const breaches = items.filter((i) => i.breach);
  return {
    timeframe: { since: filters.since ?? "all_time" },
    items,
    summary: {
      totalProducts: items.length,
      breachedProducts: breaches.length,
      criticalBreaches: breaches.filter((b) => b.severity === "critical").length,
    },
  };
}

function toWorkflowIncident(row: WorkflowSlaIncidentRow): WorkflowSlaIncident {
  return {
    id: row.id,
    product: row.product,
    severity: row.severity,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

export function escalateWorkflowSlaBreaches(input: unknown = {}): Record<string, unknown> {
  const parsed = WorkflowSlaEscalateSchema.parse(input);
  const status = getWorkflowSlaStatus({ product: parsed.product, since: parsed.since });
  const items = (status.items as WorkflowSlaStatusItem[]).filter((i) => i.breach);
  const now = Date.now();
  const minTs = new Date(now - parsed.minIntervalMinutes * 60_000).toISOString();
  const created: WorkflowSlaIncident[] = [];
  const skipped: Array<{ product: ProductType; reason: string }> = [];

  for (const item of items) {
    for (const reason of item.reasons) {
      const fingerprint = hashFingerprint(`${item.product}:${reason}`);
      const recent = db.query<WorkflowSlaIncidentRow, [ProductType, string, string]>(
        `SELECT id, product, severity, reason, fingerprint, status, created_at, resolved_at
         FROM workflow_sla_incidents
         WHERE product = ? AND fingerprint = ? AND status = 'open' AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT 1`
      ).get(item.product, fingerprint, minTs);
      if (recent) {
        skipped.push({ product: item.product, reason });
        continue;
      }
      const id = randomUUID();
      const createdAt = nowIso();
      const severity = item.severity === "critical" ? "critical" : "warning";
      db.run(
        `INSERT INTO workflow_sla_incidents (id, product, severity, reason, fingerprint, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
        [id, item.product, severity, reason, fingerprint, createdAt],
      );
      created.push({ id, product: item.product, severity, reason, status: "open", createdAt });
    }
  }

  return {
    created,
    skipped,
    escalatedCount: created.length,
    skippedCount: skipped.length,
    minIntervalMinutes: parsed.minIntervalMinutes,
  };
}

export function listWorkflowSlaIncidents(filtersInput: unknown = {}): { items: WorkflowSlaIncident[] } {
  const schema = z.object({
    product: ProductTypeSchema.optional(),
    status: z.enum(["open", "acknowledged", "resolved"]).optional(),
    limit: z.number().int().min(1).max(200).optional().default(50),
  }).strict();
  const filters = schema.parse(filtersInput);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.product) {
    where.push("product = ?");
    params.push(filters.product);
  }
  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  const sql = `SELECT id, product, severity, reason, fingerprint, status, created_at, resolved_at
               FROM workflow_sla_incidents
               ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC
               LIMIT ?`;
  params.push(filters.limit);
  const rows = db.query<WorkflowSlaIncidentRow, unknown[]>(sql).all(...params);
  return { items: rows.map(toWorkflowIncident) };
}

export function updateWorkflowSlaIncidentStatus(incidentIdInput: unknown, statusInput: unknown): WorkflowSlaIncident {
  const incidentId = z.string().min(1).parse(incidentIdInput);
  const status = z.enum(["acknowledged", "resolved"]).parse(statusInput);
  const existing = db.query<WorkflowSlaIncidentRow, [string]>(
    `SELECT id, product, severity, reason, fingerprint, status, created_at, resolved_at
     FROM workflow_sla_incidents WHERE id = ?`
  ).get(incidentId);
  if (!existing) throw new Error(`SLA incident '${incidentId}' not found`);
  const resolvedAt = status === "resolved" ? nowIso() : existing.resolved_at;
  db.run(
    `UPDATE workflow_sla_incidents
     SET status = ?, resolved_at = ?
     WHERE id = ?`,
    [status, resolvedAt ?? null, incidentId],
  );
  const updated = db.query<WorkflowSlaIncidentRow, [string]>(
    `SELECT id, product, severity, reason, fingerprint, status, created_at, resolved_at
     FROM workflow_sla_incidents WHERE id = ?`
  ).get(incidentId);
  if (!updated) throw new Error("Failed to update incident");
  return toWorkflowIncident(updated);
}

export function validateProductType(input: unknown): ProductType {
  return ProductTypeSchema.parse(input);
}

export function validateConnectorType(input: unknown): ConnectorType {
  return ConnectorTypeSchema.parse(input);
}

export function validateMasterDataEntity(input: unknown): MasterDataEntity {
  return MasterDataEntitySchema.parse(input);
}

export function resetErpPlatformForTests(): void {
  db.run(`DELETE FROM connector_replay_runs`);
  db.run(`DELETE FROM erp_master_data_records`);
  db.run(`DELETE FROM erp_master_data_mappings`);
  db.run(`DELETE FROM quote_to_order_events`);
  db.run(`DELETE FROM quote_to_order_records`);
  db.run(`DELETE FROM workflow_sla_incidents`);
  db.run(`DELETE FROM commercial_pipeline_events`);
  db.run(`DELETE FROM onboarding_snapshots`);
  db.run(`DELETE FROM onboarding_sessions`);
  db.run(`DELETE FROM pilot_launch_runs`);
  db.run(`DELETE FROM connector_dead_letters`);
  db.run(`DELETE FROM connector_renewal_runs`);
  db.run(`DELETE FROM connector_sync_runs`);
  db.run(`DELETE FROM product_workflow_runs`);
  db.run(`DELETE FROM connector_configs`);
}
