import { describe, test, expect } from "bun:test";
import { reconcileDemandSupply, simulateScenario, generateConsensusPlan } from "../mrp/sop.js";
import type { SOPDemandInput, SOPSupplyInput } from "../mrp/sop.js";

const demand: SOPDemandInput = {
  confirmedOrders: [
    { itemNo: "ITEM-A", quantity: 100, dueDate: "2026-04-15", unitPrice: 50 },
    { itemNo: "ITEM-B", quantity: 200, dueDate: "2026-04-20", unitPrice: 30 },
  ],
  forecastedDemand: [
    { itemNo: "ITEM-A", quantity: 50, period: "2026-04", confidence: 0.8 },
    { itemNo: "ITEM-B", quantity: 100, period: "2026-04", confidence: 0.9 },
  ],
};

const supply: SOPSupplyInput = {
  availableCapacity: [
    { workCenterId: "WC-1", period: "2026-04", availableMinutes: 9600 },
  ],
  currentInventory: [
    { itemNo: "ITEM-A", quantity: 80 },
    { itemNo: "ITEM-B", quantity: 150 },
  ],
  openPurchaseOrders: [
    { itemNo: "ITEM-A", quantity: 50, expectedDate: "2026-04-10" },
    { itemNo: "ITEM-B", quantity: 100, expectedDate: "2026-04-12" },
  ],
};

describe("S&OP Dashboard", () => {
  test("reconciles demand vs supply for a period", () => {
    const results = reconcileDemandSupply(demand, supply, ["2026-04"]);
    expect(results.length).toBe(1);
    expect(results[0].items.length).toBe(2);
  });

  test("calculates gaps correctly", () => {
    const [result] = reconcileDemandSupply(demand, supply, ["2026-04"]);
    const itemA = result.items.find((i) => i.itemNo === "ITEM-A")!;

    // Demand: confirmed 100 + forecast 50*0.8=40 = 140
    expect(itemA.totalDemand).toBe(140);
    // Supply: inventory 80 + PO 50 = 130
    expect(itemA.totalSupply).toBe(130);
    // Gap: 130-140 = -10
    expect(itemA.gap).toBe(-10);
  });

  test("marks shortage items correctly", () => {
    const [result] = reconcileDemandSupply(demand, supply, ["2026-04"]);
    const itemA = result.items.find((i) => i.itemNo === "ITEM-A")!;
    // Gap is -10, totalDemand is 140 → -10 >= -14 (10%) → at_risk
    expect(itemA.gapStatus).toBe("at_risk");
  });

  test("provides summary metrics", () => {
    const [result] = reconcileDemandSupply(demand, supply, ["2026-04"]);
    expect(result.summary).toBeDefined();
    expect(typeof result.summary.totalGap).toBe("number");
    expect(typeof result.summary.revenueAtRisk).toBe("number");
  });

  test("simulates demand increase scenario", () => {
    const [base] = reconcileDemandSupply(demand, supply, ["2026-04"]);
    const scenario = simulateScenario(base, { type: "demand_increase", percentage: 50 });

    // All forecasted demands should be 50% higher
    const itemA = scenario.items.find((i) => i.itemNo === "ITEM-A")!;
    const baseItemA = base.items.find((i) => i.itemNo === "ITEM-A")!;
    expect(itemA.forecastedDemand).toBeGreaterThan(baseItemA.forecastedDemand);
  });

  test("simulates capacity loss scenario", () => {
    const [base] = reconcileDemandSupply(demand, supply, ["2026-04"]);
    const scenario = simulateScenario(base, { type: "capacity_loss", percentage: 30 });

    // Planned production should decrease
    for (const item of scenario.items) {
      const baseItem = base.items.find((i) => i.itemNo === item.itemNo)!;
      expect(item.plannedProduction).toBeLessThanOrEqual(baseItem.plannedProduction);
    }
  });

  test("generates consensus plan with actions", () => {
    const results = reconcileDemandSupply(demand, supply, ["2026-04"]);
    const plan = generateConsensusPlan(results);
    expect(plan.recommendations).toBeDefined();
    expect(Array.isArray(plan.actions)).toBe(true);
  });

  test("handles empty periods gracefully", () => {
    const results = reconcileDemandSupply(demand, supply, ["2026-12"]);
    expect(results.length).toBe(1);
    expect(results[0].items.length).toBe(0);
  });
});
