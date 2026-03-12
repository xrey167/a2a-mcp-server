/**
 * Demand Planning — aggregates all demand sources into time-phased buckets.
 *
 * Sources of demand:
 *   - Independent demand: Sales orders (customer orders)
 *   - Dependent demand: BOM explosion (component requirements from production)
 *   - Safety stock: Replenishment to maintain minimum levels
 *   - Forecasts: Manual demand forecasts (optional input)
 *
 * Output: Time-phased demand per item per bucket (day/week/month)
 */

import type {
  ProductionOrder,
  SalesOrder,
  BOMComponent,
} from "../erp/types.js";
import type {
  BucketSize,
  PlanningHorizon,
  PlanningBucket,
  DemandRecord,
  DemandSource,
  TimePhasedDemand,
} from "./types.js";

function log(msg: string) {
  process.stderr.write(`[mrp-demand] ${msg}\n`);
}

// ── Planning Horizon Construction ────────────────────────────────

/**
 * Build a planning horizon with dated buckets.
 */
export function buildPlanningHorizon(
  startDate: string,
  weeks: number,
  bucketSize: BucketSize,
): PlanningHorizon {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);

  const totalDays = weeks * 7;
  const end = new Date(start);
  end.setDate(end.getDate() + totalDays);

  const buckets: PlanningBucket[] = [];

  if (bucketSize === "day") {
    for (let d = 0; d < totalDays; d++) {
      const bStart = new Date(start);
      bStart.setDate(bStart.getDate() + d);
      const bEnd = new Date(bStart);
      bEnd.setDate(bEnd.getDate() + 1);
      buckets.push({
        index: d,
        startDate: isoDate(bStart),
        endDate: isoDate(bEnd),
        label: isoDate(bStart),
      });
    }
  } else if (bucketSize === "week") {
    for (let w = 0; w < weeks; w++) {
      const bStart = new Date(start);
      bStart.setDate(bStart.getDate() + w * 7);
      const bEnd = new Date(bStart);
      bEnd.setDate(bEnd.getDate() + 7);
      const weekNum = getISOWeek(bStart);
      buckets.push({
        index: w,
        startDate: isoDate(bStart),
        endDate: isoDate(bEnd),
        label: `W${weekNum} ${bStart.getFullYear()}`,
      });
    }
  } else {
    // month
    const current = new Date(start);
    let idx = 0;
    while (current < end) {
      const bStart = new Date(current);
      const bEnd = new Date(current);
      bEnd.setMonth(bEnd.getMonth() + 1);
      if (bEnd > end) bEnd.setTime(end.getTime());
      buckets.push({
        index: idx++,
        startDate: isoDate(bStart),
        endDate: isoDate(bEnd),
        label: `${bStart.getFullYear()}-${String(bStart.getMonth() + 1).padStart(2, "0")}`,
      });
      current.setMonth(current.getMonth() + 1);
    }
  }

  return {
    startDate: isoDate(start),
    endDate: isoDate(end),
    bucketSize,
    buckets,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getISOWeek(d: Date): number {
  const temp = new Date(d.getTime());
  temp.setHours(0, 0, 0, 0);
  temp.setDate(temp.getDate() + 3 - ((temp.getDay() + 6) % 7));
  const week1 = new Date(temp.getFullYear(), 0, 4);
  return 1 + Math.round(((temp.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

/**
 * Find which bucket a date falls into.
 */
function dateToBucket(dateStr: string, horizon: PlanningHorizon): number {
  for (const bucket of horizon.buckets) {
    if (dateStr >= bucket.startDate && dateStr < bucket.endDate) {
      return bucket.index;
    }
  }
  // If date is before horizon, bucket 0; if after, last bucket
  if (dateStr < horizon.startDate) return 0;
  return horizon.buckets.length - 1;
}

// ── Demand Collection ────────────────────────────────────────────

export interface DemandForecast {
  itemNo: string;
  itemName: string;
  quantity: number;
  periodStart: string;
  periodEnd: string;
}

export interface DemandPlanInput {
  salesOrders: SalesOrder[];
  productionOrders: ProductionOrder[];
  /** Optional manual forecasts */
  forecasts?: DemandForecast[];
  /** Components with safety stock requirements */
  components: BOMComponent[];
  horizon: PlanningHorizon;
}

/**
 * Build time-phased demand plan from all sources.
 *
 * Step 1: Collect independent demand (sales orders)
 * Step 2: Explode dependent demand (production orders → BOM components)
 * Step 3: Add safety stock replenishment demand
 * Step 4: Aggregate into time buckets
 */
export function buildDemandPlan(input: DemandPlanInput): Map<string, TimePhasedDemand> {
  const { salesOrders, productionOrders, forecasts, components, horizon } = input;
  const allDemands: DemandRecord[] = [];

  // Step 1: Independent demand from sales orders
  for (const so of salesOrders) {
    if (so.status !== "open" && so.status !== "released") continue;
    for (const line of so.lines) {
      const dueDate = line.requestedDeliveryDate || so.requestedDeliveryDate;
      allDemands.push({
        itemNo: line.itemNo,
        itemName: line.itemName,
        quantity: line.quantity,
        dueDate,
        source: { type: "sales_order", sourceId: so.number, sourceLineNo: line.lineNo },
        bomLevel: 0,
      });
    }
  }

  // Step 2: Dependent demand from production orders
  // Each production order's components create dependent demand
  for (const po of productionOrders) {
    if (po.status === "finished") continue;
    explodeDemand(po.itemNo, po.itemName, po.quantity, po.dueDate, po.components, allDemands, po.number, 1);
  }

  // Step 3: Forecasts
  if (forecasts) {
    for (const fc of forecasts) {
      allDemands.push({
        itemNo: fc.itemNo,
        itemName: fc.itemName,
        quantity: fc.quantity,
        dueDate: fc.periodStart,
        source: { type: "forecast", sourceId: `FC-${fc.itemNo}-${fc.periodStart}` },
        bomLevel: 0,
      });
    }
  }

  // Step 4: Safety stock demand (bucket 0 — immediate)
  for (const comp of components) {
    if (comp.inventoryLevel < comp.safetyStock) {
      const deficit = comp.safetyStock - comp.inventoryLevel;
      allDemands.push({
        itemNo: comp.itemNo,
        itemName: comp.itemName,
        quantity: deficit,
        dueDate: horizon.startDate,
        source: { type: "safety_stock", sourceId: `SS-${comp.itemNo}` },
        bomLevel: 0,
      });
    }
  }

  log(`collected ${allDemands.length} demand records from all sources`);

  // Aggregate into time-phased demand per item
  return aggregateDemand(allDemands, horizon);
}

/**
 * Explode BOM to generate dependent demand records.
 */
function explodeDemand(
  parentItemNo: string,
  parentItemName: string,
  parentQty: number,
  parentDueDate: string,
  components: BOMComponent[],
  out: DemandRecord[],
  sourceId: string,
  level: number,
): void {
  for (const comp of components) {
    const requiredQty = comp.quantityPer * parentQty;

    // Due date for component = parent due date - component lead time
    const compDue = new Date(parentDueDate);
    compDue.setDate(compDue.getDate() - comp.leadTimeDays);
    const dueDate = isoDate(compDue);

    out.push({
      itemNo: comp.itemNo,
      itemName: comp.itemName,
      quantity: requiredQty,
      dueDate,
      source: {
        type: "dependent",
        sourceId,
      },
      bomLevel: level,
    });

    // Recursive explosion for sub-assemblies
    if (comp.children && comp.children.length > 0) {
      explodeDemand(comp.itemNo, comp.itemName, requiredQty, dueDate, comp.children, out, sourceId, level + 1);
    }
  }
}

/**
 * Aggregate demand records into time-phased buckets per item.
 */
function aggregateDemand(
  demands: DemandRecord[],
  horizon: PlanningHorizon,
): Map<string, TimePhasedDemand> {
  const result = new Map<string, TimePhasedDemand>();

  for (const demand of demands) {
    let tpd = result.get(demand.itemNo);
    if (!tpd) {
      tpd = {
        itemNo: demand.itemNo,
        itemName: demand.itemName,
        buckets: horizon.buckets.map((b) => ({
          bucketIndex: b.index,
          grossDemand: 0,
          demandRecords: [],
        })),
        totalDemand: 0,
      };
      result.set(demand.itemNo, tpd);
    }

    const bucketIdx = dateToBucket(demand.dueDate, horizon);
    const bucket = tpd.buckets[bucketIdx];
    if (bucket) {
      bucket.grossDemand += demand.quantity;
      bucket.demandRecords.push(demand);
      tpd.totalDemand += demand.quantity;
    }
  }

  return result;
}

/**
 * Get all unique item numbers with demand.
 */
export function getItemsWithDemand(demandPlan: Map<string, TimePhasedDemand>): string[] {
  return Array.from(demandPlan.keys());
}
