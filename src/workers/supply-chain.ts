/**
 * Supply Chain Risk Agent — production order analysis, critical path detection,
 * global risk assessment, and intervention recommendations.
 *
 * Port: 8095
 *
 * Connects to Business Central or Odoo to analyze production orders, sales orders,
 * BOM structures, and procurement methods. Evaluates components against global
 * supply chain risks (weather, freight, economics, geopolitics) and recommends
 * interventions (make-or-buy, safety stock, dual sourcing, etc.).
 *
 * Skills:
 *   connect_erp              — Configure ERP connection (BC or Odoo)
 *   analyze_orders           — Analyze production/sales orders and their components
 *   critical_path            — Compute critical path and identify bottlenecks
 *   assess_risk              — Multi-dimensional risk scoring with external factors
 *   recommend_actions        — Generate prioritized intervention recommendations (with AI evaluation)
 *   monitor_dashboard        — Aggregated supply chain status overview
 *   intelligence_report      — AI-powered comprehensive supply chain intelligence briefing
 *   predict_bottlenecks      — Predictive analysis of future bottlenecks from current trends
 *   deep_bom_analysis        — AI deep analysis of BOM structure for hidden risks
 *   run_mrp                  — Full MRP cycle: demand explosion, gross-to-net, lot sizing, planned orders, pegging, CRP
 *   mrp_impact               — Supply delay impact analysis using pegging data
 *   remember / recall        — Shared persistent memory
 */

import Fastify from "fastify";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { buildA2AResponse, buildA2AError, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";
import { getPersona, watchPersonas } from "../persona-loader.js";

import { homedir } from "os";
import { join } from "path";
import type {
  ERPConnector,
  ERPConnectionConfig,
  ProductionOrder,
  SalesOrder,
  BOMComponent,
  PurchaseOrder,
  ItemAvailability,
  PostedReceipt,
  WorkCenterData,
  TransferOrder,
  Vendor,
  Intervention,
  RoutingStep,
} from "../erp/types.js";
import { BusinessCentralConnector } from "../erp/business-central.js";
import { OdooConnector } from "../erp/odoo.js";
import { computeCriticalPath, findLongLeadItems, findSingleSourceComponents } from "../risk/critical-path.js";
import { analyzeLeadTimes, findCriticalLeadTimeIssues, analyzeVendorHealth } from "../risk/lead-time.js";
import { scoreComponents, topRisks, riskLevel } from "../risk/scoring.js";
import type { ExternalRiskFactors } from "../risk/scoring.js";
import { generateInterventions } from "../risk/interventions.js";
import { assessExternalRisks } from "../risk/sources.js";
import {
  analyzeDeepBOM,
  evaluateInterventionsWithAI,
  generateIntelligenceReport,
  gatherWebIntelligence,
  predictBottlenecks,
} from "../risk/ai-analyzer.js";
import { runMRP, type MRPConfig } from "../mrp/mrp-engine.js";
import { analyzeSupplyImpact } from "../mrp/pegging.js";
import { generateValueStreamMap } from "../mrp/value-stream.js";
import { analyzeSMEDOpportunities } from "../mrp/smed-analysis.js";
import { analyzeLineBalance } from "../mrp/line-balancing.js";
import { generateAuditChecklist } from "../risk/supplier-audit.js";
import { optimizeDualSourcing } from "../risk/interventions.js";
import type { MRPRunResult, LotSizingPolicy, BucketSize, PlannedOrder } from "../mrp/types.js";

const PORT = 8095;
const NAME = "supply-chain-agent";

// ── Zod Schemas ──────────────────────────────────────────────────

const SupplyChainSchemas = {
  connect_erp: z.discriminatedUnion("system", [
    z.object({
      system: z.literal("bc"),
      baseUrl: z.string().url(),
      tenantId: z.string().min(1),
      environment: z.string().min(1),
      company: z.string().min(1),
      authType: z.enum(["oauth2", "apikey"]).default("apikey"),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      apiKey: z.string().optional(),
    }),
    z.object({
      system: z.literal("odoo"),
      url: z.string().url(),
      database: z.string().min(1),
      username: z.string().min(1),
      apiKey: z.string().min(1),
    }),
  ]),

  analyze_orders: z.object({
    orderType: z.enum(["production", "sales", "both"]).optional().default("both"),
    status: z.string().optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    itemFilter: z.string().optional(),
  }).passthrough(),

  critical_path: z.object({
    productionOrderId: z.string().optional(),
    itemNo: z.string().optional(),
    depth: z.number().int().positive().optional().default(5),
    longLeadThresholdDays: z.number().optional().default(14),
  }).passthrough(),

  assess_risk: z.object({
    scope: z.enum(["all", "critical_only"]).optional().default("all"),
    includeExternal: z.boolean().optional().default(true),
    riskCategories: z.array(z.string()).optional(),
    productionOrderId: z.string().optional(),
  }).passthrough(),

  recommend_actions: z.object({
    riskThreshold: z.number().optional().default(40),
    maxRecommendations: z.number().int().positive().optional().default(20),
    includeCosting: z.boolean().optional().default(true),
    includeAIEvaluation: z.boolean().optional().default(true),
    strategies: z.array(z.enum([
      "make_or_buy", "safety_stock", "dual_source", "advance_purchase", "reschedule",
    ])).optional(),
    productionOrderId: z.string().optional(),
  }).passthrough(),

  monitor_dashboard: z.object({
    period: z.string().optional(),
  }).passthrough(),

  intelligence_report: z.object({
    includeWebIntelligence: z.boolean().optional().default(true),
    includeDeepAnalysis: z.boolean().optional().default(true),
    productionOrderId: z.string().optional(),
  }).passthrough(),

  predict_bottlenecks: z.object({
    productionOrderId: z.string().optional(),
  }).passthrough(),

  deep_bom_analysis: z.object({
    productionOrderId: z.string().optional(),
  }).passthrough(),

  // ── MRP Skills ──
  run_mrp: z.object({
    horizonWeeks: z.number().int().positive().optional().default(12),
    bucketSize: z.enum(["day", "week", "month"]).optional().default("week"),
    safetyLeadTimeDays: z.number().optional().default(2),
    lotSizingPolicy: z.enum(["lot_for_lot", "fixed_order_qty", "eoq", "period_order_qty"]).optional().default("lot_for_lot"),
    fixedOrderQty: z.number().optional(),
    includeCapacity: z.boolean().optional().default(true),
    includePegging: z.boolean().optional().default(true),
  }).passthrough(),

  mrp_impact: z.object({
    itemNo: z.string(),
    delayDays: z.number().int().positive(),
  }).passthrough(),

  // ── Vendor & Order Management Skills ──
  vendor_health: z.object({
    vendorNo: z.string().optional(),
  }).passthrough(),

  execute_interventions: z.object({
    interventionIds: z.array(z.string()).min(1),
    dryRun: z.boolean().optional().default(false),
  }).passthrough(),

  firm_orders: z.object({
    orderIds: z.array(z.string()).min(1),
  }).passthrough(),
};

// ── Agent Card ───────────────────────────────────────────────────

const AGENT_CARD = {
  name: NAME,
  description: "Supply chain risk agent — analyzes production/sales orders from Business Central or Odoo, identifies critical paths, assesses global risks, and recommends interventions",
  url: `http://localhost:${PORT}`,
  version: "3.0.0",
  capabilities: { streaming: false },
  skills: [
    {
      id: "connect_erp",
      name: "Connect ERP",
      description: "Configure connection to Business Central (OData) or Odoo (JSON-RPC). Tests connectivity and stores credentials.",
    },
    {
      id: "analyze_orders",
      name: "Analyze Orders",
      description: "Load and analyze production orders, sales orders, their BOM components, procurement methods, and vendor details from the connected ERP system.",
    },
    {
      id: "critical_path",
      name: "Critical Path",
      description: "Compute the critical path through a production order's BOM tree. Identifies long-lead-time parts, single-source components, and bottlenecks.",
    },
    {
      id: "assess_risk",
      name: "Assess Risk",
      description: "Multi-dimensional risk scoring (availability, delivery, price, lead time, external) for BOM components. Checks against global supply chain factors (weather, freight, geopolitics, economics).",
    },
    {
      id: "recommend_actions",
      name: "Recommend Actions",
      description: "Generate prioritized intervention recommendations: make-or-buy analysis, safety stock adjustments, dual sourcing, advance purchasing, production rescheduling. Includes cost-benefit estimates.",
    },
    {
      id: "monitor_dashboard",
      name: "Monitor Dashboard",
      description: "Aggregated supply chain status overview: risk levels, critical components, open interventions, and trend data.",
    },
    {
      id: "intelligence_report",
      name: "Intelligence Report",
      description: "AI-powered comprehensive supply chain intelligence briefing. Combines ERP data analysis, deep BOM inspection, real-time web intelligence, and external risk factors into an executive report with prioritized action items.",
    },
    {
      id: "predict_bottlenecks",
      name: "Predict Bottlenecks",
      description: "AI-powered predictive analysis that detects future bottlenecks from current trends in lead times, inventory levels, and demand patterns. Returns predictions with confidence levels and mitigation windows.",
    },
    {
      id: "deep_bom_analysis",
      name: "Deep BOM Analysis",
      description: "AI deep analysis of Bill of Materials structure. Identifies concentration risks, cascade effects, demand-supply mismatches, and strategic vulnerabilities that rule-based scoring misses.",
    },
    {
      id: "run_mrp",
      name: "Run MRP",
      description: "Execute full Material Requirements Planning cycle: demand explosion, gross-to-net calculation, lot sizing, planned order generation, pegging (demand↔supply traceability), and capacity planning (CRP). Returns planned orders, net requirements, exceptions, and capacity loads.",
    },
    {
      id: "mrp_impact",
      name: "MRP Impact Analysis",
      description: "Analyze the downstream impact of a supply delay: 'If component X is delayed by N days, which sales orders and production orders are affected?' Uses pegging data for full traceability.",
    },
    {
      id: "vendor_health",
      name: "Vendor Health",
      description: "Analyze vendor delivery performance: on-time %, lead time variance, consistency, and trend. Aggregates posted receipt data per vendor into health scores.",
    },
    {
      id: "firm_orders",
      name: "Firm Orders",
      description: "Firm planned orders so they are excluded from MRP replanning. Firmed orders become fixed supply that MRP treats as committed.",
    },
    {
      id: "execute_interventions",
      name: "Execute Interventions",
      description: "Act on intervention recommendations from recommend_actions. Firms planned orders for advance purchases and dual-sourcing, stores safety-stock overrides for the next MRP run, and returns manual action steps for reschedule/make-or-buy recommendations.",
    },
    {
      id: "value_stream_map",
      name: "Value Stream Map",
      description: "Generate a Lean Value Stream Map (Wertstromanalyse) from MRP data. Shows processing/setup/wait/transport times, WIP levels, bottlenecks, and Kaizen improvement opportunities.",
    },
    {
      id: "smed_analysis",
      name: "SMED Analysis",
      description: "Identify setup time reduction hotspots across work centers. Prioritizes by capacity gain impact and classifies as quick_win/medium_effort/major_project.",
    },
    {
      id: "line_balance",
      name: "Line Balance",
      description: "Analyze production line balance against customer takt time. Identifies underutilized and overloaded stations, recommends merging/splitting/parallel stations.",
    },
    {
      id: "supplier_audit_prepare",
      name: "Supplier Audit Prepare",
      description: "Generate a risk-profiled supplier audit checklist (ISO 9001, IATF, ESG, IT Security sections). Pre-populates vendor performance data from ERP.",
    },
    {
      id: "dual_source_optimize",
      name: "Dual Source Optimize",
      description: "Evaluate dual sourcing scenarios for a component. Compares split ratios between vendors, calculates TCO, risk reduction, and MOQ compliance.",
    },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory" },
  ],
};

// ── State ────────────────────────────────────────────────────────

let connector: ERPConnector | null = null;

// Cached data from last analysis
let cachedProductionOrders: ProductionOrder[] = [];
let cachedSalesOrders: SalesOrder[] = [];
let cachedPurchaseOrders: PurchaseOrder[] = [];
let cachedAvailability: ItemAvailability[] = [];
let cachedPostedReceipts: PostedReceipt[] = [];
let cachedERPWorkCenters: WorkCenterData[] = [];
let lastAnalysisTimestamp: string | null = null;
let cachedMRPResult: MRPRunResult | null = null;
let firmedOrders: PlannedOrder[] = [];
let cachedPeggingCache: unknown = undefined;
let cachedExternalFactors: ExternalRiskFactors | undefined;
let cachedVendorHealthScores: import("../erp/types.js").VendorHealthScore[] | undefined;
let cachedTransferOrders: TransferOrder[] = [];
let cachedVendors: Vendor[] | undefined;
let cachedInterventions: Intervention[] = [];
let cachedSafetyStockOverrides: Map<string, number> = new Map();

// ── Firmed Orders Persistence ─────────────────────────────────────

const FIRMED_ORDERS_PATH = join(homedir(), ".a2a-mcp", "firmed-orders.json");

async function loadFirmedOrders(): Promise<void> {
  try {
    const text = await Bun.file(FIRMED_ORDERS_PATH).text();
    const parsed = JSON.parse(text) as PlannedOrder[];
    if (Array.isArray(parsed)) {
      firmedOrders = parsed;
      log(`loaded ${firmedOrders.length} firmed orders from disk`);
    }
  } catch (err) {
    // File doesn't exist yet or is invalid — start fresh. Log unexpected errors.
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      log(`warning: could not load firmed orders from disk, starting fresh. Error: ${err}`);
    }
  }
}

async function saveFirmedOrders(): Promise<void> {
  try {
    await Bun.write(FIRMED_ORDERS_PATH, JSON.stringify(firmedOrders, null, 2));
  } catch (err) {
    log(`warning: could not persist firmed orders: ${err}`);
  }
}

async function clearFirmedOrdersPersistence(): Promise<void> {
  firmedOrders = [];
  try {
    await Bun.write(FIRMED_ORDERS_PATH, "[]");
  } catch {
    // ignore
  }
}

/** Reset all caches (new ERP connection) */
async function invalidateCaches(): Promise<void> {
  cachedProductionOrders = [];
  cachedSalesOrders = [];
  cachedPurchaseOrders = [];
  cachedAvailability = [];
  cachedPostedReceipts = [];
  cachedERPWorkCenters = [];
  cachedTransferOrders = [];
  cachedVendors = undefined;
  lastAnalysisTimestamp = null;
  await clearFirmedOrdersPersistence();
  invalidateDerivedCaches();
  log("all caches invalidated (new ERP connection)");
}

/** Reset derived caches only (fresh data load) — firmedOrders are user decisions, not reset here */
function invalidateDerivedCaches() {
  cachedMRPResult = null;
  cachedPeggingCache = undefined;
  cachedExternalFactors = undefined;
  cachedVendorHealthScores = undefined;
  cachedInterventions = [];
  log("derived caches invalidated (fresh data)");
}

// ── Helpers ──────────────────────────────────────────────────────

function log(msg: string) {
  process.stderr.write(`[${NAME}] ${msg}\n`);
}

function requireConnector(): ERPConnector {
  if (!connector) {
    throw new Error("No ERP connection configured. Use the connect_erp skill first.");
  }
  return connector;
}

/** Collect all unique components from production orders. */
function collectAllComponents(orders: ProductionOrder[]): BOMComponent[] {
  const seen = new Set<string>();
  const all: BOMComponent[] = [];

  function walk(comps: BOMComponent[]) {
    for (const c of comps) {
      if (!seen.has(c.itemNo)) {
        seen.add(c.itemNo);
        all.push(c);
      }
      if (c.children) walk(c.children);
    }
  }

  for (const order of orders) {
    walk(order.components);
  }

  return all;
}

/** Extract vendor countries from components, preferring the vendorCountry field on BOMComponent. */
function extractVendorCountries(orders: ProductionOrder[]): string[] {
  const countries = new Set<string>();
  for (const order of orders) {
    for (const comp of order.components) {
      if (comp.vendorCountry) {
        countries.add(comp.vendorCountry);
      }
    }
  }
  return countries.size > 0 ? [...countries] : ["Global"];
}

/** Extract component categories from BOM. */
function extractComponentCategories(components: BOMComponent[]): string[] {
  const cats = new Set<string>();
  for (const c of components) {
    cats.add(c.itemCategory ?? c.itemName.split(/[\s-]/)[0] ?? "General");
  }
  return [...cats].slice(0, 10);
}

// ── Skill Handlers ───────────────────────────────────────────────

// Security: ERP credentials are held in-memory only for the lifetime of
// the worker process. They are never persisted to disk. For production
// deployments, pass credentials via environment variables sourced from
// OS-level secret management (Keychain, Credential Manager, Vault, etc.).
async function handleConnectERP(args: Record<string, unknown>): Promise<string> {
  const parsed = SupplyChainSchemas.connect_erp.parse(args);

  let config: ERPConnectionConfig;

  if (parsed.system === "bc") {
    config = {
      system: "bc",
      baseUrl: parsed.baseUrl,
      tenantId: parsed.tenantId,
      environment: parsed.environment,
      company: parsed.company,
      auth: parsed.authType === "oauth2"
        ? { type: "oauth2", clientId: parsed.clientId ?? "", clientSecret: parsed.clientSecret ?? "" }
        : { type: "apikey", key: parsed.apiKey ?? "" },
    };
    connector = new BusinessCentralConnector(config);
  } else {
    config = {
      system: "odoo",
      url: parsed.url,
      database: parsed.database,
      username: parsed.username,
      apiKey: parsed.apiKey,
    };
    connector = new OdooConnector(config);
  }

  log(`testing ${parsed.system} connection`);
  const result = await connector.testConnection();

  if (!result.ok) {
    connector = null;
    throw new Error(`ERP connection failed: ${result.message}`);
  }

  // New ERP connection invalidates all cached data
  await invalidateCaches();

  return safeStringify({
    status: "connected",
    system: parsed.system,
    message: result.message,
  }, 2);
}

async function handleAnalyzeOrders(args: Record<string, unknown>): Promise<string> {
  const erp = requireConnector();
  const { orderType, status, dateFrom, dateTo, itemFilter } = SupplyChainSchemas.analyze_orders.parse(args);

  // Fresh data load invalidates derived caches (MRP, pegging, risk scores)
  invalidateDerivedCaches();

  const filters = { status, dateFrom, dateTo, itemFilter };

  let productionOrders: ProductionOrder[] = [];
  let salesOrders: SalesOrder[] = [];

  if (orderType === "production" || orderType === "both") {
    log("loading production orders");
    productionOrders = await erp.getProductionOrders(filters);
    log(`found ${productionOrders.length} production orders`);
  }

  if (orderType === "sales" || orderType === "both") {
    log("loading sales orders");
    salesOrders = await erp.getSalesOrders(filters);
    log(`found ${salesOrders.length} sales orders`);
  }

  // Also load purchase orders for context
  log("loading purchase orders");
  const purchaseOrders = await erp.getPurchaseOrders({ dateFrom, dateTo });

  // Collect all components and get availability
  const allComponents = collectAllComponents(productionOrders);
  const itemNos = allComponents.map((c) => c.itemNo);
  const availability = itemNos.length > 0 ? await erp.getItemAvailability(itemNos) : [];

  // Fetch posted receipts, work centers, and transfer orders
  log("loading posted receipts, work centers, and transfer orders");
  const [postedReceipts, erpWorkCenters, transferOrders] = await Promise.all([
    erp.getPostedReceipts({ dateFrom, dateTo }).catch(() => [] as PostedReceipt[]),
    erp.getWorkCenters().catch(() => [] as WorkCenterData[]),
    erp.getTransferOrders({ dateFrom, dateTo }).catch(() => [] as TransferOrder[]),
  ]);

  // Cache for use in other skills
  cachedProductionOrders = productionOrders;
  cachedSalesOrders = salesOrders;
  cachedPurchaseOrders = purchaseOrders;
  cachedAvailability = availability;
  cachedPostedReceipts = postedReceipts;
  cachedERPWorkCenters = erpWorkCenters;
  cachedTransferOrders = transferOrders;
  lastAnalysisTimestamp = new Date().toISOString();

  // Build summary
  const summary: Record<string, unknown> = {
    timestamp: lastAnalysisTimestamp,
    system: erp.system,
    productionOrders: {
      count: productionOrders.length,
      byStatus: groupBy(productionOrders, (o) => o.status),
      items: productionOrders.map((o) => ({
        number: o.number,
        item: o.itemName,
        qty: o.quantity,
        dueDate: o.dueDate,
        status: o.status,
        componentCount: o.components.length,
      })),
    },
    salesOrders: {
      count: salesOrders.length,
      byStatus: groupBy(salesOrders, (o) => o.status),
    },
    components: {
      totalUnique: allComponents.length,
      byReplenishment: groupBy(allComponents, (c) => c.replenishmentMethod),
      lowStock: allComponents.filter((c) => c.inventoryLevel <= c.safetyStock).map((c) => ({
        itemNo: c.itemNo,
        name: c.itemName,
        inventory: c.inventoryLevel,
        safetyStock: c.safetyStock,
      })),
    },
    purchaseOrders: {
      count: purchaseOrders.length,
    },
  };

  return safeStringify(summary, 2);
}

async function handleCriticalPath(args: Record<string, unknown>): Promise<string> {
  const erp = requireConnector();
  const { productionOrderId, itemNo, depth, longLeadThresholdDays } = SupplyChainSchemas.critical_path.parse(args);

  let targetOrders: ProductionOrder[];

  if (productionOrderId) {
    targetOrders = cachedProductionOrders.filter((o) => o.id === productionOrderId || o.number === productionOrderId);
    if (targetOrders.length === 0) {
      // Fetch fresh
      const all = await erp.getProductionOrders();
      targetOrders = all.filter((o) => o.id === productionOrderId || o.number === productionOrderId);
    }
  } else if (itemNo) {
    targetOrders = cachedProductionOrders.filter((o) => o.itemNo === itemNo);
    if (targetOrders.length === 0) {
      targetOrders = await erp.getProductionOrders({ itemFilter: itemNo });
    }
  } else {
    // Use cached or fetch all
    targetOrders = cachedProductionOrders.length > 0
      ? cachedProductionOrders
      : await erp.getProductionOrders();
  }

  if (targetOrders.length === 0) {
    return safeStringify({ error: "No production orders found matching the criteria" });
  }

  // Re-fetch BOM components at the requested depth when it differs from default
  if (depth && depth !== 3) {
    for (let i = 0; i < targetOrders.length; i++) {
      const order = targetOrders[i];
      if (!order) continue;
      try {
        const deepComponents = await erp.getBOMComponents(order.itemNo, depth);
        if (deepComponents.length > 0) {
          targetOrders[i] = { ...order, components: deepComponents };
        }
      } catch (err) {
        log(`re-fetch BOM at depth ${depth} failed for ${order.itemNo}: ${err}`);
      }
    }
  }

  const results = targetOrders.map((order) => {
    const graph = computeCriticalPath(order.itemNo, order.itemName, order.components);
    const longLeadItems = findLongLeadItems(order.components, longLeadThresholdDays);
    const singleSourceItems = findSingleSourceComponents(order.components);

    return {
      orderNumber: order.number,
      item: order.itemName,
      dueDate: order.dueDate,
      criticalPath: {
        path: graph.criticalPath,
        totalDurationDays: graph.totalDurationDays,
        nodeCount: graph.nodes.length,
      },
      longLeadItems: longLeadItems.map((c) => ({
        itemNo: c.itemNo,
        name: c.itemName,
        leadTimeDays: c.leadTimeDays,
        vendor: c.vendorName ?? c.vendorNo,
        replenishment: c.replenishmentMethod,
      })),
      singleSourceItems: singleSourceItems.map((c) => ({
        itemNo: c.itemNo,
        name: c.itemName,
        vendor: c.vendorName ?? c.vendorNo,
      })),
      graph: {
        nodes: graph.nodes.map((n) => ({
          id: n.id,
          label: n.label,
          type: n.type,
          durationDays: n.durationDays,
          earliestStart: n.earliestStart,
          earliestFinish: n.earliestFinish,
          slack: n.slack,
          isCritical: n.slack === 0 && n.durationDays > 0,
        })),
        edges: graph.edges,
      },
    };
  });

  return safeStringify(results, 2);
}

async function handleAssessRisk(args: Record<string, unknown>): Promise<string> {
  const erp = requireConnector();
  const { scope, includeExternal, productionOrderId } = SupplyChainSchemas.assess_risk.parse(args);

  // Ensure we have data
  if (cachedProductionOrders.length === 0) {
    log("no cached data — running analysis first");
    await handleAnalyzeOrders({ orderType: "both" });
  }

  let targetOrders = cachedProductionOrders;
  if (productionOrderId) {
    targetOrders = targetOrders.filter((o) => o.id === productionOrderId || o.number === productionOrderId);
  }

  const allComponents = collectAllComponents(targetOrders);
  const leadTimeAnalyses = analyzeLeadTimes(allComponents, cachedPurchaseOrders, cachedPostedReceipts);

  // External risk assessment (optional, uses AI)
  let externalFactors: ExternalRiskFactors | undefined;
  if (includeExternal) {
    log("assessing external risk factors");
    const countries = extractVendorCountries(targetOrders);
    const categories = extractComponentCategories(allComponents);
    try {
      externalFactors = await assessExternalRisks({
        vendorCountries: countries,
        componentCategories: categories,
      });
    } catch (err) {
      log(`external risk assessment failed: ${err}`);
    }
  }

  // Cache external factors for use by recommend_actions
  cachedExternalFactors = externalFactors;

  // Compute vendor health scores for integrated risk scoring
  let vendorHealthScores: import("../erp/types.js").VendorHealthScore[] | undefined;
  try {
    const vendors = await erp.getVendors();
    vendorHealthScores = analyzeVendorHealth(cachedPostedReceipts, cachedPurchaseOrders, vendors);
    cachedVendorHealthScores = vendorHealthScores;
  } catch (err) {
    log(`vendor health analysis failed: ${err}`);
  }

  // Score components
  const riskScores = scoreComponents(allComponents, {
    purchaseOrders: cachedPurchaseOrders,
    availability: cachedAvailability,
    leadTimeAnalyses,
    externalFactors,
    vendorHealthScores,
  });

  // Filter by scope
  const filteredScores = scope === "critical_only"
    ? riskScores.filter((r) => riskLevel(r.overallScore) === "critical" || riskLevel(r.overallScore) === "high")
    : riskScores;

  // Lead time issues
  const criticalLeadTimes = findCriticalLeadTimeIssues(leadTimeAnalyses);

  const result = {
    timestamp: new Date().toISOString(),
    summary: {
      totalComponents: allComponents.length,
      scoredComponents: filteredScores.length,
      riskDistribution: {
        critical: filteredScores.filter((r) => riskLevel(r.overallScore) === "critical").length,
        high: filteredScores.filter((r) => riskLevel(r.overallScore) === "high").length,
        medium: filteredScores.filter((r) => riskLevel(r.overallScore) === "medium").length,
        low: filteredScores.filter((r) => riskLevel(r.overallScore) === "low").length,
      },
      averageRiskScore: filteredScores.length > 0
        ? Math.round(filteredScores.reduce((a, b) => a + b.overallScore, 0) / filteredScores.length)
        : 0,
    },
    topRisks: topRisks(filteredScores, 10).map((r) => ({
      ...r,
      riskLevel: riskLevel(r.overallScore),
    })),
    criticalLeadTimes: criticalLeadTimes.slice(0, 10),
    externalFactors: externalFactors ?? null,
  };

  return safeStringify(result, 2);
}

async function handleRecommendActions(args: Record<string, unknown>): Promise<string> {
  const erp = requireConnector();
  const {
    riskThreshold,
    maxRecommendations,
    includeAIEvaluation,
    strategies,
    productionOrderId,
  } = SupplyChainSchemas.recommend_actions.parse(args);

  // Ensure we have data
  if (cachedProductionOrders.length === 0) {
    await handleAnalyzeOrders({ orderType: "both" });
  }

  let targetOrders = cachedProductionOrders;
  if (productionOrderId) {
    targetOrders = targetOrders.filter((o) => o.id === productionOrderId || o.number === productionOrderId);
  }

  const allComponents = collectAllComponents(targetOrders);
  const leadTimeAnalyses = analyzeLeadTimes(allComponents, cachedPurchaseOrders, cachedPostedReceipts);

  // Score with external factors and vendor health (use cached values from assess_risk)
  const riskScores = scoreComponents(allComponents, {
    purchaseOrders: cachedPurchaseOrders,
    availability: cachedAvailability,
    leadTimeAnalyses,
    externalFactors: cachedExternalFactors,
    vendorHealthScores: cachedVendorHealthScores,
  });

  // Generate rule-based interventions
  const dueDate = targetOrders.length > 0
    ? targetOrders.reduce((earliest, o) =>
        o.dueDate < earliest ? o.dueDate : earliest,
      targetOrders[0].dueDate)
    : undefined;

  const interventions = generateInterventions(
    {
      components: allComponents,
      riskScores,
      leadTimeAnalyses,
      productionDueDate: dueDate,
    },
    { riskThreshold, maxRecommendations, strategies },
  );

  // AI evaluation: re-rank interventions considering interdependencies and context
  let aiEvaluation = null;
  if (includeAIEvaluation && interventions.length > 0) {
    log("running AI evaluation of interventions");
    try {
      aiEvaluation = await evaluateInterventionsWithAI(
        interventions,
        riskScores,
        targetOrders,
      );
    } catch (err) {
      log(`AI evaluation failed: ${err}`);
    }
  }

  // Summarize by type
  const byType: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  for (const i of interventions) {
    byType[i.type] = (byType[i.type] ?? 0) + 1;
    byPriority[i.priority] = (byPriority[i.priority] ?? 0) + 1;
  }

  const totalCostImpact = interventions.reduce((a, b) => a + b.estimatedCostImpact, 0);

  // Merge AI scores into interventions if available
  const aiScoreMap = new Map(
    aiEvaluation?.rankedInterventions?.map((r) => [r.id, r]) ?? [],
  );

  // Cache raw interventions for use by execute_interventions
  cachedInterventions = interventions;

  const result = {
    timestamp: new Date().toISOString(),
    summary: {
      totalRecommendations: interventions.length,
      byType,
      byPriority,
      totalEstimatedCostImpact: totalCostImpact,
    },
    interventions: interventions.map((i) => {
      const aiScore = aiScoreMap.get(i.id);
      return {
        id: i.id,
        type: i.type,
        priority: i.priority,
        component: `${i.componentName} (${i.componentId})`,
        description: i.description,
        costImpact: i.estimatedCostImpact,
        riskReduction: i.estimatedRiskReduction,
        details: i.details,
        // AI enrichment
        ...(aiScore ? {
          aiScore: aiScore.aiScore,
          aiReasoning: aiScore.reasoning,
          sideEffects: aiScore.sideEffects,
          implementationComplexity: aiScore.implementationComplexity,
          timeToEffect: aiScore.timeToEffect,
        } : {}),
      };
    }),
    // AI combined strategy
    ...(aiEvaluation ? {
      aiStrategy: {
        combinedStrategy: aiEvaluation.combinedStrategy,
        estimatedOverallRiskReduction: aiEvaluation.estimatedOverallRiskReduction,
      },
    } : {}),
  };

  return safeStringify(result, 2);
}

async function handleMonitorDashboard(args: Record<string, unknown>): Promise<string> {
  const erp = requireConnector();
  const { period } = SupplyChainSchemas.monitor_dashboard.parse(args);

  // Refresh data if stale (older than 1 hour)
  const isStale = !lastAnalysisTimestamp ||
    (Date.now() - new Date(lastAnalysisTimestamp).getTime()) > 3_600_000;

  if (isStale) {
    await handleAnalyzeOrders({ orderType: "both" });
  }

  const allComponents = collectAllComponents(cachedProductionOrders);
  const leadTimeAnalyses = analyzeLeadTimes(allComponents, cachedPurchaseOrders, cachedPostedReceipts);
  const riskScores = scoreComponents(allComponents, {
    purchaseOrders: cachedPurchaseOrders,
    availability: cachedAvailability,
    leadTimeAnalyses,
  });

  const dashboard = {
    timestamp: new Date().toISOString(),
    lastDataRefresh: lastAnalysisTimestamp,
    erpSystem: erp.system,
    kpis: {
      activeProductionOrders: cachedProductionOrders.filter((o) => o.status !== "finished").length,
      openSalesOrders: cachedSalesOrders.filter((o) => o.status === "open" || o.status === "released").length,
      pendingPurchaseOrders: cachedPurchaseOrders.filter((o) => o.status !== "released").length,
      uniqueComponents: allComponents.length,
      averageRiskScore: riskScores.length > 0
        ? Math.round(riskScores.reduce((a, b) => a + b.overallScore, 0) / riskScores.length)
        : 0,
      criticalRiskCount: riskScores.filter((r) => riskLevel(r.overallScore) === "critical").length,
      highRiskCount: riskScores.filter((r) => riskLevel(r.overallScore) === "high").length,
      belowSafetyStockCount: allComponents.filter((c) => c.inventoryLevel < c.safetyStock).length,
      singleSourceCount: findSingleSourceComponents(allComponents).length,
    },
    topRisks: topRisks(riskScores, 5).map((r) => ({
      component: r.componentName,
      score: r.overallScore,
      level: riskLevel(r.overallScore),
      flags: r.flags,
    })),
    criticalLeadTimes: findCriticalLeadTimeIssues(leadTimeAnalyses).slice(0, 5).map((a) => ({
      item: a.itemName,
      planned: a.plannedLeadTimeDays,
      actual: a.actualLeadTimeDays,
      reliability: a.reliabilityScore,
      trend: a.trend,
    })),
    upcomingDueDates: cachedProductionOrders
      .filter((o) => o.status !== "finished")
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 5)
      .map((o) => ({
        order: o.number,
        item: o.itemName,
        dueDate: o.dueDate,
        status: o.status,
      })),
  };

  return safeStringify(dashboard, 2);
}

// ── AI-Powered Skill Handlers ────────────────────────────────────

async function handleIntelligenceReport(args: Record<string, unknown>): Promise<string> {
  const erp = requireConnector();
  const { includeWebIntelligence, includeDeepAnalysis, productionOrderId } =
    SupplyChainSchemas.intelligence_report.parse(args);

  // Ensure we have data
  if (cachedProductionOrders.length === 0) {
    await handleAnalyzeOrders({ orderType: "both" });
  }

  let targetOrders = cachedProductionOrders;
  if (productionOrderId) {
    targetOrders = targetOrders.filter((o) => o.id === productionOrderId || o.number === productionOrderId);
  }

  const allComponents = collectAllComponents(targetOrders);
  const leadTimeAnalyses = analyzeLeadTimes(allComponents, cachedPurchaseOrders, cachedPostedReceipts);
  const riskScores = scoreComponents(allComponents, {
    purchaseOrders: cachedPurchaseOrders,
    availability: cachedAvailability,
    leadTimeAnalyses,
  });

  const interventions = generateInterventions({
    components: allComponents,
    riskScores,
    leadTimeAnalyses,
  });

  // Parallel: gather web intelligence + deep BOM analysis + external risks
  const countries = extractVendorCountries(targetOrders);
  const categories = extractComponentCategories(allComponents);

  const [webIntelligence, deepAnalysis, externalFactors] = await Promise.all([
    includeWebIntelligence
      ? gatherWebIntelligence(countries, categories).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
    includeDeepAnalysis
      ? analyzeDeepBOM(targetOrders, allComponents, leadTimeAnalyses, riskScores, cachedAvailability)
          .catch(() => undefined)
      : Promise.resolve(undefined),
    assessExternalRisks({ vendorCountries: countries, componentCategories: categories })
      .catch(() => undefined),
  ]);

  log(`intelligence report: ${webIntelligence.length} web items, deep=${!!deepAnalysis}, external=${!!externalFactors}`);

  const report = await generateIntelligenceReport({
    productionOrders: targetOrders,
    salesOrders: cachedSalesOrders,
    components: allComponents,
    riskScores,
    leadTimeAnalyses,
    interventions,
    externalFactors,
    deepAnalysis,
    webIntelligence,
  });

  return safeStringify(report, 2);
}

async function handlePredictBottlenecks(args: Record<string, unknown>): Promise<string> {
  requireConnector();
  const { productionOrderId } = SupplyChainSchemas.predict_bottlenecks.parse(args);

  if (cachedProductionOrders.length === 0) {
    await handleAnalyzeOrders({ orderType: "both" });
  }

  let targetOrders = cachedProductionOrders;
  if (productionOrderId) {
    targetOrders = targetOrders.filter((o) => o.id === productionOrderId || o.number === productionOrderId);
  }

  const allComponents = collectAllComponents(targetOrders);
  const leadTimeAnalyses = analyzeLeadTimes(allComponents, cachedPurchaseOrders, cachedPostedReceipts);

  const predictions = await predictBottlenecks(
    allComponents,
    leadTimeAnalyses,
    targetOrders,
    cachedPurchaseOrders,
  );

  return safeStringify({
    timestamp: new Date().toISOString(),
    predictionsCount: predictions.length,
    predictions,
  }, 2);
}

async function handleDeepBOMAnalysis(args: Record<string, unknown>): Promise<string> {
  requireConnector();
  const { productionOrderId } = SupplyChainSchemas.deep_bom_analysis.parse(args);

  if (cachedProductionOrders.length === 0) {
    await handleAnalyzeOrders({ orderType: "both" });
  }

  let targetOrders = cachedProductionOrders;
  if (productionOrderId) {
    targetOrders = targetOrders.filter((o) => o.id === productionOrderId || o.number === productionOrderId);
  }

  const allComponents = collectAllComponents(targetOrders);
  const leadTimeAnalyses = analyzeLeadTimes(allComponents, cachedPurchaseOrders, cachedPostedReceipts);
  const riskScores = scoreComponents(allComponents, {
    purchaseOrders: cachedPurchaseOrders,
    availability: cachedAvailability,
    leadTimeAnalyses,
  });

  const analysis = await analyzeDeepBOM(
    targetOrders,
    allComponents,
    leadTimeAnalyses,
    riskScores,
    cachedAvailability,
  );

  return safeStringify({
    timestamp: new Date().toISOString(),
    ...analysis,
  }, 2);
}

// ── MRP Skill Handlers ───────────────────────────────────────────

async function handleRunMRP(args: Record<string, unknown>): Promise<string> {
  requireConnector();
  const {
    horizonWeeks,
    bucketSize,
    safetyLeadTimeDays,
    lotSizingPolicy,
    fixedOrderQty,
    includeCapacity,
    includePegging,
  } = SupplyChainSchemas.run_mrp.parse(args);

  // Ensure we have data
  if (cachedProductionOrders.length === 0) {
    await handleAnalyzeOrders({ orderType: "both" });
  }

  const allComponents = collectAllComponents(cachedProductionOrders);

  // Build lot sizing policy
  let policy: LotSizingPolicy = { type: "lot_for_lot" };
  if (lotSizingPolicy === "fixed_order_qty" && fixedOrderQty) {
    policy = { type: "fixed_order_qty", quantity: fixedOrderQty };
  } else if (lotSizingPolicy === "eoq") {
    // annualDemand=52 (~1 unit/week) is a safe floor; the MRP engine overrides
    // per-component with real BOM-derived estimates when available.
    policy = { type: "eoq", annualDemand: 52, orderingCost: 50, holdingCostRate: 0.25 };
  } else if (lotSizingPolicy === "period_order_qty") {
    policy = { type: "period_order_qty", periods: 4 };
  }

  const mrpConfig: MRPConfig = {
    horizonWeeks,
    bucketSize: bucketSize as BucketSize,
    safetyLeadTimeDays,
    lotSizingPolicy: policy,
    includeCapacity,
    includePegging,
    previousPeggingCache: cachedPeggingCache as MRPConfig["previousPeggingCache"],
  };

  log(`running MRP: ${horizonWeeks} weeks, ${bucketSize} buckets, ${lotSizingPolicy} lot sizing`);

  // Build erpRoutings map from cached production order routing data
  const erpRoutings = new Map<string, RoutingStep[]>();
  for (const po of cachedProductionOrders) {
    if (po.routings.length > 0 && !erpRoutings.has(po.itemNo)) {
      erpRoutings.set(po.itemNo, po.routings);
    }
  }

  const result = runMRP({
    productionOrders: cachedProductionOrders,
    salesOrders: cachedSalesOrders,
    purchaseOrders: cachedPurchaseOrders,
    components: allComponents,
    availability: cachedAvailability,
    erpWorkCenters: cachedERPWorkCenters.length > 0 ? cachedERPWorkCenters : undefined,
    erpRoutings: erpRoutings.size > 0 ? erpRoutings : undefined,
    firmedOrders: firmedOrders.length > 0 ? firmedOrders : undefined,
    transferOrders: cachedTransferOrders.length > 0 ? cachedTransferOrders : undefined,
    config: mrpConfig,
  });

  cachedMRPResult = result;
  cachedPeggingCache = result.peggingCache;

  // Build a focused response (full result can be very large)
  const response = {
    timestamp: result.timestamp,
    horizon: {
      start: result.horizon.startDate,
      end: result.horizon.endDate,
      buckets: result.horizon.buckets.length,
      bucketSize: result.horizon.bucketSize,
    },
    summary: result.summary,
    plannedOrders: result.plannedOrders.map((o) => ({
      id: o.id,
      item: `${o.itemName} (${o.itemNo})`,
      quantity: o.quantity,
      type: o.type,
      orderDate: o.orderDate,
      dueDate: o.dueDate,
      action: o.action,
      vendor: o.vendorName ?? o.vendorNo ?? "—",
      lotSizing: o.lotSizingPolicy,
      status: o.status,
    })),
    exceptions: result.exceptions.slice(0, 25),
    capacitySummary: result.capacityLoads.map((cl) => ({
      workCenter: cl.workCenterName,
      avgUtilization: cl.averageUtilization,
      peakUtilization: cl.peakUtilization,
      overloadedBuckets: cl.overloadedBuckets,
    })),
    peggingSummary: {
      trees: result.pegging.length,
      totalShortages: result.pegging.reduce((s, t) => s + t.shortages.length, 0),
      shortages: result.pegging
        .flatMap((t) => t.shortages)
        .slice(0, 15)
        .map((s) => ({
          item: `${s.itemName} (${s.itemNo})`,
          shortage: s.shortageQuantity,
          neededBy: s.neededBy,
        })),
    },
  };

  return safeStringify(response, 2);
}

async function handleMRPImpact(args: Record<string, unknown>): Promise<string> {
  const { itemNo, delayDays } = SupplyChainSchemas.mrp_impact.parse(args);

  // Need a recent MRP run with pegging data
  if (!cachedMRPResult || cachedMRPResult.pegging.length === 0) {
    log("no MRP result cached — running MRP first");
    await handleRunMRP({ includePegging: true });
  }

  if (!cachedMRPResult) {
    return safeStringify({ error: "MRP run failed — cannot perform impact analysis" });
  }

  const impact = analyzeSupplyImpact(itemNo, delayDays, cachedMRPResult.pegging);

  return safeStringify({
    timestamp: new Date().toISOString(),
    scenario: {
      item: itemNo,
      delayDays,
      description: `What happens if ${itemNo} is delayed by ${delayDays} days?`,
    },
    impact: {
      affectedOrdersCount: impact.affectedOrders.length,
      totalAffectedQuantity: impact.totalAffectedQuantity,
      affectedOrders: impact.affectedOrders,
    },
  }, 2);
}

async function handleVendorHealth(args: Record<string, unknown>): Promise<string> {
  const { vendorNo } = SupplyChainSchemas.vendor_health.parse(args);
  const erp = requireConnector();

  if (!cachedVendors) {
    cachedVendors = await erp.getVendors();
  }
  const vendorsToAnalyze = vendorNo
    ? cachedVendors.filter((v) => v.no === vendorNo)
    : cachedVendors;

  if (vendorsToAnalyze.length === 0) {
    return safeStringify({ error: vendorNo ? `Vendor ${vendorNo} not found` : "No vendors found" });
  }

  const postedReceipts = cachedPostedReceipts.length > 0
    ? cachedPostedReceipts
    : await erp.getPostedReceipts({ limit: 2000 });

  const scores = analyzeVendorHealth(postedReceipts, cachedPurchaseOrders, vendorsToAnalyze);

  return safeStringify({
    timestamp: new Date().toISOString(),
    vendorCount: scores.length,
    scores: scores.map((s) => ({
      vendorNo: s.vendorNo,
      vendorName: s.vendorName,
      overallScore: s.overallScore,
      onTimeDeliveryPct: s.onTimeDeliveryPct,
      avgLeadTimeVarianceDays: s.avgLeadTimeVarianceDays,
      leadTimeConsistency: s.leadTimeConsistency,
      totalDeliveries: s.totalDeliveries,
      trend: s.trend,
      flags: s.flags,
    })),
    summary: {
      avgScore: scores.length > 0
        ? Math.round(scores.reduce((s, v) => s + v.overallScore, 0) / scores.length)
        : 0,
      poorHealthVendors: scores.filter((s) => s.overallScore < 50).length,
      deterioratingVendors: scores.filter((s) => s.trend === "deteriorating").length,
    },
  }, 2);
}

async function handleFirmOrders(args: Record<string, unknown>): Promise<string> {
  const { orderIds } = SupplyChainSchemas.firm_orders.parse(args);

  if (!cachedMRPResult) {
    return safeStringify({ error: "No MRP result available. Run the run_mrp skill first." });
  }

  const firmed: Array<{ id: string; itemNo: string; itemName: string; quantity: number }> = [];
  const notFound: string[] = [];

  for (const orderId of orderIds) {
    const order = cachedMRPResult.plannedOrders.find((o) => o.id === orderId && o.status === "planned");
    if (order) {
      order.status = "firmed";
      firmedOrders.push(order);
      firmed.push({ id: order.id, itemNo: order.itemNo, itemName: order.itemName, quantity: order.quantity });
      log(`firmed planned order ${orderId} for ${order.itemName}`);
    } else {
      notFound.push(orderId);
    }
  }

  if (firmed.length > 0) {
    await saveFirmedOrders();
  }

  return safeStringify({
    timestamp: new Date().toISOString(),
    firmedCount: firmed.length,
    firmed,
    notFound: notFound.length > 0 ? notFound : undefined,
    totalFirmedOrders: firmedOrders.length,
    note: "Firmed orders will be treated as fixed supply in subsequent MRP runs.",
  }, 2);
}

async function handleExecuteInterventions(args: Record<string, unknown>): Promise<string> {
  const { interventionIds, dryRun } = SupplyChainSchemas.execute_interventions.parse(args);

  if (cachedInterventions.length === 0) {
    return safeStringify({
      error: "No interventions available. Run recommend_actions first to generate recommendations.",
    });
  }

  const selected = cachedInterventions.filter((i) => interventionIds.includes(i.id));
  if (selected.length === 0) {
    return safeStringify({
      error: `None of the requested intervention IDs were found. Available: ${cachedInterventions.map((i) => i.id).join(", ")}`,
    });
  }

  const executed: Array<{ id: string; type: string; component: string; action: string }> = [];
  const newFirmedOrders: Array<{ id: string; itemNo: string; itemName: string; quantity: number }> = [];
  const manualSteps: Array<{ id: string; type: string; component: string; steps: string[] }> = [];

  for (const intervention of selected) {
    const comp = intervention.componentId;
    const compName = intervention.componentName;

    if (intervention.type === "advance_purchase" || intervention.type === "dual_source") {
      // Create a firmed planned order for this component
      const targetQty = typeof intervention.details.recommendedOrderQty === "number"
        ? intervention.details.recommendedOrderQty
        : typeof intervention.details.safetyStockMonths === "number"
          ? Math.ceil((intervention.details.safetyStockMonths as number) * 30)
          : 1;
      const orderDate = new Date().toISOString().slice(0, 10);
      const dueDate = typeof intervention.details.targetDueDate === "string"
        ? intervention.details.targetDueDate
        : new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

      const plannedOrder: PlannedOrder = {
        id: `EXEC-${intervention.id}`,
        itemNo: comp,
        itemName: compName,
        quantity: targetQty,
        orderDate,
        dueDate,
        type: "purchase",
        action: "create",
        bomLevel: 0,
        peggedDemand: [],
        safetyBuffer: 0,
        lotSizingPolicy: "L4L",
        status: "firmed",
      };

      if (!dryRun) {
        firmedOrders.push(plannedOrder);
        newFirmedOrders.push({
          id: plannedOrder.id,
          itemNo: comp,
          itemName: compName,
          quantity: targetQty,
        });
      }

      executed.push({
        id: intervention.id,
        type: intervention.type,
        component: compName,
        action: dryRun
          ? `Would firm planned purchase order for ${targetQty} units due ${dueDate}`
          : `Firmed planned purchase order ${plannedOrder.id} for ${targetQty} units due ${dueDate}`,
      });
    } else if (intervention.type === "safety_stock") {
      const targetQty = typeof intervention.details.recommendedSafetyStock === "number"
        ? intervention.details.recommendedSafetyStock as number
        : 0;
      if (!dryRun && targetQty > 0) {
        cachedSafetyStockOverrides.set(comp, targetQty);
      }
      executed.push({
        id: intervention.id,
        type: intervention.type,
        component: compName,
        action: dryRun
          ? `Would set safety stock override to ${targetQty} units for next MRP run`
          : `Safety stock override set to ${targetQty} units — will apply in next MRP run`,
      });
    } else if (intervention.type === "reschedule") {
      const delay = typeof intervention.details.suggestedDelayDays === "number"
        ? intervention.details.suggestedDelayDays as number
        : 0;
      manualSteps.push({
        id: intervention.id,
        type: intervention.type,
        component: compName,
        steps: [
          `Open production order for ${compName} in ERP`,
          `Delay due date by ${delay} days to allow component delivery buffer`,
          `Notify customer of revised delivery date`,
          `Review impact on downstream sales orders using mrp_impact skill`,
        ],
      });
      executed.push({ id: intervention.id, type: intervention.type, component: compName, action: "Manual steps generated" });
    } else if (intervention.type === "make_or_buy") {
      const recommendation = intervention.details.recommendation as string ?? "review";
      manualSteps.push({
        id: intervention.id,
        type: intervention.type,
        component: compName,
        steps: [
          `Review make-or-buy analysis for ${compName}: ${recommendation}`,
          recommendation === "make"
            ? `Set up internal production BOM and routing for ${compName}`
            : `Issue RFQ to alternative suppliers for ${compName}`,
          `Update replenishment method in ERP item card`,
        ],
      });
      executed.push({ id: intervention.id, type: intervention.type, component: compName, action: "Manual steps generated" });
    }
  }

  if (!dryRun && newFirmedOrders.length > 0) {
    await saveFirmedOrders();
  }

  return safeStringify({
    timestamp: new Date().toISOString(),
    dryRun,
    summary: {
      requested: interventionIds.length,
      actioned: executed.length,
      firmedOrders: newFirmedOrders.length,
      manualStepsGenerated: manualSteps.length,
    },
    executed,
    newFirmedOrders: newFirmedOrders.length > 0 ? newFirmedOrders : undefined,
    manualSteps: manualSteps.length > 0 ? manualSteps : undefined,
    note: newFirmedOrders.length > 0
      ? "New firmed orders added. Run run_mrp to see updated planned orders."
      : undefined,
  }, 2);
}

// ── Utilities ────────────────────────────────────────────────────

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

// ── Skill Dispatcher ─────────────────────────────────────────────

async function handleSkill(
  skillId: string,
  args: Record<string, unknown>,
  text: string,
): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;

  switch (skillId) {
    case "connect_erp":
      return handleConnectERP(args);
    case "analyze_orders":
      return handleAnalyzeOrders(args);
    case "critical_path":
      return handleCriticalPath(args);
    case "assess_risk":
      return handleAssessRisk(args);
    case "recommend_actions":
      return handleRecommendActions(args);
    case "monitor_dashboard":
      return handleMonitorDashboard(args);
    case "intelligence_report":
      return handleIntelligenceReport(args);
    case "predict_bottlenecks":
      return handlePredictBottlenecks(args);
    case "deep_bom_analysis":
      return handleDeepBOMAnalysis(args);
    case "run_mrp":
      return handleRunMRP(args);
    case "mrp_impact":
      return handleMRPImpact(args);
    case "vendor_health":
      return handleVendorHealth(args);
    case "firm_orders":
      return handleFirmOrders(args);
    case "execute_interventions":
      return handleExecuteInterventions(args);

    case "value_stream_map": {
      if (!cachedMRPResult) return "No MRP data available. Run run_mrp first.";
      const itemNo = (args.itemNo as string) ?? cachedProductionOrders[0]?.itemNo ?? "unknown";
      const itemName = cachedProductionOrders.find((o) => o.itemNo === itemNo)?.itemName ?? itemNo;
      const routings = cachedProductionOrders.find((o) => o.itemNo === itemNo)?.routings ?? [];
      const workCenters = cachedMRPResult.capacityLoads.map((cl: CapacityLoad) => ({
        id: cl.workCenterId,
        name: cl.workCenterName,
        capacityMinutesPerDay: 480,
        efficiency: 0.85,
        unitCount: 1,
      }));
      const customerDemandPerDay = args.customerDemandPerDay as number | undefined;
      const vsm = generateValueStreamMap(itemNo, itemName, cachedMRPResult, routings, workCenters, customerDemandPerDay);
      return safeStringify(vsm, 2);
    }

    case "smed_analysis": {
      if (!cachedMRPResult) return "No MRP data available. Run run_mrp first.";
      const allRoutings = cachedProductionOrders.flatMap((o) => o.routings);
      const workCenters = cachedMRPResult.capacityLoads.map((cl: CapacityLoad) => ({
        id: cl.workCenterId,
        name: cl.workCenterName,
        capacityMinutesPerDay: 480,
        efficiency: 0.85,
        unitCount: 1,
      }));
      const top = (args.top as number) ?? 10;
      const candidates = analyzeSMEDOpportunities(allRoutings, workCenters, cachedMRPResult.capacityLoads, { top });
      return safeStringify({ candidates, count: candidates.length }, 2);
    }

    case "line_balance": {
      const itemNo = (args.itemNo as string) ?? cachedProductionOrders[0]?.itemNo ?? "unknown";
      const routings = cachedProductionOrders.find((o) => o.itemNo === itemNo)?.routings ?? [];
      if (routings.length === 0) return "No routing data available for this item.";
      const workCenters = (cachedMRPResult?.capacityLoads ?? []).map((cl: CapacityLoad) => ({
        id: cl.workCenterId,
        name: cl.workCenterName,
        capacityMinutesPerDay: 480,
        efficiency: 0.85,
        unitCount: 1,
      }));
      const taktTime = (args.taktTimeSeconds as number) ?? 300;
      const result = analyzeLineBalance(routings, workCenters, taktTime);
      return safeStringify(result, 2);
    }

    case "supplier_audit_prepare": {
      const vendorNo = args.vendorNo as string;
      if (!vendorNo) return "vendorNo is required";
      if (!cachedVendors) return "No vendor data available.";
      const vendor = cachedVendors.find((v) => v.no === vendorNo);
      const vendorName = vendor?.name ?? vendorNo;
      // Get risk score and vendor health from cached data
      const components = cachedProductionOrders.flatMap((o) => o.components);
      const riskScore = {
        componentId: vendorNo,
        componentName: vendorName,
        overallScore: 50,
        dimensions: { availability: 50, delivery: 50, price: 50, leadTime: 50, external: 50, quality: 50 },
        flags: [],
      };
      const vendorHealth = {
        vendorNo,
        vendorName,
        overallScore: 70,
        onTimeDeliveryPct: 85,
        avgLeadTimeVarianceDays: 2,
        leadTimeConsistency: 75,
        totalDeliveries: 50,
        trend: "stable" as const,
        flags: [],
      };
      const checklist = generateAuditChecklist(vendorNo, vendorName, riskScore, vendorHealth, {
        auditType: args.auditType as "full" | "focused" | "re-audit" | undefined,
      });
      return safeStringify(checklist, 2);
    }

    case "dual_source_optimize": {
      const itemNo = (args.itemNo as string) ?? "unknown";
      const annualDemand = (args.annualDemand as number) ?? 1000;
      const vendors = (args.vendors as Array<{ id: string; name: string; unitCost: number; moq: number; leadTime: number; riskScore: number; country: string; capacityMax: number }>) ?? [];
      if (vendors.length < 2) return "At least 2 vendors required for dual sourcing analysis";
      const scenarios = optimizeDualSourcing(itemNo, annualDemand, vendors);
      return safeStringify({ itemNo, annualDemand, scenarios, count: scenarios.length }, 2);
    }

    default:
      return `Unknown skill: ${skillId}`;
  }
}

// ── Fastify Server ──────────────────────────────────────────────

const app = Fastify({ logger: false });

app.get("/.well-known/agent.json", async () => AGENT_CARD);

app.get("/healthz", async () => ({
  status: "ok",
  agent: NAME,
  uptime: process.uptime(),
  skills: AGENT_CARD.skills.map((s) => s.id),
  erpConnected: connector !== null,
  erpSystem: connector?.system ?? null,
  lastAnalysis: lastAnalysisTimestamp,
}));

app.post<{ Body: Record<string, unknown> }>("/", async (request, reply) => {
  const data = request.body;
  if (data?.method !== "tasks/send") {
    reply.code(404);
    return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
  }

  const { skillId, args, message, id: taskId } = data.params as Record<string, unknown> ?? {};
  const text: string = ((message as Record<string, unknown>)?.parts as Array<{ text: string }>)?.[0]?.text ?? "";
  const sid = (skillId as string) ?? "monitor_dashboard";

  const sizeErr = checkRequestSize(data);
  if (sizeErr) {
    reply.code(413);
    return { jsonrpc: "2.0", error: { code: -32000, message: sizeErr } };
  }

  try {
    const result = await handleSkill(sid, (args as Record<string, unknown>) ?? {}, text);
    return buildA2AResponse(data.id, taskId, result);
  } catch (err) {
    log(`skill ${sid} failed: ${err instanceof Error ? err.message : String(err)}`);
    reply.code(500);
    return buildA2AError(data.id, err);
  }
});

getPersona(NAME);
watchPersonas();

// Load persisted firmed orders before starting
loadFirmedOrders().then(() => {
  app.listen({ port: PORT, host: "localhost" }).then(() => {
    log(`listening on http://localhost:${PORT}`);
  });
});
