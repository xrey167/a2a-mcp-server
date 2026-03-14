import { describe, test, expect } from "bun:test";
import { calculateESGScore, calculatePortfolioESG, identifyESGGaps, scoreEnvironmental, scoreSocial, scoreGovernance } from "../esg/scoring.js";
import { calculateCarbonFootprint } from "../esg/carbon.js";
import type { BOMComponent } from "../erp/types.js";
import type { SupplyChainRoute } from "../esg/carbon.js";

describe("ESG Scoring", () => {
  test("calculates environmental score from agent data", () => {
    const env = scoreEnvironmental({ exposureScore: 30, naturalEventCount: 1, anomalySeverity: "low", country: "DE" });
    expect(env.score).toBeGreaterThan(0);
    expect(env.score).toBeLessThanOrEqual(100);
    expect(env.carbonIntensityEstimate).toBe("medium");
  });

  test("penalizes high climate risk", () => {
    const low = scoreEnvironmental({ exposureScore: 10, country: "SE" });
    const high = scoreEnvironmental({ exposureScore: 80, country: "CN" });
    expect(low.score).toBeGreaterThan(high.score);
  });

  test("calculates social score", () => {
    const social = scoreSocial({ activeConflicts: 0, instabilityIndex: 20, country: "DE" });
    expect(social.score).toBeGreaterThan(60);
    expect(social.laborRightsIndex).toBe("strong");
  });

  test("penalizes conflict exposure", () => {
    const safe = scoreSocial({ activeConflicts: 0, country: "CH" });
    const risky = scoreSocial({ activeConflicts: 5, instabilityIndex: 70, surgeLevel: "high", country: "BD" });
    expect(safe.score).toBeGreaterThan(risky.score);
  });

  test("calculates governance score", () => {
    const gov = scoreGovernance({ threatLevel: "low", baselineDeviation: 5, country: "DE" });
    expect(gov.score).toBeGreaterThan(50);
    expect(gov.corruptionPerceptionIndex).toBe(79);
  });

  test("calculates overall ESG score", () => {
    const esg = calculateESGScore("SUPP-001", "supplier", "Test Supplier", {
      environmental: { exposureScore: 20, country: "DE" },
      social: { activeConflicts: 0, country: "DE" },
      governance: { threatLevel: "low", country: "DE" },
    });

    expect(esg.overallScore).toBeGreaterThan(50);
    expect(esg.rating).toBeDefined();
    expect(["AAA", "AA", "A", "BBB", "BB", "B", "CCC", "CC", "C"]).toContain(esg.rating);
    expect(esg.entityId).toBe("SUPP-001");
  });

  test("assigns correct ESG ratings", () => {
    const good = calculateESGScore("S1", "supplier", "Good Corp", {
      environmental: { exposureScore: 5, country: "SE" },
      social: { activeConflicts: 0, instabilityIndex: 5, country: "SE" },
      governance: { threatLevel: "none", country: "SE" },
    });
    expect(["AAA", "AA", "A"]).toContain(good.rating);

    const bad = calculateESGScore("S2", "supplier", "Bad Corp", {
      environmental: { exposureScore: 80, naturalEventCount: 10, anomalySeverity: "high", country: "BD" },
      social: { activeConflicts: 5, instabilityIndex: 80, surgeLevel: "high", country: "BD" },
      governance: { threatLevel: "critical", baselineDeviation: 50, country: "BD" },
    });
    expect(["CCC", "CC", "C"]).toContain(bad.rating);
  });

  test("flags CSRD and LkSG relevance", () => {
    const risky = calculateESGScore("S3", "supplier", "Risky Supplier", {
      environmental: { exposureScore: 60, country: "CN" },
      social: { activeConflicts: 3, instabilityIndex: 60, country: "CN" },
      governance: { threatLevel: "high", country: "CN" },
    });
    expect(risky.csrdRelevant).toBe(true);
    expect(risky.supplyChainDueDiligence).toBe(true);
  });

  test("calculates portfolio overview", () => {
    const scores = [
      calculateESGScore("S1", "supplier", "Supplier A", { environmental: { country: "DE" }, social: { country: "DE" }, governance: { country: "DE" } }),
      calculateESGScore("S2", "supplier", "Supplier B", { environmental: { country: "CN" }, social: { country: "CN" }, governance: { country: "CN" } }),
    ];
    const portfolio = calculatePortfolioESG(scores);
    expect(portfolio.totalEntities).toBe(2);
    expect(portfolio.averageScore).toBeGreaterThan(0);
  });

  test("identifies ESG gaps", () => {
    const scores = [
      calculateESGScore("S1", "supplier", "Weak Supplier", {
        environmental: { exposureScore: 70, country: "IN" },
        social: { activeConflicts: 3, instabilityIndex: 60, country: "IN" },
        governance: { threatLevel: "high", country: "IN" },
      }),
    ];
    const gaps = identifyESGGaps(scores, 70);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0].dimension).toBeDefined();
    expect(gaps[0].recommendation).toBeDefined();
  });
});

describe("Carbon Footprint", () => {
  const bom: BOMComponent[] = [
    { itemNo: "COMP-1", itemName: "Steel Sheet", quantityPer: 2, unitOfMeasure: "KG", replenishmentMethod: "purchase", leadTimeDays: 14, unitCost: 5, safetyStock: 0, inventoryLevel: 100, reorderPoint: 20 },
    { itemNo: "COMP-2", itemName: "Circuit Board", quantityPer: 1, unitOfMeasure: "PCS", replenishmentMethod: "purchase", leadTimeDays: 30, unitCost: 25, safetyStock: 0, inventoryLevel: 50, reorderPoint: 10 },
  ];

  const routes: SupplyChainRoute[] = [
    { vendorId: "V1", vendorName: "Steel Co", country: "DE", transportMode: "road", distanceKm: 200, weightKg: 50 },
    { vendorId: "V2", vendorName: "PCB Ltd", country: "CN", transportMode: "sea", distanceKm: 20000, weightKg: 5 },
  ];

  test("calculates total carbon footprint", () => {
    const cf = calculateCarbonFootprint("ITEM-001", bom, routes);
    expect(cf.totalKgCO2e).toBeGreaterThan(0);
    expect(cf.itemNo).toBe("ITEM-001");
  });

  test("provides breakdown by category", () => {
    const cf = calculateCarbonFootprint("ITEM-001", bom, routes);
    expect(cf.breakdown.transport).toBeGreaterThan(0);
    expect(cf.breakdown.manufacturing).toBeGreaterThan(0);
    expect(cf.breakdown.rawMaterial).toBeGreaterThan(0);
  });

  test("provides breakdown by supplier", () => {
    const cf = calculateCarbonFootprint("ITEM-001", bom, routes);
    expect(cf.bySupplier.length).toBe(2);
    expect(cf.bySupplier[0].kgCO2e).toBeGreaterThan(0);
  });

  test("provides Scope 1/2/3 breakdown", () => {
    const cf = calculateCarbonFootprint("ITEM-001", bom, routes);
    expect(cf.scope1).toBeGreaterThanOrEqual(0);
    expect(cf.scope2).toBeGreaterThan(0);
    expect(cf.scope3).toBeGreaterThan(0);
    // scope1 + scope2 + scope3 ≈ total (rounding differences)
    expect(Math.abs((cf.scope1 + cf.scope2 + cf.scope3) - cf.totalKgCO2e)).toBeLessThan(1);
  });

  test("generates nearshoring scenarios", () => {
    const cf = calculateCarbonFootprint("ITEM-001", bom, routes, { includeScenarios: true });
    expect(cf.scenarios).toBeDefined();
    expect(cf.scenarios!.length).toBeGreaterThan(0);
  });

  test("air freight has higher emissions than sea", () => {
    const airRoutes = routes.map((r) => ({ ...r, transportMode: "air" as const }));
    const seaRoutes = routes.map((r) => ({ ...r, transportMode: "sea" as const }));
    const airCF = calculateCarbonFootprint("AIR", bom, airRoutes);
    const seaCF = calculateCarbonFootprint("SEA", bom, seaRoutes);
    expect(airCF.breakdown.transport).toBeGreaterThan(seaCF.breakdown.transport);
  });
});
