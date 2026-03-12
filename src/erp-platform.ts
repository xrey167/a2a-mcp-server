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
export type QuoteCommunicationChannel = "email" | "call" | "meeting" | "chat" | "other";
export type QuoteCommunicationDirection = "inbound" | "outbound";
export type QuoteMailboxProvider = "gmail" | "outlook";
export type QuoteFollowupActionType = "email_followup" | "call_followup" | "escalate_owner";
export type QuoteFollowupPriority = "low" | "normal" | "high" | "critical";
export type QuoteFollowupStatus = "open" | "sent" | "done" | "dismissed";
export type RevenueGraphEntityType = "account" | "contact" | "quote" | "opportunity" | "order" | "invoice" | "payment" | "activity" | "communication";
export type AutopilotProposalStatus = "draft" | "approved" | "rejected" | "executed" | "failed";
export type TrustConsentStatus = "unknown" | "opt_in" | "opt_out";
export type Customer360Segment = "champion" | "loyal" | "promising" | "at_risk" | "churning" | "new" | "dormant";
export type Customer360HealthDimension = "engagement" | "revenue" | "sentiment" | "responsiveness";
export type Customer360InteractionType = "quote_created" | "quote_approved" | "quote_rejected" | "quote_converted" | "quote_fulfilled" | "communication" | "followup" | "consent_change" | "order_created";

const ConnectorTypeSchema = z.enum(["odoo", "business-central", "dynamics"]);
const ProductTypeSchema = z.enum(["quote-to-order", "lead-to-cash", "collections"]);
const QuoteCommunicationChannelSchema = z.enum(["email", "call", "meeting", "chat", "other"]);
const QuoteCommunicationDirectionSchema = z.enum(["inbound", "outbound"]);
const QuoteMailboxProviderSchema = z.enum(["gmail", "outlook"]);
const QuoteFollowupActionTypeSchema = z.enum(["email_followup", "call_followup", "escalate_owner"]);
const QuoteFollowupPrioritySchema = z.enum(["low", "normal", "high", "critical"]);
const QuoteFollowupStatusSchema = z.enum(["open", "sent", "done", "dismissed"]);
const RevenueGraphEntityTypeSchema = z.enum(["account", "contact", "quote", "opportunity", "order", "invoice", "payment", "activity", "communication"]);
const AutopilotProposalStatusSchema = z.enum(["draft", "approved", "rejected", "executed", "failed"]);
const TrustConsentStatusSchema = z.enum(["unknown", "opt_in", "opt_out"]);
const Customer360SegmentSchema = z.enum(["champion", "loyal", "promising", "at_risk", "churning", "new", "dormant"]);
const Customer360InteractionTypeSchema = z.enum([
  "quote_created", "quote_approved", "quote_rejected", "quote_converted",
  "quote_fulfilled", "communication", "followup", "consent_change", "order_created",
]);

const Customer360ProfileInputSchema = z.object({
  workspaceId: z.string().min(1),
  customerExternalId: z.string().min(1),
  forceRefresh: z.boolean().optional().default(false),
}).strict();

const Customer360HealthInputSchema = z.object({
  workspaceId: z.string().min(1),
  customerExternalId: z.string().min(1),
  weights: z.object({
    engagement: z.number().min(0).max(1).optional().default(0.3),
    revenue: z.number().min(0).max(1).optional().default(0.3),
    sentiment: z.number().min(0).max(1).optional().default(0.2),
    responsiveness: z.number().min(0).max(1).optional().default(0.2),
  }).optional(),
}).strict();

const Customer360TimelineInputSchema = z.object({
  workspaceId: z.string().min(1),
  customerExternalId: z.string().min(1),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
  interactionTypes: z.array(Customer360InteractionTypeSchema).optional(),
}).strict();

const Customer360SegmentsInputSchema = z.object({
  workspaceId: z.string().min(1),
  segment: Customer360SegmentSchema.optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
}).strict();

const Customer360ChurnRiskInputSchema = z.object({
  workspaceId: z.string().min(1),
  customerExternalId: z.string().optional(),
  threshold: z.number().min(0).max(100).optional().default(50),
  limit: z.number().int().min(1).max(200).optional().default(50),
}).strict();

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
  entityType: z.enum(["lead", "deal", "invoice", "quote", "order", "activity"]).default("lead"),
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

const QuoteCommunicationIngestSchema = z.object({
  connectorType: ConnectorTypeSchema.optional(),
  channel: QuoteCommunicationChannelSchema.optional().default("email"),
  direction: QuoteCommunicationDirectionSchema.optional().default("inbound"),
  subject: z.string().optional(),
  bodyText: z.string().optional().default(""),
  fromAddress: z.string().optional(),
  toAddress: z.string().optional(),
  externalThreadId: z.string().optional(),
  occurredAt: z.string().optional(),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

const QuoteMailboxMessageSchema = z.object({
  messageId: z.string().min(1),
  threadId: z.string().optional(),
  quoteExternalId: z.string().optional(),
  subject: z.string().optional(),
  bodyText: z.string().optional().default(""),
  fromAddress: z.string().optional(),
  toAddress: z.string().optional(),
  receivedAt: z.string().optional(),
  sentAt: z.string().optional(),
  direction: QuoteCommunicationDirectionSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

const QuoteMailboxImportSchema = z.object({
  provider: QuoteMailboxProviderSchema,
  messages: z.array(QuoteMailboxMessageSchema).min(1).max(500),
  workspaceDomains: z.array(z.string().min(1)).optional().default([]),
  defaultConnectorType: ConnectorTypeSchema.optional(),
  autoCreateSubmittedQuote: z.boolean().optional().default(true),
  runFollowupEngine: z.boolean().optional().default(false),
  followupAfterHours: z.number().min(1).max(24 * 30).optional().default(48),
  highValueThresholdEur: z.number().nonnegative().optional().default(5000),
  assignedTo: z.string().optional(),
  now: z.string().optional(),
}).strict();

const QuoteMailboxPullSchema = z.object({
  provider: QuoteMailboxProviderSchema,
  accessToken: z.string().min(1).optional(),
  useStoredConnection: z.boolean().optional().default(true),
  userId: z.string().optional().default("me"),
  limit: z.number().int().min(1).max(200).optional().default(50),
  since: z.string().optional(),
  query: z.string().optional(),
  folder: z.string().optional().default("inbox"),
  workspaceDomains: z.array(z.string().min(1)).optional().default([]),
  defaultConnectorType: ConnectorTypeSchema.optional(),
  autoCreateSubmittedQuote: z.boolean().optional().default(true),
  runFollowupEngine: z.boolean().optional().default(false),
  followupAfterHours: z.number().min(1).max(24 * 30).optional().default(48),
  highValueThresholdEur: z.number().nonnegative().optional().default(5000),
  assignedTo: z.string().optional(),
  now: z.string().optional(),
}).strict();

const QuoteMailboxConnectionSchema = z.object({
  provider: QuoteMailboxProviderSchema,
  userId: z.string().optional().default("me"),
  tenantId: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  refreshToken: z.string().optional(),
  accessToken: z.string().optional(),
  accessTokenExpiresAt: z.string().optional(),
  tokenEndpoint: z.string().url().optional(),
  scopes: z.array(z.string()).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  enabled: z.boolean().optional().default(true),
}).strict();

const QuoteMailboxConnectionRefreshSchema = z.object({
  userId: z.string().optional().default("me"),
  force: z.boolean().optional().default(false),
}).strict();

const QuoteMailboxConnectionListSchema = z.object({
  provider: QuoteMailboxProviderSchema.optional(),
  userId: z.string().optional(),
}).strict();

const QuoteMailboxConnectionDisableSchema = z.object({
  userId: z.string().optional().default("me"),
}).strict();

const QuoteFollowupRunSchema = z.object({
  followupAfterHours: z.number().min(1).max(24 * 30).optional().default(48),
  highValueThresholdEur: z.number().nonnegative().optional().default(5000),
  includeStates: z.array(z.enum(["submitted", "approved"])).optional().default(["submitted", "approved"]),
  maxActions: z.number().int().min(1).max(500).optional().default(100),
  assignedTo: z.string().optional(),
  now: z.string().optional(),
}).strict();

const QuoteFollowupListSchema = z.object({
  status: QuoteFollowupStatusSchema.optional(),
  actionType: QuoteFollowupActionTypeSchema.optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
}).strict();

const QuoteFollowupUpdateSchema = z.object({
  status: QuoteFollowupStatusSchema,
  note: z.string().optional(),
  lastError: z.string().optional(),
}).strict();

const QuoteFollowupWritebackSchema = z.object({
  connectorType: ConnectorTypeSchema.optional(),
  statusOnSuccess: z.enum(["open", "sent", "done"]).optional().default("sent"),
  assignedTo: z.string().optional(),
  note: z.string().optional(),
  externalId: z.string().optional(),
  maxRetries: z.number().int().min(0).max(5).optional().default(2),
  idempotencyKey: z.string().optional(),
}).strict();

const QuoteFollowupWritebackBatchSchema = z.object({
  status: QuoteFollowupStatusSchema.optional().default("open"),
  actionType: QuoteFollowupActionTypeSchema.optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  connectorType: ConnectorTypeSchema.optional(),
  statusOnSuccess: z.enum(["open", "sent", "done"]).optional().default("sent"),
  assignedTo: z.string().optional(),
  maxRetries: z.number().int().min(0).max(5).optional().default(2),
}).strict();

const QuoteCommunicationAnalyticsSchema = z.object({
  since: z.string().optional(),
  stagnationHours: z.number().min(1).max(24 * 30).optional().default(48),
}).strict();

const QuotePersonalityInsightSchema = z.object({
  since: z.string().optional(),
  quoteExternalId: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
  minConfidence: z.number().min(0).max(1).optional().default(0.35),
}).strict();

const RevenueGraphSyncSchema = z.object({
  mode: z.enum(["incremental", "full"]).optional().default("incremental"),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(10000).optional().default(5000),
  includeCommunications: z.boolean().optional().default(true),
  includeMasterData: z.boolean().optional().default(true),
  connectorTypes: z.array(ConnectorTypeSchema).optional(),
}).strict();

const RevenueGraphLookupSchema = z.object({
  includeNeighbors: z.boolean().optional().default(true),
  neighborLimit: z.number().int().min(1).max(500).optional().default(100),
}).strict();

const CommunicationThreadSyncSchema = z.object({
  source: z.enum(["existing", "mailbox_pull"]).optional().default("existing"),
  provider: QuoteMailboxProviderSchema.optional(),
  userId: z.string().optional().default("me"),
  useStoredConnection: z.boolean().optional().default(true),
  accessToken: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
  since: z.string().optional(),
  windowDays: z.number().int().min(1).max(365).optional().default(30),
  workspaceDomains: z.array(z.string().min(1)).optional().default([]),
  defaultConnectorType: ConnectorTypeSchema.optional(),
  autoCreateSubmittedQuote: z.boolean().optional().default(true),
  runFollowupEngine: z.boolean().optional().default(false),
  followupAfterHours: z.number().min(1).max(24 * 30).optional().default(48),
  highValueThresholdEur: z.number().nonnegative().optional().default(5000),
  assignedTo: z.string().optional(),
  now: z.string().optional(),
}).strict();

const CommunicationThreadSignalSchema = z.object({
  since: z.string().optional(),
  includeEvents: z.boolean().optional().default(false),
  eventLimit: z.number().int().min(1).max(500).optional().default(100),
}).strict();

const NextActionRecommendationSchema = z.object({
  quoteExternalId: z.string().min(1),
  mode: z.enum(["draft_only", "create_proposal"]).optional().default("create_proposal"),
  requireApproval: z.boolean().optional().default(true),
  assignedTo: z.string().optional(),
  channel: QuoteCommunicationChannelSchema.optional().default("email"),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

const AutopilotProposalApproveSchema = z.object({
  approvedBy: z.string().min(1),
  note: z.string().optional(),
  execute: z.boolean().optional().default(true),
}).strict();

const AutopilotProposalRejectSchema = z.object({
  rejectedBy: z.string().min(1),
  reason: z.string().min(1),
}).strict();

const DealRescueRunSchema = z.object({
  mode: z.enum(["targeted", "batch"]).optional().default("batch"),
  quoteExternalId: z.string().optional(),
  minStagnationHours: z.number().min(1).max(24 * 90).optional().default(72),
  maxQuotes: z.number().int().min(1).max(500).optional().default(50),
  assignedTo: z.string().optional(),
  dryRun: z.boolean().optional().default(false),
}).strict();

const RevenueIntelligenceFilterSchema = z.object({
  workspaceId: z.string().optional(),
  since: z.string().optional(),
}).strict();

const ForecastQualityFilterSchema = z.object({
  workspaceId: z.string().optional(),
  since: z.string().optional(),
  minSamples: z.number().int().min(1).max(1000).optional().default(5),
}).strict();

const TrustConsentStatusFilterSchema = z.object({
  workspaceId: z.string().min(1),
  contactKey: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
}).strict();

const TrustConsentUpdateSchema = z.object({
  workspaceId: z.string().min(1),
  contactKey: z.string().min(1),
  status: TrustConsentStatusSchema,
  purposes: z.array(z.string().min(1)).optional().default(["deal_communication"]),
  source: z.string().optional().default("manual"),
  updatedBy: z.string().min(1),
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

const WizardSessionCreateSchema = z.object({
  workspaceId: z.string().min(1),
  customerName: z.string().min(1),
  product: ProductTypeSchema.optional().default("quote-to-order"),
  createdBy: z.string().optional(),
  workspaceIsolationOk: z.boolean().optional().default(true),
}).strict();

const WizardSessionListSchema = z.object({
  workspaceId: z.string().optional(),
  status: z.enum(["active", "completed", "launched", "blocked"]).optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
}).strict();

const WizardConnectorTestSchema = z.object({
  entityType: z.enum(["lead", "deal", "invoice", "quote", "order", "activity"]).optional().default("quote"),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
  externalId: z.string().optional(),
  maxRetries: z.number().int().min(0).max(5).optional().default(1),
  renewIfDue: z.boolean().optional().default(true),
}).strict();

const WizardMasterDataAutoSyncSchema = z.object({
  connectors: z.array(ConnectorTypeSchema).optional(),
  sample: z.record(z.string(), z.record(z.string(), z.unknown())).optional().default({}),
}).strict();

const WizardQ2oDryRunSchema = z.object({
  amount: z.number().nonnegative().optional().default(1000),
  currency: z.string().optional().default("EUR"),
  decidedBy: z.string().optional().default("wizard"),
}).strict();

const WizardGateIdSchema = z.enum([
  "workspace_isolation",
  "required_connectors",
  "dry_run_success",
  "connector_health",
  "renewal_due",
  "mapping_drift",
]);

const WizardGateOverrideSchema = z.object({
  reason: z.string().min(3),
  approvedBy: z.string().min(1),
}).strict();

const WizardLaunchSchema = z.object({
  mode: z.enum(["sandbox", "production"]).optional().default("production"),
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
  entity_type: "lead" | "deal" | "invoice" | "quote" | "order" | "activity";
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

interface QuoteCommunicationEventRow {
  id: string;
  workspace_id: string;
  quote_external_id: string;
  connector_type: ConnectorType | null;
  channel: QuoteCommunicationChannel;
  direction: QuoteCommunicationDirection;
  subject: string | null;
  body_text: string;
  from_address: string | null;
  to_address: string | null;
  external_thread_id: string | null;
  intent_tags_json: string;
  sentiment: "positive" | "neutral" | "negative";
  urgency: "low" | "normal" | "high";
  followup_needed: number;
  followup_reason: string | null;
  estimated_deal_probability_pct: number | null;
  personality_type: string | null;
  personality_confidence: number | null;
  idempotency_key: string | null;
  metadata_json: string;
  occurred_at: string;
  created_at: string;
}

interface QuoteFollowupActionRow {
  id: string;
  workspace_id: string;
  quote_external_id: string;
  source_event_id: string | null;
  action_type: QuoteFollowupActionType;
  priority: QuoteFollowupPriority;
  status: QuoteFollowupStatus;
  reason: string;
  suggested_subject: string | null;
  suggested_message: string;
  assigned_to: string | null;
  due_at: string;
  note: string | null;
  last_error: string | null;
  writeback_run_id: string | null;
  writeback_connector: ConnectorType | null;
  writeback_status: "pending" | "success" | "failed" | null;
  writeback_synced_at: string | null;
  writeback_error: string | null;
  created_at: string;
  updated_at: string;
}

interface QuoteMailboxConnectionRow {
  id: string;
  workspace_id: string;
  provider: QuoteMailboxProvider;
  user_id: string;
  tenant_id: string | null;
  client_id: string | null;
  client_secret: string | null;
  refresh_token: string | null;
  access_token: string | null;
  access_token_expires_at: string | null;
  token_endpoint: string | null;
  scopes_json: string;
  metadata_json: string;
  enabled: number;
  last_refresh_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
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

interface RevenueGraphEntityRow {
  id: string;
  workspace_id: string;
  entity_type: RevenueGraphEntityType;
  entity_key: string;
  canonical_id: string;
  source_system: ConnectorType | null;
  external_id: string | null;
  source_refs_json: string;
  attributes_json: string;
  mapping_version: number;
  sync_state: "success" | "failed" | "conflict";
  last_synced_at: string | null;
  last_sync_error: string | null;
  schema_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface RevenueGraphEdgeRow {
  id: string;
  workspace_id: string;
  from_entity_key: string;
  to_entity_key: string;
  relation: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface AutopilotProposalRow {
  id: string;
  workspace_id: string;
  quote_external_id: string;
  action_type: "followup_email" | "approval_nudge" | "internal_task" | "crm_update";
  channel: QuoteCommunicationChannel;
  suggested_subject: string | null;
  suggested_message: string;
  reason_codes_json: string;
  expected_impact_json: string;
  status: AutopilotProposalStatus;
  requires_approval: number;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  executed_at: string | null;
  execution_mode: string | null;
  execution_result_json: string | null;
  last_error: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface DealRescueRunRow {
  id: string;
  workspace_id: string;
  mode: "targeted" | "batch";
  targeted_quote_external_id: string | null;
  min_stagnation_hours: number;
  identified_count: number;
  proposal_count: number;
  recovered_value_eur: number;
  avg_time_to_recovery_hours: number | null;
  details_json: string;
  created_at: string;
}

interface TrustConsentRow {
  id: string;
  workspace_id: string;
  contact_key: string;
  status: TrustConsentStatus;
  purposes_json: string;
  source: string | null;
  updated_by: string | null;
  updated_at: string;
  created_at: string;
}

interface TrustAuditRow {
  id: string;
  workspace_id: string;
  actor: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  details_json: string;
  created_at: string;
}

interface ConnectorReplayRow {
  id: string;
  run_id: string;
  connector_type: ConnectorType;
  created_at: string;
}

type WizardSessionStatus = "active" | "completed" | "launched" | "blocked";
type WizardGateStatus = "green" | "red" | "overridden";
type WizardStepStatus = "pending" | "done" | "blocked";

interface WizardSessionRow {
  id: string;
  workspace_id: string;
  onboarding_id: string;
  customer_name: string;
  product: ProductType;
  status: WizardSessionStatus;
  state_json: string;
  created_by: string | null;
  launch_mode: "sandbox" | "production" | null;
  launched_at: string | null;
  created_at: string;
  updated_at: string;
}

interface WizardGateOverrideRow {
  id: string;
  wizard_session_id: string;
  gate_id: z.infer<typeof WizardGateIdSchema>;
  reason: string;
  approved_by: string;
  created_at: string;
}

export interface RetryableSyncError extends Error {
  retryAfterMs?: number;
  statusCode?: number;
}

export interface ConnectorSyncRequest {
  connectorType: ConnectorType;
  direction: "ingest" | "writeback" | "two-way";
  entityType: "lead" | "deal" | "invoice" | "quote" | "order" | "activity";
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
db.run(`CREATE TABLE IF NOT EXISTS quote_communication_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  quote_external_id TEXT NOT NULL,
  connector_type TEXT,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  subject TEXT,
  body_text TEXT NOT NULL DEFAULT '',
  from_address TEXT,
  to_address TEXT,
  external_thread_id TEXT,
  intent_tags_json TEXT NOT NULL DEFAULT '[]',
  sentiment TEXT NOT NULL DEFAULT 'neutral',
  urgency TEXT NOT NULL DEFAULT 'normal',
  followup_needed INTEGER NOT NULL DEFAULT 0,
  followup_reason TEXT,
  estimated_deal_probability_pct REAL,
  personality_type TEXT,
  personality_confidence REAL,
  idempotency_key TEXT UNIQUE,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_q2o_comm_workspace_quote_occurred ON quote_communication_events(workspace_id, quote_external_id, occurred_at DESC)");
db.run("CREATE INDEX IF NOT EXISTS idx_q2o_comm_workspace_followup_needed ON quote_communication_events(workspace_id, followup_needed, occurred_at DESC)");
db.run(`CREATE TABLE IF NOT EXISTS quote_followup_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  quote_external_id TEXT NOT NULL,
  source_event_id TEXT,
  action_type TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reason TEXT NOT NULL,
  suggested_subject TEXT,
  suggested_message TEXT NOT NULL,
  assigned_to TEXT,
  due_at TEXT NOT NULL,
  note TEXT,
  last_error TEXT,
  writeback_run_id TEXT,
  writeback_connector TEXT,
  writeback_status TEXT,
  writeback_synced_at TEXT,
  writeback_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_q2o_followup_workspace_status ON quote_followup_actions(workspace_id, status, due_at ASC)");
db.run("CREATE INDEX IF NOT EXISTS idx_q2o_followup_workspace_quote ON quote_followup_actions(workspace_id, quote_external_id, created_at DESC)");
db.run(`CREATE TABLE IF NOT EXISTS quote_mailbox_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id TEXT,
  client_id TEXT,
  client_secret TEXT,
  refresh_token TEXT,
  access_token TEXT,
  access_token_expires_at TEXT,
  token_endpoint TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_refresh_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, provider, user_id)
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_q2o_mailbox_workspace_provider ON quote_mailbox_connections(workspace_id, provider, enabled)");
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
db.run(`CREATE TABLE IF NOT EXISTS wizard_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  onboarding_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  product TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  state_json TEXT NOT NULL,
  created_by TEXT,
  launch_mode TEXT,
  launched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_wizard_sessions_workspace ON wizard_sessions(workspace_id, updated_at DESC)");
db.run(`CREATE TABLE IF NOT EXISTS wizard_gate_overrides (
  id TEXT PRIMARY KEY,
  wizard_session_id TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_wizard_gate_overrides_session ON wizard_gate_overrides(wizard_session_id, created_at DESC)");
db.run("CREATE INDEX IF NOT EXISTS idx_wizard_gate_overrides_gate ON wizard_gate_overrides(gate_id, created_at DESC)");
db.run(`CREATE TABLE IF NOT EXISTS revenue_graph_entities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  source_system TEXT,
  external_id TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  attributes_json TEXT NOT NULL DEFAULT '{}',
  mapping_version INTEGER NOT NULL DEFAULT 1,
  sync_state TEXT NOT NULL DEFAULT 'success',
  last_synced_at TEXT,
  last_sync_error TEXT,
  schema_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, entity_type, entity_key)
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_revenue_graph_entities_scope ON revenue_graph_entities(workspace_id, entity_type, updated_at DESC)");
db.run("CREATE INDEX IF NOT EXISTS idx_revenue_graph_entities_canonical ON revenue_graph_entities(workspace_id, canonical_id)");
db.run(`CREATE TABLE IF NOT EXISTS revenue_graph_edges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  from_entity_key TEXT NOT NULL,
  to_entity_key TEXT NOT NULL,
  relation TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, from_entity_key, to_entity_key, relation)
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_revenue_graph_edges_scope ON revenue_graph_edges(workspace_id, from_entity_key, to_entity_key)");
db.run(`CREATE TABLE IF NOT EXISTS quote_autopilot_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  quote_external_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  suggested_subject TEXT,
  suggested_message TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  expected_impact_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  requires_approval INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT,
  approved_at TEXT,
  rejected_by TEXT,
  rejected_at TEXT,
  executed_at TEXT,
  execution_mode TEXT,
  execution_result_json TEXT,
  last_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_quote_autopilot_proposals_scope ON quote_autopilot_proposals(workspace_id, status, created_at DESC)");
db.run("CREATE INDEX IF NOT EXISTS idx_quote_autopilot_proposals_quote ON quote_autopilot_proposals(workspace_id, quote_external_id, created_at DESC)");
db.run(`CREATE TABLE IF NOT EXISTS quote_deal_rescue_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  targeted_quote_external_id TEXT,
  min_stagnation_hours REAL NOT NULL,
  identified_count INTEGER NOT NULL DEFAULT 0,
  proposal_count INTEGER NOT NULL DEFAULT 0,
  recovered_value_eur REAL NOT NULL DEFAULT 0,
  avg_time_to_recovery_hours REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_quote_deal_rescue_runs_scope ON quote_deal_rescue_runs(workspace_id, created_at DESC)");
db.run(`CREATE TABLE IF NOT EXISTS trust_contact_consents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  contact_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  purposes_json TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, contact_key)
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_trust_contact_consents_scope ON trust_contact_consents(workspace_id, status, updated_at DESC)");
db.run(`CREATE TABLE IF NOT EXISTS trust_audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_trust_audit_scope ON trust_audit_log(workspace_id, created_at DESC)");

db.run(`CREATE TABLE IF NOT EXISTS customer360_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  customer_external_id TEXT NOT NULL,
  display_name TEXT,
  segment TEXT NOT NULL DEFAULT 'new',
  health_score REAL NOT NULL DEFAULT 0,
  health_engagement REAL NOT NULL DEFAULT 0,
  health_revenue REAL NOT NULL DEFAULT 0,
  health_sentiment REAL NOT NULL DEFAULT 0,
  health_responsiveness REAL NOT NULL DEFAULT 0,
  churn_risk_pct REAL NOT NULL DEFAULT 0,
  total_quotes INTEGER NOT NULL DEFAULT 0,
  total_orders INTEGER NOT NULL DEFAULT 0,
  total_revenue REAL NOT NULL DEFAULT 0,
  avg_deal_size REAL NOT NULL DEFAULT 0,
  conversion_rate REAL NOT NULL DEFAULT 0,
  last_interaction_at TEXT,
  first_interaction_at TEXT,
  contacts_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  computed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, customer_external_id)
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_c360_workspace_segment ON customer360_profiles(workspace_id, segment)");
db.run("CREATE INDEX IF NOT EXISTS idx_c360_workspace_health ON customer360_profiles(workspace_id, health_score DESC)");
db.run("CREATE INDEX IF NOT EXISTS idx_c360_workspace_churn ON customer360_profiles(workspace_id, churn_risk_pct DESC)");

db.run(`CREATE TABLE IF NOT EXISTS customer360_health_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  customer_external_id TEXT NOT NULL,
  health_score REAL NOT NULL,
  health_engagement REAL NOT NULL,
  health_revenue REAL NOT NULL,
  health_sentiment REAL NOT NULL,
  health_responsiveness REAL NOT NULL,
  segment TEXT NOT NULL,
  churn_risk_pct REAL NOT NULL,
  created_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_c360_health_history_scope ON customer360_health_history(workspace_id, customer_external_id, created_at DESC)");

function ensureColumn(table: string, column: string, alterSql: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.run(alterSql);
  }
}

ensureColumn("workflow_sla_incidents", "resolved_at", "ALTER TABLE workflow_sla_incidents ADD COLUMN resolved_at TEXT");
ensureColumn(
  "quote_communication_events",
  "estimated_deal_probability_pct",
  "ALTER TABLE quote_communication_events ADD COLUMN estimated_deal_probability_pct REAL",
);
ensureColumn(
  "quote_communication_events",
  "personality_type",
  "ALTER TABLE quote_communication_events ADD COLUMN personality_type TEXT",
);
ensureColumn(
  "quote_communication_events",
  "personality_confidence",
  "ALTER TABLE quote_communication_events ADD COLUMN personality_confidence REAL",
);
ensureColumn(
  "quote_followup_actions",
  "writeback_run_id",
  "ALTER TABLE quote_followup_actions ADD COLUMN writeback_run_id TEXT",
);
ensureColumn(
  "quote_followup_actions",
  "writeback_connector",
  "ALTER TABLE quote_followup_actions ADD COLUMN writeback_connector TEXT",
);
ensureColumn(
  "quote_followup_actions",
  "writeback_status",
  "ALTER TABLE quote_followup_actions ADD COLUMN writeback_status TEXT",
);
ensureColumn(
  "quote_followup_actions",
  "writeback_synced_at",
  "ALTER TABLE quote_followup_actions ADD COLUMN writeback_synced_at TEXT",
);
ensureColumn(
  "quote_followup_actions",
  "writeback_error",
  "ALTER TABLE quote_followup_actions ADD COLUMN writeback_error TEXT",
);

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

const WIZARD_REQUIRED_CONNECTORS: ConnectorType[] = ["odoo", "business-central", "dynamics"];

function asObject(value: unknown): Record<string, unknown> {
  return (typeof value === "object" && value !== null && !Array.isArray(value))
    ? (value as Record<string, unknown>)
    : {};
}

function parseWizardState(raw: string): Record<string, unknown> {
  return asObject(parseMetadata(raw));
}

function getWizardSessionRow(sessionId: string): WizardSessionRow | null {
  return db.query<WizardSessionRow, [string]>(
    `SELECT id, workspace_id, onboarding_id, customer_name, product, status, state_json, created_by, launch_mode, launched_at, created_at, updated_at
     FROM wizard_sessions
     WHERE id = ?`
  ).get(sessionId) ?? null;
}

function getLatestWizardOverrides(sessionId: string): Map<string, WizardGateOverrideRow> {
  const rows = db.query<WizardGateOverrideRow, [string]>(
    `SELECT id, wizard_session_id, gate_id, reason, approved_by, created_at
     FROM wizard_gate_overrides
     WHERE wizard_session_id = ?
     ORDER BY created_at DESC`
  ).all(sessionId);
  const latest = new Map<string, WizardGateOverrideRow>();
  for (const row of rows) {
    if (!latest.has(row.gate_id)) latest.set(row.gate_id, row);
  }
  return latest;
}

function updateWizardState(
  sessionId: string,
  mutator: (state: Record<string, unknown>) => Record<string, unknown>,
  opts?: { status?: WizardSessionStatus; launchMode?: "sandbox" | "production" | null; launchedAt?: string | null },
): WizardSessionRow {
  const row = getWizardSessionRow(sessionId);
  if (!row) throw new Error(`Wizard session '${sessionId}' not found`);
  const currentState = parseWizardState(row.state_json);
  const nextState = mutator(currentState);
  const now = nowIso();
  const sets: string[] = ["state_json = ?", "updated_at = ?"];
  const params: unknown[] = [JSON.stringify(nextState), now];
  if (opts?.status) {
    sets.push("status = ?");
    params.push(opts.status);
  }
  if (opts && "launchMode" in opts) {
    sets.push("launch_mode = ?");
    params.push(opts.launchMode ?? null);
  }
  if (opts && "launchedAt" in opts) {
    sets.push("launched_at = ?");
    params.push(opts.launchedAt ?? null);
  }
  params.push(sessionId);
  db.run(`UPDATE wizard_sessions SET ${sets.join(", ")} WHERE id = ?`, params);
  const updated = getWizardSessionRow(sessionId);
  if (!updated) throw new Error("Failed to persist wizard session");
  return updated;
}

function setWizardConnectorState(
  state: Record<string, unknown>,
  connector: ConnectorType,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const connectors = asObject(state.connectors);
  const current = asObject(connectors[connector]);
  connectors[connector] = { ...current, ...patch };
  return { ...state, connectors };
}

function buildWizardSessionView(row: WizardSessionRow): Record<string, unknown> {
  const state = parseWizardState(row.state_json);
  const workspaceIsolationOk = typeof state.workspaceIsolationOk === "boolean" ? state.workspaceIsolationOk : true;
  const connectorStatusesMap = new Map(listConnectorStatuses().map((item) => [item.connector, item] as const));
  const requiredConnectors = WIZARD_REQUIRED_CONNECTORS.map((connector) => connectorStatusesMap.get(connector) ?? getConnectorStatus(connector));
  const missingConnectors = requiredConnectors.filter((connector) => !connector.enabled).map((connector) => connector.connector);
  const unhealthyConnectors = requiredConnectors
    .filter((connector) => connector.enabled && connector.health !== "healthy")
    .map((connector) => `${connector.connector}:${connector.health}`);
  const renewalDueConnectors = requiredConnectors
    .filter((connector) => connector.enabled && connector.renewalDue)
    .map((connector) => connector.connector);

  const baselineCntRow = db.query<{ cnt: number | null }, [string]>(
    `SELECT COUNT(*) as cnt FROM onboarding_snapshots WHERE onboarding_id = ? AND phase = 'baseline'`
  ).get(row.onboarding_id);
  const baselineCaptured = Number(baselineCntRow?.cnt ?? 0) > 0;

  const mappingDriftRow = db.query<{ cnt: number | null }, [string]>(
    `SELECT COUNT(*) as cnt
     FROM erp_master_data_mappings
     WHERE workspace_id = ? AND drift_status = 'changed'`
  ).get(row.workspace_id);
  const mappingDriftCount = Number(mappingDriftRow?.cnt ?? 0);

  const masterDataState = asObject(state.masterData);
  const q2oDryRunState = asObject(state.q2oDryRun);
  const dryRunPassed = q2oDryRunState.passed === true;
  const masterDataSyncedAt = typeof masterDataState.lastSyncedAt === "string" ? masterDataState.lastSyncedAt : undefined;
  const dryRunAt = typeof q2oDryRunState.lastRunAt === "string" ? q2oDryRunState.lastRunAt : undefined;

  const overrides = getLatestWizardOverrides(row.id);
  const gate = (
    id: z.infer<typeof WizardGateIdSchema>,
    title: string,
    gateClass: "critical" | "overridable",
    green: boolean,
    reason: string,
    fixPath: string,
  ): Record<string, unknown> => {
    const override = overrides.get(id);
    const status: WizardGateStatus = green ? "green" : (gateClass === "overridable" && override ? "overridden" : "red");
    return {
      id,
      title,
      class: gateClass,
      status,
      reason: green ? undefined : reason,
      fixPath,
      override: override
        ? {
            reason: override.reason,
            approvedBy: override.approved_by,
            approvedAt: override.created_at,
          }
        : undefined,
    };
  };

  const gates = [
    gate(
      "workspace_isolation",
      "Workspace Isolation",
      "critical",
      workspaceIsolationOk,
      "Workspace isolation failed for this session.",
      "Re-authenticate with a key scoped to this workspace or use an admin key.",
    ),
    gate(
      "required_connectors",
      "Required Connectors",
      "critical",
      missingConnectors.length === 0,
      `Missing required connectors: ${missingConnectors.join(", ") || "none"}.`,
      "Connect Odoo, Business Central, and Dynamics in the wizard before launch.",
    ),
    gate(
      "dry_run_success",
      "Quote-to-Order Dry Run",
      "critical",
      dryRunPassed,
      "No successful quote-to-order dry run recorded.",
      "Run quote-to-order dry run and resolve any reported errors.",
    ),
    gate(
      "connector_health",
      "Connector Health",
      "overridable",
      unhealthyConnectors.length === 0,
      `Unhealthy/degraded connectors: ${unhealthyConnectors.join(", ") || "none"}.`,
      "Run connector test/retry and inspect last sync error before override.",
    ),
    gate(
      "renewal_due",
      "Renewal Due",
      "overridable",
      renewalDueConnectors.length === 0,
      `Connector renewals pending: ${renewalDueConnectors.join(", ") || "none"}.`,
      "Run Business Central renewal and re-check status before override.",
    ),
    gate(
      "mapping_drift",
      "Master Data Mapping Drift",
      "overridable",
      mappingDriftCount === 0,
      `Detected ${mappingDriftCount} mapping drift entries.`,
      "Review changed mappings and update driftStatus to ok.",
    ),
  ];

  const criticalBlocking = gates.filter((item) => item.class === "critical" && item.status !== "green");
  const nonCriticalBlocking = gates.filter((item) => item.class === "overridable" && item.status === "red");

  const steps: Array<Record<string, unknown>> = [
    {
      id: "workspace",
      title: "Workspace auswählen/isolieren",
      status: workspaceIsolationOk ? "done" : "blocked" as WizardStepStatus,
      detail: workspaceIsolationOk ? row.workspace_id : "Workspace isolation not satisfied",
    },
    {
      id: "onboarding",
      title: "Onboarding Session anlegen",
      status: row.onboarding_id ? "done" : "blocked" as WizardStepStatus,
      detail: row.onboarding_id,
    },
    {
      id: "baseline",
      title: "Baseline erfassen",
      status: baselineCaptured ? "done" : "pending" as WizardStepStatus,
      detail: baselineCaptured ? "Baseline snapshot captured" : "Capture baseline snapshot",
    },
    {
      id: "connect_odoo",
      title: "Odoo verbinden",
      status: (connectorStatusesMap.get("odoo")?.enabled ?? false) ? "done" : "pending" as WizardStepStatus,
      detail: (connectorStatusesMap.get("odoo")?.enabled ?? false) ? "Connected" : "Not connected",
    },
    {
      id: "connect_business_central",
      title: "Business Central verbinden + Renewal prüfen",
      status: (() => {
        const status = connectorStatusesMap.get("business-central");
        if (!status?.enabled) return "pending";
        if (status.renewalDue) return "blocked";
        return "done";
      })() as WizardStepStatus,
      detail: (() => {
        const status = connectorStatusesMap.get("business-central");
        if (!status?.enabled) return "Not connected";
        if (status.renewalDue) return "Renewal due";
        return "Connected and renewal healthy";
      })(),
    },
    {
      id: "connect_dynamics",
      title: "Dynamics verbinden",
      status: (connectorStatusesMap.get("dynamics")?.enabled ?? false) ? "done" : "pending" as WizardStepStatus,
      detail: (connectorStatusesMap.get("dynamics")?.enabled ?? false) ? "Connected" : "Not connected",
    },
    {
      id: "master_data_sync",
      title: "Master Data Auto-Sync",
      status: masterDataSyncedAt ? "done" : (missingConnectors.length > 0 ? "blocked" : "pending") as WizardStepStatus,
      detail: masterDataSyncedAt ?? "Awaiting master data sync",
    },
    {
      id: "mapping_review",
      title: "Mapping Drift Review/Fix",
      status: mappingDriftCount === 0
        ? (masterDataSyncedAt ? "done" : "pending")
        : "blocked" as WizardStepStatus,
      detail: mappingDriftCount === 0 ? "No mapping drift" : `${mappingDriftCount} drift items require review`,
    },
    {
      id: "q2o_dry_run",
      title: "Quote-to-Order Dry Run",
      status: dryRunPassed ? "done" : (missingConnectors.length > 0 ? "blocked" : "pending") as WizardStepStatus,
      detail: dryRunPassed ? `Last successful dry run at ${dryRunAt ?? "unknown"}` : "Dry run not passed",
    },
    {
      id: "launch_and_report",
      title: "SLA/Incident Check + Launch + Report",
      status: (row.status === "launched" || row.status === "completed") ? "done" : (dryRunPassed ? "pending" : "blocked") as WizardStepStatus,
      detail: row.status === "launched" ? `Launched via ${row.launch_mode ?? "unknown"} mode` : "Awaiting launch",
    },
  ];

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    onboardingId: row.onboarding_id,
    customerName: row.customer_name,
    product: row.product,
    status: row.status,
    launchMode: row.launch_mode ?? undefined,
    launchedAt: row.launched_at ?? undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    connectors: requiredConnectors,
    steps,
    gates,
    readiness: {
      criticalBlocking,
      nonCriticalBlocking,
      canLaunchProduction: criticalBlocking.length === 0 && nonCriticalBlocking.length === 0,
      canLaunchSandbox: criticalBlocking.length === 0,
      warnAndContinueEnabled: true,
    },
    state,
  };
}

function wizardSessionSummary(row: WizardSessionRow): Record<string, unknown> {
  const view = buildWizardSessionView(row);
  return {
    id: view.id,
    workspaceId: view.workspaceId,
    onboardingId: view.onboardingId,
    customerName: view.customerName,
    product: view.product,
    status: view.status,
    updatedAt: view.updatedAt,
    readiness: view.readiness,
  };
}

export function createWizardSessionState(input: unknown): Record<string, unknown> {
  const parsed = WizardSessionCreateSchema.parse(input);
  const onboarding = createOnboardingSession({
    customerName: parsed.customerName,
    product: parsed.product,
    metadata: {
      wizard: true,
      workspaceId: parsed.workspaceId,
      createdBy: parsed.createdBy ?? "wizard",
    },
  });
  captureOnboardingSnapshot({ onboardingId: onboarding.id, phase: "baseline" });
  const now = nowIso();
  const id = randomUUID();
  const state = {
    workspaceIsolationOk: parsed.workspaceIsolationOk,
    connectors: {},
    masterData: {},
    q2oDryRun: {},
  };
  db.run(
    `INSERT INTO wizard_sessions (id, workspace_id, onboarding_id, customer_name, product, status, state_json, created_by, launch_mode, launched_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, ?, ?)`,
    [
      id,
      parsed.workspaceId,
      onboarding.id,
      parsed.customerName,
      parsed.product,
      JSON.stringify(state),
      parsed.createdBy ?? null,
      now,
      now,
    ],
  );
  return getWizardSessionState(id);
}

export function listWizardSessionStates(filtersInput: unknown = {}): { items: Record<string, unknown>[] } {
  const filters = WizardSessionListSchema.parse(filtersInput);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.workspaceId) {
    where.push("workspace_id = ?");
    params.push(filters.workspaceId);
  }
  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  const sql = `SELECT id, workspace_id, onboarding_id, customer_name, product, status, state_json, created_by, launch_mode, launched_at, created_at, updated_at
               FROM wizard_sessions
               ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY updated_at DESC
               LIMIT ?`;
  params.push(filters.limit);
  const rows = db.query<WizardSessionRow, unknown[]>(sql).all(...params);
  return { items: rows.map(wizardSessionSummary) };
}

export function getWizardSessionState(sessionIdInput: unknown): Record<string, unknown> {
  const sessionId = z.string().min(1).parse(sessionIdInput);
  const row = getWizardSessionRow(sessionId);
  if (!row) throw new Error(`Wizard session '${sessionId}' not found`);
  return buildWizardSessionView(row);
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
    activity: "tasks",
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
    activity: "salesQuotes",
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
    activity: "mail.activity",
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

  if (request.connectorType === "business-central" && request.entityType === "activity") {
    return {
      mode: "simulated",
      connector: request.connectorType,
      reason: "Business Central activity writeback uses note bridge adapter in managed deployments",
      direction: request.direction,
      entityType: request.entityType,
      externalId: request.externalId ?? null,
      syncedAt: nowIso(),
      upstream: {
        bridge: "sales-quote-note",
        payloadKeys: Object.keys(request.payload),
      },
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

function parseIntentTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function toQuoteCommunicationEvent(row: QuoteCommunicationEventRow): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    quoteExternalId: row.quote_external_id,
    connectorType: row.connector_type ?? undefined,
    channel: row.channel,
    direction: row.direction,
    subject: row.subject ?? undefined,
    bodyText: row.body_text,
    fromAddress: row.from_address ?? undefined,
    toAddress: row.to_address ?? undefined,
    externalThreadId: row.external_thread_id ?? undefined,
    intentTags: parseIntentTags(row.intent_tags_json),
    sentiment: row.sentiment,
    urgency: row.urgency,
    followupNeeded: row.followup_needed === 1,
    followupReason: row.followup_reason ?? undefined,
    estimatedDealProbabilityPct: row.estimated_deal_probability_pct ?? undefined,
    personalityType: row.personality_type ?? undefined,
    personalityConfidence: row.personality_confidence ?? undefined,
    metadata: parseMetadata(row.metadata_json),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function toQuoteFollowupAction(row: QuoteFollowupActionRow): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    quoteExternalId: row.quote_external_id,
    sourceEventId: row.source_event_id ?? undefined,
    actionType: row.action_type,
    priority: row.priority,
    status: row.status,
    reason: row.reason,
    suggestedSubject: row.suggested_subject ?? undefined,
    suggestedMessage: row.suggested_message,
    assignedTo: row.assigned_to ?? undefined,
    dueAt: row.due_at,
    note: row.note ?? undefined,
    lastError: row.last_error ?? undefined,
    writeback: {
      runId: row.writeback_run_id ?? undefined,
      connector: row.writeback_connector ?? undefined,
      status: row.writeback_status ?? undefined,
      syncedAt: row.writeback_synced_at ?? undefined,
      error: row.writeback_error ?? undefined,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, "");
}

function extractEmailDomain(address: string | undefined): string | null {
  if (!address) return null;
  const trimmed = address.trim().toLowerCase();
  if (!trimmed) return null;
  const match = trimmed.match(/<?[^<>\s@]+@([^<>\s@]+)>?$/);
  return match?.[1] ?? null;
}

function inferMailDirection(
  explicitDirection: QuoteCommunicationDirection | undefined,
  fromAddress: string | undefined,
  toAddress: string | undefined,
  workspaceDomains: Set<string>,
): QuoteCommunicationDirection {
  if (explicitDirection) return explicitDirection;
  const fromDomain = extractEmailDomain(fromAddress);
  const toDomain = extractEmailDomain(toAddress);
  const fromInternal = fromDomain ? workspaceDomains.has(fromDomain) : false;
  const toInternal = toDomain ? workspaceDomains.has(toDomain) : false;
  if (!fromInternal && toInternal) return "inbound";
  if (fromInternal && !toInternal) return "outbound";
  return "inbound";
}

function extractQuoteExternalIdFromText(subject: string, bodyText: string): string | null {
  const combined = `${subject} ${bodyText}`;
  const direct = combined.match(/\bQ-[A-Za-z0-9][A-Za-z0-9_-]{1,}\b/i);
  if (direct?.[0]) return direct[0];

  const fallback = combined.match(/\b(?:quote|angebot)\s*(?:id|nr|number|#|no)?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9_-]{2,})\b/i);
  if (!fallback?.[1]) return null;
  const token = fallback[1];
  if (/^\d+$/.test(token)) return `Q-${token}`;
  return token;
}

function chooseDefaultQuoteConnector(
  provider: QuoteMailboxProvider,
  preferred: ConnectorType | undefined,
): ConnectorType | null {
  if (preferred) return preferred;
  const fromConfig = db.query<{ type: ConnectorType }, []>(
    `SELECT type
     FROM connector_configs
     WHERE enabled = 1
     ORDER BY CASE health WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END ASC, updated_at DESC
     LIMIT 1`
  ).get();
  if (fromConfig?.type) return fromConfig.type;
  if (provider === "outlook") return "dynamics";
  return null;
}

function buildMailboxIdempotencyKey(provider: QuoteMailboxProvider, messageId: string): string {
  return `mailbox:${provider}:${messageId.trim()}`;
}

function parseDateToIso(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) return undefined;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return undefined;
  return new Date(ts).toISOString();
}

function safeBase64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const buf = Buffer.from(`${normalized}${padding}`, "base64");
  return buf.toString("utf8");
}

function extractGmailBodyFromPayload(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  const bodyObj = asObject(payload.body);
  const directData = typeof bodyObj.data === "string" ? bodyObj.data : "";
  if (directData) {
    try {
      return safeBase64UrlDecode(directData);
    } catch {
      return "";
    }
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const rawPart of parts) {
    const part = asObject(rawPart);
    const mimeType = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
    const nested = extractGmailBodyFromPayload(part);
    if (nested && (mimeType.includes("text/plain") || mimeType === "")) {
      return nested;
    }
  }
  for (const rawPart of parts) {
    const nested = extractGmailBodyFromPayload(asObject(rawPart));
    if (nested) return nested;
  }
  return "";
}

type PulledMailboxMessage = {
  messageId: string;
  threadId?: string;
  subject?: string;
  bodyText: string;
  fromAddress?: string;
  toAddress?: string;
  receivedAt?: string;
  sentAt?: string;
  metadata: Record<string, unknown>;
};

async function pullGmailMessages(input: {
  accessToken: string;
  userId: string;
  limit: number;
  query?: string;
  since?: string;
}): Promise<PulledMailboxMessage[]> {
  const qParts: string[] = [];
  if (input.query) qParts.push(input.query);
  if (input.since) {
    const sinceTs = Date.parse(input.since);
    if (Number.isFinite(sinceTs)) {
      qParts.push(`after:${Math.floor(sinceTs / 1000)}`);
    }
  }
  const params = new URLSearchParams({
    maxResults: String(input.limit),
    q: qParts.join(" ").trim(),
  });
  if (!params.get("q")) params.delete("q");
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(input.userId)}/messages?${params.toString()}`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!listRes.ok) {
    throw new Error(`Gmail list API failed: HTTP ${listRes.status}`);
  }
  const listJson = asObject(await listRes.json());
  const ids = Array.isArray(listJson.messages)
    ? listJson.messages
      .map((m) => asObject(m))
      .map((m) => typeof m.id === "string" ? m.id : null)
      .filter((id): id is string => Boolean(id))
      .slice(0, input.limit)
    : [];
  const pulled: PulledMailboxMessage[] = [];
  for (const id of ids) {
    const detailUrl = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(input.userId)}/messages/${encodeURIComponent(id)}?format=full`;
    const detailRes = await fetch(detailUrl, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    if (!detailRes.ok) continue;
    const detail = asObject(await detailRes.json());
    const payload = asObject(detail.payload);
    const headerRows = Array.isArray(payload.headers) ? payload.headers : [];
    const headerMap = new Map<string, string>();
    for (const rowRaw of headerRows) {
      const row = asObject(rowRaw);
      const name = typeof row.name === "string" ? row.name.toLowerCase() : "";
      const value = typeof row.value === "string" ? row.value : "";
      if (name) headerMap.set(name, value);
    }
    const receivedAt = parseDateToIso(headerMap.get("date")) ?? undefined;
    const subject = headerMap.get("subject");
    const fromAddress = headerMap.get("from");
    const toAddress = headerMap.get("to");
    const bodyText = extractGmailBodyFromPayload(payload) || (typeof detail.snippet === "string" ? detail.snippet : "");
    pulled.push({
      messageId: (typeof detail.id === "string" ? detail.id : id),
      threadId: typeof detail.threadId === "string" ? detail.threadId : undefined,
      subject: subject || undefined,
      bodyText: bodyText || "",
      fromAddress: fromAddress || undefined,
      toAddress: toAddress || undefined,
      receivedAt,
      sentAt: receivedAt,
      metadata: {
        provider: "gmail",
        labelIds: Array.isArray(detail.labelIds) ? detail.labelIds : [],
        snippet: typeof detail.snippet === "string" ? detail.snippet : undefined,
      },
    });
  }
  return pulled;
}

function quoteOutlookOdataValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function pullOutlookMessages(input: {
  accessToken: string;
  userId: string;
  folder: string;
  limit: number;
  since?: string;
}): Promise<PulledMailboxMessage[]> {
  const base = input.userId === "me"
    ? "https://graph.microsoft.com/v1.0/me"
    : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(input.userId)}`;
  const folder = input.folder.trim().toLowerCase();
  const folderSegment = folder.length > 0 ? folder : "inbox";
  const params = new URLSearchParams({
    "$top": String(input.limit),
    "$orderby": "receivedDateTime desc",
    "$select": "id,internetMessageId,subject,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,conversationId",
  });
  if (input.since) {
    const sinceIso = parseDateToIso(input.since);
    if (sinceIso) params.set("$filter", `receivedDateTime ge ${quoteOutlookOdataValue(sinceIso)}`);
  }
  const url = `${base}/mailFolders/${encodeURIComponent(folderSegment)}/messages?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Outlook list API failed: HTTP ${res.status}`);
  }
  const json = asObject(await res.json());
  const rows = Array.isArray(json.value) ? json.value.map((row) => asObject(row)) : [];
  const pulled: PulledMailboxMessage[] = [];
  for (const row of rows) {
    const fromObj = asObject(asObject(row.from).emailAddress);
    const toRows = Array.isArray(row.toRecipients) ? row.toRecipients : [];
    const firstTo = toRows.length > 0 ? asObject(asObject(asObject(toRows[0]).emailAddress)) : {};
    const messageId = typeof row.internetMessageId === "string" && row.internetMessageId.length > 0
      ? row.internetMessageId
      : (typeof row.id === "string" ? row.id : randomUUID());
    pulled.push({
      messageId,
      threadId: typeof row.conversationId === "string" ? row.conversationId : undefined,
      subject: typeof row.subject === "string" ? row.subject : undefined,
      bodyText: typeof row.bodyPreview === "string" ? row.bodyPreview : "",
      fromAddress: typeof fromObj.address === "string" ? fromObj.address : undefined,
      toAddress: typeof firstTo.address === "string" ? firstTo.address : undefined,
      receivedAt: parseDateToIso(typeof row.receivedDateTime === "string" ? row.receivedDateTime : undefined),
      sentAt: parseDateToIso(typeof row.sentDateTime === "string" ? row.sentDateTime : undefined),
      metadata: {
        provider: "outlook",
        graphId: typeof row.id === "string" ? row.id : undefined,
        conversationId: typeof row.conversationId === "string" ? row.conversationId : undefined,
      },
    });
  }
  return pulled;
}

function defaultTokenEndpoint(provider: QuoteMailboxProvider, tenantId?: string): string {
  if (provider === "gmail") return "https://oauth2.googleapis.com/token";
  const tenant = tenantId && tenantId.length > 0 ? tenantId : "common";
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

function getMailboxConnectionRow(
  workspaceId: string,
  provider: QuoteMailboxProvider,
  userId?: string,
): QuoteMailboxConnectionRow | null {
  if (userId && userId.length > 0) {
    return db.query<QuoteMailboxConnectionRow, [string, string, string]>(
      `SELECT id, workspace_id, provider, user_id, tenant_id, client_id, client_secret, refresh_token, access_token, access_token_expires_at, token_endpoint,
              scopes_json, metadata_json, enabled, last_refresh_at, last_error, created_at, updated_at
       FROM quote_mailbox_connections
       WHERE workspace_id = ? AND provider = ? AND user_id = ? AND enabled = 1
       LIMIT 1`
    ).get(workspaceId, provider, userId) ?? null;
  }
  return db.query<QuoteMailboxConnectionRow, [string, string]>(
    `SELECT id, workspace_id, provider, user_id, tenant_id, client_id, client_secret, refresh_token, access_token, access_token_expires_at, token_endpoint,
            scopes_json, metadata_json, enabled, last_refresh_at, last_error, created_at, updated_at
     FROM quote_mailbox_connections
     WHERE workspace_id = ? AND provider = ? AND enabled = 1
     ORDER BY updated_at DESC
     LIMIT 1`
  ).get(workspaceId, provider) ?? null;
}

function toMailboxConnectionSummary(row: QuoteMailboxConnectionRow): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    userId: row.user_id,
    tenantId: row.tenant_id ?? undefined,
    enabled: row.enabled === 1,
    hasClientId: Boolean(row.client_id),
    hasClientSecret: Boolean(row.client_secret),
    hasRefreshToken: Boolean(row.refresh_token),
    hasAccessToken: Boolean(row.access_token),
    accessTokenExpiresAt: row.access_token_expires_at ?? undefined,
    tokenEndpoint: row.token_endpoint ?? undefined,
    scopes: parseIntentTags(row.scopes_json),
    metadata: parseMetadata(row.metadata_json),
    lastRefreshAt: row.last_refresh_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertQuoteMailboxConnection(workspaceIdInput: unknown, bodyInput: unknown): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const body = QuoteMailboxConnectionSchema.parse(bodyInput);
  const now = nowIso();
  const existing = db.query<QuoteMailboxConnectionRow, [string, string, string]>(
    `SELECT id, workspace_id, provider, user_id, tenant_id, client_id, client_secret, refresh_token, access_token, access_token_expires_at, token_endpoint,
            scopes_json, metadata_json, enabled, last_refresh_at, last_error, created_at, updated_at
     FROM quote_mailbox_connections
     WHERE workspace_id = ? AND provider = ? AND user_id = ?
     LIMIT 1`
  ).get(workspaceId, body.provider, body.userId);
  const tokenEndpoint = body.tokenEndpoint ?? defaultTokenEndpoint(body.provider, body.tenantId);
  if (existing) {
    db.run(
      `UPDATE quote_mailbox_connections
       SET tenant_id = COALESCE(?, tenant_id),
           client_id = COALESCE(?, client_id),
           client_secret = COALESCE(?, client_secret),
           refresh_token = COALESCE(?, refresh_token),
           access_token = COALESCE(?, access_token),
           access_token_expires_at = COALESCE(?, access_token_expires_at),
           token_endpoint = COALESCE(?, token_endpoint),
           scopes_json = ?,
           metadata_json = ?,
           enabled = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        body.tenantId ?? null,
        body.clientId ?? null,
        body.clientSecret ?? null,
        body.refreshToken ?? null,
        body.accessToken ?? null,
        body.accessTokenExpiresAt ?? null,
        tokenEndpoint,
        JSON.stringify(body.scopes),
        JSON.stringify(body.metadata),
        body.enabled ? 1 : 0,
        now,
        existing.id,
      ],
    );
    const updated = getMailboxConnectionRow(workspaceId, body.provider, body.userId);
    if (!updated) throw new Error("Failed to update mailbox connection");
    return toMailboxConnectionSummary(updated);
  }

  const id = randomUUID();
  db.run(
    `INSERT INTO quote_mailbox_connections (
       id, workspace_id, provider, user_id, tenant_id, client_id, client_secret, refresh_token, access_token, access_token_expires_at,
       token_endpoint, scopes_json, metadata_json, enabled, last_refresh_at, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    [
      id,
      workspaceId,
      body.provider,
      body.userId,
      body.tenantId ?? null,
      body.clientId ?? null,
      body.clientSecret ?? null,
      body.refreshToken ?? null,
      body.accessToken ?? null,
      body.accessTokenExpiresAt ?? null,
      tokenEndpoint,
      JSON.stringify(body.scopes),
      JSON.stringify(body.metadata),
      body.enabled ? 1 : 0,
      now,
      now,
    ],
  );
  const saved = getMailboxConnectionRow(workspaceId, body.provider, body.userId);
  if (!saved) throw new Error("Failed to create mailbox connection");
  return toMailboxConnectionSummary(saved);
}

export function listQuoteMailboxConnections(workspaceIdInput: unknown, filtersInput: unknown = {}): { items: Array<Record<string, unknown>> } {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const filters = QuoteMailboxConnectionListSchema.parse(filtersInput);
  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (filters.provider) {
    where.push("provider = ?");
    params.push(filters.provider);
  }
  if (filters.userId) {
    where.push("user_id = ?");
    params.push(filters.userId);
  }
  const rows = db.query<QuoteMailboxConnectionRow, unknown[]>(
    `SELECT id, workspace_id, provider, user_id, tenant_id, client_id, client_secret, refresh_token, access_token, access_token_expires_at, token_endpoint,
            scopes_json, metadata_json, enabled, last_refresh_at, last_error, created_at, updated_at
     FROM quote_mailbox_connections
     WHERE ${where.join(" AND ")}
     ORDER BY provider ASC, user_id ASC`
  ).all(...params);
  return { items: rows.map(toMailboxConnectionSummary) };
}

export function disableQuoteMailboxConnection(
  workspaceIdInput: unknown,
  providerInput: unknown,
  bodyInput: unknown = {},
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const provider = QuoteMailboxProviderSchema.parse(providerInput);
  const body = QuoteMailboxConnectionDisableSchema.parse(bodyInput);
  const existing = getMailboxConnectionRow(workspaceId, provider, body.userId);
  if (!existing) throw new Error(`Mailbox connection not found for workspace '${workspaceId}', provider '${provider}', user '${body.userId}'`);
  db.run(
    `UPDATE quote_mailbox_connections
     SET enabled = 0, updated_at = ?
     WHERE id = ?`,
    [nowIso(), existing.id],
  );
  return { status: "disabled", workspaceId, provider, userId: body.userId };
}

type MailboxTokenResolution = {
  accessToken: string;
  userId: string;
  source: "provided" | "stored_access_token" | "refreshed";
  connectionId?: string;
};

async function resolveMailboxAccessToken(input: {
  workspaceId: string;
  provider: QuoteMailboxProvider;
  userId: string;
  providedAccessToken?: string;
  useStoredConnection: boolean;
  forceRefresh?: boolean;
}): Promise<MailboxTokenResolution> {
  if (input.providedAccessToken && input.providedAccessToken.length > 0) {
    return {
      accessToken: input.providedAccessToken,
      userId: input.userId,
      source: "provided",
    };
  }
  if (!input.useStoredConnection) {
    throw new Error("No accessToken provided and stored mailbox connection disabled for this request.");
  }
  let connection = getMailboxConnectionRow(input.workspaceId, input.provider, input.userId);
  if (!connection && input.userId === "me") {
    // "me" is convenient for API pulls, but stored bindings often use explicit mailbox IDs.
    connection = getMailboxConnectionRow(input.workspaceId, input.provider);
  }
  if (!connection) {
    throw new Error(`No mailbox connection found for workspace '${input.workspaceId}', provider '${input.provider}', user '${input.userId}'.`);
  }
  const notExpiringSoon = connection.access_token && (
    !connection.access_token_expires_at
    || Date.parse(connection.access_token_expires_at) > Date.now() + 60_000
  );
  if (notExpiringSoon && !input.forceRefresh) {
    return {
      accessToken: connection.access_token as string,
      userId: connection.user_id,
      source: "stored_access_token",
      connectionId: connection.id,
    };
  }
  if (!connection.refresh_token || !connection.client_id) {
    throw new Error(`Mailbox connection '${connection.id}' is missing refresh credentials.`);
  }

  const tokenEndpoint = connection.token_endpoint ?? defaultTokenEndpoint(connection.provider, connection.tenant_id ?? undefined);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: connection.refresh_token,
    client_id: connection.client_id,
  });
  if (connection.client_secret) form.set("client_secret", connection.client_secret);
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const errorMsg = `Mailbox token refresh failed: HTTP ${res.status}`;
    db.run(
      `UPDATE quote_mailbox_connections
       SET last_error = ?, updated_at = ?
       WHERE id = ?`,
      [`${errorMsg}${bodyText ? ` (${bodyText.slice(0, 200)})` : ""}`, nowIso(), connection.id],
    );
    throw new Error(errorMsg);
  }
  const tokenJson = asObject(await res.json());
  const accessToken = typeof tokenJson.access_token === "string" ? tokenJson.access_token : "";
  if (!accessToken) throw new Error("Mailbox token refresh response missing access_token.");
  const expiresIn = Number(tokenJson.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const refreshToken = typeof tokenJson.refresh_token === "string" && tokenJson.refresh_token.length > 0
    ? tokenJson.refresh_token
    : connection.refresh_token;
  db.run(
    `UPDATE quote_mailbox_connections
     SET access_token = ?, access_token_expires_at = ?, refresh_token = ?, token_endpoint = ?, last_refresh_at = ?, last_error = NULL, enabled = 1, updated_at = ?
     WHERE id = ?`,
    [accessToken, expiresAt, refreshToken, tokenEndpoint, nowIso(), nowIso(), connection.id],
  );
  return {
    accessToken,
    userId: connection.user_id,
    source: "refreshed",
    connectionId: connection.id,
  };
}

export async function refreshQuoteMailboxConnection(
  workspaceIdInput: unknown,
  providerInput: unknown,
  bodyInput: unknown = {},
): Promise<Record<string, unknown>> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const provider = QuoteMailboxProviderSchema.parse(providerInput);
  const body = QuoteMailboxConnectionRefreshSchema.parse(bodyInput);
  const resolved = await resolveMailboxAccessToken({
    workspaceId,
    provider,
    userId: body.userId,
    useStoredConnection: true,
    forceRefresh: body.force,
  });
  const current = getMailboxConnectionRow(workspaceId, provider, body.userId);
  if (!current) throw new Error("Mailbox connection disappeared after refresh.");
  return {
    workspaceId,
    provider,
    userId: body.userId,
    tokenSource: resolved.source,
    connection: toMailboxConnectionSummary(current),
  };
}

const COMM_INTENT_RULES: Array<{ tag: string; keywords: string[] }> = [
  { tag: "ready_to_buy", keywords: ["go ahead", "approved", "po approved", "purchase order", "let us proceed", "auftrag frei", "freigegeben"] },
  { tag: "pricing_objection", keywords: ["too expensive", "budget", "preis", "cost too high", "rabatt", "discount needed"] },
  { tag: "timing_delay", keywords: ["next quarter", "later", "delay", "postpone", "spater", "verschieben"] },
  { tag: "procurement_block", keywords: ["legal review", "security review", "dsgvo", "gdpr", "contract redline", "compliance"] },
  { tag: "request_update", keywords: ["status update", "any update", "follow up", "nachfass", "stand"] },
  { tag: "no_interest", keywords: ["not interested", "kein interesse", "stop contacting", "closed lost"] },
];

type MbtiDimensionConfig = {
  left: "E" | "S" | "T" | "J";
  right: "I" | "N" | "F" | "P";
  leftKeywords: string[];
  rightKeywords: string[];
};

const MBTI_DIMENSIONS: MbtiDimensionConfig[] = [
  {
    left: "E",
    right: "I",
    leftKeywords: ["call", "meeting", "discuss", "align", "team", "workshop", "speak", "telefonat", "abstimmen", "gemeinsam", "kurz sprechen"],
    rightKeywords: ["details", "document", "analyze", "review", "intern", "written", "schriftlich", "dokument", "in ruhe", "nachdenken", "auswerten"],
  },
  {
    left: "S",
    right: "N",
    leftKeywords: ["specific", "exact", "details", "step", "numbers", "contract", "concrete", "konkret", "genau", "zahlen", "spezifikation"],
    rightKeywords: ["strategy", "vision", "future", "opportunity", "innovation", "potential", "langfristig", "strategie", "vision", "moeglichkeit", "big picture"],
  },
  {
    left: "T",
    right: "F",
    leftKeywords: ["roi", "cost", "budget", "efficiency", "risk", "compliance", "data", "preis", "kosten", "wirtschaftlich", "objektiv"],
    rightKeywords: ["trust", "feel", "support", "relationship", "appreciate", "concern", "care", "vertrauen", "beziehung", "danke", "wertschaetzen"],
  },
  {
    left: "J",
    right: "P",
    leftKeywords: ["deadline", "schedule", "final", "approve", "decision", "plan", "process", "today", "asap", "frist", "verbindlich", "sofort"],
    rightKeywords: ["maybe", "explore", "flexible", "options", "later", "postpone", "brainstorm", "vielleicht", "optional", "spaeter", "testen"],
  },
];

type MbtiDimensionScore = {
  leftLetter: string;
  rightLetter: string;
  leftHits: number;
  rightHits: number;
  selected: string;
  confidence: number;
};

type MbtiEstimate = {
  type: string;
  confidence: number;
  dimensions: Record<"EI" | "SN" | "TF" | "JP", MbtiDimensionScore>;
  model: "heuristic_mbti_v1";
};

function keywordHits(haystack: string, keywords: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword || keyword.length === 0) continue;
    if (haystack.includes(keyword)) {
      score += keyword.includes(" ") ? 2 : 1;
    }
  }
  return score;
}

function bounded(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function estimateMbtiFromCommunication(input: {
  subject: string;
  bodyText: string;
  direction: QuoteCommunicationDirection;
  sentiment: "positive" | "neutral" | "negative";
  urgency: "low" | "normal" | "high";
  intentTags: string[];
}): MbtiEstimate {
  const haystack = `${input.subject} ${input.bodyText}`.toLowerCase();
  const result: Record<"EI" | "SN" | "TF" | "JP", MbtiDimensionScore> = {
    EI: { leftLetter: "E", rightLetter: "I", leftHits: 0, rightHits: 0, selected: "I", confidence: 0.35 },
    SN: { leftLetter: "S", rightLetter: "N", leftHits: 0, rightHits: 0, selected: "S", confidence: 0.35 },
    TF: { leftLetter: "T", rightLetter: "F", leftHits: 0, rightHits: 0, selected: "T", confidence: 0.35 },
    JP: { leftLetter: "J", rightLetter: "P", leftHits: 0, rightHits: 0, selected: "J", confidence: 0.35 },
  };

  for (const dim of MBTI_DIMENSIONS) {
    const key = `${dim.left}${dim.right}` as "EI" | "SN" | "TF" | "JP";
    const leftHits = keywordHits(haystack, dim.leftKeywords);
    const rightHits = keywordHits(haystack, dim.rightKeywords);
    result[key].leftHits = leftHits;
    result[key].rightHits = rightHits;
  }

  if (input.urgency === "high") {
    result.JP.leftHits += 1;
    result.EI.leftHits += 1;
  } else if (input.urgency === "low") {
    result.JP.rightHits += 1;
  }
  if (input.sentiment === "negative") {
    result.TF.leftHits += 1;
  } else if (input.sentiment === "positive") {
    result.TF.rightHits += 1;
  }
  if (input.direction === "inbound" && haystack.includes("?")) {
    result.EI.leftHits += 1;
  }
  if (input.intentTags.includes("timing_delay")) result.JP.rightHits += 2;
  if (input.intentTags.includes("ready_to_buy")) result.JP.leftHits += 2;
  if (input.intentTags.includes("pricing_objection") || input.intentTags.includes("procurement_block")) result.TF.leftHits += 1;

  let totalConfidence = 0;
  const letters: string[] = [];
  (["EI", "SN", "TF", "JP"] as const).forEach((key) => {
    const dim = result[key];
    const delta = dim.leftHits - dim.rightHits;
    const totalHits = dim.leftHits + dim.rightHits;
    const selected = delta >= 0 ? dim.leftLetter : dim.rightLetter;
    const confidence = totalHits === 0
      ? 0.35
      : bounded(0.45 + (Math.abs(delta) / (totalHits + 2)) * 0.35 + Math.min(totalHits, 6) * 0.03, 0.35, 0.93);
    dim.selected = selected;
    dim.confidence = Number(confidence.toFixed(3));
    letters.push(selected);
    totalConfidence += dim.confidence;
  });

  return {
    type: letters.join(""),
    confidence: Number((totalConfidence / 4).toFixed(3)),
    dimensions: result,
    model: "heuristic_mbti_v1",
  };
}

function classifyQuoteCommunication(
  subject: string,
  bodyText: string,
  direction: QuoteCommunicationDirection,
): {
  intentTags: string[];
  sentiment: "positive" | "neutral" | "negative";
  urgency: "low" | "normal" | "high";
  followupNeeded: boolean;
  followupReason: string | null;
} {
  const haystack = `${subject} ${bodyText}`.toLowerCase();
  const intentTags = new Set<string>();
  for (const rule of COMM_INTENT_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) {
      intentTags.add(rule.tag);
    }
  }

  let sentiment: "positive" | "neutral" | "negative" = "neutral";
  if (intentTags.has("ready_to_buy")) sentiment = "positive";
  if (intentTags.has("pricing_objection") || intentTags.has("timing_delay") || intentTags.has("procurement_block") || intentTags.has("no_interest")) {
    sentiment = "negative";
  }

  let urgency: "low" | "normal" | "high" = "normal";
  if (haystack.includes("urgent") || haystack.includes("asap") || haystack.includes("today") || haystack.includes("dringend")) {
    urgency = "high";
  }
  if (intentTags.has("ready_to_buy")) urgency = "high";
  if (intentTags.has("timing_delay")) urgency = "low";

  const followupNeeded = direction === "inbound" && (
    intentTags.has("request_update")
    || intentTags.has("pricing_objection")
    || intentTags.has("procurement_block")
    || intentTags.has("ready_to_buy")
    || haystack.includes("?")
  );

  let followupReason: string | null = null;
  if (intentTags.has("ready_to_buy")) followupReason = "Buyer signaled readiness. Follow up immediately to convert to order.";
  else if (intentTags.has("procurement_block")) followupReason = "Procurement/compliance blocker detected. Escalate owner and unblock.";
  else if (intentTags.has("pricing_objection")) followupReason = "Pricing objection detected. Follow up with revised value framing.";
  else if (intentTags.has("request_update")) followupReason = "Customer requested a status update. Respond quickly to protect trust.";
  else if (followupNeeded) followupReason = "Inbound message likely needs response.";

  return {
    intentTags: Array.from(intentTags.values()),
    sentiment,
    urgency,
    followupNeeded,
    followupReason,
  };
}

interface WorkspaceProbabilityCalibration {
  sampleSize: number;
  globalWinRatePct: number;
  sentimentAdjustments: Record<"positive" | "neutral" | "negative", number>;
  tagAdjustments: Map<string, number>;
}

function buildWorkspaceProbabilityCalibration(workspaceId: string): WorkspaceProbabilityCalibration {
  const closedQuotes = db.query<{ quote_external_id: string; state: QuoteToOrderState }, [string]>(
    `SELECT quote_external_id, state
     FROM quote_to_order_records
     WHERE workspace_id = ?
       AND state IN ('converted_to_order', 'fulfilled', 'rejected')`
  ).all(workspaceId);
  const outcomeByQuote = new Map<string, boolean>();
  for (const row of closedQuotes) {
    outcomeByQuote.set(row.quote_external_id, row.state === "converted_to_order" || row.state === "fulfilled");
  }

  const events = db.query<{ quote_external_id: string; sentiment: "positive" | "neutral" | "negative"; intent_tags_json: string }, [string]>(
    `SELECT quote_external_id, sentiment, intent_tags_json
     FROM quote_communication_events
     WHERE workspace_id = ?
     ORDER BY occurred_at DESC`
  ).all(workspaceId);

  let total = 0;
  let wins = 0;
  const sentimentStats: Record<"positive" | "neutral" | "negative", { total: number; wins: number }> = {
    positive: { total: 0, wins: 0 },
    neutral: { total: 0, wins: 0 },
    negative: { total: 0, wins: 0 },
  };
  const tagStats = new Map<string, { total: number; wins: number }>();
  for (const event of events) {
    const won = outcomeByQuote.get(event.quote_external_id);
    if (won === undefined) continue;
    total += 1;
    if (won) wins += 1;
    sentimentStats[event.sentiment].total += 1;
    if (won) sentimentStats[event.sentiment].wins += 1;
    const tags = new Set(parseIntentTags(event.intent_tags_json));
    for (const tag of tags) {
      const current = tagStats.get(tag) ?? { total: 0, wins: 0 };
      current.total += 1;
      if (won) current.wins += 1;
      tagStats.set(tag, current);
    }
  }

  const globalRate = total > 0 ? (wins / total) : 0.45;
  const sampleScale = total >= 20 ? 1 : total >= 10 ? 0.7 : total >= 5 ? 0.4 : 0.2;
  const sentimentAdjustments: Record<"positive" | "neutral" | "negative", number> = {
    positive: 0,
    neutral: 0,
    negative: 0,
  };
  for (const sentiment of ["positive", "neutral", "negative"] as const) {
    const bucket = sentimentStats[sentiment];
    if (bucket.total < 3) continue;
    const rate = bucket.wins / bucket.total;
    sentimentAdjustments[sentiment] = Number(((rate - globalRate) * 35 * sampleScale).toFixed(2));
  }
  const tagAdjustments = new Map<string, number>();
  for (const [tag, bucket] of tagStats.entries()) {
    if (bucket.total < 3) continue;
    const rate = bucket.wins / bucket.total;
    const delta = Number(((rate - globalRate) * 28 * sampleScale).toFixed(2));
    if (Math.abs(delta) >= 0.5) {
      tagAdjustments.set(tag, delta);
    }
  }

  return {
    sampleSize: total,
    globalWinRatePct: Number((globalRate * 100).toFixed(1)),
    sentimentAdjustments,
    tagAdjustments,
  };
}

function applyWorkspaceProbabilityCalibration(
  score: number,
  sentiment: "positive" | "neutral" | "negative",
  intentTags: string[],
  calibration: WorkspaceProbabilityCalibration | null,
): number {
  if (!calibration || calibration.sampleSize < 3) return score;
  let adjusted = score + calibration.sentimentAdjustments[sentiment];
  for (const tag of intentTags) {
    const delta = calibration.tagAdjustments.get(tag);
    if (delta !== undefined) adjusted += delta;
  }
  return adjusted;
}

function estimateDealProbabilityPct(
  state: QuoteToOrderState | undefined,
  amount: number,
  sentiment: "positive" | "neutral" | "negative",
  intentTags: string[],
  workspaceId?: string,
): number {
  const stateBase: Record<QuoteToOrderState, number> = {
    draft: 20,
    submitted: 45,
    approved: 70,
    rejected: 5,
    converted_to_order: 90,
    fulfilled: 100,
  };
  let score = state ? stateBase[state] : 35;
  if (sentiment === "positive") score += 15;
  if (sentiment === "negative") score -= 20;
  if (intentTags.includes("ready_to_buy")) score += 20;
  if (intentTags.includes("pricing_objection")) score -= 10;
  if (intentTags.includes("timing_delay")) score -= 15;
  if (intentTags.includes("procurement_block")) score -= 8;
  if (intentTags.includes("no_interest")) score -= 35;
  if (amount >= 10000) score += 3;
  if (amount <= 500) score -= 3;
  if (workspaceId) {
    score = applyWorkspaceProbabilityCalibration(score, sentiment, intentTags, buildWorkspaceProbabilityCalibration(workspaceId));
  }
  if (state === "fulfilled") return 100;
  return Math.max(0, Math.min(99, Math.round(score)));
}

function bumpPriority(priority: QuoteFollowupPriority): QuoteFollowupPriority {
  if (priority === "low") return "normal";
  if (priority === "normal") return "high";
  return "critical";
}

function buildSuggestedFollowup(
  quoteExternalId: string,
  actionType: QuoteFollowupActionType,
  reason: string,
  sentiment: "positive" | "neutral" | "negative",
  dealProbabilityPct: number,
): { subject?: string; message: string } {
  const baseSubject = `Follow-up zu Angebot ${quoteExternalId}`;
  if (actionType === "escalate_owner") {
    return {
      subject: `Escalation: ${quoteExternalId} braucht Owner-Einsatz`,
      message: `Bitte owner-seitig eskalieren: ${reason}\nAktuelle Deal-Wahrscheinlichkeit: ${dealProbabilityPct}%.\nEmpfohlene Aktion: Blocker mit Kunde heute aufloesen.`,
    };
  }
  if (actionType === "call_followup") {
    return {
      subject: `Kurzabstimmung zu ${quoteExternalId}`,
      message: `Hallo,\nkurze Rueckmeldung zu ${quoteExternalId}. ${reason}\nSollen wir heute einen 15-min Termin fuer den naechsten Schritt machen?\n\nViele Gruesse`,
    };
  }
  const tone = sentiment === "negative" ? "Ich moechte offene Punkte schnell klaeren." : "Ich gebe gern ein kurzes Update zum aktuellen Stand.";
  return {
    subject: baseSubject,
    message: `Hallo,\n${tone}\n${reason}\nAktuelle Einschaetzung Deal-Wahrscheinlichkeit: ${dealProbabilityPct}%.\nPasst ein kurzer Slot fuer die naechsten Schritte?\n\nViele Gruesse`,
  };
}

export function ingestQuoteCommunication(
  workspaceIdInput: unknown,
  quoteExternalIdInput: unknown,
  bodyInput: unknown,
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const quoteExternalId = z.string().min(1).parse(quoteExternalIdInput);
  const body = QuoteCommunicationIngestSchema.parse(bodyInput);
  const now = nowIso();
  const occurredAt = body.occurredAt ?? now;
  const idempotencyKey = body.idempotencyKey ?? null;

  if (idempotencyKey) {
    const existing = db.query<QuoteCommunicationEventRow, [string]>(
      `SELECT id, workspace_id, quote_external_id, connector_type, channel, direction, subject, body_text, from_address, to_address,
              external_thread_id, intent_tags_json, sentiment, urgency, followup_needed, followup_reason, estimated_deal_probability_pct, personality_type, personality_confidence, idempotency_key, metadata_json,
              occurred_at, created_at
       FROM quote_communication_events
       WHERE idempotency_key = ?`
    ).get(idempotencyKey);
    if (existing) {
      return { duplicate: true, event: toQuoteCommunicationEvent(existing) };
    }
  }

  const quote = getQ2oRow(workspaceId, quoteExternalId);
  const classified = classifyQuoteCommunication(body.subject ?? "", body.bodyText, body.direction);
  const estimatedDealProbabilityPct = estimateDealProbabilityPct(
    quote?.state,
    num(quote?.amount),
    classified.sentiment,
    classified.intentTags,
    workspaceId,
  );
  const personality = estimateMbtiFromCommunication({
    subject: body.subject ?? "",
    bodyText: body.bodyText,
    direction: body.direction,
    sentiment: classified.sentiment,
    urgency: classified.urgency,
    intentTags: classified.intentTags,
  });
  const enrichedMetadata = {
    ...body.metadata,
    personalityModel: personality.model,
    personalityDimensions: personality.dimensions,
  };

  const id = randomUUID();
  db.run(
    `INSERT INTO quote_communication_events (
       id, workspace_id, quote_external_id, connector_type, channel, direction, subject, body_text, from_address, to_address, external_thread_id,
       intent_tags_json, sentiment, urgency, followup_needed, followup_reason, estimated_deal_probability_pct, personality_type, personality_confidence,
       idempotency_key, metadata_json, occurred_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workspaceId,
      quoteExternalId,
      body.connectorType ?? null,
      body.channel,
      body.direction,
      body.subject ?? null,
      body.bodyText,
      body.fromAddress ?? null,
      body.toAddress ?? null,
      body.externalThreadId ?? null,
      JSON.stringify(classified.intentTags),
      classified.sentiment,
      classified.urgency,
      classified.followupNeeded ? 1 : 0,
      classified.followupReason,
      estimatedDealProbabilityPct,
      personality.type,
      personality.confidence,
      idempotencyKey,
      JSON.stringify(enrichedMetadata),
      occurredAt,
      now,
    ],
  );

  const saved = db.query<QuoteCommunicationEventRow, [string]>(
    `SELECT id, workspace_id, quote_external_id, connector_type, channel, direction, subject, body_text, from_address, to_address,
            external_thread_id, intent_tags_json, sentiment, urgency, followup_needed, followup_reason, estimated_deal_probability_pct, personality_type, personality_confidence, idempotency_key, metadata_json,
            occurred_at, created_at
     FROM quote_communication_events
     WHERE id = ?`
  ).get(id);
  if (!saved) throw new Error("Failed to persist communication event");
  return {
    duplicate: false,
    event: toQuoteCommunicationEvent(saved),
  };
}

export function importQuoteMailboxCommunications(
  workspaceIdInput: unknown,
  bodyInput: unknown,
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const body = QuoteMailboxImportSchema.parse(bodyInput);
  const workspaceDomains = new Set(
    body.workspaceDomains
      .map(normalizeDomain)
      .filter((value) => value.length > 0),
  );
  const defaultConnectorType = chooseDefaultQuoteConnector(body.provider, body.defaultConnectorType);
  const executedAt = nowIso();
  const ingested: Array<Record<string, unknown>> = [];
  const duplicates: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const autoCreatedQuotes = new Set<string>();

  for (const message of body.messages) {
    const quoteExternalId = message.quoteExternalId ?? extractQuoteExternalIdFromText(message.subject ?? "", message.bodyText);
    if (!quoteExternalId) {
      skipped.push({ messageId: message.messageId, reason: "quote_id_not_detected" });
      continue;
    }

    let quote = getQ2oRow(workspaceId, quoteExternalId);
    if (!quote && body.autoCreateSubmittedQuote) {
      if (!defaultConnectorType) {
        skipped.push({ messageId: message.messageId, quoteExternalId, reason: "quote_missing_and_no_default_connector" });
        continue;
      }
      const created = syncQuoteToOrderQuote(workspaceId, {
        connectorType: defaultConnectorType,
        quoteExternalId,
        state: "submitted",
        amount: 0,
        currency: "EUR",
        idempotencyKey: `${buildMailboxIdempotencyKey(body.provider, message.messageId)}:autocreate`,
        payload: {
          source: "mailbox-import",
          provider: body.provider,
          messageId: message.messageId,
        },
      }) as { duplicate?: boolean; record?: QuoteToOrderRecord };
      if (!created.duplicate && created.record) {
        autoCreatedQuotes.add(quoteExternalId);
      }
      quote = getQ2oRow(workspaceId, quoteExternalId);
    }

    if (!quote) {
      skipped.push({ messageId: message.messageId, quoteExternalId, reason: "quote_not_found" });
      continue;
    }

    const direction = inferMailDirection(message.direction, message.fromAddress, message.toAddress, workspaceDomains);
    const occurredAt = message.receivedAt ?? message.sentAt ?? executedAt;
    const idempotencyKey = buildMailboxIdempotencyKey(body.provider, message.messageId);

    const result = ingestQuoteCommunication(workspaceId, quoteExternalId, {
      connectorType: defaultConnectorType ?? quote.source_system,
      channel: "email",
      direction,
      subject: message.subject,
      bodyText: message.bodyText,
      fromAddress: message.fromAddress,
      toAddress: message.toAddress,
      externalThreadId: message.threadId,
      occurredAt,
      idempotencyKey,
      metadata: {
        ...message.metadata,
        mailboxProvider: body.provider,
        mailboxMessageId: message.messageId,
        mailboxThreadId: message.threadId ?? null,
        mailboxImportedAt: executedAt,
      },
    }) as { duplicate: boolean; event?: Record<string, unknown> };

    if (result.duplicate) {
      duplicates.push({ messageId: message.messageId, quoteExternalId });
      continue;
    }
    ingested.push({
      messageId: message.messageId,
      quoteExternalId,
      direction,
      event: result.event ?? null,
    });
  }

  const response: Record<string, unknown> = {
    workspaceId,
    provider: body.provider,
    executedAt,
    requested: body.messages.length,
    ingestedCount: ingested.length,
    duplicateCount: duplicates.length,
    skippedCount: skipped.length,
    autoCreatedQuoteCount: autoCreatedQuotes.size,
    autoCreatedQuotes: Array.from(autoCreatedQuotes.values()),
    ingested,
    duplicates,
    skipped,
  };

  if (body.runFollowupEngine) {
    response.followups = runQuoteFollowupEngine(workspaceId, {
      followupAfterHours: body.followupAfterHours,
      highValueThresholdEur: body.highValueThresholdEur,
      assignedTo: body.assignedTo,
      now: body.now,
    });
  }

  return response;
}

export async function pullQuoteMailboxCommunications(
  workspaceIdInput: unknown,
  bodyInput: unknown,
): Promise<Record<string, unknown>> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const body = QuoteMailboxPullSchema.parse(bodyInput);
  const resolvedToken = await resolveMailboxAccessToken({
    workspaceId,
    provider: body.provider,
    userId: body.userId,
    providedAccessToken: body.accessToken,
    useStoredConnection: body.useStoredConnection,
  });
  const pulled = body.provider === "gmail"
    ? await pullGmailMessages({
      accessToken: resolvedToken.accessToken,
      userId: resolvedToken.userId,
      limit: body.limit,
      query: body.query,
      since: body.since,
    })
    : await pullOutlookMessages({
      accessToken: resolvedToken.accessToken,
      userId: resolvedToken.userId,
      folder: body.folder,
      limit: body.limit,
      since: body.since,
    });

  const importPayload = {
    provider: body.provider,
    workspaceDomains: body.workspaceDomains,
    defaultConnectorType: body.defaultConnectorType,
    autoCreateSubmittedQuote: body.autoCreateSubmittedQuote,
    runFollowupEngine: body.runFollowupEngine,
    followupAfterHours: body.followupAfterHours,
    highValueThresholdEur: body.highValueThresholdEur,
    assignedTo: body.assignedTo,
    now: body.now,
    messages: pulled.map((msg) => ({
      ...msg,
      direction: undefined,
      metadata: {
        ...msg.metadata,
        source: "mailbox-pull",
      },
    })),
  };

  const imported = importQuoteMailboxCommunications(workspaceId, importPayload);
  return {
    workspaceId,
    provider: body.provider,
    userId: resolvedToken.userId,
    tokenSource: resolvedToken.source,
    mailboxConnectionId: resolvedToken.connectionId ?? null,
    pulledCount: pulled.length,
    requestedLimit: body.limit,
    since: body.since ?? null,
    import: imported,
  };
}

export function runQuoteFollowupEngine(workspaceIdInput: unknown, bodyInput: unknown = {}): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const body = QuoteFollowupRunSchema.parse(bodyInput);
  const now = body.now ? new Date(body.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Invalid now timestamp");
  const nowIsoValue = now.toISOString();
  const nowMs = now.getTime();

  const placeholders = body.includeStates.map(() => "?").join(", ");
  const records = db.query<QuoteToOrderRecordRow, unknown[]>(
    `SELECT id, workspace_id, source_system, quote_external_id, order_external_id, approval_external_id, customer_external_id, state, amount, currency,
            external_id, sync_state, last_synced_at, last_sync_error, conflict_marker, payload_json, approval_deadline_at, approval_decided_at,
            conversion_deadline_at, converted_at, fulfilled_at, version, created_at, updated_at
     FROM quote_to_order_records
     WHERE workspace_id = ? AND state IN (${placeholders})
     ORDER BY updated_at ASC
     LIMIT ?`
  ).all(workspaceId, ...body.includeStates, body.maxActions * 4);

  const created: Array<Record<string, unknown>> = [];
  const skipped: Array<{ quoteExternalId: string; reason: string }> = [];

  for (const row of records) {
    if (created.length >= body.maxActions) break;

    const existingAction = db.query<{ id: string }, [string, string]>(
      `SELECT id
       FROM quote_followup_actions
       WHERE workspace_id = ? AND quote_external_id = ? AND status IN ('open', 'sent')
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(workspaceId, row.quote_external_id);
    if (existingAction) {
      skipped.push({ quoteExternalId: row.quote_external_id, reason: "open_action_exists" });
      continue;
    }

    const latestEvent = db.query<QuoteCommunicationEventRow, [string, string]>(
      `SELECT id, workspace_id, quote_external_id, connector_type, channel, direction, subject, body_text, from_address, to_address,
              external_thread_id, intent_tags_json, sentiment, urgency, followup_needed, followup_reason, estimated_deal_probability_pct, personality_type, personality_confidence, idempotency_key, metadata_json,
              occurred_at, created_at
       FROM quote_communication_events
       WHERE workspace_id = ? AND quote_external_id = ?
       ORDER BY occurred_at DESC
       LIMIT 1`
    ).get(workspaceId, row.quote_external_id);

    const touchCandidates = [row.updated_at, row.last_synced_at, row.created_at, latestEvent?.occurred_at].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const lastTouchAt = touchCandidates
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0];
    const hoursSinceTouch = Number.isFinite(lastTouchAt)
      ? (nowMs - (lastTouchAt as number)) / (1000 * 60 * 60)
      : Number.POSITIVE_INFINITY;
    if (hoursSinceTouch < body.followupAfterHours) {
      skipped.push({ quoteExternalId: row.quote_external_id, reason: "not_stale" });
      continue;
    }

    const intentTags = latestEvent ? parseIntentTags(latestEvent.intent_tags_json) : [];
    const sentiment = latestEvent?.sentiment ?? "neutral";
    const baseProbability = latestEvent?.estimated_deal_probability_pct ?? estimateDealProbabilityPct(
      row.state,
      row.amount,
      sentiment,
      intentTags,
      workspaceId,
    );

    let actionType: QuoteFollowupActionType = "email_followup";
    let priority: QuoteFollowupPriority = "normal";
    let reason = `Quote ${row.quote_external_id} has no meaningful touchpoint for ${Math.round(hoursSinceTouch)}h.`;

    if (intentTags.includes("procurement_block")) {
      actionType = "escalate_owner";
      priority = "high";
      reason = "Procurement/compliance blocker detected in communication. Owner escalation required.";
    } else if (intentTags.includes("pricing_objection") || sentiment === "negative") {
      actionType = "call_followup";
      priority = "high";
      reason = "Negative buying signal detected. Human follow-up call recommended.";
    } else if (intentTags.includes("ready_to_buy")) {
      actionType = "call_followup";
      priority = "critical";
      reason = "Buyer appears ready to buy. Immediate conversion follow-up required.";
    }

    if (row.amount >= body.highValueThresholdEur && priority !== "critical") {
      priority = bumpPriority(priority);
    }
    if (hoursSinceTouch >= body.followupAfterHours * 2 && priority !== "critical") {
      priority = bumpPriority(priority);
    }

    const dueHours = priority === "critical" ? 1 : priority === "high" ? 4 : priority === "normal" ? 24 : 48;
    const dueAt = new Date(nowMs + dueHours * 60 * 60 * 1000).toISOString();
    const suggestion = buildSuggestedFollowup(row.quote_external_id, actionType, reason, sentiment, baseProbability);
    const id = randomUUID();

    db.run(
      `INSERT INTO quote_followup_actions (
         id, workspace_id, quote_external_id, source_event_id, action_type, priority, status, reason, suggested_subject, suggested_message,
         assigned_to, due_at, note, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [
        id,
        workspaceId,
        row.quote_external_id,
        latestEvent?.id ?? null,
        actionType,
        priority,
        reason,
        suggestion.subject ?? null,
        suggestion.message,
        body.assignedTo ?? null,
        dueAt,
        nowIsoValue,
        nowIsoValue,
      ],
    );

    const saved = db.query<QuoteFollowupActionRow, [string]>(
      `SELECT id, workspace_id, quote_external_id, source_event_id, action_type, priority, status, reason, suggested_subject, suggested_message,
              assigned_to, due_at, note, last_error, writeback_run_id, writeback_connector, writeback_status, writeback_synced_at, writeback_error, created_at, updated_at
       FROM quote_followup_actions WHERE id = ?`
    ).get(id);
    if (!saved) throw new Error("Failed to persist follow-up action");
    created.push({
      ...toQuoteFollowupAction(saved),
      estimatedDealProbabilityPct: baseProbability,
      staleHours: Number(hoursSinceTouch.toFixed(1)),
    });
  }

  return {
    workspaceId,
    executedAt: nowIsoValue,
    createdCount: created.length,
    skippedCount: skipped.length,
    created,
    skipped,
  };
}

export function listQuoteFollowupActions(workspaceIdInput: unknown, filtersInput: unknown = {}): { items: Array<Record<string, unknown>> } {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const filters = QuoteFollowupListSchema.parse(filtersInput);
  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  if (filters.actionType) {
    where.push("action_type = ?");
    params.push(filters.actionType);
  }
  params.push(filters.limit);
  const rows = db.query<QuoteFollowupActionRow, unknown[]>(
    `SELECT id, workspace_id, quote_external_id, source_event_id, action_type, priority, status, reason, suggested_subject, suggested_message,
            assigned_to, due_at, note, last_error, writeback_run_id, writeback_connector, writeback_status, writeback_synced_at, writeback_error, created_at, updated_at
     FROM quote_followup_actions
     WHERE ${where.join(" AND ")}
     ORDER BY due_at ASC, created_at DESC
     LIMIT ?`
  ).all(...params);
  return { items: rows.map(toQuoteFollowupAction) };
}

export function updateQuoteFollowupAction(
  workspaceIdInput: unknown,
  actionIdInput: unknown,
  bodyInput: unknown,
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const actionId = z.string().min(1).parse(actionIdInput);
  const body = QuoteFollowupUpdateSchema.parse(bodyInput);
  const now = nowIso();
  const existing = db.query<QuoteFollowupActionRow, [string, string]>(
    `SELECT id, workspace_id, quote_external_id, source_event_id, action_type, priority, status, reason, suggested_subject, suggested_message,
            assigned_to, due_at, note, last_error, writeback_run_id, writeback_connector, writeback_status, writeback_synced_at, writeback_error, created_at, updated_at
     FROM quote_followup_actions
     WHERE workspace_id = ? AND id = ?`
  ).get(workspaceId, actionId);
  if (!existing) throw new Error(`Follow-up action '${actionId}' not found for workspace '${workspaceId}'`);

  db.run(
    `UPDATE quote_followup_actions
     SET status = ?, note = COALESCE(?, note), last_error = ?, updated_at = ?
     WHERE id = ?`,
    [body.status, body.note ?? null, body.lastError ?? null, now, actionId],
  );
  const updated = db.query<QuoteFollowupActionRow, [string]>(
    `SELECT id, workspace_id, quote_external_id, source_event_id, action_type, priority, status, reason, suggested_subject, suggested_message,
            assigned_to, due_at, note, last_error, writeback_run_id, writeback_connector, writeback_status, writeback_synced_at, writeback_error, created_at, updated_at
     FROM quote_followup_actions WHERE id = ?`
  ).get(actionId);
  if (!updated) throw new Error("Failed to update follow-up action");
  return toQuoteFollowupAction(updated);
}

function getQuoteFollowupActionRow(workspaceId: string, actionId: string): QuoteFollowupActionRow | null {
  return db.query<QuoteFollowupActionRow, [string, string]>(
    `SELECT id, workspace_id, quote_external_id, source_event_id, action_type, priority, status, reason, suggested_subject, suggested_message,
            assigned_to, due_at, note, last_error, writeback_run_id, writeback_connector, writeback_status, writeback_synced_at, writeback_error, created_at, updated_at
     FROM quote_followup_actions
     WHERE workspace_id = ? AND id = ?`
  ).get(workspaceId, actionId) ?? null;
}

function mergeFollowupNote(existing: string | null, incoming: string | undefined): string | null {
  if (!incoming || incoming.trim().length === 0) return existing;
  if (!existing || existing.trim().length === 0) return incoming.trim();
  if (existing.includes(incoming.trim())) return existing;
  return `${existing}\n${incoming.trim()}`;
}

export async function writebackQuoteFollowupAction(
  workspaceIdInput: unknown,
  actionIdInput: unknown,
  bodyInput: unknown = {},
): Promise<Record<string, unknown>> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const actionId = z.string().min(1).parse(actionIdInput);
  const body = QuoteFollowupWritebackSchema.parse(bodyInput);

  const action = getQuoteFollowupActionRow(workspaceId, actionId);
  if (!action) throw new Error(`Follow-up action '${actionId}' not found for workspace '${workspaceId}'`);
  const quote = getQ2oRow(workspaceId, action.quote_external_id);
  if (!quote) throw new Error(`Quote '${action.quote_external_id}' not found for workspace '${workspaceId}'`);

  const connectorType = body.connectorType ?? quote.source_system;
  const sourceEvent = action.source_event_id
    ? db.query<QuoteCommunicationEventRow, [string, string, string]>(
      `SELECT id, workspace_id, quote_external_id, connector_type, channel, direction, subject, body_text, from_address, to_address,
              external_thread_id, intent_tags_json, sentiment, urgency, followup_needed, followup_reason, estimated_deal_probability_pct, personality_type, personality_confidence, idempotency_key, metadata_json,
              occurred_at, created_at
       FROM quote_communication_events
       WHERE workspace_id = ? AND quote_external_id = ? AND id = ?`
    ).get(workspaceId, action.quote_external_id, action.source_event_id)
    : null;

  const activityPayload = {
    workspaceId,
    followupActionId: action.id,
    quoteExternalId: action.quote_external_id,
    orderExternalId: quote.order_external_id,
    actionType: action.action_type,
    priority: action.priority,
    status: action.status,
    reason: action.reason,
    dueAt: action.due_at,
    assignedTo: body.assignedTo ?? action.assigned_to ?? null,
    suggestedSubject: action.suggested_subject,
    suggestedMessage: action.suggested_message,
    note: body.note ?? action.note ?? null,
    sourceSystem: quote.source_system,
    sourceEvent: sourceEvent ? {
      id: sourceEvent.id,
      sentiment: sourceEvent.sentiment,
      urgency: sourceEvent.urgency,
      intentTags: parseIntentTags(sourceEvent.intent_tags_json),
      occurredAt: sourceEvent.occurred_at,
      fromAddress: sourceEvent.from_address,
      toAddress: sourceEvent.to_address,
    } : null,
    traceability: {
      source_system: connectorType,
      external_id: action.quote_external_id,
      sync_state: "pending",
      last_synced_at: null,
      last_sync_error: null,
    },
  } satisfies Record<string, unknown>;

  const idempotencyKey = body.idempotencyKey ?? `followup-writeback:${workspaceId}:${action.id}:${connectorType}`;
  let syncResult: ConnectorSyncResult;
  try {
    syncResult = await syncConnector(connectorType, {
      direction: "writeback",
      entityType: "activity",
      externalId: body.externalId,
      idempotencyKey,
      payload: activityPayload,
      maxRetries: body.maxRetries,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.run(
      `UPDATE quote_followup_actions
       SET writeback_connector = ?, writeback_status = 'failed', writeback_synced_at = NULL, writeback_error = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [connectorType, message, message, nowIso(), action.id],
    );
    throw err;
  }

  const mergedNote = mergeFollowupNote(action.note, body.note);
  const updatedAt = nowIso();
  if (syncResult.status === "success") {
    db.run(
      `UPDATE quote_followup_actions
       SET status = ?, assigned_to = COALESCE(?, assigned_to), note = ?, last_error = NULL,
           writeback_run_id = ?, writeback_connector = ?, writeback_status = 'success', writeback_synced_at = ?, writeback_error = NULL, updated_at = ?
       WHERE id = ?`,
      [
        body.statusOnSuccess,
        body.assignedTo ?? null,
        mergedNote,
        syncResult.runId,
        connectorType,
        syncResult.entity.last_synced_at ?? updatedAt,
        updatedAt,
        action.id,
      ],
    );
  } else {
    const error = syncResult.error ?? "Unknown writeback failure";
    db.run(
      `UPDATE quote_followup_actions
       SET assigned_to = COALESCE(?, assigned_to), note = ?, last_error = ?, writeback_run_id = ?, writeback_connector = ?,
           writeback_status = 'failed', writeback_synced_at = NULL, writeback_error = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.assignedTo ?? null,
        mergedNote,
        error,
        syncResult.runId,
        connectorType,
        error,
        updatedAt,
        action.id,
      ],
    );
  }

  const updated = getQuoteFollowupActionRow(workspaceId, action.id);
  if (!updated) throw new Error("Failed to load updated follow-up action after writeback");
  return {
    action: toQuoteFollowupAction(updated),
    writeback: {
      connectorType,
      status: syncResult.status,
      runId: syncResult.runId,
      syncedAt: syncResult.entity.last_synced_at,
      error: syncResult.error ?? null,
      idempotencyKey: syncResult.idempotencyKey,
    },
    sync: syncResult,
  };
}

export async function writebackQuoteFollowupBatch(
  workspaceIdInput: unknown,
  bodyInput: unknown = {},
): Promise<Record<string, unknown>> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const body = QuoteFollowupWritebackBatchSchema.parse(bodyInput);
  const where: string[] = ["workspace_id = ?", "status = ?"];
  const params: unknown[] = [workspaceId, body.status];
  if (body.actionType) {
    where.push("action_type = ?");
    params.push(body.actionType);
  }
  params.push(body.limit);
  const actionIds = db.query<{ id: string }, unknown[]>(
    `SELECT id
     FROM quote_followup_actions
     WHERE ${where.join(" AND ")}
     ORDER BY due_at ASC, created_at ASC
     LIMIT ?`
  ).all(...params);

  const processed: Array<Record<string, unknown>> = [];
  const failed: Array<{ actionId: string; error: string }> = [];
  for (const row of actionIds) {
    try {
      const result = await writebackQuoteFollowupAction(workspaceId, row.id, {
        connectorType: body.connectorType,
        statusOnSuccess: body.statusOnSuccess,
        assignedTo: body.assignedTo,
        maxRetries: body.maxRetries,
      });
      processed.push(result);
    } catch (err) {
      failed.push({
        actionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    workspaceId,
    requested: actionIds.length,
    processedCount: processed.length,
    failedCount: failed.length,
    processed,
    failed,
  };
}

export async function runScheduledFollowupWritebacks(input: {
  workspaceId?: string;
  limitPerWorkspace?: number;
  connectorType?: ConnectorType;
  assignedTo?: string;
  statusOnSuccess?: "open" | "sent" | "done";
  maxRetries?: number;
} = {}): Promise<Record<string, unknown>> {
  const limitPerWorkspace = Math.max(1, Math.min(100, input.limitPerWorkspace ?? 20));
  const workspaceRows = input.workspaceId
    ? [{ workspace_id: input.workspaceId }]
    : db.query<{ workspace_id: string }, []>(
      `SELECT DISTINCT workspace_id
       FROM quote_followup_actions
       WHERE status = 'open'
       ORDER BY workspace_id ASC`
    ).all();

  const results: Array<Record<string, unknown>> = [];
  let processedCount = 0;
  let failedCount = 0;

  for (const row of workspaceRows) {
    const workspaceId = row.workspace_id;
    try {
      const outcome = await writebackQuoteFollowupBatch(workspaceId, {
        status: "open",
        limit: limitPerWorkspace,
        connectorType: input.connectorType,
        statusOnSuccess: input.statusOnSuccess ?? "sent",
        assignedTo: input.assignedTo,
        maxRetries: input.maxRetries ?? 2,
      }) as { processedCount: number; failedCount: number };
      results.push({ workspaceId, ...outcome });
      processedCount += outcome.processedCount;
      failedCount += outcome.failedCount;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failedCount += 1;
      results.push({ workspaceId, error: message });
    }
  }

  return {
    scheduledAt: nowIso(),
    workspaceCount: workspaceRows.length,
    processedCount,
    failedCount,
    results,
  };
}

export function getQuotePersonalityInsights(
  workspaceIdInput: unknown,
  filtersInput: unknown = {},
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const filters = QuotePersonalityInsightSchema.parse(filtersInput);
  const where: string[] = [
    "workspace_id = ?",
    "personality_type IS NOT NULL",
    "personality_confidence IS NOT NULL",
    "personality_confidence >= ?",
  ];
  const params: unknown[] = [workspaceId, filters.minConfidence];
  if (filters.since) {
    where.push("occurred_at >= ?");
    params.push(filters.since);
  }
  if (filters.quoteExternalId) {
    where.push("quote_external_id = ?");
    params.push(filters.quoteExternalId);
  }
  const sampleLimit = filters.quoteExternalId
    ? Math.max(filters.limit, 100)
    : Math.min(4000, Math.max(filters.limit * 20, 400));
  params.push(sampleLimit);

  const rows = db.query<{
    quote_external_id: string;
    personality_type: string | null;
    personality_confidence: number | null;
    occurred_at: string;
    metadata_json: string;
    subject: string | null;
    body_text: string;
    sentiment: "positive" | "neutral" | "negative";
    urgency: "low" | "normal" | "high";
  }, unknown[]>(
    `SELECT quote_external_id, personality_type, personality_confidence, occurred_at, metadata_json, subject, body_text, sentiment, urgency
     FROM quote_communication_events
     WHERE ${where.join(" AND ")}
     ORDER BY occurred_at DESC
     LIMIT ?`
  ).all(...params);

  const latestByQuote = new Map<string, {
    type: string;
    confidence: number;
    occurredAt: string;
    metadata: Record<string, unknown>;
    subject: string;
    snippet: string;
    sentiment: "positive" | "neutral" | "negative";
    urgency: "low" | "normal" | "high";
  }>();
  for (const row of rows) {
    if (!row.personality_type || row.personality_type.length !== 4) continue;
    if (latestByQuote.has(row.quote_external_id)) continue;
    const metadata = parseMetadata(row.metadata_json);
    latestByQuote.set(row.quote_external_id, {
      type: row.personality_type,
      confidence: Number(num(row.personality_confidence).toFixed(3)),
      occurredAt: row.occurred_at,
      metadata,
      subject: row.subject ?? "",
      snippet: row.body_text.slice(0, 220),
      sentiment: row.sentiment,
      urgency: row.urgency,
    });
  }

  const profiles = Array.from(latestByQuote.entries())
    .map(([quoteExternalId, value]) => ({
      quoteExternalId,
      personalityType: value.type,
      confidence: value.confidence,
      occurredAt: value.occurredAt,
      explanation: {
        model: value.metadata.personalityModel ?? "heuristic_mbti_v1",
        dimensions: value.metadata.personalityDimensions ?? {},
        evidence: {
          subject: value.subject,
          snippet: value.snippet,
          sentiment: value.sentiment,
          urgency: value.urgency,
        },
      },
    }))
    .sort((a, b) => b.confidence - a.confidence);

  const distributionCounts = new Map<string, number>();
  for (const profile of profiles) {
    distributionCounts.set(profile.personalityType, (distributionCounts.get(profile.personalityType) ?? 0) + 1);
  }
  const distribution = Array.from(distributionCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({
      type,
      count,
      sharePct: Number(((count / Math.max(1, profiles.length)) * 100).toFixed(1)),
    }));
  const dominantType = distribution.length > 0 ? distribution[0].type : null;
  const averageConfidence = profiles.length > 0
    ? Number((profiles.reduce((acc, profile) => acc + profile.confidence, 0) / profiles.length).toFixed(3))
    : 0;
  const trendByDay = new Map<string, { total: number; confidenceSum: number }>();
  for (const profile of profiles) {
    const day = profile.occurredAt.slice(0, 10);
    const current = trendByDay.get(day) ?? { total: 0, confidenceSum: 0 };
    current.total += 1;
    current.confidenceSum += profile.confidence;
    trendByDay.set(day, current);
  }
  const trend = Array.from(trendByDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, stat]) => ({
      day,
      samples: stat.total,
      averageConfidence: Number((stat.confidenceSum / Math.max(1, stat.total)).toFixed(3)),
    }));

  const stylePlaybook: Record<string, string> = {
    ENTJ: "Lead with ROI, milestones, and decision windows. Keep updates concise and action-driven.",
    ENTP: "Offer options and strategic upside. Frame experiments with clear expected outcomes.",
    ENFJ: "Connect next steps to stakeholder alignment and customer impact. Keep tone collaborative.",
    ENFP: "Use vision-oriented framing and flexible options. Keep momentum with short iterations.",
    ESTJ: "Provide concrete status, ownership, and deadlines. Show operational control and risk handling.",
    ESTP: "Keep communication practical and fast. Emphasize immediate wins and quick decisions.",
    ESFJ: "Prioritize clarity, support, and reliable follow-up. Confirm expectations and commitments.",
    ESFP: "Use direct, warm communication and concrete quick wins. Keep process lightweight.",
    INTJ: "Provide strategic rationale plus structured execution plan. Avoid unnecessary noise.",
    INTP: "Share clear logic, assumptions, and trade-offs. Offer space for technical scrutiny.",
    INFJ: "Frame decisions around long-term fit and trust. Use structured but empathetic updates.",
    INFP: "Respect values and relationship context. Keep messaging thoughtful and non-pushy.",
    ISTJ: "Send precise facts, dependencies, and due dates. Focus on reliability and correctness.",
    ISTP: "Keep it concise and solution-first. Highlight practical unblock paths.",
    ISFJ: "Provide predictable cadence and clear responsibilities. Reduce uncertainty proactively.",
    ISFP: "Use clear and respectful updates with optional paths. Avoid heavy process pressure.",
  };

  return {
    workspaceId,
    timeframe: { since: filters.since ?? "all_time" },
    model: "heuristic_mbti_v1",
    sampledEvents: rows.length,
    sampledQuotes: profiles.length,
    dominantType,
    averageConfidence,
    distribution,
    trend,
    profiles: profiles.slice(0, filters.limit),
    communicationPlaybook: dominantType ? (stylePlaybook[dominantType] ?? "Use concise, respectful, and value-focused follow-up communication.") : null,
  };
}

export function getQuoteCommunicationAnalytics(
  workspaceIdInput: unknown,
  filtersInput: unknown = {},
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const filters = QuoteCommunicationAnalyticsSchema.parse(filtersInput);
  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (filters.since) {
    where.push("occurred_at >= ?");
    params.push(filters.since);
  }
  const clause = `WHERE ${where.join(" AND ")}`;

  const totals = db.query<{
    total: number;
    inbound: number;
    outbound: number;
    followupSignals: number;
    positive: number;
    neutral: number;
    negative: number;
    avgDealProbability: number | null;
  }, unknown[]>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
       SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound,
       SUM(CASE WHEN followup_needed = 1 THEN 1 ELSE 0 END) as followupSignals,
       SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
       SUM(CASE WHEN sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral,
       SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) as negative,
       AVG(estimated_deal_probability_pct) as avgDealProbability
     FROM quote_communication_events
     ${clause}`
  ).get(...params);

  const actionRows = db.query<{ status: QuoteFollowupStatus; cnt: number }, [string]>(
    `SELECT status, COUNT(*) as cnt
     FROM quote_followup_actions
     WHERE workspace_id = ?
     GROUP BY status`
  ).all(workspaceId);
  const actionsByStatus: Record<QuoteFollowupStatus, number> = { open: 0, sent: 0, done: 0, dismissed: 0 };
  for (const row of actionRows) actionsByStatus[row.status] = row.cnt;

  const timelineRows = db.query<{ quote_external_id: string; direction: QuoteCommunicationDirection; occurred_at: string }, unknown[]>(
    `SELECT quote_external_id, direction, occurred_at
     FROM quote_communication_events
     ${clause}
     ORDER BY quote_external_id ASC, occurred_at ASC`
  ).all(...params);
  const pendingInboundByQuote = new Map<string, number>();
  const responseMinutes: number[] = [];
  for (const row of timelineRows) {
    const occurredMs = Date.parse(row.occurred_at);
    if (!Number.isFinite(occurredMs)) continue;
    if (row.direction === "inbound") {
      pendingInboundByQuote.set(row.quote_external_id, occurredMs);
      continue;
    }
    const inboundMs = pendingInboundByQuote.get(row.quote_external_id);
    if (inboundMs !== undefined && occurredMs >= inboundMs) {
      responseMinutes.push((occurredMs - inboundMs) / (60 * 1000));
      pendingInboundByQuote.delete(row.quote_external_id);
    }
  }

  const latestByQuote = new Map<string, number>();
  const latestRows = db.query<{ quote_external_id: string; estimated_deal_probability_pct: number | null }, [string]>(
    `SELECT quote_external_id, estimated_deal_probability_pct
     FROM quote_communication_events
     WHERE workspace_id = ?
     ORDER BY occurred_at DESC`
  ).all(workspaceId);
  for (const row of latestRows) {
    if (latestByQuote.has(row.quote_external_id)) continue;
    latestByQuote.set(row.quote_external_id, num(row.estimated_deal_probability_pct));
  }
  let highConfidenceQuotes = 0;
  let atRiskQuotes = 0;
  for (const probability of latestByQuote.values()) {
    if (probability >= 70) highConfidenceQuotes += 1;
    if (probability <= 40) atRiskQuotes += 1;
  }
  const calibration = buildWorkspaceProbabilityCalibration(workspaceId);

  const thresholdTs = new Date(Date.now() - filters.stagnationHours * 60 * 60 * 1000).toISOString();
  const stale = db.query<{ cnt: number }, [string, string]>(
    `SELECT COUNT(*) as cnt
     FROM quote_to_order_records r
     LEFT JOIN (
       SELECT workspace_id, quote_external_id, MAX(occurred_at) as last_comm
       FROM quote_communication_events
       GROUP BY workspace_id, quote_external_id
     ) c
       ON c.workspace_id = r.workspace_id AND c.quote_external_id = r.quote_external_id
     WHERE r.workspace_id = ?
       AND r.state IN ('submitted', 'approved')
       AND COALESCE(c.last_comm, r.updated_at, r.created_at) < ?`
  ).get(workspaceId, thresholdTs);
  const personality = getQuotePersonalityInsights(workspaceId, {
    since: filters.since,
    limit: 50,
    minConfidence: 0.35,
  });

  return {
    workspaceId,
    timeframe: { since: filters.since ?? "all_time" },
    communication: {
      totalEvents: num(totals?.total),
      inbound: num(totals?.inbound),
      outbound: num(totals?.outbound),
      followupSignals: num(totals?.followupSignals),
      sentiment: {
        positive: num(totals?.positive),
        neutral: num(totals?.neutral),
        negative: num(totals?.negative),
      },
      medianFirstResponseMinutes: median(responseMinutes.filter((v) => v >= 0)),
    },
    dealProbability: {
      averagePct: Number(num(totals?.avgDealProbability).toFixed(1)),
      highConfidenceQuotes,
      atRiskQuotes,
      sampledQuotes: latestByQuote.size,
      scoringModel: "heuristic+workspace_calibration_v1",
      calibrationSampleSize: calibration.sampleSize,
      calibrationGlobalWinRatePct: calibration.globalWinRatePct,
    },
    followups: {
      byStatus: actionsByStatus,
      staleQuotesBeyondThreshold: num(stale?.cnt),
      stagnationHours: filters.stagnationHours,
    },
    personality,
  };
}

function normalizeGraphToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._:@-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function revenueGraphKey(entityType: RevenueGraphEntityType, entityId: string): string {
  return `${entityType}:${normalizeGraphToken(entityId)}`;
}

function canonicalIdentity(
  entityType: RevenueGraphEntityType,
  sourceSystem: ConnectorType | null,
  externalId: string | null,
  attrs: Record<string, unknown>,
): string {
  if (entityType === "contact") {
    const email = typeof attrs.email === "string" ? attrs.email.trim().toLowerCase() : "";
    if (email.length > 0) return `contact:${email}`;
  }
  if (entityType === "account") {
    const accountCode = typeof attrs.accountCode === "string" ? attrs.accountCode : "";
    if (accountCode.length > 0) return `account:${normalizeGraphToken(accountCode)}`;
    const name = typeof attrs.name === "string" ? attrs.name : "";
    if (name.length > 0) return `account:${normalizeGraphToken(name)}`;
  }
  if (externalId && externalId.length > 0) return `${entityType}:${normalizeGraphToken(externalId)}`;
  const system = sourceSystem ?? "unknown";
  return `${entityType}:${system}:${Bun.hash(JSON.stringify(attrs)).toString(16)}`;
}

function mergeJsonArrayUnique<T>(currentRaw: string, incoming: T[]): T[] {
  const current = Array.isArray(parseMetadata(currentRaw)) ? (parseMetadata(currentRaw) as T[]) : [];
  const seen = new Set(current.map((item) => JSON.stringify(item)));
  const merged = [...current];
  for (const item of incoming) {
    const signature = JSON.stringify(item);
    if (!seen.has(signature)) {
      seen.add(signature);
      merged.push(item);
    }
  }
  return merged;
}

function toRevenueGraphEntity(row: RevenueGraphEntityRow): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    entityType: row.entity_type,
    entityKey: row.entity_key,
    canonicalId: row.canonical_id,
    sourceSystem: row.source_system ?? undefined,
    externalId: row.external_id ?? undefined,
    sourceRefs: Array.isArray(parseMetadata(row.source_refs_json)) ? parseMetadata(row.source_refs_json) : [],
    attributes: parseMetadata(row.attributes_json),
    mappingVersion: row.mapping_version,
    syncState: row.sync_state,
    lastSyncedAt: row.last_synced_at ?? undefined,
    lastSyncError: row.last_sync_error ?? undefined,
    schemaHash: row.schema_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function upsertRevenueGraphEntity(input: {
  workspaceId: string;
  entityType: RevenueGraphEntityType;
  entityKey: string;
  sourceSystem?: ConnectorType | null;
  externalId?: string | null;
  sourceRef?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  mappingVersion?: number;
  syncState?: "success" | "failed" | "conflict";
  lastSyncError?: string | null;
}): void {
  const now = nowIso();
  const existing = db.query<RevenueGraphEntityRow, [string, RevenueGraphEntityType, string]>(
    `SELECT id, workspace_id, entity_type, entity_key, canonical_id, source_system, external_id, source_refs_json, attributes_json,
            mapping_version, sync_state, last_synced_at, last_sync_error, schema_hash, created_at, updated_at
     FROM revenue_graph_entities
     WHERE workspace_id = ? AND entity_type = ? AND entity_key = ?`
  ).get(input.workspaceId, input.entityType, input.entityKey);
  const attributes = input.attributes ?? {};
  const canonicalId = canonicalIdentity(input.entityType, input.sourceSystem ?? null, input.externalId ?? null, attributes);
  const sourceRefs = input.sourceRef ? [input.sourceRef] : [];
  const schemaHash = Bun.hash(Object.keys(attributes).sort().join("|")).toString(16);

  if (!existing) {
    db.run(
      `INSERT INTO revenue_graph_entities (
         id, workspace_id, entity_type, entity_key, canonical_id, source_system, external_id, source_refs_json, attributes_json,
         mapping_version, sync_state, last_synced_at, last_sync_error, schema_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.workspaceId,
        input.entityType,
        input.entityKey,
        canonicalId,
        input.sourceSystem ?? null,
        input.externalId ?? null,
        JSON.stringify(sourceRefs),
        JSON.stringify(attributes),
        input.mappingVersion ?? 1,
        input.syncState ?? "success",
        now,
        input.lastSyncError ?? null,
        schemaHash,
        now,
        now,
      ],
    );
    return;
  }

  const mergedSourceRefs = mergeJsonArrayUnique(existing.source_refs_json, sourceRefs);
  const mergedAttributes = {
    ...parseMetadata(existing.attributes_json),
    ...attributes,
  };
  db.run(
    `UPDATE revenue_graph_entities
     SET canonical_id = ?, source_system = COALESCE(?, source_system), external_id = COALESCE(?, external_id),
         source_refs_json = ?, attributes_json = ?, mapping_version = ?, sync_state = ?, last_synced_at = ?, last_sync_error = ?, schema_hash = ?, updated_at = ?
     WHERE id = ?`,
    [
      canonicalId,
      input.sourceSystem ?? null,
      input.externalId ?? null,
      JSON.stringify(mergedSourceRefs),
      JSON.stringify(mergedAttributes),
      Math.max(existing.mapping_version, input.mappingVersion ?? 1),
      input.syncState ?? existing.sync_state,
      now,
      input.lastSyncError ?? null,
      Bun.hash(Object.keys(mergedAttributes).sort().join("|")).toString(16),
      now,
      existing.id,
    ],
  );
}

function upsertRevenueGraphEdge(input: {
  workspaceId: string;
  fromEntityKey: string;
  toEntityKey: string;
  relation: string;
  metadata?: Record<string, unknown>;
}): void {
  const now = nowIso();
  const metadata = input.metadata ?? {};
  const existing = db.query<RevenueGraphEdgeRow, [string, string, string, string]>(
    `SELECT id, workspace_id, from_entity_key, to_entity_key, relation, metadata_json, created_at, updated_at
     FROM revenue_graph_edges
     WHERE workspace_id = ? AND from_entity_key = ? AND to_entity_key = ? AND relation = ?`
  ).get(input.workspaceId, input.fromEntityKey, input.toEntityKey, input.relation);
  if (!existing) {
    db.run(
      `INSERT INTO revenue_graph_edges (
         id, workspace_id, from_entity_key, to_entity_key, relation, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.workspaceId,
        input.fromEntityKey,
        input.toEntityKey,
        input.relation,
        JSON.stringify(metadata),
        now,
        now,
      ],
    );
    return;
  }
  const mergedMetadata = {
    ...parseMetadata(existing.metadata_json),
    ...metadata,
  };
  db.run(
    `UPDATE revenue_graph_edges
     SET metadata_json = ?, updated_at = ?
     WHERE id = ?`,
    [JSON.stringify(mergedMetadata), now, existing.id],
  );
}

type ThreadSignalSnapshot = {
  threadId: string;
  quoteExternalIds: string[];
  messageCount: number;
  lastOccurredAt: string;
  sentimentTrend: "improving" | "stable" | "deteriorating";
  urgencyLevel: "low" | "normal" | "high";
  objectionCategories: string[];
  stakeholderInfluence: {
    participants: number;
    externalParticipants: number;
    influenceScore: number;
  };
  responseLatency: {
    medianMinutes: number;
    sampledPairs: number;
  };
  followupLikelihoodPct: number;
  dealProbability: {
    latestPct: number;
    trendDeltaPct: number;
  };
  personality: Record<string, unknown>;
  earlyWarnings: string[];
  events?: Array<Record<string, unknown>>;
};

function normalizedThreadId(row: QuoteCommunicationEventRow): string {
  return row.external_thread_id && row.external_thread_id.trim().length > 0
    ? row.external_thread_id.trim()
    : `quote:${row.quote_external_id}`;
}

function parseEmailAddress(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.trim().toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return match?.[0] ?? null;
}

function summarizeThreadSignals(
  workspaceId: string,
  threadId: string,
  rowsInput: QuoteCommunicationEventRow[],
  opts: { includeEvents: boolean; eventLimit: number },
): ThreadSignalSnapshot {
  const rows = [...rowsInput].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const messageCount = rows.length;
  const quoteIds = Array.from(new Set(rows.map((r) => r.quote_external_id)));
  const lastOccurredAt = rows[rows.length - 1]?.occurred_at ?? nowIso();
  const sentimentScore = (value: QuoteCommunicationEventRow["sentiment"]): number => (
    value === "positive" ? 1 : value === "negative" ? -1 : 0
  );
  const firstHalf = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
  const secondHalf = rows.slice(Math.floor(rows.length / 2));
  const firstAvg = firstHalf.length > 0 ? firstHalf.reduce((acc, row) => acc + sentimentScore(row.sentiment), 0) / firstHalf.length : 0;
  const secondAvg = secondHalf.length > 0 ? secondHalf.reduce((acc, row) => acc + sentimentScore(row.sentiment), 0) / secondHalf.length : 0;
  const sentimentTrend: ThreadSignalSnapshot["sentimentTrend"] = secondAvg - firstAvg > 0.2
    ? "improving"
    : firstAvg - secondAvg > 0.2
      ? "deteriorating"
      : "stable";

  const urgencyLevel = rows.some((row) => row.urgency === "high")
    ? "high"
    : rows.some((row) => row.urgency === "normal")
      ? "normal"
      : "low";

  const objectionSet = new Set<string>();
  const participants = new Set<string>();
  const externalParticipants = new Set<string>();
  const responseMinutes: number[] = [];
  const pendingInboundAt = new Map<string, number>();
  let followupSignals = 0;
  let latestProbability = 0;
  let firstProbability = 0;
  let probabilitySeen = 0;

  for (const row of rows) {
    const tags = parseIntentTags(row.intent_tags_json);
    if (tags.includes("pricing_objection")) objectionSet.add("pricing");
    if (tags.includes("timing_delay")) objectionSet.add("timing");
    if (tags.includes("procurement_block")) objectionSet.add("procurement");
    if (tags.includes("no_interest")) objectionSet.add("interest_loss");

    if (row.followup_needed === 1) followupSignals += 1;

    const from = parseEmailAddress(row.from_address);
    const to = parseEmailAddress(row.to_address);
    if (from) participants.add(from);
    if (to) participants.add(to);
    if (from && !from.endsWith("@yourcompany.com")) externalParticipants.add(from);
    if (to && !to.endsWith("@yourcompany.com")) externalParticipants.add(to);

    const occurredMs = Date.parse(row.occurred_at);
    if (row.direction === "inbound") {
      pendingInboundAt.set(row.quote_external_id, occurredMs);
    } else {
      const pending = pendingInboundAt.get(row.quote_external_id);
      if (pending !== undefined && Number.isFinite(occurredMs) && occurredMs >= pending) {
        responseMinutes.push((occurredMs - pending) / (1000 * 60));
        pendingInboundAt.delete(row.quote_external_id);
      }
    }

    if (row.estimated_deal_probability_pct !== null && row.estimated_deal_probability_pct !== undefined) {
      if (probabilitySeen === 0) firstProbability = num(row.estimated_deal_probability_pct);
      latestProbability = num(row.estimated_deal_probability_pct);
      probabilitySeen += 1;
    }
  }

  const staleHours = Math.max(0, (Date.now() - Date.parse(lastOccurredAt)) / (1000 * 60 * 60));
  const followupLikelihoodPct = Math.round(bounded(
    (messageCount > 0 ? (followupSignals / messageCount) * 75 : 0)
      + (staleHours >= 72 ? 20 : staleHours >= 48 ? 10 : 0)
      + (sentimentTrend === "deteriorating" ? 10 : 0),
    0,
    99,
  ));
  const trendDeltaPct = probabilitySeen > 1 ? Number((latestProbability - firstProbability).toFixed(1)) : 0;

  const personalityRows = rows.filter((row) => row.personality_type && row.personality_confidence !== null);
  const personalityCounts = new Map<string, number>();
  for (const row of personalityRows) {
    personalityCounts.set(row.personality_type as string, (personalityCounts.get(row.personality_type as string) ?? 0) + 1);
  }
  const dominantPersonality = Array.from(personalityCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const strongestEvent = personalityRows
    .map((row) => ({ row, confidence: num(row.personality_confidence) }))
    .sort((a, b) => b.confidence - a.confidence)[0]?.row ?? null;
  const strongestMetadata = strongestEvent ? parseMetadata(strongestEvent.metadata_json) : {};
  const personality = {
    dominantType: dominantPersonality,
    sampledEvents: personalityRows.length,
    distribution: Array.from(personalityCounts.entries()).map(([type, count]) => ({ type, count })),
    explanation: strongestEvent ? {
      model: strongestMetadata.personalityModel ?? "heuristic_mbti_v1",
      confidence: strongestEvent.personality_confidence,
      dimensions: strongestMetadata.personalityDimensions ?? {},
      evidence: {
        subject: strongestEvent.subject ?? "",
        snippet: strongestEvent.body_text.slice(0, 220),
      },
    } : null,
  };

  const earlyWarnings: string[] = [];
  if (staleHours >= 72) earlyWarnings.push("silent_deal");
  if (objectionSet.has("procurement") || objectionSet.has("pricing")) earlyWarnings.push("scope_confusion");
  if (externalParticipants.size < 2) earlyWarnings.push("decision_maker_absent");
  const quoteRows = quoteIds
    .map((quoteExternalId) => getQ2oRow(workspaceId, quoteExternalId))
    .filter((item): item is QuoteToOrderRecordRow => item !== null);
  if (quoteRows.some((row) => row.conversion_deadline_at && !row.converted_at && row.conversion_deadline_at < nowIso())) {
    earlyWarnings.push("quote_aging_out");
  }

  const eventItems = opts.includeEvents
    ? rows.slice(-opts.eventLimit).map((row) => toQuoteCommunicationEvent(row))
    : undefined;

  return {
    threadId,
    quoteExternalIds: quoteIds,
    messageCount,
    lastOccurredAt,
    sentimentTrend,
    urgencyLevel,
    objectionCategories: Array.from(objectionSet.values()),
    stakeholderInfluence: {
      participants: participants.size,
      externalParticipants: externalParticipants.size,
      influenceScore: Math.round(bounded(externalParticipants.size * 12 + participants.size * 4, 0, 100)),
    },
    responseLatency: {
      medianMinutes: median(responseMinutes.filter((value) => value >= 0)),
      sampledPairs: responseMinutes.length,
    },
    followupLikelihoodPct,
    dealProbability: {
      latestPct: latestProbability,
      trendDeltaPct,
    },
    personality,
    earlyWarnings: Array.from(new Set(earlyWarnings.values())),
    events: eventItems,
  };
}

export function syncRevenueGraphWorkspace(workspaceIdInput: unknown, bodyInput: unknown = {}): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const body = RevenueGraphSyncSchema.parse(bodyInput);
  const now = nowIso();
  const connectorFilter = body.connectorTypes && body.connectorTypes.length > 0
    ? new Set(body.connectorTypes)
    : null;
  const connectorAllowed = (value: ConnectorType | null | undefined): boolean => {
    if (!connectorFilter) return true;
    if (!value) return false;
    return connectorFilter.has(value);
  };

  if (body.mode === "full") {
    db.run(`DELETE FROM revenue_graph_edges WHERE workspace_id = ?`, [workspaceId]);
    db.run(`DELETE FROM revenue_graph_entities WHERE workspace_id = ?`, [workspaceId]);
  }

  const sinceFilter = body.since;
  let entityUpserts = 0;
  let edgeUpserts = 0;

  const q2oRows = db.query<QuoteToOrderRecordRow, unknown[]>(
    `SELECT id, workspace_id, source_system, quote_external_id, order_external_id, approval_external_id, customer_external_id, state, amount, currency,
            external_id, sync_state, last_synced_at, last_sync_error, conflict_marker, payload_json, approval_deadline_at, approval_decided_at,
            conversion_deadline_at, converted_at, fulfilled_at, version, created_at, updated_at
     FROM quote_to_order_records
     WHERE workspace_id = ? ${sinceFilter ? "AND updated_at >= ?" : ""}
     ORDER BY updated_at DESC
     LIMIT ?`
  ).all(...(sinceFilter ? [workspaceId, sinceFilter, body.limit] : [workspaceId, body.limit]));
  for (const row of q2oRows) {
    if (!connectorAllowed(row.source_system)) continue;
    const quoteKey = revenueGraphKey("quote", row.quote_external_id);
    upsertRevenueGraphEntity({
      workspaceId,
      entityType: "quote",
      entityKey: quoteKey,
      sourceSystem: row.source_system,
      externalId: row.quote_external_id,
      sourceRef: { system: row.source_system, externalId: row.quote_external_id, table: "quote_to_order_records" },
      attributes: {
        quoteExternalId: row.quote_external_id,
        state: row.state,
        amount: row.amount,
        currency: row.currency,
        approvalDeadlineAt: row.approval_deadline_at,
        conversionDeadlineAt: row.conversion_deadline_at,
        traceability: {
          source_system: row.source_system,
          external_id: row.external_id,
          sync_state: row.sync_state,
          last_synced_at: row.last_synced_at,
          last_sync_error: row.last_sync_error,
        },
      },
      syncState: row.sync_state,
      lastSyncError: row.last_sync_error,
    });
    entityUpserts += 1;

    if (row.customer_external_id) {
      const accountKey = revenueGraphKey("account", row.customer_external_id);
      upsertRevenueGraphEntity({
        workspaceId,
        entityType: "account",
        entityKey: accountKey,
        sourceSystem: row.source_system,
        externalId: row.customer_external_id,
        sourceRef: { system: row.source_system, externalId: row.customer_external_id, table: "quote_to_order_records" },
        attributes: { accountCode: row.customer_external_id },
      });
      entityUpserts += 1;
      upsertRevenueGraphEdge({
        workspaceId,
        fromEntityKey: accountKey,
        toEntityKey: quoteKey,
        relation: "owns_quote",
        metadata: { source: "q2o" },
      });
      edgeUpserts += 1;
    }

    if (row.order_external_id) {
      const orderKey = revenueGraphKey("order", row.order_external_id);
      upsertRevenueGraphEntity({
        workspaceId,
        entityType: "order",
        entityKey: orderKey,
        sourceSystem: row.source_system,
        externalId: row.order_external_id,
        sourceRef: { system: row.source_system, externalId: row.order_external_id, table: "quote_to_order_records" },
        attributes: {
          state: row.state,
          convertedAt: row.converted_at,
          fulfilledAt: row.fulfilled_at,
          amount: row.amount,
          currency: row.currency,
        },
      });
      entityUpserts += 1;
      upsertRevenueGraphEdge({
        workspaceId,
        fromEntityKey: quoteKey,
        toEntityKey: orderKey,
        relation: "converts_to_order",
        metadata: { source: "q2o" },
      });
      edgeUpserts += 1;
    }
  }

  if (body.includeMasterData) {
    const masterRows = db.query<MasterDataRecordRow, unknown[]>(
      `SELECT id, workspace_id, connector_type, entity, external_id, source_system, sync_state, last_synced_at, last_sync_error, schema_hash, payload_json, created_at, updated_at
       FROM erp_master_data_records
       WHERE workspace_id = ? ${sinceFilter ? "AND updated_at >= ?" : ""}
       ORDER BY updated_at DESC
       LIMIT ?`
    ).all(...(sinceFilter ? [workspaceId, sinceFilter, body.limit] : [workspaceId, body.limit]));
    for (const row of masterRows) {
      if (!connectorAllowed(row.connector_type)) continue;
      if (row.entity === "customer") {
        const payload = parseMetadata(row.payload_json);
        const accountKey = revenueGraphKey("account", row.external_id);
        upsertRevenueGraphEntity({
          workspaceId,
          entityType: "account",
          entityKey: accountKey,
          sourceSystem: row.connector_type,
          externalId: row.external_id,
          sourceRef: { system: row.connector_type, externalId: row.external_id, table: "erp_master_data_records", entity: row.entity },
          attributes: {
            ...payload,
            accountCode: row.external_id,
            syncState: row.sync_state,
          },
          syncState: row.sync_state,
          lastSyncError: row.last_sync_error,
        });
        entityUpserts += 1;
      }
    }
  }

  const followupRows = db.query<QuoteFollowupActionRow, [string, number]>(
    `SELECT id, workspace_id, quote_external_id, source_event_id, action_type, priority, status, reason, suggested_subject, suggested_message,
            assigned_to, due_at, note, last_error, writeback_run_id, writeback_connector, writeback_status, writeback_synced_at, writeback_error, created_at, updated_at
     FROM quote_followup_actions
     WHERE workspace_id = ?
     ORDER BY updated_at DESC
     LIMIT ?`
  ).all(workspaceId, body.limit);
  for (const row of followupRows) {
    const activityKey = revenueGraphKey("activity", row.id);
    const quoteKey = revenueGraphKey("quote", row.quote_external_id);
    upsertRevenueGraphEntity({
      workspaceId,
      entityType: "activity",
      entityKey: activityKey,
      sourceSystem: row.writeback_connector ?? null,
      externalId: row.id,
      sourceRef: { table: "quote_followup_actions", actionType: row.action_type },
      attributes: {
        actionType: row.action_type,
        status: row.status,
        priority: row.priority,
        dueAt: row.due_at,
        assignedTo: row.assigned_to,
      },
    });
    entityUpserts += 1;
    upsertRevenueGraphEdge({
      workspaceId,
      fromEntityKey: quoteKey,
      toEntityKey: activityKey,
      relation: "has_activity",
      metadata: { source: "followup" },
    });
    edgeUpserts += 1;
  }

  if (body.includeCommunications) {
    const commRows = db.query<QuoteCommunicationEventRow, unknown[]>(
      `SELECT id, workspace_id, quote_external_id, connector_type, channel, direction, subject, body_text, from_address, to_address,
              external_thread_id, intent_tags_json, sentiment, urgency, followup_needed, followup_reason, estimated_deal_probability_pct, personality_type, personality_confidence, idempotency_key, metadata_json,
              occurred_at, created_at
       FROM quote_communication_events
       WHERE workspace_id = ? ${sinceFilter ? "AND occurred_at >= ?" : ""}
       ORDER BY occurred_at DESC
       LIMIT ?`
    ).all(...(sinceFilter ? [workspaceId, sinceFilter, body.limit * 3] : [workspaceId, body.limit * 3]));
    for (const row of commRows) {
      if (!connectorAllowed(row.connector_type ?? undefined)) continue;
      const communicationKey = revenueGraphKey("communication", row.id);
      const quoteKey = revenueGraphKey("quote", row.quote_external_id);
      upsertRevenueGraphEntity({
        workspaceId,
        entityType: "communication",
        entityKey: communicationKey,
        sourceSystem: row.connector_type,
        externalId: row.id,
        sourceRef: { system: row.connector_type, externalId: row.id, table: "quote_communication_events" },
        attributes: {
          channel: row.channel,
          direction: row.direction,
          subject: row.subject,
          sentiment: row.sentiment,
          urgency: row.urgency,
          intentTags: parseIntentTags(row.intent_tags_json),
          occurredAt: row.occurred_at,
        },
      });
      entityUpserts += 1;
      upsertRevenueGraphEdge({
        workspaceId,
        fromEntityKey: communicationKey,
        toEntityKey: quoteKey,
        relation: "about_quote",
        metadata: { threadId: normalizedThreadId(row) },
      });
      edgeUpserts += 1;

      const fromEmail = parseEmailAddress(row.from_address);
      if (fromEmail) {
        const contactKey = revenueGraphKey("contact", fromEmail);
        upsertRevenueGraphEntity({
          workspaceId,
          entityType: "contact",
          entityKey: contactKey,
          externalId: fromEmail,
          sourceSystem: row.connector_type,
          sourceRef: { table: "quote_communication_events", role: "sender" },
          attributes: { email: fromEmail },
        });
        entityUpserts += 1;
        upsertRevenueGraphEdge({
          workspaceId,
          fromEntityKey: contactKey,
          toEntityKey: communicationKey,
          relation: "sent_message",
          metadata: { direction: row.direction },
        });
        edgeUpserts += 1;
      }
      const toEmail = parseEmailAddress(row.to_address);
      if (toEmail) {
        const contactKey = revenueGraphKey("contact", toEmail);
        upsertRevenueGraphEntity({
          workspaceId,
          entityType: "contact",
          entityKey: contactKey,
          externalId: toEmail,
          sourceSystem: row.connector_type,
          sourceRef: { table: "quote_communication_events", role: "recipient" },
          attributes: { email: toEmail },
        });
        entityUpserts += 1;
        upsertRevenueGraphEdge({
          workspaceId,
          fromEntityKey: communicationKey,
          toEntityKey: contactKey,
          relation: "received_by",
          metadata: { direction: row.direction },
        });
        edgeUpserts += 1;
      }
    }
  }

  const syncRows = db.query<SyncRunRow, [number]>(
    `SELECT id, connector_type, direction, entity_type, external_id, idempotency_key, payload_json, status, attempts, last_error, next_retry_at,
            created_at, updated_at, source_system, sync_state, last_sync_error, last_synced_at
     FROM connector_sync_runs
     ORDER BY updated_at DESC
     LIMIT ?`
  ).all(body.limit * 2);
  for (const row of syncRows) {
    const payload = parseMetadata(row.payload_json);
    if ((payload.workspaceId as string | undefined) !== workspaceId && (payload.workspace_id as string | undefined) !== workspaceId) continue;
    if (!connectorAllowed(row.connector_type)) continue;
    if (row.entity_type === "lead" || row.entity_type === "deal") {
      const oppId = row.external_id ?? row.id;
      upsertRevenueGraphEntity({
        workspaceId,
        entityType: "opportunity",
        entityKey: revenueGraphKey("opportunity", oppId),
        sourceSystem: row.connector_type,
        externalId: row.external_id ?? row.id,
        sourceRef: { table: "connector_sync_runs", runId: row.id },
        attributes: {
          status: row.status,
          syncState: row.sync_state,
          direction: row.direction,
        },
      });
      entityUpserts += 1;
    } else if (row.entity_type === "invoice") {
      const invoiceId = row.external_id ?? row.id;
      const invoiceKey = revenueGraphKey("invoice", invoiceId);
      upsertRevenueGraphEntity({
        workspaceId,
        entityType: "invoice",
        entityKey: invoiceKey,
        sourceSystem: row.connector_type,
        externalId: row.external_id ?? row.id,
        sourceRef: { table: "connector_sync_runs", runId: row.id },
        attributes: {
          status: row.status,
          syncState: row.sync_state,
          payload,
        },
      });
      entityUpserts += 1;
      const paymentId = typeof payload.paymentExternalId === "string"
        ? payload.paymentExternalId
        : typeof payload.payment_id === "string"
          ? payload.payment_id
          : null;
      if (paymentId) {
        const paymentKey = revenueGraphKey("payment", paymentId);
        upsertRevenueGraphEntity({
          workspaceId,
          entityType: "payment",
          entityKey: paymentKey,
          sourceSystem: row.connector_type,
          externalId: paymentId,
          sourceRef: { table: "connector_sync_runs", runId: row.id },
          attributes: {
            amount: payload.amount ?? null,
            currency: payload.currency ?? null,
            status: payload.paymentStatus ?? payload.status ?? null,
          },
        });
        entityUpserts += 1;
        upsertRevenueGraphEdge({
          workspaceId,
          fromEntityKey: paymentKey,
          toEntityKey: invoiceKey,
          relation: "applies_to_invoice",
          metadata: { source: "sync_run" },
        });
        edgeUpserts += 1;
      }
    }
  }

  const mappingStats = db.query<{ driftCount: number | null; maxVersion: number | null }, [string]>(
    `SELECT
       SUM(CASE WHEN drift_status = 'changed' THEN 1 ELSE 0 END) as driftCount,
       MAX(mapping_version) as maxVersion
     FROM erp_master_data_mappings
     WHERE workspace_id = ?`
  ).get(workspaceId);

  return {
    workspaceId,
    syncedAt: now,
    mode: body.mode,
    counts: {
      entityUpserts,
      edgeUpserts,
    },
    mapping: {
      driftCount: num(mappingStats?.driftCount),
      maxVersion: Math.max(1, num(mappingStats?.maxVersion)),
    },
    connectorScope: connectorFilter ? Array.from(connectorFilter.values()) : "all",
  };
}

export function getRevenueGraphEntity(
  workspaceIdInput: unknown,
  entityTypeInput: unknown,
  entityIdInput: unknown,
  filtersInput: unknown = {},
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const entityType = RevenueGraphEntityTypeSchema.parse(entityTypeInput);
  const entityId = z.string().min(1).parse(entityIdInput);
  const filters = RevenueGraphLookupSchema.parse(filtersInput);

  const candidateKeys = new Set<string>();
  candidateKeys.add(entityId);
  candidateKeys.add(revenueGraphKey(entityType, entityId));
  if (entityId.includes(":")) candidateKeys.add(entityId.toLowerCase());

  let row: RevenueGraphEntityRow | null = null;
  for (const key of candidateKeys.values()) {
    row = db.query<RevenueGraphEntityRow, [string, RevenueGraphEntityType, string, string]>(
      `SELECT id, workspace_id, entity_type, entity_key, canonical_id, source_system, external_id, source_refs_json, attributes_json,
              mapping_version, sync_state, last_synced_at, last_sync_error, schema_hash, created_at, updated_at
       FROM revenue_graph_entities
       WHERE workspace_id = ? AND entity_type = ? AND (entity_key = ? OR external_id = ?)
       LIMIT 1`
    ).get(workspaceId, entityType, key, key) ?? null;
    if (row) break;
  }
  if (!row) throw new Error(`Revenue graph entity '${entityType}:${entityId}' not found in workspace '${workspaceId}'.`);

  if (!filters.includeNeighbors) {
    return {
      workspaceId,
      entity: toRevenueGraphEntity(row),
      neighbors: [],
    };
  }

  const edges = db.query<RevenueGraphEdgeRow, [string, string, string, number]>(
    `SELECT id, workspace_id, from_entity_key, to_entity_key, relation, metadata_json, created_at, updated_at
     FROM revenue_graph_edges
     WHERE workspace_id = ? AND (from_entity_key = ? OR to_entity_key = ?)
     ORDER BY updated_at DESC
     LIMIT ?`
  ).all(workspaceId, row.entity_key, row.entity_key, filters.neighborLimit);
  const neighborKeys = new Set<string>();
  for (const edge of edges) {
    if (edge.from_entity_key !== row.entity_key) neighborKeys.add(edge.from_entity_key);
    if (edge.to_entity_key !== row.entity_key) neighborKeys.add(edge.to_entity_key);
  }
  const neighbors = Array.from(neighborKeys.values())
    .map((key) => db.query<RevenueGraphEntityRow, [string, string]>(
      `SELECT id, workspace_id, entity_type, entity_key, canonical_id, source_system, external_id, source_refs_json, attributes_json,
              mapping_version, sync_state, last_synced_at, last_sync_error, schema_hash, created_at, updated_at
       FROM revenue_graph_entities
       WHERE workspace_id = ? AND entity_key = ?`
    ).get(workspaceId, key))
    .filter((item): item is RevenueGraphEntityRow => item !== null)
    .map(toRevenueGraphEntity);

  return {
    workspaceId,
    entity: toRevenueGraphEntity(row),
    neighbors,
    relations: edges.map((edge) => ({
      relation: edge.relation,
      fromEntityKey: edge.from_entity_key,
      toEntityKey: edge.to_entity_key,
      metadata: parseMetadata(edge.metadata_json),
    })),
  };
}

export async function syncQuoteCommunicationThreads(
  workspaceIdInput: unknown,
  bodyInput: unknown = {},
): Promise<Record<string, unknown>> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const body = CommunicationThreadSyncSchema.parse(bodyInput);
  const syncedAt = nowIso();
  let importResult: Record<string, unknown> | null = null;

  if (body.source === "mailbox_pull") {
    if (!body.provider) throw new Error("provider is required when source=mailbox_pull");
    importResult = await pullQuoteMailboxCommunications(workspaceId, {
      provider: body.provider,
      userId: body.userId,
      useStoredConnection: body.useStoredConnection,
      accessToken: body.accessToken,
      limit: body.limit,
      since: body.since,
      workspaceDomains: body.workspaceDomains,
      defaultConnectorType: body.defaultConnectorType,
      autoCreateSubmittedQuote: body.autoCreateSubmittedQuote,
      runFollowupEngine: body.runFollowupEngine,
      followupAfterHours: body.followupAfterHours,
      highValueThresholdEur: body.highValueThresholdEur,
      assignedTo: body.assignedTo,
      now: body.now,
    });
  }

  const since = body.since ?? new Date(Date.now() - body.windowDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.query<QuoteCommunicationEventRow, [string, string, number]>(
    `SELECT id, workspace_id, quote_external_id, connector_type, channel, direction, subject, body_text, from_address, to_address,
            external_thread_id, intent_tags_json, sentiment, urgency, followup_needed, followup_reason, estimated_deal_probability_pct, personality_type, personality_confidence, idempotency_key, metadata_json,
            occurred_at, created_at
     FROM quote_communication_events
     WHERE workspace_id = ? AND occurred_at >= ?
     ORDER BY occurred_at DESC
     LIMIT ?`
  ).all(workspaceId, since, Math.min(5000, body.limit * 40));

  const grouped = new Map<string, QuoteCommunicationEventRow[]>();
  for (const row of rows) {
    const key = normalizedThreadId(row);
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }

  const threadSummaries = Array.from(grouped.entries())
    .map(([threadId, threadRows]) => summarizeThreadSignals(workspaceId, threadId, threadRows, { includeEvents: false, eventLimit: 0 }))
    .sort((a, b) => Date.parse(b.lastOccurredAt) - Date.parse(a.lastOccurredAt))
    .slice(0, body.limit)
    .map((item) => ({
      threadId: item.threadId,
      quoteExternalIds: item.quoteExternalIds,
      messageCount: item.messageCount,
      lastOccurredAt: item.lastOccurredAt,
      sentimentTrend: item.sentimentTrend,
      urgencyLevel: item.urgencyLevel,
      objectionCategories: item.objectionCategories,
      followupLikelihoodPct: item.followupLikelihoodPct,
      dealProbability: item.dealProbability,
      dominantPersonalityType: (item.personality.dominantType as string | null) ?? null,
      earlyWarnings: item.earlyWarnings,
    }));

  return {
    workspaceId,
    syncedAt,
    source: body.source,
    timeframe: { since },
    imported: importResult,
    threads: threadSummaries,
    threadCount: grouped.size,
  };
}

export function getQuoteCommunicationThreadSignals(
  workspaceIdInput: unknown,
  threadIdInput: unknown,
  filtersInput: unknown = {},
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const threadId = z.string().min(1).parse(threadIdInput);
  const filters = CommunicationThreadSignalSchema.parse(filtersInput);

  let rows: QuoteCommunicationEventRow[] = [];
  if (threadId.startsWith("quote:")) {
    const quoteExternalId = threadId.slice("quote:".length);
    rows = db.query<QuoteCommunicationEventRow, unknown[]>(
      `SELECT id, workspace_id, quote_external_id, connector_type, channel, direction, subject, body_text, from_address, to_address,
              external_thread_id, intent_tags_json, sentiment, urgency, followup_needed, followup_reason, estimated_deal_probability_pct, personality_type, personality_confidence, idempotency_key, metadata_json,
              occurred_at, created_at
       FROM quote_communication_events
       WHERE workspace_id = ? AND quote_external_id = ? ${filters.since ? "AND occurred_at >= ?" : ""}
       ORDER BY occurred_at ASC`
    ).all(...(filters.since ? [workspaceId, quoteExternalId, filters.since] : [workspaceId, quoteExternalId]));
  } else {
    rows = db.query<QuoteCommunicationEventRow, unknown[]>(
      `SELECT id, workspace_id, quote_external_id, connector_type, channel, direction, subject, body_text, from_address, to_address,
              external_thread_id, intent_tags_json, sentiment, urgency, followup_needed, followup_reason, estimated_deal_probability_pct, personality_type, personality_confidence, idempotency_key, metadata_json,
              occurred_at, created_at
       FROM quote_communication_events
       WHERE workspace_id = ? AND external_thread_id = ? ${filters.since ? "AND occurred_at >= ?" : ""}
       ORDER BY occurred_at ASC`
    ).all(...(filters.since ? [workspaceId, threadId, filters.since] : [workspaceId, threadId]));
  }

  if (rows.length === 0) {
    throw new Error(`No communication events found for thread '${threadId}'`);
  }

  const summary = summarizeThreadSignals(workspaceId, threadId, rows, {
    includeEvents: filters.includeEvents,
    eventLimit: filters.eventLimit,
  });
  return {
    workspaceId,
    ...summary,
  };
}

function toAutopilotProposal(row: AutopilotProposalRow): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    quoteExternalId: row.quote_external_id,
    actionType: row.action_type,
    channel: row.channel,
    suggestedSubject: row.suggested_subject ?? undefined,
    suggestedMessage: row.suggested_message,
    reasonCodes: parseIntentTags(row.reason_codes_json),
    expectedImpact: parseMetadata(row.expected_impact_json),
    status: row.status,
    requiresApproval: row.requires_approval === 1,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    rejectedBy: row.rejected_by ?? undefined,
    rejectedAt: row.rejected_at ?? undefined,
    executedAt: row.executed_at ?? undefined,
    executionMode: row.execution_mode ?? undefined,
    executionResult: row.execution_result_json ? parseMetadata(row.execution_result_json) : undefined,
    lastError: row.last_error ?? undefined,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getAutopilotProposalRow(workspaceId: string, proposalId: string): AutopilotProposalRow | null {
  return db.query<AutopilotProposalRow, [string, string]>(
    `SELECT id, workspace_id, quote_external_id, action_type, channel, suggested_subject, suggested_message, reason_codes_json,
            expected_impact_json, status, requires_approval, approved_by, approved_at, rejected_by, rejected_at,
            executed_at, execution_mode, execution_result_json, last_error, metadata_json, created_at, updated_at
     FROM quote_autopilot_proposals
     WHERE workspace_id = ? AND id = ?`
  ).get(workspaceId, proposalId) ?? null;
}

function recordTrustAudit(
  workspaceId: string,
  actor: string,
  eventType: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown>,
): void {
  db.run(
    `INSERT INTO trust_audit_log (id, workspace_id, actor, event_type, entity_type, entity_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), workspaceId, actor, eventType, entityType, entityId, JSON.stringify(details), nowIso()],
  );
}

function normalizeContactKey(value: string): string {
  return value.trim().toLowerCase();
}

function getConsentStatus(workspaceId: string, contactKey: string): TrustConsentStatus {
  const row = db.query<TrustConsentRow, [string, string]>(
    `SELECT id, workspace_id, contact_key, status, purposes_json, source, updated_by, updated_at, created_at
     FROM trust_contact_consents
     WHERE workspace_id = ? AND contact_key = ?`
  ).get(workspaceId, normalizeContactKey(contactKey));
  return row?.status ?? "unknown";
}

function quotePrimaryContactKey(workspaceId: string, quoteExternalId: string): string | null {
  const row = db.query<{ from_address: string | null; to_address: string | null }, [string, string]>(
    `SELECT from_address, to_address
     FROM quote_communication_events
     WHERE workspace_id = ? AND quote_external_id = ?
     ORDER BY occurred_at DESC
     LIMIT 1`
  ).get(workspaceId, quoteExternalId);
  const from = parseEmailAddress(row?.from_address ?? null);
  if (from) return from;
  const to = parseEmailAddress(row?.to_address ?? null);
  return to;
}

function latestQuoteCommunication(workspaceId: string, quoteExternalId: string): QuoteCommunicationEventRow | null {
  return db.query<QuoteCommunicationEventRow, [string, string]>(
    `SELECT id, workspace_id, quote_external_id, connector_type, channel, direction, subject, body_text, from_address, to_address,
            external_thread_id, intent_tags_json, sentiment, urgency, followup_needed, followup_reason, estimated_deal_probability_pct, personality_type, personality_confidence, idempotency_key, metadata_json,
            occurred_at, created_at
     FROM quote_communication_events
     WHERE workspace_id = ? AND quote_external_id = ?
     ORDER BY occurred_at DESC
     LIMIT 1`
  ).get(workspaceId, quoteExternalId) ?? null;
}

function quoteStagnationHours(workspaceId: string, quoteExternalId: string): number {
  const row = db.query<{ last_touch_at: string | null }, [string, string]>(
    `SELECT COALESCE(
        (SELECT MAX(occurred_at) FROM quote_communication_events WHERE workspace_id = ? AND quote_external_id = ?),
        (SELECT updated_at FROM quote_to_order_records WHERE workspace_id = ? AND quote_external_id = ?),
        (SELECT created_at FROM quote_to_order_records WHERE workspace_id = ? AND quote_external_id = ?)
      ) as last_touch_at`
  ).get(workspaceId, quoteExternalId, workspaceId, quoteExternalId, workspaceId, quoteExternalId);
  if (!row?.last_touch_at) return 999;
  const ms = Date.parse(row.last_touch_at);
  if (!Number.isFinite(ms)) return 999;
  return Number((((Date.now() - ms) / (1000 * 60 * 60))).toFixed(1));
}

function buildQuoteNextAction(
  quote: QuoteToOrderRecordRow,
  latestEvent: QuoteCommunicationEventRow | null,
  stagnationHours: number,
): {
  actionType: "followup_email" | "approval_nudge" | "internal_task" | "crm_update";
  priority: QuoteFollowupPriority;
  reasonCodes: string[];
  suggestedSubject: string;
  suggestedMessage: string;
  expectedImpact: Record<string, unknown>;
} {
  const tags = latestEvent ? parseIntentTags(latestEvent.intent_tags_json) : [];
  const sentiment = latestEvent?.sentiment ?? "neutral";
  const reasonCodes: string[] = [];
  let actionType: "followup_email" | "approval_nudge" | "internal_task" | "crm_update" = "followup_email";
  let priority: QuoteFollowupPriority = "normal";

  if (stagnationHours >= 72) {
    reasonCodes.push("silent_deal");
    priority = "high";
  }
  if (quote.state === "approved" && !quote.order_external_id) {
    actionType = "approval_nudge";
    reasonCodes.push("approved_not_converted");
    priority = priority === "high" ? "critical" : "high";
  }
  if (tags.includes("procurement_block")) {
    actionType = "internal_task";
    reasonCodes.push("procurement_block");
    priority = "high";
  }
  if (tags.includes("pricing_objection")) {
    actionType = "followup_email";
    reasonCodes.push("pricing_objection");
    priority = "high";
  }
  if (tags.includes("ready_to_buy")) {
    actionType = quote.state === "approved" ? "approval_nudge" : "followup_email";
    reasonCodes.push("ready_to_buy_signal");
    priority = "critical";
  }
  if (sentiment === "negative") {
    reasonCodes.push("negative_sentiment");
    if (priority === "normal") priority = "high";
  }
  if (reasonCodes.length === 0) {
    reasonCodes.push("steady_pipeline_optimization");
  }

  const followupType: QuoteFollowupActionType = actionType === "internal_task"
    ? "escalate_owner"
    : actionType === "approval_nudge"
      ? "call_followup"
      : "email_followup";
  const suggestion = buildSuggestedFollowup(
    quote.quote_external_id,
    followupType,
    reasonCodes.join(", "),
    sentiment,
    latestEvent?.estimated_deal_probability_pct ?? estimateDealProbabilityPct(quote.state, quote.amount, sentiment, tags, quote.workspace_id),
  );
  const expectedImpact = {
    conversionLiftPct: Number((5 + (priority === "critical" ? 5 : priority === "high" ? 3 : 1)).toFixed(1)),
    recoveredValueEur: Math.round(quote.amount * (priority === "critical" ? 0.35 : priority === "high" ? 0.22 : 0.12)),
    timeSavedHours: Number((priority === "critical" ? 1.8 : priority === "high" ? 1.1 : 0.6).toFixed(1)),
    breachCostAvoidedEur: priority === "critical" ? 220 : priority === "high" ? 140 : 70,
  };

  return {
    actionType,
    priority,
    reasonCodes,
    suggestedSubject: suggestion.subject ?? `Next step for quote ${quote.quote_external_id}`,
    suggestedMessage: suggestion.message,
    expectedImpact,
  };
}

function createAutopilotProposal(args: {
  workspaceId: string;
  quoteExternalId: string;
  actionType: "followup_email" | "approval_nudge" | "internal_task" | "crm_update";
  channel: QuoteCommunicationChannel;
  reasonCodes: string[];
  expectedImpact: Record<string, unknown>;
  suggestedSubject: string;
  suggestedMessage: string;
  requireApproval: boolean;
  metadata: Record<string, unknown>;
}): Record<string, unknown> {
  const id = randomUUID();
  const now = nowIso();
  db.run(
    `INSERT INTO quote_autopilot_proposals (
       id, workspace_id, quote_external_id, action_type, channel, suggested_subject, suggested_message,
       reason_codes_json, expected_impact_json, status, requires_approval, metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    [
      id,
      args.workspaceId,
      args.quoteExternalId,
      args.actionType,
      args.channel,
      args.suggestedSubject,
      args.suggestedMessage,
      JSON.stringify(args.reasonCodes),
      JSON.stringify(args.expectedImpact),
      args.requireApproval ? 1 : 0,
      JSON.stringify(args.metadata),
      now,
      now,
    ],
  );
  const row = getAutopilotProposalRow(args.workspaceId, id);
  if (!row) throw new Error("Failed to create autopilot proposal");
  return toAutopilotProposal(row);
}

export function createQuoteNextActionRecommendation(
  workspaceIdInput: unknown,
  bodyInput: unknown = {},
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const body = NextActionRecommendationSchema.parse(bodyInput);
  const quote = getQ2oRow(workspaceId, body.quoteExternalId);
  if (!quote) throw new Error(`Quote '${body.quoteExternalId}' not found for workspace '${workspaceId}'.`);

  const latestEvent = latestQuoteCommunication(workspaceId, body.quoteExternalId);
  const stagnationHours = quoteStagnationHours(workspaceId, body.quoteExternalId);
  const recommendation = buildQuoteNextAction(quote, latestEvent, stagnationHours);
  const proposal = body.mode === "create_proposal"
    ? createAutopilotProposal({
      workspaceId,
      quoteExternalId: body.quoteExternalId,
      actionType: recommendation.actionType,
      channel: body.channel,
      reasonCodes: recommendation.reasonCodes,
      expectedImpact: recommendation.expectedImpact,
      suggestedSubject: recommendation.suggestedSubject,
      suggestedMessage: recommendation.suggestedMessage,
      requireApproval: body.requireApproval,
      metadata: {
        createdBy: "recommendation-engine",
        assignedTo: body.assignedTo ?? null,
        stagnationHours,
        ...body.metadata,
      },
    })
    : null;

  return {
    workspaceId,
    quoteExternalId: body.quoteExternalId,
    actionType: recommendation.actionType,
    priority: recommendation.priority,
    reasonCodes: recommendation.reasonCodes,
    suggestedSubject: recommendation.suggestedSubject,
    suggestedMessage: recommendation.suggestedMessage,
    expectedImpact: recommendation.expectedImpact,
    stagnationHours,
    latestSignal: latestEvent ? toQuoteCommunicationEvent(latestEvent) : null,
    proposal,
  };
}

async function executeApprovedAutopilotProposal(
  proposal: AutopilotProposalRow,
  approvedBy: string,
  note?: string,
): Promise<Record<string, unknown>> {
  const quote = getQ2oRow(proposal.workspace_id, proposal.quote_external_id);
  if (!quote) throw new Error(`Quote '${proposal.quote_external_id}' not found`);
  const now = nowIso();

  if (proposal.action_type === "followup_email") {
    const contact = quotePrimaryContactKey(proposal.workspace_id, proposal.quote_external_id);
    if (contact && getConsentStatus(proposal.workspace_id, contact) === "opt_out") {
      throw new Error(`Contact '${contact}' is opted out for communication.`);
    }
    const actionId = randomUUID();
    db.run(
      `INSERT INTO quote_followup_actions (
         id, workspace_id, quote_external_id, source_event_id, action_type, priority, status, reason, suggested_subject, suggested_message,
         assigned_to, due_at, note, last_error, writeback_run_id, writeback_connector, writeback_status, writeback_synced_at, writeback_error, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, 'email_followup', 'high', 'open', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      [
        actionId,
        proposal.workspace_id,
        proposal.quote_external_id,
        "Autopilot approved follow-up draft",
        proposal.suggested_subject ?? `Follow-up ${proposal.quote_external_id}`,
        proposal.suggested_message,
        approvedBy,
        new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        note ?? null,
        now,
        now,
      ],
    );
    return {
      executionMode: "draft_only_v1",
      followupActionId: actionId,
      message: "Draft follow-up created. External send remains manual in v1.",
    };
  }

  if (proposal.action_type === "internal_task" || proposal.action_type === "approval_nudge") {
    const actionType: QuoteFollowupActionType = proposal.action_type === "internal_task" ? "escalate_owner" : "call_followup";
    const priority: QuoteFollowupPriority = proposal.action_type === "internal_task" ? "high" : "critical";
    const actionId = randomUUID();
    db.run(
      `INSERT INTO quote_followup_actions (
         id, workspace_id, quote_external_id, source_event_id, action_type, priority, status, reason, suggested_subject, suggested_message,
         assigned_to, due_at, note, last_error, writeback_run_id, writeback_connector, writeback_status, writeback_synced_at, writeback_error, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, ?, 'open', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      [
        actionId,
        proposal.workspace_id,
        proposal.quote_external_id,
        actionType,
        priority,
        "Autopilot internal execution",
        proposal.suggested_subject ?? `Action ${proposal.quote_external_id}`,
        proposal.suggested_message,
        approvedBy,
        new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        note ?? null,
        now,
        now,
      ],
    );
    return {
      executionMode: "internal_task_created",
      followupActionId: actionId,
    };
  }

  const syncResult = await syncConnector(quote.source_system, {
    direction: "writeback",
    entityType: "deal",
    externalId: quote.quote_external_id,
    idempotencyKey: `autopilot:${proposal.id}:${Date.now()}`,
    payload: {
      workspaceId: proposal.workspace_id,
      quoteExternalId: proposal.quote_external_id,
      proposalId: proposal.id,
      approvedBy,
      note: note ?? null,
      update: "next_action_executed",
    },
    maxRetries: 1,
  });
  return {
    executionMode: "crm_writeback",
    sync: syncResult,
  };
}

export async function approveQuoteAutopilotProposal(
  workspaceIdInput: unknown,
  proposalIdInput: unknown,
  bodyInput: unknown = {},
): Promise<Record<string, unknown>> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const proposalId = z.string().min(1).parse(proposalIdInput);
  const body = AutopilotProposalApproveSchema.parse(bodyInput);
  const proposal = getAutopilotProposalRow(workspaceId, proposalId);
  if (!proposal) throw new Error(`Autopilot proposal '${proposalId}' not found.`);
  if (proposal.status !== "draft") throw new Error(`Proposal '${proposalId}' is already ${proposal.status}.`);

  const approvedAt = nowIso();
  db.run(
    `UPDATE quote_autopilot_proposals
     SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
     WHERE id = ?`,
    [body.approvedBy, approvedAt, approvedAt, proposal.id],
  );
  recordTrustAudit(workspaceId, body.approvedBy, "autopilot_proposal_approved", "autopilot_proposal", proposal.id, {
    quoteExternalId: proposal.quote_external_id,
    actionType: proposal.action_type,
  });

  if (!body.execute) {
    const updated = getAutopilotProposalRow(workspaceId, proposal.id);
    return {
      proposal: updated ? toAutopilotProposal(updated) : null,
      executed: false,
    };
  }

  try {
    const executionResult = await executeApprovedAutopilotProposal(proposal, body.approvedBy, body.note);
    const executedAt = nowIso();
    db.run(
      `UPDATE quote_autopilot_proposals
       SET status = 'executed', executed_at = ?, execution_mode = ?, execution_result_json = ?, updated_at = ?, last_error = NULL
       WHERE id = ?`,
      [
        executedAt,
        typeof executionResult.executionMode === "string" ? executionResult.executionMode : "manual",
        JSON.stringify(executionResult),
        executedAt,
        proposal.id,
      ],
    );
    recordTrustAudit(workspaceId, body.approvedBy, "autopilot_proposal_executed", "autopilot_proposal", proposal.id, executionResult);
    const updated = getAutopilotProposalRow(workspaceId, proposal.id);
    return {
      proposal: updated ? toAutopilotProposal(updated) : null,
      executed: true,
      executionResult,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.run(
      `UPDATE quote_autopilot_proposals
       SET status = 'failed', last_error = ?, updated_at = ?
       WHERE id = ?`,
      [message, nowIso(), proposal.id],
    );
    recordTrustAudit(workspaceId, body.approvedBy, "autopilot_proposal_failed", "autopilot_proposal", proposal.id, {
      error: message,
    });
    throw err;
  }
}

export function rejectQuoteAutopilotProposal(
  workspaceIdInput: unknown,
  proposalIdInput: unknown,
  bodyInput: unknown = {},
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const proposalId = z.string().min(1).parse(proposalIdInput);
  const body = AutopilotProposalRejectSchema.parse(bodyInput);
  const proposal = getAutopilotProposalRow(workspaceId, proposalId);
  if (!proposal) throw new Error(`Autopilot proposal '${proposalId}' not found.`);
  if (proposal.status !== "draft" && proposal.status !== "approved" && proposal.status !== "failed") {
    throw new Error(`Proposal '${proposalId}' cannot be rejected in status '${proposal.status}'.`);
  }

  const now = nowIso();
  db.run(
    `UPDATE quote_autopilot_proposals
     SET status = 'rejected', rejected_by = ?, rejected_at = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
    [body.rejectedBy, now, body.reason, now, proposal.id],
  );
  recordTrustAudit(workspaceId, body.rejectedBy, "autopilot_proposal_rejected", "autopilot_proposal", proposal.id, {
    reason: body.reason,
  });
  const updated = getAutopilotProposalRow(workspaceId, proposal.id);
  if (!updated) throw new Error("Failed to update autopilot proposal");
  return {
    proposal: toAutopilotProposal(updated),
  };
}

export function runQuoteDealRescue(
  workspaceIdInput: unknown,
  bodyInput: unknown = {},
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const body = DealRescueRunSchema.parse(bodyInput);
  const staleRows = db.query<QuoteToOrderRecordRow & { last_touch_at: string | null }, [string]>(
    `SELECT r.id, r.workspace_id, r.source_system, r.quote_external_id, r.order_external_id, r.approval_external_id, r.customer_external_id, r.state, r.amount, r.currency,
            r.external_id, r.sync_state, r.last_synced_at, r.last_sync_error, r.conflict_marker, r.payload_json, r.approval_deadline_at, r.approval_decided_at,
            r.conversion_deadline_at, r.converted_at, r.fulfilled_at, r.version, r.created_at, r.updated_at,
            COALESCE((
              SELECT MAX(e.occurred_at)
              FROM quote_communication_events e
              WHERE e.workspace_id = r.workspace_id AND e.quote_external_id = r.quote_external_id
            ), r.updated_at, r.created_at) as last_touch_at
     FROM quote_to_order_records r
     WHERE r.workspace_id = ? AND r.state IN ('submitted', 'approved')
     ORDER BY r.updated_at ASC`
  ).all(workspaceId);

  const candidates = staleRows
    .filter((row) => body.mode === "batch" || row.quote_external_id === body.quoteExternalId)
    .map((row) => ({
      row,
      stagnationHours: Number((((Date.now() - Date.parse(row.last_touch_at ?? row.updated_at)) / (1000 * 60 * 60))).toFixed(1)),
    }))
    .filter((item) => item.stagnationHours >= body.minStagnationHours)
    .slice(0, body.maxQuotes);

  const proposals: Array<Record<string, unknown>> = [];
  const recommendationPreview: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    const recommendation = createQuoteNextActionRecommendation(workspaceId, {
      quoteExternalId: candidate.row.quote_external_id,
      mode: body.dryRun ? "draft_only" : "create_proposal",
      requireApproval: true,
      assignedTo: body.assignedTo,
      metadata: {
        origin: "deal_rescue",
        stagnationHours: candidate.stagnationHours,
      },
    });
    recommendationPreview.push(recommendation);
    const proposal = recommendation.proposal;
    if (proposal) proposals.push(proposal as Record<string, unknown>);
  }

  const recovery = db.query<{ recoveredValue: number | null; avgHours: number | null }, [string]>(
    `SELECT
       SUM(amount) as recoveredValue,
       AVG((julianday(converted_at) - julianday(conversion_deadline_at)) * 24) as avgHours
     FROM quote_to_order_records
     WHERE workspace_id = ?
       AND converted_at IS NOT NULL
       AND conversion_deadline_at IS NOT NULL
       AND converted_at > conversion_deadline_at`
  ).get(workspaceId);

  const runId = randomUUID();
  db.run(
    `INSERT INTO quote_deal_rescue_runs (
       id, workspace_id, mode, targeted_quote_external_id, min_stagnation_hours, identified_count, proposal_count,
       recovered_value_eur, avg_time_to_recovery_hours, details_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      workspaceId,
      body.mode,
      body.mode === "targeted" ? body.quoteExternalId ?? null : null,
      body.minStagnationHours,
      candidates.length,
      proposals.length,
      Math.round(num(recovery?.recoveredValue)),
      recovery?.avgHours !== null && recovery?.avgHours !== undefined ? Number(num(recovery.avgHours).toFixed(2)) : null,
      JSON.stringify({
        dryRun: body.dryRun,
        recommendationPreview: recommendationPreview.map((item) => ({
          quoteExternalId: item.quoteExternalId,
          actionType: item.actionType,
          reasonCodes: item.reasonCodes,
          expectedImpact: item.expectedImpact,
        })),
      }),
      nowIso(),
    ],
  );

  return {
    runId,
    workspaceId,
    mode: body.mode,
    dryRun: body.dryRun,
    minStagnationHours: body.minStagnationHours,
    identifiedQuotes: candidates.map((item) => ({
      quoteExternalId: item.row.quote_external_id,
      stagnationHours: item.stagnationHours,
      amount: item.row.amount,
      state: item.row.state,
    })),
    proposalCount: proposals.length,
    proposals,
    recoveredValueEur: Math.round(num(recovery?.recoveredValue)),
    averageTimeToRecoveryHours: recovery?.avgHours !== null && recovery?.avgHours !== undefined
      ? Number(num(recovery.avgHours).toFixed(2))
      : null,
  };
}

export function getForecastQualityAnalytics(filtersInput: unknown = {}): Record<string, unknown> {
  const filters = ForecastQualityFilterSchema.parse(filtersInput);
  const where: string[] = ["q.state IN ('converted_to_order','fulfilled','rejected')"];
  const params: unknown[] = [];
  if (filters.workspaceId) {
    where.push("q.workspace_id = ?");
    params.push(filters.workspaceId);
  }
  if (filters.since) {
    where.push("q.updated_at >= ?");
    params.push(filters.since);
  }
  const rows = db.query<{
    workspace_id: string;
    quote_external_id: string;
    state: QuoteToOrderState;
    predicted_pct: number | null;
  }, unknown[]>(
    `SELECT q.workspace_id, q.quote_external_id, q.state,
            (
              SELECT e.estimated_deal_probability_pct
              FROM quote_communication_events e
              WHERE e.workspace_id = q.workspace_id AND e.quote_external_id = q.quote_external_id
                AND e.estimated_deal_probability_pct IS NOT NULL
              ORDER BY e.occurred_at DESC
              LIMIT 1
            ) as predicted_pct
     FROM quote_to_order_records q
     WHERE ${where.join(" AND ")}`
  ).all(...params)
    .filter((row) => row.predicted_pct !== null);

  const scored = rows.map((row) => {
    const predicted = bounded(num(row.predicted_pct) / 100, 0, 1);
    const actual = row.state === "converted_to_order" || row.state === "fulfilled" ? 1 : 0;
    return {
      ...row,
      predicted,
      actual,
      absErrorPct: Math.abs(predicted - actual) * 100,
      brier: (predicted - actual) ** 2,
    };
  });

  const mae = scored.length > 0
    ? Number((scored.reduce((acc, item) => acc + item.absErrorPct, 0) / scored.length).toFixed(2))
    : 0;
  const brier = scored.length > 0
    ? Number((scored.reduce((acc, item) => acc + item.brier, 0) / scored.length).toFixed(4))
    : 0;
  const buckets = [
    { range: "0-20", min: 0, max: 0.2 },
    { range: "21-40", min: 0.2, max: 0.4 },
    { range: "41-60", min: 0.4, max: 0.6 },
    { range: "61-80", min: 0.6, max: 0.8 },
    { range: "81-100", min: 0.8, max: 1.01 },
  ].map((bucket) => {
    const bucketRows = scored.filter((item) => item.predicted >= bucket.min && item.predicted < bucket.max);
    const actualWinRate = bucketRows.length > 0
      ? Number(((bucketRows.filter((item) => item.actual === 1).length / bucketRows.length) * 100).toFixed(1))
      : null;
    const avgPredicted = bucketRows.length > 0
      ? Number((bucketRows.reduce((acc, item) => acc + item.predicted, 0) / bucketRows.length * 100).toFixed(1))
      : null;
    return {
      bucket: bucket.range,
      samples: bucketRows.length,
      averagePredictedPct: avgPredicted,
      actualWinRatePct: actualWinRate,
      calibrationGapPct: avgPredicted !== null && actualWinRate !== null
        ? Number((avgPredicted - actualWinRate).toFixed(1))
        : null,
    };
  });

  return {
    timeframe: { since: filters.since ?? "all_time" },
    workspaceId: filters.workspaceId ?? "all",
    sampleSize: scored.length,
    meetsMinimumSample: scored.length >= filters.minSamples,
    meanAbsoluteErrorPct: mae,
    brierScore: brier,
    accuracyPct: Number(Math.max(0, 100 - mae).toFixed(1)),
    calibration: buckets,
  };
}

export function getRevenueIntelligenceAnalytics(filtersInput: unknown = {}): Record<string, unknown> {
  const filters = RevenueIntelligenceFilterSchema.parse(filtersInput);
  const executive = getExecutiveAnalytics({ workspaceId: filters.workspaceId, since: filters.since });
  const ops = getOpsAnalytics({ since: filters.since });
  const forecast = getForecastQualityAnalytics({
    workspaceId: filters.workspaceId,
    since: filters.since,
    minSamples: 3,
  });

  const staleWhere: string[] = ["r.state IN ('submitted','approved')"];
  const staleParams: unknown[] = [];
  if (filters.workspaceId) {
    staleWhere.push("r.workspace_id = ?");
    staleParams.push(filters.workspaceId);
  }
  const staleRow = db.query<{ cnt: number | null }, unknown[]>(
    `SELECT COUNT(*) as cnt
     FROM quote_to_order_records r
     LEFT JOIN (
       SELECT workspace_id, quote_external_id, MAX(occurred_at) as last_comm
       FROM quote_communication_events
       GROUP BY workspace_id, quote_external_id
     ) c ON c.workspace_id = r.workspace_id AND c.quote_external_id = r.quote_external_id
     WHERE ${staleWhere.join(" AND ")}
       AND COALESCE(c.last_comm, r.updated_at, r.created_at) < ?`
  ).get(...[...staleParams, new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()]);

  const followupWhere: string[] = ["due_at <= ?"];
  const followupParams: unknown[] = [nowIso()];
  if (filters.workspaceId) {
    followupWhere.push("workspace_id = ?");
    followupParams.push(filters.workspaceId);
  }
  if (filters.since) {
    followupWhere.push("created_at >= ?");
    followupParams.push(filters.since);
  }
  const followupSla = db.query<{ totalDue: number | null; onTime: number | null }, unknown[]>(
    `SELECT
       COUNT(*) as totalDue,
       SUM(CASE WHEN status IN ('done','sent') AND updated_at <= due_at THEN 1 ELSE 0 END) as onTime
     FROM quote_followup_actions
     WHERE ${followupWhere.join(" AND ")}`
  ).get(...followupParams);
  const followupSlaPct = num(followupSla?.totalDue) > 0
    ? Number(((num(followupSla?.onTime) / num(followupSla?.totalDue)) * 100).toFixed(1))
    : 0;

  const rescueWhere: string[] = ["1 = 1"];
  const rescueParams: unknown[] = [];
  if (filters.workspaceId) {
    rescueWhere.push("workspace_id = ?");
    rescueParams.push(filters.workspaceId);
  }
  if (filters.since) {
    rescueWhere.push("created_at >= ?");
    rescueParams.push(filters.since);
  }
  const rescue = db.query<{ recoveredValue: number | null; runs: number | null }, unknown[]>(
    `SELECT SUM(recovered_value_eur) as recoveredValue, COUNT(*) as runs
     FROM quote_deal_rescue_runs
     WHERE ${rescueWhere.join(" AND ")}`
  ).get(...rescueParams);

  const now = Date.now();
  const currentSince = filters.since ?? new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const periodMs = now - Date.parse(currentSince);
  const baselineStart = new Date(Date.parse(currentSince) - periodMs).toISOString();
  const baselineEnd = currentSince;
  const conversionRateForWindow = (start: string, end: string): number => {
    const where: string[] = ["created_at >= ?", "created_at < ?"];
    const params: unknown[] = [start, end];
    if (filters.workspaceId) {
      where.push("workspace_id = ?");
      params.push(filters.workspaceId);
    }
    const row = db.query<{ submitted: number | null; converted: number | null }, unknown[]>(
      `SELECT
         SUM(CASE WHEN state IN ('submitted','approved','converted_to_order','fulfilled','rejected') THEN 1 ELSE 0 END) as submitted,
         SUM(CASE WHEN state IN ('converted_to_order','fulfilled') THEN 1 ELSE 0 END) as converted
       FROM quote_to_order_records
       WHERE ${where.join(" AND ")}`
    ).get(...params);
    return num(row?.submitted) > 0 ? (num(row?.converted) / num(row?.submitted)) * 100 : 0;
  };
  const baselineRate = conversionRateForWindow(baselineStart, baselineEnd);
  const currentRate = conversionRateForWindow(currentSince, nowIso());
  const conversionLiftPct = Number((currentRate - baselineRate).toFixed(1));

  return {
    timeframe: { since: filters.since ?? "last_30_days" },
    workspaceId: filters.workspaceId ?? "all",
    executive,
    ops,
    forecast,
    metrics: {
      conversionLiftPct,
      followupSlaAdherencePct: followupSlaPct,
      recoveredRevenueEur: Math.round(num(rescue?.recoveredValue)),
      dealRescueRuns: num(rescue?.runs),
      silentDealCount: num(staleRow?.cnt),
      forecastErrorPct: (forecast as Record<string, unknown>).meanAbsoluteErrorPct ?? 0,
      timeToFirstOrderConversionHours: (executive as Record<string, unknown>).timeToFirstOrderConversionHours ?? null,
    },
  };
}

function toTrustConsent(row: TrustConsentRow): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contactKey: row.contact_key,
    status: row.status,
    purposes: parseIntentTags(row.purposes_json),
    source: row.source ?? undefined,
    updatedBy: row.updated_by ?? undefined,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export function getTrustConsentStatus(filtersInput: unknown): Record<string, unknown> {
  const filters = TrustConsentStatusFilterSchema.parse(filtersInput);
  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [filters.workspaceId];
  if (filters.contactKey) {
    where.push("contact_key = ?");
    params.push(normalizeContactKey(filters.contactKey));
  }
  params.push(filters.limit);
  const rows = db.query<TrustConsentRow, unknown[]>(
    `SELECT id, workspace_id, contact_key, status, purposes_json, source, updated_by, updated_at, created_at
     FROM trust_contact_consents
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC
     LIMIT ?`
  ).all(...params);

  const summary = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, { unknown: 0, opt_in: 0, opt_out: 0 } as Record<TrustConsentStatus, number>);

  return {
    workspaceId: filters.workspaceId,
    summary,
    items: rows.map(toTrustConsent),
    policy: {
      consentMode: "explainable_opt_out_supported",
      autonomousOutreach: false,
    },
  };
}

export function updateTrustConsent(input: unknown): Record<string, unknown> {
  const body = TrustConsentUpdateSchema.parse(input);
  const now = nowIso();
  const contactKey = normalizeContactKey(body.contactKey);
  const existing = db.query<TrustConsentRow, [string, string]>(
    `SELECT id, workspace_id, contact_key, status, purposes_json, source, updated_by, updated_at, created_at
     FROM trust_contact_consents
     WHERE workspace_id = ? AND contact_key = ?`
  ).get(body.workspaceId, contactKey);

  if (!existing) {
    db.run(
      `INSERT INTO trust_contact_consents
       (id, workspace_id, contact_key, status, purposes_json, source, updated_by, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        body.workspaceId,
        contactKey,
        body.status,
        JSON.stringify(body.purposes),
        body.source,
        body.updatedBy,
        now,
        now,
      ],
    );
  } else {
    db.run(
      `UPDATE trust_contact_consents
       SET status = ?, purposes_json = ?, source = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.status,
        JSON.stringify(body.purposes),
        body.source,
        body.updatedBy,
        now,
        existing.id,
      ],
    );
  }

  const updated = db.query<TrustConsentRow, [string, string]>(
    `SELECT id, workspace_id, contact_key, status, purposes_json, source, updated_by, updated_at, created_at
     FROM trust_contact_consents
     WHERE workspace_id = ? AND contact_key = ?`
  ).get(body.workspaceId, contactKey);
  if (!updated) throw new Error("Failed to persist trust consent");
  recordTrustAudit(body.workspaceId, body.updatedBy, "consent_updated", "contact", contactKey, {
    status: body.status,
    purposes: body.purposes,
    source: body.source,
  });
  return toTrustConsent(updated);
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

export function recordWizardConnectorConnection(
  sessionIdInput: unknown,
  connectorInput: unknown,
  _connectorStatusInput?: unknown,
): Record<string, unknown> {
  const sessionId = z.string().min(1).parse(sessionIdInput);
  const connector = ConnectorTypeSchema.parse(connectorInput);
  const connectorStatus = getConnectorStatus(connector);
  updateWizardState(sessionId, (state) => {
    const patch: Record<string, unknown> = {
      connectedAt: nowIso(),
      enabled: connectorStatus.enabled,
      health: connectorStatus.health,
      renewalDue: connectorStatus.renewalDue,
      tokenStatus: connectorStatus.tokenStatus,
      lastConnectError: connectorStatus.lastError ?? null,
    };
    return setWizardConnectorState(state, connector, patch);
  });
  return getWizardSessionState(sessionId);
}

export async function runWizardConnectorTest(
  sessionIdInput: unknown,
  connectorInput: unknown,
  bodyInput: unknown = {},
): Promise<Record<string, unknown>> {
  const sessionId = z.string().min(1).parse(sessionIdInput);
  const connectorType = ConnectorTypeSchema.parse(connectorInput);
  const body = WizardConnectorTestSchema.parse(bodyInput);
  const session = getWizardSessionRow(sessionId);
  if (!session) throw new Error(`Wizard session '${sessionId}' not found`);

  const before = getConnectorStatus(connectorType);
  if (!before.enabled) {
    throw new Error(`Connector '${connectorType}' must be connected and enabled before test run.`);
  }

  const externalId = body.externalId ?? `wizard-probe-${sessionId.slice(0, 8)}-${connectorType}-${Date.now()}`;
  const idempotencyKey = `wizard:test:${sessionId}:${connectorType}:${Date.now()}`;

  try {
    const syncResult = await syncConnector(connectorType, {
      direction: "two-way",
      entityType: body.entityType,
      externalId,
      idempotencyKey,
      payload: {
        ...body.payload,
        wizard_session_id: sessionId,
        workspace_id: session.workspace_id,
        source_system: connectorType,
      },
      maxRetries: body.maxRetries,
    });

    let renewed = false;
    if (connectorType === "business-central" && body.renewIfDue) {
      const status = getConnectorStatus("business-central");
      if (status.enabled && status.renewalDue) {
        await renewBusinessCentralSubscription();
        renewed = true;
      }
    }

    const after = getConnectorStatus(connectorType);
    updateWizardState(sessionId, (state) => setWizardConnectorState(state, connectorType, {
      testedAt: nowIso(),
      lastTestStatus: "success",
      lastRunId: syncResult.runId,
      lastTestError: null,
      renewedAt: renewed ? nowIso() : undefined,
    }));

    return {
      sessionId,
      connectorType,
      renewed,
      before,
      after,
      syncResult,
      session: getWizardSessionState(sessionId),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateWizardState(sessionId, (state) => setWizardConnectorState(state, connectorType, {
      testedAt: nowIso(),
      lastTestStatus: "failed",
      lastTestError: message,
    }));
    throw err;
  }
}

function wizardSamplePayload(
  session: WizardSessionRow,
  connector: ConnectorType,
  entity: MasterDataEntity,
  sampleInput: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const provided = sampleInput[entity];
  if (provided && Object.keys(provided).length > 0) {
    return {
      ...provided,
      source_system: connector,
      sync_state: "success",
      last_synced_at: nowIso(),
      last_sync_error: null,
    };
  }
  const base = {
    source_system: connector,
    sync_state: "success",
    last_synced_at: nowIso(),
    last_sync_error: null,
    workspace_id: session.workspace_id,
  };
  switch (entity) {
    case "customer":
      return { ...base, customer_name: session.customer_name, customer_code: `${connector.toUpperCase()}-${session.id.slice(0, 6)}` };
    case "product":
      return { ...base, sku: `SKU-${session.id.slice(0, 4)}-${connector.slice(0, 3)}`, product_name: "Wizard Product", active: true };
    case "price":
      return { ...base, list_name: "Standard", amount: 1000, currency: "EUR" };
    case "tax":
      return { ...base, tax_code: "STD", tax_rate: 19 };
    default:
      return base;
  }
}

export function runWizardMasterDataAutoSync(sessionIdInput: unknown, bodyInput: unknown = {}): Record<string, unknown> {
  const sessionId = z.string().min(1).parse(sessionIdInput);
  const body = WizardMasterDataAutoSyncSchema.parse(bodyInput);
  const session = getWizardSessionRow(sessionId);
  if (!session) throw new Error(`Wizard session '${sessionId}' not found`);

  const connectors = body.connectors && body.connectors.length > 0 ? body.connectors : WIZARD_REQUIRED_CONNECTORS;
  const entities: MasterDataEntity[] = ["customer", "product", "price", "tax"];
  const sample = body.sample;
  const syncResults: Array<Record<string, unknown>> = [];
  const errors: Array<{ connectorType: ConnectorType; entity?: MasterDataEntity; error: string }> = [];

  for (const connectorType of connectors) {
    const status = getConnectorStatus(connectorType);
    if (!status.enabled) {
      errors.push({ connectorType, error: "Connector is not connected/enabled." });
      continue;
    }

    for (const entity of entities) {
      try {
        const payload = wizardSamplePayload(session, connectorType, entity, sample);
        const externalId = `${entity}-${connectorType}-${session.id.slice(0, 8)}`;
        const result = syncMasterDataEntity(session.workspace_id, entity, {
          connectorType,
          records: [{ externalId, payload }],
          idempotencyKey: `wizard:md:${sessionId}:${connectorType}:${entity}:${Date.now()}`,
        });
        syncResults.push({
          connectorType,
          entity,
          result,
        });
      } catch (err) {
        errors.push({
          connectorType,
          entity,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const mappingDriftRow = db.query<{ cnt: number | null }, [string]>(
    `SELECT COUNT(*) as cnt
     FROM erp_master_data_mappings
     WHERE workspace_id = ? AND drift_status = 'changed'`
  ).get(session.workspace_id);
  const mappingDriftCount = Number(mappingDriftRow?.cnt ?? 0);

  const summary = {
    syncedAt: nowIso(),
    attemptedConnectors: connectors,
    syncedRecords: syncResults.length,
    errors,
    mappingDriftCount,
  };

  updateWizardState(sessionId, (state) => {
    const next = { ...state };
    next.masterData = {
      lastSyncedAt: summary.syncedAt,
      lastResult: summary,
    };
    return next;
  });

  return {
    sessionId,
    workspaceId: session.workspace_id,
    summary,
    syncResults,
    session: getWizardSessionState(sessionId),
  };
}

export function runWizardQuoteToOrderDryRun(sessionIdInput: unknown, bodyInput: unknown = {}): Record<string, unknown> {
  const sessionId = z.string().min(1).parse(sessionIdInput);
  const body = WizardQ2oDryRunSchema.parse(bodyInput);
  const session = getWizardSessionRow(sessionId);
  if (!session) throw new Error(`Wizard session '${sessionId}' not found`);

  const missingConnectors = WIZARD_REQUIRED_CONNECTORS.filter((connector) => !getConnectorStatus(connector).enabled);
  if (missingConnectors.length > 0) {
    updateWizardState(sessionId, (state) => {
      const next = { ...state };
      next.q2oDryRun = {
        lastRunAt: nowIso(),
        passed: false,
        error: `Missing required connectors: ${missingConnectors.join(", ")}`,
      };
      return next;
    });
    throw new Error(`Dry run blocked. Missing required connectors: ${missingConnectors.join(", ")}`);
  }

  const workflowRunId = recordWorkflowRun("quote-to-order", "running", null, {
    wizardSessionId: sessionId,
    workspaceId: session.workspace_id,
    customerName: session.customer_name,
  });

  try {
    const runStamp = Date.now();
    for (const connectorType of WIZARD_REQUIRED_CONNECTORS) {
      const quoteExternalId = `WIZ-Q-${connectorType}-${sessionId.slice(0, 6)}-${runStamp}`;
      const approvalExternalId = `WIZ-APR-${connectorType}-${sessionId.slice(0, 6)}-${runStamp}`;
      const orderExternalId = `WIZ-SO-${connectorType}-${sessionId.slice(0, 6)}-${runStamp}`;
      const approvalDeadlineAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const conversionDeadlineAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const tracePayload = {
        wizard_session_id: sessionId,
        source_system: connectorType,
        external_id: quoteExternalId,
        sync_state: "success",
        last_synced_at: nowIso(),
        last_sync_error: null,
      };

      syncQuoteToOrderQuote(session.workspace_id, {
        connectorType,
        quoteExternalId,
        approvalExternalId,
        customerExternalId: `WIZ-CUST-${sessionId.slice(0, 6)}`,
        amount: body.amount,
        currency: body.currency,
        state: "submitted",
        approvalDeadlineAt,
        conversionDeadlineAt,
        idempotencyKey: `wizard:q2o:quote:${sessionId}:${connectorType}:${runStamp}`,
        payload: tracePayload,
      });
      decideQuoteToOrderApproval(session.workspace_id, approvalExternalId, {
        decision: "approved",
        decidedBy: body.decidedBy,
        quoteExternalId,
        idempotencyKey: `wizard:q2o:approval:${sessionId}:${connectorType}:${runStamp}`,
        payload: {
          ...tracePayload,
          decision: "approved",
        },
      });
      syncQuoteToOrderOrder(session.workspace_id, {
        connectorType,
        quoteExternalId,
        orderExternalId,
        amount: body.amount,
        currency: body.currency,
        state: "converted_to_order",
        idempotencyKey: `wizard:q2o:order:${sessionId}:${connectorType}:${runStamp}`,
        payload: tracePayload,
      });
      syncQuoteToOrderOrder(session.workspace_id, {
        connectorType,
        quoteExternalId,
        orderExternalId,
        amount: body.amount,
        currency: body.currency,
        state: "fulfilled",
        idempotencyKey: `wizard:q2o:fulfill:${sessionId}:${connectorType}:${runStamp}`,
        payload: tracePayload,
      });
    }

    updateWorkflowRun(workflowRunId, "completed");
    const pipeline = getQuoteToOrderPipeline(session.workspace_id, {});
    updateWizardState(sessionId, (state) => {
      const next = { ...state };
      next.q2oDryRun = {
        lastRunAt: nowIso(),
        passed: true,
        error: null,
        workflowRunId,
      };
      return next;
    });
    return {
      sessionId,
      workspaceId: session.workspace_id,
      workflowRunId,
      pipeline,
      session: getWizardSessionState(sessionId),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateWorkflowRun(workflowRunId, "failed", message);
    updateWizardState(sessionId, (state) => {
      const next = { ...state };
      next.q2oDryRun = {
        lastRunAt: nowIso(),
        passed: false,
        error: message,
        workflowRunId,
      };
      return next;
    });
    throw err;
  }
}

export function overrideWizardGate(
  sessionIdInput: unknown,
  gateIdInput: unknown,
  bodyInput: unknown,
): Record<string, unknown> {
  const sessionId = z.string().min(1).parse(sessionIdInput);
  const gateId = WizardGateIdSchema.parse(gateIdInput);
  const body = WizardGateOverrideSchema.parse(bodyInput);
  const current = getWizardSessionState(sessionId);
  const gates = Array.isArray(current.gates) ? current.gates : [];
  const gate = gates.find((item) => asObject(item).id === gateId);
  if (!gate) throw new Error(`Gate '${gateId}' not found on wizard session`);
  const gateObj = asObject(gate);
  if (gateObj.class !== "overridable") {
    throw new Error(`Gate '${gateId}' is critical and cannot be overridden.`);
  }
  db.run(
    `INSERT INTO wizard_gate_overrides (id, wizard_session_id, gate_id, reason, approved_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [randomUUID(), sessionId, gateId, body.reason, body.approvedBy, nowIso()],
  );
  updateWizardState(sessionId, (state) => ({ ...state, lastOverrideAt: nowIso() }));
  return getWizardSessionState(sessionId);
}

export function launchWizardSession(sessionIdInput: unknown, bodyInput: unknown = {}): Record<string, unknown> {
  const sessionId = z.string().min(1).parse(sessionIdInput);
  const body = WizardLaunchSchema.parse(bodyInput);
  const session = getWizardSessionRow(sessionId);
  if (!session) throw new Error(`Wizard session '${sessionId}' not found`);

  const state = getWizardSessionState(sessionId);
  const gates = (Array.isArray(state.gates) ? state.gates : []).map(asObject);
  const criticalBlocking = gates.filter((gate) => gate.class === "critical" && gate.status !== "green");
  if (criticalBlocking.length > 0) {
    const gateList = criticalBlocking.map((gate) => String(gate.id)).join(", ");
    throw new Error(`Launch blocked by critical gates: ${gateList}`);
  }

  const nonCriticalBlocking = gates.filter((gate) => gate.class === "overridable" && gate.status === "red");
  if (body.mode === "production" && nonCriticalBlocking.length > 0) {
    const gateList = nonCriticalBlocking.map((gate) => String(gate.id)).join(", ");
    throw new Error(`Production launch requires overrides for non-critical red gates: ${gateList}`);
  }

  const report = buildOnboardingReport({ onboardingId: session.onboarding_id, autoCaptureCurrent: true });
  const readinessPayload = {
    wizardSessionId: sessionId,
    mode: body.mode,
    gates,
    criticalBlocking,
    nonCriticalBlocking,
  };
  const pilotRunId = createPilotLaunchRun({
    status: body.mode === "production" ? "launched" : "dry_run",
    readiness: readinessPayload,
    salesPacket: body.mode === "production" ? { format: "wizard", generatedAt: nowIso() } : undefined,
    delivery: {
      mode: body.mode,
      at: nowIso(),
      warnAndContinue: nonCriticalBlocking.length === 0 ? false : true,
    },
  });

  if (body.mode === "production") {
    updateWizardState(
      sessionId,
      (currentState) => ({ ...currentState, lastLaunchAt: nowIso(), launchPilotRunId: pilotRunId }),
      { status: "launched", launchMode: "production", launchedAt: nowIso() },
    );
  } else {
    updateWizardState(
      sessionId,
      (currentState) => ({ ...currentState, lastSandboxLaunchAt: nowIso(), launchPilotRunId: pilotRunId }),
      { status: "completed", launchMode: "sandbox" },
    );
  }

  return {
    session: getWizardSessionState(sessionId),
    pilotLaunchRunId: pilotRunId,
    mode: body.mode,
    report,
    executive: getExecutiveAnalytics({ workspaceId: session.workspace_id }),
    ops: getOpsAnalytics({ since: session.created_at }),
    sla: getWorkflowSlaStatus({ product: "quote-to-order" }),
  };
}

export function getWizardSessionReport(sessionIdInput: unknown): Record<string, unknown> {
  const sessionId = z.string().min(1).parse(sessionIdInput);
  const session = getWizardSessionRow(sessionId);
  if (!session) throw new Error(`Wizard session '${sessionId}' not found`);
  return {
    session: getWizardSessionState(sessionId),
    onboarding: buildOnboardingReport({ onboardingId: session.onboarding_id, autoCaptureCurrent: true }),
    executive: getExecutiveAnalytics({ workspaceId: session.workspace_id }),
    ops: getOpsAnalytics({ since: session.created_at }),
    sla: getWorkflowSlaStatus({ product: "quote-to-order" }),
    incidents: listWorkflowSlaIncidents({ product: "quote-to-order", limit: 50 }),
  };
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
  const conversionRow = db.query<{ submittedAt: string | null; convertedAt: string | null }, unknown[]>(
    `SELECT MIN(created_at) as submittedAt, MIN(converted_at) as convertedAt
     FROM quote_to_order_records
     ${clause.length > 0 ? `${clause} AND converted_at IS NOT NULL` : "WHERE converted_at IS NOT NULL"}`
  ).get(...params);
  const timeToFirstOrderConversionHours = conversionRow?.submittedAt && conversionRow?.convertedAt
    ? Number(((Date.parse(conversionRow.convertedAt) - Date.parse(conversionRow.submittedAt)) / 3600000).toFixed(2))
    : null;

  return {
    timeframe: { since: filters.since ?? "all_time" },
    workspaceId: filters.workspaceId ?? "all",
    quoteToOrderConversionRatePct: conversionRate,
    medianApprovalTimeMinutes: median(approvalRows.map((r) => num(r.mins)).filter((v) => v > 0)),
    revenueAtRiskEur: Math.round(num(totals?.revenueRisk)),
    timeSavedHours: Number(timeSavedHours.toFixed(1)),
    manualStepsRemoved: Math.round(manualStepsRemoved),
    estimatedValueEur: Math.round(estimatedValue),
    timeToFirstOrderConversionHours,
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
    entity_type: "lead" | "deal" | "invoice" | "quote" | "order" | "activity";
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

// ─── Customer 360 ────────────────────────────────────────────────────

interface Customer360ProfileRow {
  id: string;
  workspace_id: string;
  customer_external_id: string;
  display_name: string | null;
  segment: Customer360Segment;
  health_score: number;
  health_engagement: number;
  health_revenue: number;
  health_sentiment: number;
  health_responsiveness: number;
  churn_risk_pct: number;
  total_quotes: number;
  total_orders: number;
  total_revenue: number;
  avg_deal_size: number;
  conversion_rate: number;
  last_interaction_at: string | null;
  first_interaction_at: string | null;
  contacts_json: string;
  metadata_json: string;
  computed_at: string;
  created_at: string;
  updated_at: string;
}

interface Customer360HealthData {
  communicationCount: number;
  daysSinceLastInteraction: number;
  activeQuoteCount: number;
  totalRevenue: number;
  avgDealSize: number;
  workspaceAvgDealSize: number;
  conversionRate: number;
  sentimentCounts: { positive: number; neutral: number; negative: number };
  avgResponseHours: number;
  overdueFollowupRatio: number;
}

interface Customer360HealthWeights {
  engagement: number;
  revenue: number;
  sentiment: number;
  responsiveness: number;
}

interface Customer360HealthResult {
  score: number;
  engagement: number;
  revenue: number;
  sentiment: number;
  responsiveness: number;
}

interface Customer360Metrics {
  healthScore: number;
  conversionRate: number;
  totalQuotes: number;
  convertedQuotes: number;
  daysSinceLastInteraction: number;
  daysSinceFirstInteraction: number;
  sentimentTrend: number;
  overdueFollowupCount: number;
  rejectionRate: number;
}

interface Customer360TimelineEntry {
  type: Customer360InteractionType;
  timestamp: string;
  summary: string;
  details: Record<string, unknown>;
}

function computeCustomer360Health(
  data: Customer360HealthData,
  weights: Customer360HealthWeights = { engagement: 0.3, revenue: 0.3, sentiment: 0.2, responsiveness: 0.2 },
): Customer360HealthResult {
  // Engagement: communication frequency + recency + active quotes
  const recencyScore = data.daysSinceLastInteraction <= 7 ? 100
    : data.daysSinceLastInteraction <= 14 ? 80
    : data.daysSinceLastInteraction <= 30 ? 60
    : data.daysSinceLastInteraction <= 60 ? 30
    : 10;
  const commFreqScore = Math.min(100, data.communicationCount * 10);
  const activeQuoteScore = Math.min(100, data.activeQuoteCount * 25);
  const engagement = Math.round(recencyScore * 0.4 + commFreqScore * 0.3 + activeQuoteScore * 0.3);

  // Revenue: total revenue relative to workspace avg, conversion rate
  const dealSizeRatio = data.workspaceAvgDealSize > 0
    ? Math.min(2, data.avgDealSize / data.workspaceAvgDealSize) : 0.5;
  const revenueBase = Math.min(100, data.totalRevenue > 0 ? 40 + dealSizeRatio * 30 : 0);
  const convBonus = data.conversionRate * 100 * 0.3;
  const revenue = Math.round(Math.min(100, revenueBase + convBonus));

  // Sentiment: weighted from communication sentiment distribution
  const totalSentiment = data.sentimentCounts.positive + data.sentimentCounts.neutral + data.sentimentCounts.negative;
  const sentiment = totalSentiment > 0
    ? Math.round(
        (data.sentimentCounts.positive * 100 + data.sentimentCounts.neutral * 50 + data.sentimentCounts.negative * 10)
        / totalSentiment,
      )
    : 50;

  // Responsiveness: based on response time and overdue ratio
  const responseScore = data.avgResponseHours <= 4 ? 100
    : data.avgResponseHours <= 12 ? 80
    : data.avgResponseHours <= 24 ? 60
    : data.avgResponseHours <= 72 ? 30
    : 10;
  const overdueDeduction = Math.min(50, data.overdueFollowupRatio * 100);
  const responsiveness = Math.round(Math.max(0, responseScore - overdueDeduction));

  const score = Math.round(
    engagement * weights.engagement
    + revenue * weights.revenue
    + sentiment * weights.sentiment
    + responsiveness * weights.responsiveness,
  );

  return { score, engagement, revenue, sentiment, responsiveness };
}

function computeCustomer360Segment(metrics: Customer360Metrics): Customer360Segment {
  const { healthScore, conversionRate, daysSinceLastInteraction, daysSinceFirstInteraction, totalQuotes } = metrics;

  if (daysSinceFirstInteraction <= 30 && totalQuotes <= 2) return "new";
  if (daysSinceLastInteraction > 90 && totalQuotes <= 1) return "dormant";
  if (healthScore < 20 || daysSinceLastInteraction > 60) return "churning";
  if (healthScore < 40) return "at_risk";
  if (healthScore >= 80 && conversionRate >= 0.5 && daysSinceLastInteraction <= 30) return "champion";
  if (healthScore >= 60 && metrics.convertedQuotes >= 2) return "loyal";
  return "promising";
}

function computeCustomer360ChurnRisk(metrics: Customer360Metrics): { riskPct: number; factors: string[] } {
  const factors: string[] = [];
  let risk = 0;

  // Days since last interaction (0-30 points)
  if (metrics.daysSinceLastInteraction > 90) { risk += 30; factors.push("no_interaction_90d"); }
  else if (metrics.daysSinceLastInteraction > 60) { risk += 20; factors.push("no_interaction_60d"); }
  else if (metrics.daysSinceLastInteraction > 30) { risk += 10; factors.push("no_interaction_30d"); }

  // Sentiment trend (0-25 points)
  if (metrics.sentimentTrend < -0.3) { risk += 25; factors.push("sentiment_declining_fast"); }
  else if (metrics.sentimentTrend < 0) { risk += 10; factors.push("sentiment_declining"); }

  // Overdue followups (0-20 points)
  if (metrics.overdueFollowupCount > 3) { risk += 20; factors.push("many_overdue_followups"); }
  else if (metrics.overdueFollowupCount > 0) { risk += 10; factors.push("overdue_followups"); }

  // Rejection rate (0-15 points)
  if (metrics.rejectionRate > 0.5) { risk += 15; factors.push("high_rejection_rate"); }
  else if (metrics.rejectionRate > 0.2) { risk += 8; factors.push("moderate_rejection_rate"); }

  // Low engagement (0-10 points)
  if (metrics.healthScore < 30) { risk += 10; factors.push("low_health_score"); }

  return { riskPct: Math.min(100, risk), factors };
}

// ========== Customer 360 Profile Helper Functions ==========

/**
 * Try to retrieve a cached Customer 360 profile.
 * Returns the cached profile if found and not expired (1-hour TTL), otherwise null.
 */
function tryGetCachedProfile(
  workspaceId: string,
  customerExternalId: string,
): Record<string, unknown> | null {
  const cached = db.query<Customer360ProfileRow, [string, string]>(
    `SELECT * FROM customer360_profiles WHERE workspace_id = ? AND customer_external_id = ? LIMIT 1`,
  ).get(workspaceId, customerExternalId);

  if (!cached) return null;

  const age = Date.now() - new Date(cached.computed_at).getTime();
  if (age >= 3600_000) return null;

  const {
    contacts_json,
    metadata_json,
    workspace_id,
    customer_external_id,
    ...publicFields
  } = cached as unknown as Record<string, any>;

  return {
    ...publicFields,
    contacts: JSON.parse(contacts_json),
    metadata: JSON.parse(metadata_json),
    fromCache: true,
  };
}

/**
 * Fetch master data for a customer.
 */
function fetchCustomer360MasterData(
  workspaceId: string,
  customerExternalId: string,
): { masterPayload: Record<string, unknown>; displayName: string } {
  const masterRow = db.query<MasterDataRecordRow, [string, string]>(
    `SELECT * FROM erp_master_data_records WHERE workspace_id = ? AND entity = 'customer' AND external_id = ? LIMIT 1`,
  ).get(workspaceId, customerExternalId);

  const masterPayload = masterRow ? JSON.parse(masterRow.payload_json) as Record<string, unknown> : {};
  const displayName = (masterPayload.name as string) || (masterPayload.displayName as string) || customerExternalId;

  return { masterPayload, displayName };
}

interface QuoteMetricsResult {
  quotes: QuoteToOrderRecordRow[];
  totalQuotes: number;
  convertedQuotes: number;
  fulfilledQuotes: number;
  rejectedQuotes: number;
  totalRevenue: number;
  avgDealSize: number;
  conversionRate: number;
  rejectionRate: number;
  activeQuotes: QuoteToOrderRecordRow[];
  workspaceAvgDealSize: number;
}

/**
 * Fetch and compute quote-related metrics for a customer.
 */
function fetchCustomer360QuoteMetrics(
  workspaceId: string,
  customerExternalId: string,
): QuoteMetricsResult {
  const quotes = db.query<QuoteToOrderRecordRow, [string, string]>(
    `SELECT * FROM quote_to_order_records WHERE workspace_id = ? AND customer_external_id = ?`,
  ).all(workspaceId, customerExternalId);

  const totalQuotes = quotes.length;
  const convertedQuotes = quotes.filter(q => q.state === "converted_to_order" || q.state === "fulfilled").length;
  const fulfilledQuotes = quotes.filter(q => q.state === "fulfilled").length;
  const rejectedQuotes = quotes.filter(q => q.state === "rejected").length;
  const totalRevenue = quotes
    .filter(q => q.state === "converted_to_order" || q.state === "fulfilled")
    .reduce((sum, q) => sum + q.amount, 0);
  const avgDealSize = convertedQuotes > 0 ? totalRevenue / convertedQuotes : 0;
  const conversionRate = totalQuotes > 0 ? convertedQuotes / totalQuotes : 0;
  const rejectionRate = totalQuotes > 0 ? rejectedQuotes / totalQuotes : 0;
  const activeQuotes = quotes.filter(q => q.state === "draft" || q.state === "submitted" || q.state === "approved");

  // Workspace average deal size for comparison
  const wsAvgRow = db.query<{ avg_deal: number }, [string]>(
    `SELECT COALESCE(AVG(amount), 0) as avg_deal FROM quote_to_order_records
     WHERE workspace_id = ? AND state IN ('converted_to_order', 'fulfilled') AND amount > 0`,
  ).get(workspaceId);
  const workspaceAvgDealSize = wsAvgRow?.avg_deal ?? 0;

  return {
    quotes,
    totalQuotes,
    convertedQuotes,
    fulfilledQuotes,
    rejectedQuotes,
    totalRevenue,
    avgDealSize,
    conversionRate,
    rejectionRate,
    activeQuotes,
    workspaceAvgDealSize,
  };
}

interface CommunicationMetricsResult {
  commRows: QuoteCommunicationEventRow[];
  sentimentCounts: { positive: number; neutral: number; negative: number };
  sentimentTrend: number;
  avgResponseHours: number;
}

/**
 * Fetch and compute communication-related metrics for a customer.
 */
function fetchCustomer360CommunicationMetrics(
  workspaceId: string,
  quoteIds: string[],
): CommunicationMetricsResult {
  let commRows: QuoteCommunicationEventRow[] = [];
  if (quoteIds.length > 0) {
    const placeholders = quoteIds.map(() => "?").join(",");
    commRows = db.query<QuoteCommunicationEventRow, unknown[]>(
      `SELECT * FROM quote_communication_events
       WHERE workspace_id = ? AND quote_external_id IN (${placeholders})
       ORDER BY occurred_at DESC`,
    ).all(workspaceId, ...quoteIds);
  }

  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  for (const c of commRows) sentimentCounts[c.sentiment]++;

  // Sentiment trend: compare recent half vs older half
  let sentimentTrend = 0;
  if (commRows.length >= 4) {
    const mid = Math.floor(commRows.length / 2);
    const sentimentVal = (s: string) => s === "positive" ? 1 : s === "negative" ? -1 : 0;
    const recentAvg = commRows.slice(0, mid).reduce((s, c) => s + sentimentVal(c.sentiment), 0) / mid;
    const olderAvg = commRows.slice(mid).reduce((s, c) => s + sentimentVal(c.sentiment), 0) / (commRows.length - mid);
    sentimentTrend = recentAvg - olderAvg;
  }

  // Avg response hours (estimate from consecutive inbound→outbound pairs)
  let totalResponseHours = 0;
  let responsePairs = 0;
  for (let i = 1; i < commRows.length; i++) {
    if (commRows[i].direction === "inbound" && commRows[i - 1].direction === "outbound") {
      const diff = new Date(commRows[i - 1].occurred_at).getTime() - new Date(commRows[i].occurred_at).getTime();
      if (diff > 0) {
        totalResponseHours += diff / 3_600_000;
        responsePairs++;
      }
    }
  }
  const avgResponseHours = responsePairs > 0 ? totalResponseHours / responsePairs : 24;

  return { commRows, sentimentCounts, sentimentTrend, avgResponseHours };
}

interface FollowupMetricsResult {
  overdueFollowupCount: number;
  totalFollowups: number;
  overdueFollowupRatio: number;
}

/**
 * Fetch and compute followup-related metrics for a customer.
 */
function fetchCustomer360FollowupMetrics(
  workspaceId: string,
  quoteIds: string[],
): FollowupMetricsResult {
  let overdueFollowupCount = 0;
  let totalFollowups = 0;

  if (quoteIds.length > 0) {
    const placeholders = quoteIds.map(() => "?").join(",");
    const followupRows = db.query<{ status: string; due_at: string }, unknown[]>(
      `SELECT status, due_at FROM quote_followup_actions
       WHERE workspace_id = ? AND quote_external_id IN (${placeholders})`,
    ).all(workspaceId, ...quoteIds);
    totalFollowups = followupRows.length;
    overdueFollowupCount = followupRows.filter(
      f => f.status === "open" && new Date(f.due_at) < new Date(),
    ).length;
  }

  const overdueFollowupRatio = totalFollowups > 0 ? overdueFollowupCount / totalFollowups : 0;
  return { overdueFollowupCount, totalFollowups, overdueFollowupRatio };
}

interface InteractionDatesResult {
  firstInteractionAt: string | null;
  lastInteractionAt: string | null;
  daysSinceLastInteraction: number;
  daysSinceFirstInteraction: number;
}

/**
 * Compute interaction date metrics from quotes and communication events.
 */
function computeCustomer360InteractionDates(
  quotes: QuoteToOrderRecordRow[],
  commRows: QuoteCommunicationEventRow[],
): InteractionDatesResult {
  let minTime: number | null = null;
  let maxTime: number | null = null;

  for (const q of quotes) {
    const t = new Date(q.created_at).getTime();
    if (Number.isNaN(t)) continue;
    if (minTime === null || t < minTime) minTime = t;
    if (maxTime === null || t > maxTime) maxTime = t;
  }

  for (const c of commRows) {
    const t = new Date(c.occurred_at).getTime();
    if (Number.isNaN(t)) continue;
    if (minTime === null || t < minTime) minTime = t;
    if (maxTime === null || t > maxTime) maxTime = t;
  }

  const firstInteractionAt = minTime !== null ? new Date(minTime).toISOString() : null;
  const lastInteractionAt = maxTime !== null ? new Date(maxTime).toISOString() : null;
  const daysSinceLastInteraction = lastInteractionAt
    ? (Date.now() - new Date(lastInteractionAt).getTime()) / 86_400_000
    : 999;
  const daysSinceFirstInteraction = firstInteractionAt
    ? (Date.now() - new Date(firstInteractionAt).getTime()) / 86_400_000
    : 0;

  return { firstInteractionAt, lastInteractionAt, daysSinceLastInteraction, daysSinceFirstInteraction };
}

/**
 * Fetch revenue graph contacts for a customer.
 */
function fetchCustomer360Contacts(
  workspaceId: string,
  customerExternalId: string,
): Record<string, unknown>[] {
  const accountKey = revenueGraphKey("account", customerExternalId);
  const contactEdges = db.query<RevenueGraphEdgeRow, [string, string]>(
    `SELECT * FROM revenue_graph_edges
     WHERE workspace_id = ? AND from_entity_key = ? AND relation IN ('has_contact', 'employs')`,
  ).all(workspaceId, accountKey);

  const contacts: Record<string, unknown>[] = [];
  for (const edge of contactEdges) {
    const contactEntity = db.query<RevenueGraphEntityRow, [string, string]>(
      `SELECT * FROM revenue_graph_entities WHERE workspace_id = ? AND entity_key = ? LIMIT 1`,
    ).get(workspaceId, edge.to_entity_key);
    if (contactEntity) {
      const attrs = JSON.parse(contactEntity.attributes_json) as Record<string, unknown>;
      const consentStatus = getConsentStatus(workspaceId, contactEntity.external_id ?? edge.to_entity_key);
      contacts.push({
        entityKey: contactEntity.entity_key,
        externalId: contactEntity.external_id,
        attributes: attrs,
        consentStatus,
        relation: edge.relation,
      });
    }
  }

  return contacts;
}

/**
 * Persist the computed Customer 360 profile to the database.
 */
type Customer360ProfilePersistInput = {
  workspaceId: string;
  customerExternalId: string;
  displayName: string;
  segment: Customer360Segment;
  health: Customer360HealthResult;
  churn: { riskPct: number; factors: string[] };
  totalQuotes: number;
  fulfilledQuotes: number;
  totalRevenue: number;
  avgDealSize: number;
  conversionRate: number;
  lastInteractionAt: string | null;
  firstInteractionAt: string | null;
  contacts: Record<string, unknown>[];
  masterPayload: Record<string, unknown>;
  now: string;
};

function persistCustomer360Profile(input: Customer360ProfilePersistInput): void {
  const {
    workspaceId,
    customerExternalId,
    displayName,
    segment,
    health,
    churn,
    totalQuotes,
    fulfilledQuotes,
    totalRevenue,
    avgDealSize,
    conversionRate,
    lastInteractionAt,
    firstInteractionAt,
    contacts,
    masterPayload,
    now,
  } = input;
  const profileId = randomUUID();
  db.run(
    `INSERT INTO customer360_profiles (
      id, workspace_id, customer_external_id, display_name, segment,
      health_score, health_engagement, health_revenue, health_sentiment, health_responsiveness,
      churn_risk_pct, total_quotes, total_orders, total_revenue, avg_deal_size, conversion_rate,
      last_interaction_at, first_interaction_at, contacts_json, metadata_json, computed_at, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id, customer_external_id) DO UPDATE SET
      display_name = excluded.display_name, segment = excluded.segment,
      health_score = excluded.health_score, health_engagement = excluded.health_engagement,
      health_revenue = excluded.health_revenue, health_sentiment = excluded.health_sentiment,
      health_responsiveness = excluded.health_responsiveness, churn_risk_pct = excluded.churn_risk_pct,
      total_quotes = excluded.total_quotes, total_orders = excluded.total_orders,
      total_revenue = excluded.total_revenue, avg_deal_size = excluded.avg_deal_size,
      conversion_rate = excluded.conversion_rate, last_interaction_at = excluded.last_interaction_at,
      first_interaction_at = excluded.first_interaction_at, contacts_json = excluded.contacts_json,
      metadata_json = excluded.metadata_json, computed_at = excluded.computed_at, updated_at = excluded.updated_at`,
    profileId, workspaceId, customerExternalId, displayName, segment,
    health.score, health.engagement, health.revenue, health.sentiment, health.responsiveness,
    churn.riskPct, totalQuotes, fulfilledQuotes, totalRevenue, avgDealSize, conversionRate,
    lastInteractionAt, firstInteractionAt, JSON.stringify(contacts), JSON.stringify(masterPayload),
    now, now, now,
  );
}

/**
 * Create a health history snapshot (max 1 per day).
 */
function createCustomer360HealthSnapshot(
  workspaceId: string,
  customerExternalId: string,
  health: Customer360HealthResult,
  segment: Customer360Segment,
  churnRiskPct: number,
  now: string,
): void {
  const nowDate = new Date(now);
  const dayStart = new Date(Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate(),
    0, 0, 0, 0,
  ));
  const nextDayStart = new Date(Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  const dayStartIso = dayStart.toISOString();
  const nextDayStartIso = nextDayStart.toISOString();

  const existingSnapshot = db.query<{ id: string }, [string, string, string, string]>(
    `SELECT id FROM customer360_health_history
     WHERE workspace_id = ? AND customer_external_id = ? AND created_at >= ? AND created_at < ?
     LIMIT 1`,
  ).get(workspaceId, customerExternalId, dayStartIso, nextDayStartIso);

  if (!existingSnapshot) {
    db.run(
      `INSERT INTO customer360_health_history (
        id, workspace_id, customer_external_id, health_score,
        health_engagement, health_revenue, health_sentiment, health_responsiveness,
        segment, churn_risk_pct, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      randomUUID(), workspaceId, customerExternalId, health.score,
      health.engagement, health.revenue, health.sentiment, health.responsiveness,
      segment, churnRiskPct, now,
    );
  }
}

// ========== Main Customer 360 Profile Function ==========

export function getCustomer360Profile(
  workspaceIdInput: unknown,
  customerExternalIdInput: unknown,
  forceRefreshInput: unknown = false,
): Record<string, unknown> {
  const workspaceId = z.string().min(1).parse(workspaceIdInput);
  const customerExternalId = z.string().min(1).parse(customerExternalIdInput);
  const forceRefresh = z.boolean().optional().default(false).parse(forceRefreshInput);

  // Try cache first
  if (!forceRefresh) {
    const cached = tryGetCachedProfile(workspaceId, customerExternalId);
    if (cached) return cached;
  }

  const now = nowIso();

  // Fetch master data
  const { masterPayload, displayName } = fetchCustomer360MasterData(workspaceId, customerExternalId);

  // Fetch and compute quote metrics
  const quoteMetrics = fetchCustomer360QuoteMetrics(workspaceId, customerExternalId);
  const { quotes, totalQuotes, convertedQuotes, fulfilledQuotes, rejectedQuotes, totalRevenue, avgDealSize, conversionRate, rejectionRate, activeQuotes, workspaceAvgDealSize } = quoteMetrics;

  // Fetch and compute communication metrics
  const quoteIds = quotes.map(q => q.quote_external_id);
  const commMetrics = fetchCustomer360CommunicationMetrics(workspaceId, quoteIds);
  const { commRows, sentimentCounts, sentimentTrend, avgResponseHours } = commMetrics;

  // Fetch followup metrics
  const followupMetrics = fetchCustomer360FollowupMetrics(workspaceId, quoteIds);
  const { overdueFollowupCount, totalFollowups, overdueFollowupRatio } = followupMetrics;

  // Compute interaction dates
  const interactionDates = computeCustomer360InteractionDates(quotes, commRows);
  const { firstInteractionAt, lastInteractionAt, daysSinceLastInteraction, daysSinceFirstInteraction } = interactionDates;

  // Fetch contacts
  const contacts = fetchCustomer360Contacts(workspaceId, customerExternalId);

  // Compute health, segment, and churn risk
  const healthData: Customer360HealthData = {
    communicationCount: commRows.length,
    daysSinceLastInteraction,
    activeQuoteCount: activeQuotes.length,
    totalRevenue,
    avgDealSize,
    workspaceAvgDealSize,
    conversionRate,
    sentimentCounts,
    avgResponseHours,
    overdueFollowupRatio,
  };
  const health = computeCustomer360Health(healthData);

  const segmentMetrics: Customer360Metrics = {
    healthScore: health.score,
    conversionRate,
    totalQuotes,
    convertedQuotes,
    daysSinceLastInteraction,
    daysSinceFirstInteraction,
    sentimentTrend,
    overdueFollowupCount,
    rejectionRate,
  };
  const segment = computeCustomer360Segment(segmentMetrics);
  const churn = computeCustomer360ChurnRisk(segmentMetrics);

  // Persist profile to database
  persistCustomer360Profile(
    workspaceId,
    customerExternalId,
    displayName,
    segment,
    health,
    churn,
    totalQuotes,
    fulfilledQuotes,
    totalRevenue,
    avgDealSize,
    conversionRate,
    lastInteractionAt,
    firstInteractionAt,
    contacts,
    masterPayload,
    now,
  );

  // Create health history snapshot
  createCustomer360HealthSnapshot(workspaceId, customerExternalId, health, segment, churn.riskPct, now);

  return {
    workspaceId,
    customerExternalId,
    displayName,
    segment,
    health: { score: health.score, engagement: health.engagement, revenue: health.revenue, sentiment: health.sentiment, responsiveness: health.responsiveness },
    churnRisk: churn,
    quotes: { total: totalQuotes, converted: convertedQuotes, fulfilled: fulfilledQuotes, rejected: rejectedQuotes, active: activeQuotes.length },
    revenue: { total: totalRevenue, avgDealSize, conversionRate },
    interactions: { communicationCount: commRows.length, lastAt: lastInteractionAt, firstAt: firstInteractionAt, avgResponseHours: Math.round(avgResponseHours * 10) / 10 },
    contacts,
    followups: { total: totalFollowups, overdue: overdueFollowupCount },
    sentimentDistribution: sentimentCounts,
    sentimentTrend: Math.round(sentimentTrend * 100) / 100,
    computedAt: now,
    fromCache: false,
  };
}

export function getCustomer360Health(
  workspaceIdInput: unknown,
  customerExternalIdInput: unknown,
  weightsInput: unknown = undefined,
): Record<string, unknown> {
  const opts = Customer360HealthInputSchema.parse({
    workspaceId: workspaceIdInput,
    customerExternalId: customerExternalIdInput,
    weights: weightsInput,
  });
  const weights = opts.weights ?? { engagement: 0.3, revenue: 0.3, sentiment: 0.2, responsiveness: 0.2 };

  // Reuse profile computation, then overlay custom weights
  const profile = getCustomer360Profile(opts.workspaceId, opts.customerExternalId, true) as Record<string, unknown>;
  const healthObj = profile.health as { score: number; engagement: number; revenue: number; sentiment: number; responsiveness: number };

  const reweighted = Math.round(
    healthObj.engagement * weights.engagement
    + healthObj.revenue * weights.revenue
    + healthObj.sentiment * weights.sentiment
    + healthObj.responsiveness * weights.responsiveness,
  );

  // Health history for trend
  const history = db.query<{ health_score: number; created_at: string }, [string, string]>(
    `SELECT health_score, created_at FROM customer360_health_history
     WHERE workspace_id = ? AND customer_external_id = ?
     ORDER BY created_at DESC LIMIT 30`,
  ).all(opts.workspaceId, opts.customerExternalId);

  return {
    workspaceId: opts.workspaceId,
    customerExternalId: opts.customerExternalId,
    score: reweighted,
    dimensions: { engagement: healthObj.engagement, revenue: healthObj.revenue, sentiment: healthObj.sentiment, responsiveness: healthObj.responsiveness },
    weights,
    history: history.map(h => ({ score: h.health_score, date: h.created_at })),
  };
}

export function getCustomer360Timeline(
  workspaceIdInput: unknown,
  customerExternalIdInput: unknown,
  optionsInput: unknown = {},
): Record<string, unknown> {
  const opts = Customer360TimelineInputSchema.parse({
    workspaceId: workspaceIdInput,
    customerExternalId: customerExternalIdInput,
    ...((optionsInput && typeof optionsInput === "object") ? optionsInput : {}),
  });

  const entries: Customer360TimelineEntry[] = [];
  const sinceFilter = opts.since ? new Date(opts.since).toISOString() : null;
  const allowedTypes = opts.interactionTypes ? new Set(opts.interactionTypes) : null;

  // Quote lifecycle events
  const quotes = db.query<QuoteToOrderRecordRow, [string, string]>(
    `SELECT * FROM quote_to_order_records WHERE workspace_id = ? AND customer_external_id = ?`,
  ).all(opts.workspaceId, opts.customerExternalId);

  for (const q of quotes) {
    const quoteEvent = (type: Customer360InteractionType, ts: string, summary: string) => {
      if (sinceFilter && ts < sinceFilter) return;
      if (allowedTypes && !allowedTypes.has(type)) return;
      entries.push({ type, timestamp: ts, summary, details: { quoteExternalId: q.quote_external_id, amount: q.amount, currency: q.currency, state: q.state } });
    };
    quoteEvent("quote_created", q.created_at, `Quote ${q.quote_external_id} created (${q.currency} ${q.amount})`);
    if (q.state === "approved" && q.approval_decided_at) quoteEvent("quote_approved", q.approval_decided_at, `Quote ${q.quote_external_id} approved`);
    if (q.state === "rejected" && q.approval_decided_at) quoteEvent("quote_rejected", q.approval_decided_at, `Quote ${q.quote_external_id} rejected`);
    if (q.converted_at) quoteEvent("quote_converted", q.converted_at, `Quote ${q.quote_external_id} converted to order`);
    if (q.fulfilled_at) quoteEvent("quote_fulfilled", q.fulfilled_at, `Quote ${q.quote_external_id} fulfilled`);
    if (q.order_external_id) quoteEvent("order_created", q.converted_at ?? q.updated_at, `Order ${q.order_external_id} created from quote ${q.quote_external_id}`);
  }

  // Communication events
  if (!allowedTypes || allowedTypes.has("communication")) {
    const quoteIds = quotes.map(q => q.quote_external_id);
    if (quoteIds.length > 0) {
      const placeholders = quoteIds.map(() => "?").join(",");
      let commSql = `SELECT * FROM quote_communication_events
        WHERE workspace_id = ? AND quote_external_id IN (${placeholders})`;
      const commParams: unknown[] = [opts.workspaceId, ...quoteIds];
      if (sinceFilter) { commSql += ` AND occurred_at >= ?`; commParams.push(sinceFilter); }
      commSql += ` ORDER BY occurred_at DESC`;
      const comms = db.query<QuoteCommunicationEventRow, unknown[]>(commSql).all(...commParams);
      for (const c of comms) {
        entries.push({
          type: "communication",
          timestamp: c.occurred_at,
          summary: `${c.direction} ${c.channel}${c.subject ? `: ${c.subject}` : ""}`,
          details: { channel: c.channel, direction: c.direction, sentiment: c.sentiment, quoteExternalId: c.quote_external_id, personalityType: c.personality_type },
        });
      }
    }
  }

  // Followup events
  if (!allowedTypes || allowedTypes.has("followup")) {
    const quoteIds = quotes.map(q => q.quote_external_id);
    if (quoteIds.length > 0) {
      const placeholders = quoteIds.map(() => "?").join(",");
      let fSql = `SELECT * FROM quote_followup_actions WHERE workspace_id = ? AND quote_external_id IN (${placeholders})`;
      const fParams: unknown[] = [opts.workspaceId, ...quoteIds];
      if (sinceFilter) { fSql += ` AND created_at >= ?`; fParams.push(sinceFilter); }
      const followups = db.query<QuoteFollowupActionRow, unknown[]>(fSql).all(...fParams);
      for (const f of followups) {
        entries.push({
          type: "followup",
          timestamp: f.created_at,
          summary: `${f.action_type} (${f.priority}) — ${f.status}`,
          details: { actionType: f.action_type, priority: f.priority, status: f.status, dueAt: f.due_at, quoteExternalId: f.quote_external_id },
        });
      }
    }
  }

  // Consent change events
  if (!allowedTypes || allowedTypes.has("consent_change")) {
    let auditSql = `SELECT * FROM trust_audit_log WHERE workspace_id = ? AND entity_type = 'contact'`;
    const auditParams: unknown[] = [opts.workspaceId];
    if (sinceFilter) { auditSql += ` AND created_at >= ?`; auditParams.push(sinceFilter); }
    auditSql += ` ORDER BY created_at DESC LIMIT 200`;
    const auditRows = db.query<TrustAuditRow, unknown[]>(auditSql).all(...auditParams);
    for (const a of auditRows) {
      entries.push({
        type: "consent_change",
        timestamp: a.created_at,
        summary: `Consent ${a.event_type} by ${a.actor}`,
        details: JSON.parse(a.details_json) as Record<string, unknown>,
      });
    }
  }

  // Sort by timestamp DESC, apply limit
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const limited = entries.slice(0, opts.limit);

  return { workspaceId: opts.workspaceId, customerExternalId: opts.customerExternalId, count: limited.length, totalAvailable: entries.length, items: limited };
}

export function getCustomer360Segments(filtersInput: unknown): Record<string, unknown> {
  const filters = Customer360SegmentsInputSchema.parse(filtersInput);

  // First ensure all known customers have profiles
  const knownCustomers = db.query<{ customer_external_id: string }, [string]>(
    `SELECT DISTINCT customer_external_id FROM quote_to_order_records
     WHERE workspace_id = ? AND customer_external_id IS NOT NULL`,
  ).all(filters.workspaceId);

  const profiledSet = new Set(
    db.query<{ customer_external_id: string }, [string]>(
      `SELECT customer_external_id FROM customer360_profiles WHERE workspace_id = ?`,
    ).all(filters.workspaceId).map(r => r.customer_external_id),
  );

  // Compute profiles for unprofiled customers (batch, up to 50 at a time)
  let computed = 0;
  for (const c of knownCustomers) {
    if (!profiledSet.has(c.customer_external_id) && computed < 50) {
      getCustomer360Profile(filters.workspaceId, c.customer_external_id);
      computed++;
    }
  }

  // Query profiles
  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [filters.workspaceId];
  if (filters.segment) {
    where.push("segment = ?");
    params.push(filters.segment);
  }
  params.push(filters.limit);

  const profiles = db.query<Customer360ProfileRow, unknown[]>(
    `SELECT * FROM customer360_profiles
     WHERE ${where.join(" AND ")}
     ORDER BY health_score DESC
     LIMIT ?`,
  ).all(...params);

  // Segment summary
  const segmentCounts = db.query<{ segment: string; cnt: number }, [string]>(
    `SELECT segment, COUNT(*) as cnt FROM customer360_profiles WHERE workspace_id = ? GROUP BY segment`,
  ).all(filters.workspaceId);
  const summary = Object.fromEntries(segmentCounts.map(s => [s.segment, s.cnt]));

  return {
    workspaceId: filters.workspaceId,
    segmentFilter: filters.segment ?? null,
    summary,
    count: profiles.length,
    items: profiles.map(p => ({
      customerExternalId: p.customer_external_id,
      displayName: p.display_name,
      segment: p.segment,
      healthScore: p.health_score,
      churnRiskPct: p.churn_risk_pct,
      totalRevenue: p.total_revenue,
      totalQuotes: p.total_quotes,
      lastInteractionAt: p.last_interaction_at,
    })),
  };
}

export function getCustomer360ChurnRisk(filtersInput: unknown): Record<string, unknown> {
  const filters = Customer360ChurnRiskInputSchema.parse(filtersInput);

  if (filters.customerExternalId) {
    // Single customer detailed view
    const profile = getCustomer360Profile(filters.workspaceId, filters.customerExternalId) as Record<string, unknown>;
    return {
      workspaceId: filters.workspaceId,
      customerExternalId: filters.customerExternalId,
      churnRisk: profile.churnRisk,
      healthScore: (profile.health as Record<string, unknown>).score,
      segment: profile.segment,
      lastInteractionAt: (profile.interactions as Record<string, unknown>).lastAt,
      sentimentTrend: profile.sentimentTrend,
    };
  }

  // All customers above threshold
  const rows = db.query<Customer360ProfileRow, [string, number, number]>(
    `SELECT * FROM customer360_profiles
     WHERE workspace_id = ? AND churn_risk_pct >= ?
     ORDER BY churn_risk_pct DESC
     LIMIT ?`,
  ).all(filters.workspaceId, filters.threshold, filters.limit);

  return {
    workspaceId: filters.workspaceId,
    threshold: filters.threshold,
    count: rows.length,
    items: rows.map(r => ({
      customerExternalId: r.customer_external_id,
      displayName: r.display_name,
      churnRiskPct: r.churn_risk_pct,
      segment: r.segment,
      healthScore: r.health_score,
      totalRevenue: r.total_revenue,
      lastInteractionAt: r.last_interaction_at,
    })),
  };
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
  db.run(`DELETE FROM customer360_health_history`);
  db.run(`DELETE FROM customer360_profiles`);
  db.run(`DELETE FROM trust_audit_log`);
  db.run(`DELETE FROM trust_contact_consents`);
  db.run(`DELETE FROM quote_deal_rescue_runs`);
  db.run(`DELETE FROM quote_autopilot_proposals`);
  db.run(`DELETE FROM revenue_graph_edges`);
  db.run(`DELETE FROM revenue_graph_entities`);
  db.run(`DELETE FROM wizard_gate_overrides`);
  db.run(`DELETE FROM wizard_sessions`);
  db.run(`DELETE FROM quote_followup_actions`);
  db.run(`DELETE FROM quote_communication_events`);
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
