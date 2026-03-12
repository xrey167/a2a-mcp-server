/**
 * Supply Chain Risk Agent — production order analysis, critical path detection,
 * global risk assessment, and intervention recommendations.
 *
 * Port: 8089
 *
 * Connects to Business Central or Odoo to analyze production orders, sales orders,
 * BOM structures, and procurement methods. Evaluates components against global
 * supply chain risks (weather, freight, economics, geopolitics) and recommends
 * interventions (make-or-buy, safety stock, dual sourcing, etc.).
 *
 * Skills:
 *   connect_erp        — Configure ERP connection (BC or Odoo)
 *   analyze_orders      — Analyze production/sales orders and their components
 *   critical_path       — Compute critical path and identify bottlenecks
 *   assess_risk         — Multi-dimensional risk scoring with external factors
 *   recommend_actions   — Generate prioritized intervention recommendations
 *   monitor_dashboard   — Aggregated supply chain status overview
 *   remember / recall   — Shared persistent memory
 */

import Fastify from "fastify";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { buildA2AResponse, buildA2AError, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";
import { getPersona, watchPersonas } from "../persona-loader.js";

import type {
  ERPConnector,
  ERPConnectionConfig,
  ProductionOrder,
  SalesOrder,
  BOMComponent,
  PurchaseOrder,
  ItemAvailability,
} from "../erp/types.js";
import { BusinessCentralConnector } from "../erp/business-central.js";
import { OdooConnector } from "../erp/odoo.js";
import { computeCriticalPath, findLongLeadItems, findSingleSourceComponents } from "../risk/critical-path.js";
import { analyzeLeadTimes, findCriticalLeadTimeIssues } from "../risk/lead-time.js";
import { scoreComponents, topRisks, riskLevel } from "../risk/scoring.js";
import type { ExternalRiskFactors } from "../risk/scoring.js";
import { generateInterventions } from "../risk/interventions.js";
import { assessExternalRisks } from "../risk/sources.js";

const PORT = 8089;
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
    strategies: z.array(z.enum([
      "make_or_buy", "safety_stock", "dual_source", "advance_purchase", "reschedule",
    ])).optional(),
    productionOrderId: z.string().optional(),
  }).passthrough(),

  monitor_dashboard: z.object({
    period: z.string().optional(),
  }).passthrough(),
};

// ── Agent Card ───────────────────────────────────────────────────

const AGENT_CARD = {
  name: NAME,
  description: "Supply chain risk agent — analyzes production/sales orders from Business Central or Odoo, identifies critical paths, assesses global risks, and recommends interventions",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
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
let lastAnalysisTimestamp: string | null = null;

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

/** Extract vendor countries from components. */
function extractVendorCountries(orders: ProductionOrder[], erp: ERPConnector): string[] {
  const countries = new Set<string>();
  for (const order of orders) {
    for (const comp of order.components) {
      if (comp.vendorName) {
        // Use vendor name as hint; in real usage vendor records provide country
        countries.add(comp.vendorName);
      }
    }
  }
  return countries.size > 0 ? [...countries] : ["Global"];
}

/** Extract component categories from BOM. */
function extractComponentCategories(components: BOMComponent[]): string[] {
  const cats = new Set<string>();
  for (const c of components) {
    cats.add(c.itemName.split(/[\s-]/)[0] ?? "General");
  }
  return [...cats].slice(0, 10);
}

// ── Skill Handlers ───────────────────────────────────────────────

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

  return safeStringify({
    status: "connected",
    system: parsed.system,
    message: result.message,
  }, 2);
}

async function handleAnalyzeOrders(args: Record<string, unknown>): Promise<string> {
  const erp = requireConnector();
  const { orderType, status, dateFrom, dateTo, itemFilter } = SupplyChainSchemas.analyze_orders.parse(args);

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

  // Cache for use in other skills
  cachedProductionOrders = productionOrders;
  cachedSalesOrders = salesOrders;
  cachedPurchaseOrders = purchaseOrders;
  cachedAvailability = availability;
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

  const results = targetOrders.map((order) => {
    // Ensure components are loaded (may need deeper BOM)
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
  const leadTimeAnalyses = analyzeLeadTimes(allComponents, cachedPurchaseOrders);

  // External risk assessment (optional, uses AI)
  let externalFactors: ExternalRiskFactors | undefined;
  if (includeExternal) {
    log("assessing external risk factors");
    const countries = extractVendorCountries(targetOrders, erp);
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

  // Score components
  const riskScores = scoreComponents(allComponents, {
    purchaseOrders: cachedPurchaseOrders,
    availability: cachedAvailability,
    leadTimeAnalyses,
    externalFactors,
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
  const leadTimeAnalyses = analyzeLeadTimes(allComponents, cachedPurchaseOrders);

  // Score first
  const riskScores = scoreComponents(allComponents, {
    purchaseOrders: cachedPurchaseOrders,
    availability: cachedAvailability,
    leadTimeAnalyses,
  });

  // Generate interventions
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

  // Summarize by type
  const byType: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  for (const i of interventions) {
    byType[i.type] = (byType[i.type] ?? 0) + 1;
    byPriority[i.priority] = (byPriority[i.priority] ?? 0) + 1;
  }

  const totalCostImpact = interventions.reduce((a, b) => a + b.estimatedCostImpact, 0);

  const result = {
    timestamp: new Date().toISOString(),
    summary: {
      totalRecommendations: interventions.length,
      byType,
      byPriority,
      totalEstimatedCostImpact: totalCostImpact,
    },
    interventions: interventions.map((i) => ({
      id: i.id,
      type: i.type,
      priority: i.priority,
      component: `${i.componentName} (${i.componentId})`,
      description: i.description,
      costImpact: i.estimatedCostImpact,
      riskReduction: i.estimatedRiskReduction,
      details: i.details,
    })),
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
  const leadTimeAnalyses = analyzeLeadTimes(allComponents, cachedPurchaseOrders);
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

app.listen({ port: PORT, host: "localhost" }).then(() => {
  log(`listening on http://localhost:${PORT}`);
});
