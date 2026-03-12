/**
 * MRP Engine — orchestrates the complete Material Requirements Planning cycle.
 *
 * Full MRP Run:
 *   1. Build planning horizon (time buckets)
 *   2. Collect and explode demand (independent + dependent)
 *   3. Aggregate supply (on-hand, POs, production orders)
 *   4. Run gross-to-net calculation with lot sizing
 *   5. Generate planned orders with action messages
 *   6. Build pegging trees (demand ↔ supply traceability)
 *   7. Calculate capacity loads (CRP)
 *   8. Detect exceptions and generate alerts
 *
 * This is the core planning engine that ties together all MRP modules.
 */

import type {
  ProductionOrder,
  SalesOrder,
  PurchaseOrder,
  BOMComponent,
  ItemAvailability,
  WorkCenterData,
  RoutingStep,
} from "../erp/types.js";
import type {
  BucketSize,
  PlanningHorizon,
  LotSizingConfig,
  LotSizingPolicy,
  PlannedOrder,
  ActionMessage,
  NetRequirement,
  MRPRunResult,
  MRPException,
  MRPSummary,
  WorkCenter,
} from "./types.js";
import { buildPlanningHorizon, buildDemandPlanWithExceptions, type DemandForecast } from "./demand-plan.js";
import { buildSupplyPlan, calculateGrossToNet } from "./gross-to-net.js";
import { policyName } from "./lot-sizing.js";
import { buildPeggingTrees, type PeggingInput } from "./pegging.js";
import { discoverWorkCenters, calculateCapacityLoads, detectCapacityExceptions } from "./capacity.js";

function log(msg: string) {
  process.stderr.write(`[mrp-engine] ${msg}\n`);
}

// ── MRP Run Configuration ────────────────────────────────────────

export interface MRPConfig {
  /** Planning horizon in weeks (default: 12) */
  horizonWeeks?: number;
  /** Bucket size for time-phasing (default: week) */
  bucketSize?: BucketSize;
  /** Start date for planning (default: today) */
  startDate?: string;
  /** Safety lead time buffer in days (default: 2) */
  safetyLeadTimeDays?: number;
  /** Default lot sizing policy */
  lotSizingPolicy?: LotSizingPolicy;
  /** Per-item lot sizing overrides */
  itemLotSizing?: Record<string, LotSizingPolicy>;
  /** Manual demand forecasts */
  forecasts?: DemandForecast[];
  /** Work center overrides */
  workCenters?: WorkCenter[];
  /** Include capacity planning? (default: true) */
  includeCapacity?: boolean;
  /** Include pegging? (default: true) */
  includePegging?: boolean;
}

export interface MRPInput {
  productionOrders: ProductionOrder[];
  salesOrders: SalesOrder[];
  purchaseOrders: PurchaseOrder[];
  components: BOMComponent[];
  availability: ItemAvailability[];
  /** ERP work center master data (optional, used for CRP) */
  erpWorkCenters?: WorkCenterData[];
  /** ERP routing master data (optional, used for planned order CRP) */
  erpRoutings?: Map<string, RoutingStep[]>;
  config: MRPConfig;
}

// ── MRP Run ──────────────────────────────────────────────────────

/**
 * Execute a full MRP run.
 */
export function runMRP(input: MRPInput): MRPRunResult {
  const { productionOrders, salesOrders, purchaseOrders, components, availability, erpWorkCenters, erpRoutings, config } = input;
  const startTime = Date.now();

  log("starting MRP run");

  // 1. Build planning horizon
  const today = config.startDate ?? new Date().toISOString().slice(0, 10);
  const horizonWeeks = config.horizonWeeks ?? 12;
  const bucketSize = config.bucketSize ?? "week";
  const horizon = buildPlanningHorizon(today, horizonWeeks, bucketSize);

  log(`horizon: ${horizon.startDate} to ${horizon.endDate}, ${horizon.buckets.length} ${bucketSize} buckets`);

  // 2. Build demand plan (explode BOM, aggregate by bucket)
  const demandResult = buildDemandPlanWithExceptions({
    salesOrders,
    productionOrders,
    forecasts: config.forecasts,
    components,
    horizon,
  });
  const demandPlan = demandResult.demandPlan;
  const demandExceptions = demandResult.exceptions;

  log(`demand plan: ${demandPlan.size} items with demand`);

  // 3. Build supply plan (on-hand + POs + production)
  const itemNos = Array.from(demandPlan.keys());
  const supplyPlan = buildSupplyPlan(itemNos, purchaseOrders, productionOrders, availability, horizon);

  // 4. Lot sizing config — merge ERP policies with user overrides
  const itemPolicies = new Map<string, LotSizingPolicy>();
  // Auto-map from ERP BOM component lot sizing policies
  for (const comp of components) {
    const mapped = mapERPLotSizingPolicy(comp);
    if (mapped) itemPolicies.set(comp.itemNo, mapped);
  }
  // User overrides take priority
  for (const [k, v] of Object.entries(config.itemLotSizing ?? {})) {
    itemPolicies.set(k, v);
  }
  const lotSizingConfig: LotSizingConfig = {
    defaultPolicy: config.lotSizingPolicy ?? { type: "lot_for_lot" },
    itemPolicies,
  };

  // 5. Gross-to-net calculation
  const g2nResult = calculateGrossToNet({
    demandPlan,
    supplyPlan,
    components,
    horizon,
    lotSizingConfig,
    safetyLeadTimeDays: config.safetyLeadTimeDays ?? 2,
  });

  log(`gross-to-net: ${g2nResult.netRequirements.size} items processed`);

  // 6. Generate planned orders from net requirements
  const plannedOrders = generatePlannedOrders(g2nResult.netRequirements, g2nResult.itemMetadata, horizon, components);

  log(`planned orders: ${plannedOrders.length} generated`);

  // 7. Pegging
  let pegging: MRPRunResult["pegging"] = [];
  if (config.includePegging !== false) {
    const peggingInput: PeggingInput = {
      salesOrders,
      productionOrders,
      purchaseOrders,
      availability,
      plannedOrders,
      netRequirements: g2nResult.netRequirements,
    };
    pegging = buildPeggingTrees(peggingInput);
    log(`pegging: ${pegging.length} trees built`);
  }

  // 8. Capacity planning — merge ERP work centers with discovered/override data
  let capacityLoads: MRPRunResult["capacityLoads"] = [];
  let capacityExceptions: MRPException[] = [];
  if (config.includeCapacity !== false) {
    const erpWCs = erpWorkCenters ? mapERPWorkCenters(erpWorkCenters) : undefined;
    const mergedOverrides = [...(erpWCs ?? []), ...(config.workCenters ?? [])];
    const workCenters = discoverWorkCenters(productionOrders, mergedOverrides.length > 0 ? mergedOverrides : undefined);
    if (workCenters.length > 0) {
      // Build routing map for planned order CRP: combine ERP routings + production order routings
      const routingMap = new Map<string, RoutingStep[]>(erpRoutings ?? []);
      for (const po of productionOrders) {
        if (po.routings.length > 0 && !routingMap.has(po.itemNo)) {
          routingMap.set(po.itemNo, po.routings);
        }
      }

      capacityLoads = calculateCapacityLoads({
        productionOrders,
        plannedOrders,
        workCenters,
        horizon,
        routingMap: routingMap.size > 0 ? routingMap : undefined,
      });
      capacityExceptions = detectCapacityExceptions(capacityLoads);
      log(`capacity: ${workCenters.length} work centers, ${capacityExceptions.length} exceptions`);
    }
  }

  // 9. Detect exceptions
  const exceptions = [
    ...demandExceptions,
    ...detectShortageExceptions(g2nResult.netRequirements, horizon),
    ...detectLateOrderExceptions(plannedOrders),
    ...detectNoVendorExceptions(plannedOrders, components),
    ...capacityExceptions,
  ];

  // 10. Build summary
  const summary = buildSummary(
    components,
    g2nResult.netRequirements,
    plannedOrders,
    pegging,
    capacityLoads,
    exceptions,
  );

  const elapsed = Date.now() - startTime;
  log(`MRP run complete in ${elapsed}ms`);

  return {
    timestamp: new Date().toISOString(),
    horizon,
    netRequirements: Array.from(g2nResult.netRequirements.values()),
    plannedOrders,
    pegging,
    capacityLoads,
    exceptions,
    summary,
  };
}

// ── Planned Order Generation ─────────────────────────────────────

function generatePlannedOrders(
  netRequirements: Map<string, NetRequirement>,
  itemMetadata: Map<string, { leadTimeDays: number; safetyStock: number; lotSizingPolicy: string; replenishmentMethod: string }>,
  horizon: PlanningHorizon,
  components: BOMComponent[],
): PlannedOrder[] {
  const orders: PlannedOrder[] = [];
  const compMap = new Map(components.map((c) => [c.itemNo, c]));
  let counter = 0;

  for (const [itemNo, nr] of netRequirements) {
    const meta = itemMetadata.get(itemNo);
    const comp = compMap.get(itemNo);

    for (const bucket of nr.buckets) {
      if (bucket.plannedOrderReceipt <= 0) continue;

      counter++;
      const dueBucket = horizon.buckets[bucket.bucketIndex];
      const releaseBucket = horizon.buckets[bucket.plannedOrderRelease] ?? horizon.buckets[0];

      const orderType = meta?.replenishmentMethod === "production" || meta?.replenishmentMethod === "assembly"
        ? "production" as const
        : "purchase" as const;

      const order: PlannedOrder = {
        id: `PO-${String(counter).padStart(5, "0")}`,
        itemNo,
        itemName: nr.itemName,
        quantity: bucket.plannedOrderReceipt,
        orderDate: releaseBucket.startDate,
        dueDate: dueBucket.startDate,
        type: orderType,
        vendorNo: comp?.vendorNo,
        vendorName: comp?.vendorName,
        action: determineAction(bucket, releaseBucket),
        bomLevel: 0,
        peggedDemand: [],
        safetyBuffer: meta?.leadTimeDays ? (meta.leadTimeDays - (comp?.leadTimeDays ?? 0)) : 0,
        lotSizingPolicy: meta?.lotSizingPolicy ?? "L4L",
        status: "planned",
      };

      orders.push(order);
    }
  }

  return orders;
}

function determineAction(
  bucket: NetRequirement["buckets"][0],
  releaseBucket: { startDate: string },
): ActionMessage {
  const today = new Date().toISOString().slice(0, 10);
  if (releaseBucket.startDate <= today) return "expedite";
  return "create";
}

// ── Exception Detection ──────────────────────────────────────────

function detectShortageExceptions(
  netRequirements: Map<string, NetRequirement>,
  horizon: PlanningHorizon,
): MRPException[] {
  const exceptions: MRPException[] = [];

  for (const [itemNo, nr] of netRequirements) {
    for (const bucket of nr.buckets) {
      if (bucket.projectedOnHand < 0) {
        exceptions.push({
          severity: bucket.bucketIndex < 2 ? "critical" : "warning",
          type: "shortage",
          itemNo,
          itemName: nr.itemName,
          message: `Projected shortage of ${Math.abs(bucket.projectedOnHand)} units of ${nr.itemName} in ${horizon.buckets[bucket.bucketIndex]?.label ?? `bucket ${bucket.bucketIndex}`}`,
          bucket: bucket.bucketIndex,
          suggestedAction: "Increase planned order quantity or expedite existing supply",
        });
      }
    }
  }

  return exceptions;
}

function detectLateOrderExceptions(plannedOrders: PlannedOrder[]): MRPException[] {
  const today = new Date().toISOString().slice(0, 10);

  return plannedOrders
    .filter((o) => o.orderDate < today)
    .map((o) => ({
      severity: "critical" as const,
      type: "past_due" as const,
      itemNo: o.itemNo,
      itemName: o.itemName,
      message: `Planned order ${o.id} for ${o.itemName} should have been released on ${o.orderDate} — order date is past due`,
      suggestedAction: "Expedite this order immediately or find alternative supply",
    }));
}

function detectNoVendorExceptions(
  plannedOrders: PlannedOrder[],
  components: BOMComponent[],
): MRPException[] {
  const compMap = new Map(components.map((c) => [c.itemNo, c]));

  return plannedOrders
    .filter((o) => o.type === "purchase" && !o.vendorNo && !o.vendorName)
    .filter((o) => {
      const comp = compMap.get(o.itemNo);
      return !comp?.vendorNo && !comp?.vendorName;
    })
    .map((o) => ({
      severity: "warning" as const,
      type: "no_vendor" as const,
      itemNo: o.itemNo,
      itemName: o.itemName,
      message: `Planned purchase order ${o.id} for ${o.itemName} has no assigned vendor`,
      suggestedAction: "Assign a vendor before releasing this order",
    }));
}

// ── Summary ──────────────────────────────────────────────────────

function buildSummary(
  components: BOMComponent[],
  netRequirements: Map<string, NetRequirement>,
  plannedOrders: PlannedOrder[],
  pegging: MRPRunResult["pegging"],
  capacityLoads: MRPRunResult["capacityLoads"],
  exceptions: MRPException[],
): MRPSummary {
  const itemsWithNet = Array.from(netRequirements.values()).filter(
    (nr) => nr.buckets.some((b) => b.netRequirement > 0),
  ).length;

  const totalShortages = pegging.reduce((sum, tree) => sum + tree.shortages.length, 0);

  return {
    totalItems: components.length,
    itemsWithNetRequirements: itemsWithNet,
    plannedPurchaseOrders: plannedOrders.filter((o) => o.type === "purchase").length,
    plannedProductionOrders: plannedOrders.filter((o) => o.type === "production").length,
    totalShortages,
    totalExceptions: exceptions.length,
    overloadedWorkCenters: capacityLoads.filter((l) => l.overloadedBuckets > 0).length,
    coveragePercentage: components.length > 0
      ? Math.round(((components.length - totalShortages) / components.length) * 100)
      : 100,
  };
}

// ── ERP Data Mapping ──────────────────────────────────────────────

/**
 * Map ERP BOM component lot sizing policy to MRP LotSizingPolicy.
 * Returns null if no ERP policy is set or it maps to default L4L.
 */
function mapERPLotSizingPolicy(comp: BOMComponent): LotSizingPolicy | null {
  if (!comp.lotSizingPolicy) return null;

  switch (comp.lotSizingPolicy) {
    case "lot_for_lot":
    case "order":
      return { type: "lot_for_lot" };

    case "fixed_order_qty":
      return { type: "fixed_order_qty", quantity: comp.orderQuantity ?? 1 };

    case "eoq":
      // EOQ needs annual demand — estimate from safety stock and lead time
      return { type: "eoq", annualDemand: (comp.safetyStock ?? 0) * 12, orderingCost: comp.unitCost * 0.1, holdingCostRate: comp.unitCost * 0.25 };

    case "maximum_qty":
      return {
        type: "min_max",
        min: comp.minimumOrderQty ?? comp.reorderPoint ?? 0,
        max: comp.orderQuantity ?? (comp.safetyStock ? comp.safetyStock * 2 : 100),
      };

    default:
      return null;
  }
}

/**
 * Convert ERP WorkCenterData to MRP WorkCenter format.
 * Uses calendar data for accurate hours/day and OEE for real efficiency.
 */
function mapERPWorkCenters(erpWCs: WorkCenterData[]): WorkCenter[] {
  const workCenters: WorkCenter[] = [];

  for (const wc of erpWCs) {
    if (wc.blocked) continue;

    // Use calendar hours if available, otherwise fall back to raw capacity
    const hoursPerDay = wc.calendar?.hoursPerDay ?? (wc.capacityMinutesPerDay / 60);
    const capacityMinutesPerDay = hoursPerDay * 60;

    // Use actual OEE if measured, otherwise ERP efficiency setting
    const efficiency = wc.oeeActual
      ? wc.oeeActual / 100
      : wc.efficiencyPercent / 100;

    // Count active machine centers if available
    let unitCount = wc.machineCount;
    if (wc.machineCenters && wc.machineCenters.length > 0) {
      unitCount = wc.machineCenters.filter((mc) => !mc.blocked).length || 1;
    }

    workCenters.push({
      id: wc.id,
      name: wc.name,
      capacityMinutesPerDay: capacityMinutesPerDay,
      efficiency,
      unitCount,
      workingDaysPerWeek: wc.calendar?.daysPerWeek ?? wc.workingDaysPerWeek,
    });
  }

  return workCenters;
}
