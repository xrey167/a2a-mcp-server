/**
 * Intervention recommendations for supply chain risk mitigation.
 *
 * Strategies:
 *   - Make-or-Buy: compare internal production cost vs. purchasing
 *   - Safety Stock: adjust minimum stock levels based on risk
 *   - Dual Sourcing: identify alternative suppliers
 *   - Advance Purchase: early ordering for at-risk components
 *   - Reschedule: adjust production plan to mitigate delays
 */

import type { BOMComponent, RiskScore, Intervention } from "../erp/types.js";
import type { LeadTimeAnalysis } from "./lead-time.js";
import { riskLevel } from "./scoring.js";
import { shouldStopRecursion } from "../mrp/bom-guard.js";

// ── Make-or-Buy estimation constants ──────────────────────────────

/**
 * Fraction of lead-time days assumed to be productive labour hours.
 * E.g. 0.5 means each lead-time day contributes half a day of actual work.
 */
const INTERNAL_LABOUR_HOURS_PER_LEAD_DAY = 0.5;
/**
 * Material cost as a fraction of vendor unit cost for internal production.
 * 0.6 assumes 40% of the purchase price is the vendor's margin / overhead,
 * so raw materials can be acquired for roughly 60% of the finished-part cost.
 */
const INTERNAL_MATERIAL_COST_FRACTION = 0.6;

export interface InterventionContext {
  components: BOMComponent[];
  riskScores: RiskScore[];
  leadTimeAnalyses: LeadTimeAnalysis[];
  productionDueDate?: string;
  /** Internal hourly rate for make-or-buy calculation */
  internalHourlyRate?: number;
}

/**
 * Generate prioritized intervention recommendations.
 */
export function generateInterventions(
  ctx: InterventionContext,
  options?: {
    riskThreshold?: number;
    maxRecommendations?: number;
    strategies?: Intervention["type"][];
  },
): Intervention[] {
  const threshold = options?.riskThreshold ?? 40;
  const maxRecs = options?.maxRecommendations ?? 20;
  const strategies = options?.strategies ?? [
    "make_or_buy", "safety_stock", "dual_source", "advance_purchase", "reschedule",
  ];

  const interventions: Intervention[] = [];
  const componentMap = buildComponentMap(ctx.components);

  // Filter to at-risk components
  const atRisk = ctx.riskScores.filter((r) => r.overallScore >= threshold);

  for (const risk of atRisk) {
    const comp = componentMap.get(risk.componentId);
    if (!comp) continue;

    const leadTime = ctx.leadTimeAnalyses.find((a) => a.itemNo === risk.componentId);

    if (strategies.includes("make_or_buy")) {
      const mob = evaluateMakeOrBuy(comp, risk, ctx);
      if (mob) interventions.push(mob);
    }

    if (strategies.includes("safety_stock")) {
      const ss = evaluateSafetyStock(comp, risk, leadTime);
      if (ss) interventions.push(ss);
    }

    if (strategies.includes("dual_source")) {
      const ds = evaluateDualSource(comp, risk);
      if (ds) interventions.push(ds);
    }

    if (strategies.includes("advance_purchase")) {
      const ap = evaluateAdvancePurchase(comp, risk, leadTime, ctx.productionDueDate);
      if (ap) interventions.push(ap);
    }

    if (strategies.includes("reschedule")) {
      const rs = evaluateReschedule(comp, risk, leadTime, ctx.productionDueDate);
      if (rs) interventions.push(rs);
    }
  }

  // Sort by priority then by risk reduction
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  interventions.sort((a, b) => {
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return b.estimatedRiskReduction - a.estimatedRiskReduction;
  });

  return interventions.slice(0, maxRecs);
}

// ── Strategy Evaluators ──────────────────────────────────────────

function evaluateMakeOrBuy(
  comp: BOMComponent,
  risk: RiskScore,
  ctx: InterventionContext,
): Intervention | null {
  // Only relevant for purchased components
  if (comp.replenishmentMethod !== "purchase") return null;

  // Only suggest if delivery or availability risk is high
  if (risk.dimensions.delivery < 40 && risk.dimensions.availability < 40) return null;

  const hourlyRate = ctx.internalHourlyRate ?? 50;
  // Rough estimate: internal production cost = material + labor estimate
  const estimatedInternalHours = comp.leadTimeDays * INTERNAL_LABOUR_HOURS_PER_LEAD_DAY;
  const internalCost = comp.unitCost * INTERNAL_MATERIAL_COST_FRACTION + estimatedInternalHours * hourlyRate;
  const purchaseCost = comp.unitCost;

  const savingsPercent = ((purchaseCost - internalCost) / purchaseCost) * 100;
  const recommend = internalCost < purchaseCost * 1.2; // Recommend if within 20% cost

  return {
    id: `mob-${comp.itemNo}`,
    type: "make_or_buy",
    componentId: comp.itemNo,
    componentName: comp.itemName,
    priority: riskLevel(risk.overallScore),
    description: recommend
      ? `Consider internal production of ${comp.itemName} — estimated ${Math.abs(Math.round(savingsPercent))}% ${savingsPercent > 0 ? "cheaper" : "more expensive"} but eliminates vendor dependency`
      : `Internal production of ${comp.itemName} would be ~${Math.round(Math.abs(savingsPercent))}% more expensive — keep purchasing but mitigate risk through other strategies`,
    estimatedCostImpact: Math.round(internalCost - purchaseCost),
    estimatedRiskReduction: recommend ? 25 : 5,
    details: {
      currentCost: purchaseCost,
      estimatedInternalCost: Math.round(internalCost),
      recommendation: recommend ? "make" : "buy",
      rationale: recommend
        ? "Internal production eliminates vendor dependency and lead time uncertainty"
        : "Cost difference too high; consider alternative risk mitigation",
    },
  };
}

function evaluateSafetyStock(
  comp: BOMComponent,
  risk: RiskScore,
  leadTime?: LeadTimeAnalysis,
): Intervention | null {
  // Suggest safety stock adjustment if availability risk is elevated
  if (risk.dimensions.availability < 30) return null;

  const currentSS = comp.safetyStock;
  const leadTimeDays = comp.leadTimeDays;
  const dailyUsage = comp.quantityPer; // Simplified: per-unit BOM qty as proxy

  // Calculate recommended safety stock based on risk level
  let safetyFactor = 1.5;
  if (risk.overallScore >= 75) safetyFactor = 3.0;
  else if (risk.overallScore >= 50) safetyFactor = 2.0;

  // Account for lead time variability (guard against zero lead time)
  const varianceFactor = leadTime?.variance && leadTime.variance > 0
    ? 1 + (leadTime.variance / Math.max(leadTimeDays, 1)) * 0.5
    : 1;

  const recommendedSS = Math.ceil(dailyUsage * leadTimeDays * safetyFactor * varianceFactor);

  if (recommendedSS <= currentSS) return null;

  const additionalStockCost = (recommendedSS - currentSS) * comp.unitCost;

  return {
    id: `ss-${comp.itemNo}`,
    type: "safety_stock",
    componentId: comp.itemNo,
    componentName: comp.itemName,
    priority: riskLevel(risk.overallScore),
    description: `Increase safety stock for ${comp.itemName} from ${currentSS} to ${recommendedSS} units (risk factor: ${safetyFactor}x)`,
    estimatedCostImpact: Math.round(additionalStockCost),
    estimatedRiskReduction: 20,
    details: {
      currentSafetyStock: currentSS,
      recommendedSafetyStock: recommendedSS,
      additionalUnits: recommendedSS - currentSS,
      holdingCost: Math.round(additionalStockCost),
      safetyFactor,
      varianceFactor: Math.round(varianceFactor * 100) / 100,
    },
  };
}

function evaluateDualSource(
  comp: BOMComponent,
  risk: RiskScore,
): Intervention | null {
  // Only relevant for single-source purchased components
  if (comp.replenishmentMethod !== "purchase") return null;
  if (!risk.flags.includes("SINGLE_SOURCE")) return null;

  return {
    id: `ds-${comp.itemNo}`,
    type: "dual_source",
    componentId: comp.itemNo,
    componentName: comp.itemName,
    priority: riskLevel(risk.overallScore),
    description: `Establish a second supplier for ${comp.itemName} (currently single-source: ${comp.vendorName ?? comp.vendorNo ?? "unknown"})`,
    estimatedCostImpact: Math.round(comp.unitCost * 0.05 * comp.quantityPer * 100), // ~5% premium estimate for dual sourcing
    estimatedRiskReduction: 30,
    details: {
      currentVendor: comp.vendorName ?? comp.vendorNo,
      rationale: "Single-source dependency creates critical supply risk. A second qualified supplier provides fallback capacity.",
      suggestedSplit: "70/30 primary/secondary",
    },
  };
}

function evaluateAdvancePurchase(
  comp: BOMComponent,
  risk: RiskScore,
  leadTime: LeadTimeAnalysis | undefined,
  dueDate?: string,
): Intervention | null {
  if (comp.replenishmentMethod !== "purchase") return null;

  // Only suggest if lead time risk or external risk is elevated
  if (risk.dimensions.leadTime < 40 && risk.dimensions.external < 40) return null;

  const additionalBuffer = leadTime?.trend === "increasing" ? Math.ceil(comp.leadTimeDays * 0.3) : Math.ceil(comp.leadTimeDays * 0.15);

  let urgency = "";
  if (dueDate) {
    const due = new Date(dueDate);
    const today = new Date();
    const daysUntilDue = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    const totalNeeded = comp.leadTimeDays + additionalBuffer;

    if (daysUntilDue < totalNeeded) {
      urgency = ` — URGENT: only ${daysUntilDue} days until due date, needs ${totalNeeded} days lead time`;
    }
  }

  return {
    id: `ap-${comp.itemNo}`,
    type: "advance_purchase",
    componentId: comp.itemNo,
    componentName: comp.itemName,
    priority: risk.dimensions.leadTime >= 60 || urgency ? "critical" : riskLevel(risk.overallScore),
    description: `Order ${comp.itemName} ${additionalBuffer} days earlier than planned to buffer against lead time risk${urgency}`,
    estimatedCostImpact: Math.round(comp.unitCost * comp.quantityPer * 0.02), // ~2% cost of earlier inventory holding
    estimatedRiskReduction: 15,
    details: {
      currentLeadTime: comp.leadTimeDays,
      additionalBufferDays: additionalBuffer,
      trend: leadTime?.trend ?? "unknown",
      variance: leadTime?.variance ?? null,
    },
  };
}

function evaluateReschedule(
  comp: BOMComponent,
  risk: RiskScore,
  leadTime: LeadTimeAnalysis | undefined,
  dueDate?: string,
): Intervention | null {
  if (!dueDate) return null;
  if (risk.overallScore < 60) return null;

  const due = new Date(dueDate);
  const today = new Date();
  const daysUntilDue = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  const effectiveLeadTime = leadTime?.actualLeadTimeDays ?? comp.leadTimeDays;

  // Only suggest reschedule if timeline is genuinely at risk
  if (daysUntilDue >= effectiveLeadTime * 1.2) return null;

  const suggestedDelay = Math.ceil(effectiveLeadTime * 0.3);

  return {
    id: `rs-${comp.itemNo}`,
    type: "reschedule",
    componentId: comp.itemNo,
    componentName: comp.itemName,
    priority: "high",
    description: `Consider delaying production by ${suggestedDelay} days due to ${comp.itemName} delivery risk (${daysUntilDue} days until due, ${effectiveLeadTime} days effective lead time)`,
    estimatedCostImpact: 0, // Depends on customer impact
    estimatedRiskReduction: 20,
    details: {
      currentDueDate: dueDate,
      daysUntilDue,
      effectiveLeadTime,
      suggestedDelayDays: suggestedDelay,
      rationale: "Current timeline does not allow sufficient buffer for component delivery uncertainty",
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function buildComponentMap(components: BOMComponent[]): Map<string, BOMComponent> {
  const map = new Map<string, BOMComponent>();

  function walk(comps: BOMComponent[], visited: Set<string>, depth: number) {
    for (const c of comps) {
      map.set(c.itemNo, c);
      if (c.children && !shouldStopRecursion(c.itemNo, visited, depth)) {
        const childVisited = new Set(visited);
        childVisited.add(c.itemNo);
        walk(c.children, childVisited, depth + 1);
      }
    }
  }

  walk(components, new Set(), 0);
  return map;
}

// ── Dual Sourcing Optimizer (SC-2) ──────────────────────────────

export interface DualSourceVendor {
  id: string;
  name: string;
  unitCost: number;
  moq: number;
  leadTime: number;
  riskScore: number;
  country: string;
  capacityMax: number;
}

export interface DualSourceScenario {
  primaryVendor: { id: string; name: string; share: number; unitCost: number };
  secondaryVendor: { id: string; name: string; share: number; unitCost: number };

  totalCostOfOwnership: number;
  riskReduction: number;
  geographicDiversification: boolean;
  moqSatisfied: boolean;

  tradeoffs: {
    costPremium: number;
    complexityIncrease: "low" | "medium" | "high";
    qualityRisk: string;
  };
}

/**
 * Evaluate dual sourcing scenarios for an item.
 * Compares split ratios between vendor pairs and selects optimal combinations.
 */
export function optimizeDualSourcing(
  itemNo: string,
  annualDemand: number,
  vendors: DualSourceVendor[],
  splitRatios?: number[],
): DualSourceScenario[] {
  if (vendors.length < 2) return [];

  const ratios = splitRatios ?? [0.7, 0.6, 0.5];
  const scenarios: DualSourceScenario[] = [];

  // Sort vendors by risk-adjusted cost (cost weighted by risk)
  const sorted = [...vendors].sort((a, b) => {
    const adjA = a.unitCost * (1 + a.riskScore / 200);
    const adjB = b.unitCost * (1 + b.riskScore / 200);
    return adjA - adjB;
  });

  // Best single-source TCO for comparison
  const bestSingle = sorted[0];
  const singleTCO = bestSingle.unitCost * annualDemand;

  // Evaluate pairs
  for (let i = 0; i < Math.min(sorted.length, 3); i++) {
    for (let j = i + 1; j < Math.min(sorted.length, 4); j++) {
      const primary = sorted[i];
      const secondary = sorted[j];

      for (const primaryShare of ratios) {
        const secondaryShare = 1 - primaryShare;
        const primaryQty = Math.round(annualDemand * primaryShare);
        const secondaryQty = annualDemand - primaryQty;

        // Check MOQ
        const moqSatisfied = primaryQty >= primary.moq && secondaryQty >= secondary.moq;

        // Check capacity
        if (primaryQty > primary.capacityMax || secondaryQty > secondary.capacityMax) continue;

        // TCO
        const tco = primary.unitCost * primaryQty + secondary.unitCost * secondaryQty;
        const costPremium = Math.round(((tco - singleTCO) / singleTCO) * 100);

        // Risk reduction: weighted average risk vs single source
        const blendedRisk = primary.riskScore * primaryShare + secondary.riskScore * secondaryShare;
        const riskReduction = Math.round(((bestSingle.riskScore - blendedRisk) / Math.max(1, bestSingle.riskScore)) * 100);

        const geoDiversified = primary.country !== secondary.country;

        const complexity: "low" | "medium" | "high" = primaryShare >= 0.8 ? "low" : primaryShare >= 0.6 ? "medium" : "high";

        scenarios.push({
          primaryVendor: { id: primary.id, name: primary.name, share: primaryShare, unitCost: primary.unitCost },
          secondaryVendor: { id: secondary.id, name: secondary.name, share: secondaryShare, unitCost: secondary.unitCost },
          totalCostOfOwnership: Math.round(tco * 100) / 100,
          riskReduction,
          geographicDiversification: geoDiversified,
          moqSatisfied,
          tradeoffs: {
            costPremium,
            complexityIncrease: complexity,
            qualityRisk: primary.country !== secondary.country
              ? "Different origins may have quality variance — incoming inspection recommended"
              : "Same origin — consistent quality expected",
          },
        });
      }
    }
  }

  // Sort by best risk/cost tradeoff
  scenarios.sort((a, b) => {
    // Prefer scenarios where risk reduction > cost premium
    const aValue = a.riskReduction - a.tradeoffs.costPremium;
    const bValue = b.riskReduction - b.tradeoffs.costPremium;
    return bValue - aValue;
  });

  return scenarios;
}
