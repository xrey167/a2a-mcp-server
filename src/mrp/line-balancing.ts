/**
 * Line Balancing (Taktzeit-Balancierung)
 *
 * Analyzes production line balance efficiency by comparing station
 * cycle times against customer takt time. Identifies imbalances and
 * recommends rebalancing actions.
 */

import type { RoutingStep } from "../erp/types.js";
import type { WorkCenter } from "./types.js";

function log(msg: string) {
  process.stderr.write(`[line-balancing] ${msg}\n`);
}

export interface LineBalanceStation {
  workCenterId: string;
  name: string;
  cycleTime: number;      // seconds
  idleTime: number;        // taktTime - cycleTime
  utilization: number;     // cycleTime / taktTime (%)
  operations: string[];    // assigned operation descriptions
}

export interface LineBalanceRecommendation {
  type: "merge_stations" | "split_operation" | "parallel_station" | "rebalance";
  description: string;
  estimatedEfficiencyGain: number;
}

export interface LineBalanceResult {
  lineName: string;
  taktTime: number;                      // seconds

  stations: LineBalanceStation[];

  // Metrics
  bottleneckStation: string;
  bottleneckCycleTime: number;
  balancingEfficiency: number;           // %
  balancingLoss: number;                 // 100 - efficiency
  theoreticalMinStations: number;

  // Recommendations
  recommendations: LineBalanceRecommendation[];
}

/**
 * Analyze line balance from routing steps against a given takt time.
 *
 * @param routingSteps - Production routing operations
 * @param workCenters - Work center definitions
 * @param customerTaktTime - Required takt time in seconds/unit
 */
export function analyzeLineBalance(
  routingSteps: RoutingStep[],
  workCenters: WorkCenter[],
  customerTaktTime: number,
): LineBalanceResult {
  const wcMap = new Map(workCenters.map((wc) => [wc.id, wc]));

  // Group operations by work center (= station)
  const stationOps = new Map<string, RoutingStep[]>();
  for (const step of routingSteps) {
    const ops = stationOps.get(step.workCenterNo) ?? [];
    ops.push(step);
    stationOps.set(step.workCenterNo, ops);
  }

  // Build stations
  const stations: LineBalanceStation[] = [];
  let totalCycleTime = 0;
  let maxCycleTime = 0;
  let bottleneckStation = "";

  for (const [wcId, ops] of stationOps) {
    const wc = wcMap.get(wcId);
    const name = wc?.name ?? wcId;

    // Cycle time = sum of (setup + run) for all ops at this station, in seconds
    const cycleTimeSeconds = ops.reduce(
      (sum, op) => sum + (op.setupTimeMinutes + op.runTimeMinutes) * 60,
      0,
    );

    const idleTime = Math.max(0, customerTaktTime - cycleTimeSeconds);
    const utilization = customerTaktTime > 0
      ? Math.round((cycleTimeSeconds / customerTaktTime) * 100)
      : 0;

    stations.push({
      workCenterId: wcId,
      name,
      cycleTime: Math.round(cycleTimeSeconds),
      idleTime: Math.round(idleTime),
      utilization,
      operations: ops.map((o) => `${o.operationNo}: ${o.description}`),
    });

    totalCycleTime += cycleTimeSeconds;
    if (cycleTimeSeconds > maxCycleTime) {
      maxCycleTime = cycleTimeSeconds;
      bottleneckStation = name;
    }
  }

  // Sort stations by routing order (using first operation number)
  stations.sort((a, b) => {
    const aOp = stationOps.get(a.workCenterId)?.[0]?.operationNo ?? "0";
    const bOp = stationOps.get(b.workCenterId)?.[0]?.operationNo ?? "0";
    return aOp.localeCompare(bOp, undefined, { numeric: true });
  });

  const stationCount = stations.length;
  const balancingEfficiency = stationCount > 0 && customerTaktTime > 0
    ? Math.round((totalCycleTime / (stationCount * customerTaktTime)) * 100)
    : 0;
  const balancingLoss = 100 - balancingEfficiency;
  const theoreticalMinStations = customerTaktTime > 0
    ? Math.ceil(totalCycleTime / customerTaktTime)
    : stationCount;

  // Generate recommendations
  const recommendations = generateRecommendations(stations, customerTaktTime, theoreticalMinStations);

  const result: LineBalanceResult = {
    lineName: `Line for ${routingSteps[0]?.description ?? "unknown"}`,
    taktTime: customerTaktTime,
    stations,
    bottleneckStation,
    bottleneckCycleTime: Math.round(maxCycleTime),
    balancingEfficiency,
    balancingLoss,
    theoreticalMinStations,
    recommendations,
  };

  log(`line balance: ${stations.length} stations, efficiency=${balancingEfficiency}%, bottleneck=${bottleneckStation}`);
  return result;
}

/**
 * Optimize line balance by reassigning operations.
 * Simple heuristic: merge underutilized adjacent stations.
 */
export function optimizeLineBalance(
  current: LineBalanceResult,
  constraints?: { maxStations?: number; fixedOperations?: string[] },
): LineBalanceResult {
  const maxStations = constraints?.maxStations ?? current.stations.length;
  const fixedOps = new Set(constraints?.fixedOperations ?? []);

  // If already at theoretical minimum or constrained, return as-is
  if (current.stations.length <= current.theoreticalMinStations) {
    return current;
  }

  // Simple merge heuristic: combine adjacent stations if combined cycle < takt
  const optimized: LineBalanceStation[] = [];
  let i = 0;

  while (i < current.stations.length) {
    const station = { ...current.stations[i] };
    station.operations = [...station.operations];

    // Try to merge with next station if both are underutilized
    while (
      i + 1 < current.stations.length &&
      optimized.length + (current.stations.length - i - 1) > current.theoreticalMinStations &&
      !fixedOps.has(station.workCenterId) &&
      !fixedOps.has(current.stations[i + 1].workCenterId)
    ) {
      const next = current.stations[i + 1];
      const combinedCycle = station.cycleTime + next.cycleTime;

      if (combinedCycle <= current.taktTime) {
        station.cycleTime = combinedCycle;
        station.idleTime = Math.max(0, current.taktTime - combinedCycle);
        station.utilization = current.taktTime > 0
          ? Math.round((combinedCycle / current.taktTime) * 100)
          : 0;
        station.operations.push(...next.operations);
        station.name = `${station.name} + ${next.name}`;
        i++;
      } else {
        break;
      }
    }

    optimized.push(station);
    i++;
  }

  // Recalculate metrics
  const totalCycle = optimized.reduce((s, st) => s + st.cycleTime, 0);
  const maxCycle = Math.max(...optimized.map((s) => s.cycleTime));
  const bottleneck = optimized.find((s) => s.cycleTime === maxCycle)?.name ?? "";
  const efficiency = optimized.length > 0 && current.taktTime > 0
    ? Math.round((totalCycle / (optimized.length * current.taktTime)) * 100)
    : 0;

  return {
    ...current,
    stations: optimized,
    bottleneckStation: bottleneck,
    bottleneckCycleTime: Math.round(maxCycle),
    balancingEfficiency: efficiency,
    balancingLoss: 100 - efficiency,
    recommendations: generateRecommendations(optimized, current.taktTime, current.theoreticalMinStations),
  };
}

// ── Recommendation Engine ───────────────────────────────────────

function generateRecommendations(
  stations: LineBalanceStation[],
  taktTime: number,
  theoreticalMin: number,
): LineBalanceRecommendation[] {
  const recommendations: LineBalanceRecommendation[] = [];

  // Check for mergeable adjacent stations
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    if (a.cycleTime + b.cycleTime <= taktTime && a.utilization < 60 && b.utilization < 60) {
      recommendations.push({
        type: "merge_stations",
        description: `Merge "${a.name}" (${a.utilization}%) and "${b.name}" (${b.utilization}%) — combined cycle ${Math.round(a.cycleTime + b.cycleTime)}s vs takt ${Math.round(taktTime)}s`,
        estimatedEfficiencyGain: Math.round((a.idleTime + b.idleTime) / (stations.length * taktTime) * 100),
      });
    }
  }

  // Check for overloaded stations needing split
  for (const station of stations) {
    if (station.cycleTime > taktTime) {
      recommendations.push({
        type: "split_operation",
        description: `Split operations at "${station.name}" — cycle time ${Math.round(station.cycleTime)}s exceeds takt ${Math.round(taktTime)}s by ${Math.round(station.cycleTime - taktTime)}s`,
        estimatedEfficiencyGain: Math.round(((station.cycleTime - taktTime) / taktTime) * 100),
      });
    }
  }

  // Check if parallel stations would help
  for (const station of stations) {
    if (station.cycleTime > taktTime * 1.5) {
      recommendations.push({
        type: "parallel_station",
        description: `Add parallel station for "${station.name}" — cycle time ${Math.round(station.cycleTime)}s is ${Math.round(station.cycleTime / taktTime * 100)}% of takt`,
        estimatedEfficiencyGain: Math.round(((station.cycleTime - taktTime) / (stations.length * taktTime)) * 100),
      });
    }
  }

  // General rebalance if actual > theoretical minimum
  if (stations.length > theoreticalMin) {
    recommendations.push({
      type: "rebalance",
      description: `Current ${stations.length} stations can theoretically be reduced to ${theoreticalMin}. Full rebalancing analysis recommended.`,
      estimatedEfficiencyGain: Math.round(((stations.length - theoreticalMin) / stations.length) * 100),
    });
  }

  return recommendations;
}
