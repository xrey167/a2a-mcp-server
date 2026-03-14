/**
 * Capacity Requirements Planning (CRP)
 *
 * Calculates work center loads from production orders and planned orders,
 * detects overloads, and identifies capacity bottlenecks.
 *
 * Uses routing data from production orders to compute:
 *   - Setup time + run time per operation per work center
 *   - Load distribution across time buckets
 *   - Utilization percentages and overload detection
 */

import type { ProductionOrder, RoutingStep } from "../erp/types.js";
import type {
  PlanningHorizon,
  PlannedOrder,
  WorkCenter,
  CapacityLoad,
  MRPException,
} from "./types.js";

function log(msg: string) {
  process.stderr.write(`[mrp-capacity] ${msg}\n`);
}

// ── Default Work Centers ─────────────────────────────────────────

/**
 * Extract work centers from routing data across all production orders.
 * If no routing data is available, return defaults.
 */
export function discoverWorkCenters(
  productionOrders: ProductionOrder[],
  overrides?: WorkCenter[],
): WorkCenter[] {
  const wcMap = new Map<string, WorkCenter>();

  // User overrides take priority
  if (overrides) {
    for (const wc of overrides) {
      wcMap.set(wc.id, wc);
    }
  }

  // Discover from routing data
  for (const order of productionOrders) {
    for (const step of order.routings) {
      if (!wcMap.has(step.workCenterNo)) {
        wcMap.set(step.workCenterNo, {
          id: step.workCenterNo,
          name: step.workCenterName,
          // Default: 8 hours per day, 85% efficiency, 1 machine
          capacityMinutesPerDay: 480,
          efficiency: 0.85,
          unitCount: 1,
        });
      }
    }
  }

  return Array.from(wcMap.values());
}

// ── Capacity Calculation ─────────────────────────────────────────

export interface CapacityInput {
  productionOrders: ProductionOrder[];
  plannedOrders: PlannedOrder[];
  workCenters: WorkCenter[];
  horizon: PlanningHorizon;
  /** Routing master data for planned order CRP (itemNo → routing steps) */
  routingMap?: Map<string, RoutingStep[]>;
}

/**
 * Calculate capacity loads for all work centers across the planning horizon.
 */
export function calculateCapacityLoads(input: CapacityInput): CapacityLoad[] {
  const { productionOrders, plannedOrders, workCenters, horizon } = input;

  if (workCenters.length === 0) {
    log("no work centers discovered — skipping CRP");
    return [];
  }

  const loads: CapacityLoad[] = workCenters.map((wc) => ({
    workCenterId: wc.id,
    workCenterName: wc.name,
    buckets: horizon.buckets.map((b) => ({
      bucketIndex: b.index,
      requiredMinutes: 0,
      availableMinutes: calculateAvailableMinutes(wc, b.startDate, b.endDate),
      utilization: 0,
      overloaded: false,
      orders: [],
    })),
    averageUtilization: 0,
    peakUtilization: 0,
    overloadedBuckets: 0,
  }));

  const loadMap = new Map(loads.map((l) => [l.workCenterId, l]));

  // Load from existing production orders
  for (const order of productionOrders) {
    if (order.status === "finished") continue;
    loadRoutings(order.routings, order.quantity, order.number, "production", order.itemNo, order.startDate, loadMap, horizon);
  }

  // Load from planned production orders — look up routings from routing map
  if (input.routingMap) {
    for (const po of plannedOrders) {
      if (po.type !== "production") continue;
      const routings = input.routingMap.get(po.itemNo);
      if (routings && routings.length > 0) {
        loadRoutings(routings, po.quantity, po.id, "planned", po.itemNo, po.orderDate, loadMap, horizon);
      }
    }
    log(`loaded planned order routings for ${plannedOrders.filter((o) => o.type === "production" && input.routingMap!.has(o.itemNo)).length} planned production orders`);
  }

  // Calculate utilization
  for (const load of loads) {
    let totalUtil = 0;
    let peak = 0;
    let overloaded = 0;

    for (const bucket of load.buckets) {
      if (bucket.availableMinutes > 0) {
        bucket.utilization = Math.round((bucket.requiredMinutes / bucket.availableMinutes) * 100);
        bucket.overloaded = bucket.utilization > 100;
      }
      totalUtil += bucket.utilization;
      if (bucket.utilization > peak) peak = bucket.utilization;
      if (bucket.overloaded) overloaded++;
    }

    load.averageUtilization = Math.round(totalUtil / Math.max(1, load.buckets.length));
    load.peakUtilization = peak;
    load.overloadedBuckets = overloaded;
  }

  log(`calculated capacity for ${loads.length} work centers`);
  return loads;
}

function calculateAvailableMinutes(wc: WorkCenter, startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));

  // Use ERP calendar working days if available, otherwise assume 5/7
  const daysPerWeek = wc.workingDaysPerWeek ?? 5;

  // Count working days by iterating through the period to correctly
  // handle partial weeks and weekend boundaries instead of using a
  // simple ratio which is inaccurate for short periods.
  let workingDays = 0;
  const weekendDays = 7 - daysPerWeek;          // e.g. 2 for a 5-day week
  const firstWeekendDay = daysPerWeek;           // e.g. day-of-week index 5 (Sat) for Mon-Fri
  const cursor = new Date(start);
  for (let i = 0; i < totalDays; i++) {
    const dow = cursor.getDay();                 // 0=Sun .. 6=Sat
    // Map JS day (0=Sun) to ISO-style Mon=0: (dow + 6) % 7
    const isoDow = (dow + 6) % 7;               // 0=Mon .. 6=Sun
    if (isoDow < daysPerWeek) {
      workingDays++;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return workingDays * wc.capacityMinutesPerDay * wc.efficiency * wc.unitCount;
}

function loadRoutings(
  routings: RoutingStep[],
  quantity: number,
  orderId: string,
  orderType: string,
  itemNo: string,
  startDate: string,
  loadMap: Map<string, CapacityLoad>,
  horizon: PlanningHorizon,
): void {
  // Determine bucket for this order
  const bucketIdx = dateToBucket(startDate, horizon);

  for (const step of routings) {
    const load = loadMap.get(step.workCenterNo);
    if (!load) continue;

    const bucket = load.buckets[bucketIdx];
    if (!bucket) continue;

    const setupMin = step.setupTimeMinutes;
    const runMin = step.runTimeMinutes * quantity;
    const totalMin = setupMin + runMin;

    bucket.requiredMinutes += totalMin;
    bucket.orders.push({
      orderType,
      orderId,
      itemNo,
      setupMinutes: setupMin,
      runMinutes: runMin,
    });
  }
}

function dateToBucket(dateStr: string, horizon: PlanningHorizon): number {
  for (const bucket of horizon.buckets) {
    if (dateStr >= bucket.startDate && dateStr < bucket.endDate) {
      return bucket.index;
    }
  }
  if (dateStr < horizon.startDate) return 0;
  return horizon.buckets.length - 1;
}

// ── Exception Detection ──────────────────────────────────────────

/**
 * Generate MRP exceptions from capacity loads.
 */
export function detectCapacityExceptions(loads: CapacityLoad[]): MRPException[] {
  const exceptions: MRPException[] = [];

  for (const load of loads) {
    for (const bucket of load.buckets) {
      if (bucket.overloaded) {
        exceptions.push({
          severity: bucket.utilization > 150 ? "critical" : "warning",
          type: "overload",
          workCenterId: load.workCenterId,
          message: `Work center ${load.workCenterName} overloaded at ${bucket.utilization}% in bucket ${bucket.bucketIndex} (${bucket.requiredMinutes}min required vs ${bucket.availableMinutes}min available)`,
          bucket: bucket.bucketIndex,
          suggestedAction: bucket.utilization > 150
            ? "Consider overtime, outsourcing, or rescheduling orders"
            : "Monitor closely; consider shifting load to adjacent periods",
        });
      }
    }

    if (load.averageUtilization > 90) {
      exceptions.push({
        severity: "warning",
        type: "overload",
        workCenterId: load.workCenterId,
        message: `Work center ${load.workCenterName} has sustained high utilization at ${load.averageUtilization}% average — no buffer for disruptions`,
        suggestedAction: "Plan additional capacity or reduce load to maintain buffer",
      });
    }
  }

  return exceptions;
}
