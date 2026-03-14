/**
 * Value Stream Mapping — Lean Manufacturing analysis from MRP data.
 *
 * Generates a Wertstromanalyse (Value Stream Map) from MRP run results,
 * routing data, and capacity data. Identifies waste, bottlenecks, and
 * Kaizen improvement opportunities.
 */

import type { RoutingStep, WorkCenterData } from "../erp/types.js";
import type { MRPRunResult, CapacityLoad, WorkCenter } from "./types.js";

function log(msg: string) {
  process.stderr.write(`[value-stream] ${msg}\n`);
}

// ── Interfaces ──────────────────────────────────────────────────

export interface ValueStreamStep {
  workCenterId: string;
  workCenterName: string;
  operationNo: string;
  operationType: "processing" | "transport" | "inspection" | "storage" | "setup";

  // Time metrics (minutes)
  processingTime: number;
  setupTime: number;
  waitTime: number;
  transportTime: number;
  inspectionTime: number;

  // Lean metrics
  cycleTime: number;        // Processing + Setup
  leadTime: number;          // Total time for this step
  valueAddedRatio: number;   // Processing / LeadTime (%)

  // Inventory
  wipQuantity: number;
  wipDays: number;

  // Capacity
  oee: number | null;
  utilization: number;
  taktTime: number | null;
}

export interface KaizenOpportunity {
  type: "setup_reduction" | "wait_elimination" | "transport_optimization" | "wip_reduction" | "bottleneck_relief" | "quality_improvement";
  station: string;
  description: string;
  estimatedImpact: string;
  priority: "high" | "medium" | "low";
}

export interface ValueStreamMap {
  productFamily: string;
  itemNo: string;
  itemName: string;

  // Aggregate metrics
  totalLeadTime: number;
  totalProcessingTime: number;
  totalSetupTime: number;
  totalWaitTime: number;
  totalTransportTime: number;
  valueAddedRatio: number;

  // Takt time analysis
  customerTaktTime: number | null;
  bottleneckStation: string | null;
  balancingLoss: number;

  // Inventory metrics
  totalWip: number;
  totalWipDays: number;
  inventoryTurns: number | null;

  // Steps (ordered by routing sequence)
  steps: ValueStreamStep[];

  // Kaizen blitzes
  kaizenOpportunities: KaizenOpportunity[];
}

export interface ValueStreamComparison {
  current: ValueStreamMap;
  target: ValueStreamMap;
  improvements: Array<{
    metric: string;
    currentValue: number;
    targetValue: number;
    change: number;
    changePercent: number;
  }>;
}

// ── Main Functions ──────────────────────────────────────────────

/**
 * Generate a Value Stream Map from MRP data + routing + capacity.
 */
export function generateValueStreamMap(
  itemNo: string,
  itemName: string,
  mrpResult: MRPRunResult,
  routingSteps: RoutingStep[],
  workCenters: WorkCenter[],
  customerDemandPerDay?: number,
): ValueStreamMap {
  const wcMap = new Map(workCenters.map((wc) => [wc.id, wc]));
  const capacityMap = new Map(mrpResult.capacityLoads.map((cl) => [cl.workCenterId, cl]));

  // Calculate takt time if demand is known
  const taktTime = customerDemandPerDay && customerDemandPerDay > 0
    ? (480 / customerDemandPerDay) // 480 min = 8h work day, result in min/unit
    : null;

  // Build steps from routing
  const steps: ValueStreamStep[] = routingSteps.map((rs) => {
    const wc = wcMap.get(rs.workCenterNo);
    const cap = capacityMap.get(rs.workCenterNo);

    const processingTime = rs.runTimeMinutes;
    const setupTime = rs.setupTimeMinutes;
    const waitTime = rs.waitTimeMinutes;
    const transportTime = rs.moveTimeMinutes;
    const inspectionTime = 0; // Not explicitly tracked in routing steps

    const cycleTime = processingTime + setupTime;
    const leadTime = processingTime + setupTime + waitTime + transportTime + inspectionTime;
    const valueAddedRatio = leadTime > 0 ? Math.round((processingTime / leadTime) * 100) : 0;

    // WIP estimation from capacity load orders
    let wipQuantity = 0;
    if (cap) {
      for (const bucket of cap.buckets) {
        const itemOrders = bucket.orders.filter((o) => o.itemNo === itemNo);
        wipQuantity += itemOrders.length;
      }
    }

    const throughputPerDay = wc
      ? (wc.capacityMinutesPerDay * wc.efficiency) / Math.max(1, cycleTime)
      : 1;
    const wipDays = throughputPerDay > 0 ? Math.round((wipQuantity / throughputPerDay) * 10) / 10 : 0;

    // OEE from capacity data
    const oee = wc && "oeeActual" in wc ? (wc as unknown as WorkCenterData).oeeActual ?? null : null;

    // Utilization from capacity load
    const utilization = cap ? cap.averageUtilization : 0;

    return {
      workCenterId: rs.workCenterNo,
      workCenterName: rs.workCenterName,
      operationNo: rs.operationNo,
      operationType: "processing" as const,
      processingTime,
      setupTime,
      waitTime,
      transportTime,
      inspectionTime,
      cycleTime,
      leadTime,
      valueAddedRatio,
      wipQuantity,
      wipDays,
      oee,
      utilization,
      taktTime,
    };
  });

  // Aggregate metrics
  const totalProcessingTime = steps.reduce((s, st) => s + st.processingTime, 0);
  const totalSetupTime = steps.reduce((s, st) => s + st.setupTime, 0);
  const totalWaitTime = steps.reduce((s, st) => s + st.waitTime, 0);
  const totalTransportTime = steps.reduce((s, st) => s + st.transportTime, 0);
  const totalLeadTime = steps.reduce((s, st) => s + st.leadTime, 0);
  const valueAddedRatio = totalLeadTime > 0
    ? Math.round((totalProcessingTime / totalLeadTime) * 100)
    : 0;

  // Bottleneck: station with highest cycle time
  let bottleneckStation: string | null = null;
  let maxCycleTime = 0;
  for (const step of steps) {
    if (step.cycleTime > maxCycleTime) {
      maxCycleTime = step.cycleTime;
      bottleneckStation = step.workCenterName;
    }
  }

  // Balancing loss
  const avgCycleTime = steps.length > 0
    ? steps.reduce((s, st) => s + st.cycleTime, 0) / steps.length
    : 0;
  const balancingLoss = maxCycleTime > 0 && steps.length > 0
    ? Math.round((1 - avgCycleTime / maxCycleTime) * 100)
    : 0;

  // WIP totals
  const totalWip = steps.reduce((s, st) => s + st.wipQuantity, 0);
  const totalWipDays = steps.reduce((s, st) => s + st.wipDays, 0);
  const inventoryTurns = totalWipDays > 0 ? Math.round((365 / totalWipDays) * 10) / 10 : null;

  // Generate Kaizen opportunities
  const kaizenOpportunities = identifyKaizenOpportunities(steps, taktTime);

  const vsm: ValueStreamMap = {
    productFamily: itemNo,
    itemNo,
    itemName,
    totalLeadTime,
    totalProcessingTime,
    totalSetupTime,
    totalWaitTime,
    totalTransportTime,
    valueAddedRatio,
    customerTaktTime: taktTime,
    bottleneckStation,
    balancingLoss,
    totalWip,
    totalWipDays,
    inventoryTurns,
    steps,
    kaizenOpportunities,
  };

  log(`generated VSM for ${itemNo}: ${steps.length} steps, VARatio=${valueAddedRatio}%, bottleneck=${bottleneckStation}`);
  return vsm;
}

/**
 * Compare two Value Stream Maps (current vs. target or two time points).
 */
export function compareValueStreams(
  current: ValueStreamMap,
  target: ValueStreamMap,
): ValueStreamComparison {
  const metrics = [
    { metric: "totalLeadTime", currentValue: current.totalLeadTime, targetValue: target.totalLeadTime },
    { metric: "totalProcessingTime", currentValue: current.totalProcessingTime, targetValue: target.totalProcessingTime },
    { metric: "totalSetupTime", currentValue: current.totalSetupTime, targetValue: target.totalSetupTime },
    { metric: "totalWaitTime", currentValue: current.totalWaitTime, targetValue: target.totalWaitTime },
    { metric: "valueAddedRatio", currentValue: current.valueAddedRatio, targetValue: target.valueAddedRatio },
    { metric: "totalWip", currentValue: current.totalWip, targetValue: target.totalWip },
    { metric: "balancingLoss", currentValue: current.balancingLoss, targetValue: target.balancingLoss },
  ];

  return {
    current,
    target,
    improvements: metrics.map((m) => ({
      ...m,
      change: m.targetValue - m.currentValue,
      changePercent: m.currentValue !== 0
        ? Math.round(((m.targetValue - m.currentValue) / m.currentValue) * 100)
        : 0,
    })),
  };
}

// ── Kaizen Identification ───────────────────────────────────────

function identifyKaizenOpportunities(
  steps: ValueStreamStep[],
  taktTime: number | null,
): KaizenOpportunity[] {
  const opportunities: KaizenOpportunity[] = [];

  for (const step of steps) {
    // SMED candidate: setup > 20% of cycle time
    if (step.cycleTime > 0 && step.setupTime / step.cycleTime > 0.2) {
      opportunities.push({
        type: "setup_reduction",
        station: step.workCenterName,
        description: `Setup time (${step.setupTime}min) is ${Math.round((step.setupTime / step.cycleTime) * 100)}% of cycle time. SMED candidate.`,
        estimatedImpact: `Cycle time -${Math.round(step.setupTime * 0.5)}min (50% setup reduction)`,
        priority: step.setupTime / step.cycleTime > 0.4 ? "high" : "medium",
      });
    }

    // Wait time elimination: wait > processing time
    if (step.waitTime > step.processingTime && step.waitTime > 0) {
      opportunities.push({
        type: "wait_elimination",
        station: step.workCenterName,
        description: `Wait time (${step.waitTime}min) exceeds processing time (${step.processingTime}min). Pull system or buffer reduction needed.`,
        estimatedImpact: `Lead time -${Math.round(step.waitTime * 0.5)}min`,
        priority: step.waitTime > step.processingTime * 2 ? "high" : "medium",
      });
    }

    // Transport optimization: transport > 10% of lead time
    if (step.leadTime > 0 && step.transportTime / step.leadTime > 0.1) {
      opportunities.push({
        type: "transport_optimization",
        station: step.workCenterName,
        description: `Transport time (${step.transportTime}min) is ${Math.round((step.transportTime / step.leadTime) * 100)}% of lead time. Layout optimization needed.`,
        estimatedImpact: `Lead time -${Math.round(step.transportTime * 0.5)}min`,
        priority: "low",
      });
    }

    // WIP reduction: WIP > 3 days
    if (step.wipDays > 3) {
      opportunities.push({
        type: "wip_reduction",
        station: step.workCenterName,
        description: `WIP level at ${step.wipDays} days exceeds 3-day target. Kanban or flow improvement needed.`,
        estimatedImpact: `WIP -${Math.round((step.wipDays - 3) * 100 / step.wipDays)}%`,
        priority: step.wipDays > 5 ? "high" : "medium",
      });
    }

    // Bottleneck relief: cycle time > takt time
    if (taktTime && step.cycleTime > taktTime) {
      opportunities.push({
        type: "bottleneck_relief",
        station: step.workCenterName,
        description: `Cycle time (${step.cycleTime}min) exceeds takt time (${Math.round(taktTime)}min). Capacity expansion or load balancing needed.`,
        estimatedImpact: `Throughput +${Math.round(((step.cycleTime - taktTime) / taktTime) * 100)}%`,
        priority: "high",
      });
    }

    // Quality: low OEE
    if (step.oee !== null && step.oee < 65) {
      opportunities.push({
        type: "quality_improvement",
        station: step.workCenterName,
        description: `OEE at ${step.oee}% is below 65% threshold. TPM program recommended.`,
        estimatedImpact: `OEE +${Math.round(85 - step.oee)}pp potential`,
        priority: step.oee < 50 ? "high" : "medium",
      });
    }
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return opportunities.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}
