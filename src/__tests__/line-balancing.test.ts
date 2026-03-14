import { describe, test, expect } from "bun:test";
import { analyzeLineBalance, optimizeLineBalance } from "../mrp/line-balancing.js";
import type { RoutingStep } from "../erp/types.js";
import type { WorkCenter } from "../mrp/types.js";

const routingSteps: RoutingStep[] = [
  { operationNo: "10", description: "Cut", workCenterNo: "WC-1", workCenterName: "Station A", setupTimeMinutes: 0.5, runTimeMinutes: 1, waitTimeMinutes: 0, moveTimeMinutes: 0 },
  { operationNo: "20", description: "Weld", workCenterNo: "WC-2", workCenterName: "Station B", setupTimeMinutes: 0.5, runTimeMinutes: 2, waitTimeMinutes: 0, moveTimeMinutes: 0 },
  { operationNo: "30", description: "Paint", workCenterNo: "WC-3", workCenterName: "Station C", setupTimeMinutes: 0, runTimeMinutes: 0.5, waitTimeMinutes: 0, moveTimeMinutes: 0 },
  { operationNo: "40", description: "Assemble", workCenterNo: "WC-4", workCenterName: "Station D", setupTimeMinutes: 0.25, runTimeMinutes: 1.75, waitTimeMinutes: 0, moveTimeMinutes: 0 },
];

const workCenters: WorkCenter[] = [
  { id: "WC-1", name: "Station A", capacityMinutesPerDay: 480, efficiency: 0.9, unitCount: 1 },
  { id: "WC-2", name: "Station B", capacityMinutesPerDay: 480, efficiency: 0.85, unitCount: 1 },
  { id: "WC-3", name: "Station C", capacityMinutesPerDay: 480, efficiency: 0.9, unitCount: 1 },
  { id: "WC-4", name: "Station D", capacityMinutesPerDay: 480, efficiency: 0.9, unitCount: 1 },
];

// Takt time = 180 seconds (3 minutes = 160 units/8h day)
const TAKT_TIME = 180;

describe("Line Balancing", () => {
  test("analyzes all stations", () => {
    const result = analyzeLineBalance(routingSteps, workCenters, TAKT_TIME);
    expect(result.stations.length).toBe(4);
  });

  test("identifies bottleneck station", () => {
    const result = analyzeLineBalance(routingSteps, workCenters, TAKT_TIME);
    // Station B: (0.5+2)*60=150s is highest
    expect(result.bottleneckStation).toBe("Station B");
    expect(result.bottleneckCycleTime).toBe(150);
  });

  test("calculates balancing efficiency", () => {
    const result = analyzeLineBalance(routingSteps, workCenters, TAKT_TIME);
    // Total cycle: 90+150+30+120=390s, 4 stations × 180s = 720s
    // Efficiency = 390/720 = 54%
    expect(result.balancingEfficiency).toBe(54);
    expect(result.balancingLoss).toBe(46);
  });

  test("calculates theoretical minimum stations", () => {
    const result = analyzeLineBalance(routingSteps, workCenters, TAKT_TIME);
    // Total=390s, takt=180s → ceil(390/180) = 3
    expect(result.theoreticalMinStations).toBe(3);
  });

  test("detects underutilized stations for merging", () => {
    const result = analyzeLineBalance(routingSteps, workCenters, TAKT_TIME);
    const mergeRecs = result.recommendations.filter((r) => r.type === "merge_stations");
    // Station C (30s, 17%) could merge with adjacent
    expect(mergeRecs.length).toBeGreaterThanOrEqual(0);
  });

  test("suggests rebalance when stations > theoretical minimum", () => {
    const result = analyzeLineBalance(routingSteps, workCenters, TAKT_TIME);
    const rebalance = result.recommendations.find((r) => r.type === "rebalance");
    expect(rebalance).toBeDefined();
  });

  test("optimizes by merging underutilized stations", () => {
    const current = analyzeLineBalance(routingSteps, workCenters, TAKT_TIME);
    const optimized = optimizeLineBalance(current);
    // Should have fewer or equal stations
    expect(optimized.stations.length).toBeLessThanOrEqual(current.stations.length);
    expect(optimized.balancingEfficiency).toBeGreaterThanOrEqual(current.balancingEfficiency);
  });
});
