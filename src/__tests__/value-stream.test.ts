import { describe, test, expect } from "bun:test";
import { generateValueStreamMap, compareValueStreams } from "../mrp/value-stream.js";
import type { MRPRunResult, WorkCenter, CapacityLoad } from "../mrp/types.js";
import type { RoutingStep } from "../erp/types.js";

const routingSteps: RoutingStep[] = [
  { operationNo: "10", description: "Cutting", workCenterNo: "WC-CUT", workCenterName: "Cutting Center", setupTimeMinutes: 15, runTimeMinutes: 5, waitTimeMinutes: 10, moveTimeMinutes: 3 },
  { operationNo: "20", description: "Welding", workCenterNo: "WC-WLD", workCenterName: "Welding Center", setupTimeMinutes: 30, runTimeMinutes: 8, waitTimeMinutes: 20, moveTimeMinutes: 5 },
  { operationNo: "30", description: "Assembly", workCenterNo: "WC-ASM", workCenterName: "Assembly Line", setupTimeMinutes: 5, runTimeMinutes: 12, waitTimeMinutes: 5, moveTimeMinutes: 2 },
];

const workCenters: WorkCenter[] = [
  { id: "WC-CUT", name: "Cutting Center", capacityMinutesPerDay: 480, efficiency: 0.85, unitCount: 1 },
  { id: "WC-WLD", name: "Welding Center", capacityMinutesPerDay: 480, efficiency: 0.80, unitCount: 1 },
  { id: "WC-ASM", name: "Assembly Line", capacityMinutesPerDay: 480, efficiency: 0.90, unitCount: 2 },
];

const minimalMRP: MRPRunResult = {
  timestamp: "2026-03-14T00:00:00Z",
  horizon: { startDate: "2026-03-14", endDate: "2026-06-14", bucketSize: "week", buckets: [] },
  netRequirements: [],
  plannedOrders: [],
  pegging: [],
  capacityLoads: [
    {
      workCenterId: "WC-CUT", workCenterName: "Cutting Center",
      buckets: [], averageUtilization: 70, peakUtilization: 85, overloadedBuckets: 0,
    },
    {
      workCenterId: "WC-WLD", workCenterName: "Welding Center",
      buckets: [], averageUtilization: 92, peakUtilization: 110, overloadedBuckets: 1,
    },
    {
      workCenterId: "WC-ASM", workCenterName: "Assembly Line",
      buckets: [], averageUtilization: 55, peakUtilization: 65, overloadedBuckets: 0,
    },
  ],
  exceptions: [],
  summary: {
    totalItems: 3, itemsWithNetRequirements: 2, plannedPurchaseOrders: 1,
    plannedProductionOrders: 1, totalShortages: 0, totalExceptions: 0,
    overloadedWorkCenters: 1, coveragePercentage: 100,
  },
};

describe("Value Stream Mapping", () => {
  test("generates VSM with correct step count", () => {
    const vsm = generateValueStreamMap("ITEM-001", "Test Item", minimalMRP, routingSteps, workCenters);
    expect(vsm.steps.length).toBe(3);
    expect(vsm.itemNo).toBe("ITEM-001");
  });

  test("calculates total lead time correctly", () => {
    const vsm = generateValueStreamMap("ITEM-001", "Test Item", minimalMRP, routingSteps, workCenters);
    // Step 1: 5+15+10+3=33, Step 2: 8+30+20+5=63, Step 3: 12+5+5+2=24 → Total=120
    expect(vsm.totalLeadTime).toBe(120);
    expect(vsm.totalProcessingTime).toBe(25); // 5+8+12
    expect(vsm.totalSetupTime).toBe(50);      // 15+30+5
  });

  test("identifies bottleneck station", () => {
    const vsm = generateValueStreamMap("ITEM-001", "Test Item", minimalMRP, routingSteps, workCenters);
    // Welding has highest cycle time: 30+8=38
    expect(vsm.bottleneckStation).toBe("Welding Center");
  });

  test("calculates value-added ratio", () => {
    const vsm = generateValueStreamMap("ITEM-001", "Test Item", minimalMRP, routingSteps, workCenters);
    // Processing=25, LeadTime=120 → 25/120=20.8% → 21%
    expect(vsm.valueAddedRatio).toBe(21);
  });

  test("generates Kaizen opportunities for high setup times", () => {
    const vsm = generateValueStreamMap("ITEM-001", "Test Item", minimalMRP, routingSteps, workCenters);
    const setupKaizens = vsm.kaizenOpportunities.filter((k) => k.type === "setup_reduction");
    // Welding: setup 30/(30+8)=78% > 20% → SMED candidate
    // Cutting: setup 15/(15+5)=75% > 20% → SMED candidate
    expect(setupKaizens.length).toBeGreaterThan(0);
  });

  test("generates bottleneck relief when takt time exceeded", () => {
    const vsm = generateValueStreamMap("ITEM-001", "Test Item", minimalMRP, routingSteps, workCenters, 100);
    // Takt = 480/100 = 4.8 min. All cycle times > 4.8 → bottleneck relief
    const bottleneckKaizens = vsm.kaizenOpportunities.filter((k) => k.type === "bottleneck_relief");
    expect(bottleneckKaizens.length).toBeGreaterThan(0);
  });

  test("compares two value stream maps", () => {
    const current = generateValueStreamMap("ITEM-001", "Test Item", minimalMRP, routingSteps, workCenters);

    // "Improved" routing with reduced setup
    const improvedRouting = routingSteps.map((r) => ({ ...r, setupTimeMinutes: Math.round(r.setupTimeMinutes * 0.5) }));
    const target = generateValueStreamMap("ITEM-001", "Test Item", minimalMRP, improvedRouting, workCenters);

    const comparison = compareValueStreams(current, target);
    expect(comparison.improvements.length).toBeGreaterThan(0);

    const setupImprovement = comparison.improvements.find((i) => i.metric === "totalSetupTime");
    expect(setupImprovement).toBeDefined();
    expect(setupImprovement!.change).toBeLessThan(0); // Setup decreased
  });
});
