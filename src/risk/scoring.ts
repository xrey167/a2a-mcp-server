/**
 * Multi-dimensional risk scoring for supply chain components.
 *
 * Dimensions:
 *   - Availability: inventory vs. demand, safety stock coverage
 *   - Delivery: vendor dependency, single-source, geographic concentration
 *   - Price: cost volatility, commodity exposure
 *   - Lead Time: variability, buffer remaining
 *   - External: weather, freight, geopolitical, economic factors
 *
 * Score 0-100 per dimension (100 = highest risk).
 */

import type { BOMComponent, RiskScore, PurchaseOrder, ItemAvailability, VendorHealthScore } from "../erp/types.js";
import type { LeadTimeAnalysis } from "./lead-time.js";
import { shouldStopRecursion } from "../mrp/bom-guard.js";

export interface ExternalRiskFactors {
  weatherRisk: number;       // 0-100
  freightRisk: number;       // 0-100
  geopoliticalRisk: number;  // 0-100
  economicRisk: number;      // 0-100
  commodityPriceRisk: number; // 0-100
  details: string[];
}

export interface ScoringContext {
  purchaseOrders: PurchaseOrder[];
  availability: ItemAvailability[];
  leadTimeAnalyses: LeadTimeAnalysis[];
  externalFactors?: ExternalRiskFactors;
  /** Demand quantity needed for the production order */
  demandQty?: number;
  /** Vendor-level health scores for delivery risk assessment */
  vendorHealthScores?: VendorHealthScore[];
}

/**
 * Score all components in a BOM tree.
 */
export function scoreComponents(
  components: BOMComponent[],
  context: ScoringContext,
): RiskScore[] {
  const scores: RiskScore[] = [];

  function walk(comps: BOMComponent[], visited: Set<string> = new Set(), depth: number = 0) {
    for (const comp of comps) {
      scores.push(scoreComponent(comp, context));
      if (comp.children && !shouldStopRecursion(comp.itemNo, visited, depth)) {
        const childVisited = new Set(visited);
        childVisited.add(comp.itemNo);
        walk(comp.children, childVisited, depth + 1);
      }
    }
  }

  walk(components);
  return scores.sort((a, b) => b.overallScore - a.overallScore);
}

function scoreComponent(comp: BOMComponent, ctx: ScoringContext): RiskScore {
  const flags: string[] = [];

  const availability = scoreAvailability(comp, ctx, flags);
  const delivery = scoreDelivery(comp, ctx, flags);
  const price = scorePrice(comp, ctx, flags);
  const leadTime = scoreLeadTime(comp, ctx, flags);
  const external = scoreExternal(comp, ctx, flags);

  // Weighted average (availability and delivery are most critical)
  const weights = { availability: 0.30, delivery: 0.25, price: 0.15, leadTime: 0.20, external: 0.10 };
  const overallScore = Math.round(
    availability * weights.availability +
    delivery * weights.delivery +
    price * weights.price +
    leadTime * weights.leadTime +
    external * weights.external,
  );

  return {
    componentId: comp.itemNo,
    componentName: comp.itemName,
    overallScore,
    dimensions: { availability, delivery, price, leadTime, external },
    flags,
  };
}

// ── Dimension Scorers ────────────────────────────────────────────

function scoreAvailability(comp: BOMComponent, ctx: ScoringContext, flags: string[]): number {
  let score = 0;

  const avail = ctx.availability.find((a) => a.itemNo === comp.itemNo);
  const demandQty = ctx.demandQty ?? comp.quantityPer;

  if (avail) {
    // Stock coverage
    if (avail.available <= 0) {
      score += 50;
      flags.push("NO_STOCK");
    } else if (avail.available < demandQty) {
      score += 35;
      flags.push("INSUFFICIENT_STOCK");
    } else if (avail.available < demandQty * 1.5) {
      score += 15;
    }

    // Safety stock breach
    if (comp.safetyStock > 0 && avail.available < comp.safetyStock) {
      score += 25;
      flags.push("BELOW_SAFETY_STOCK");
    }

    // Incoming vs. outgoing
    if (avail.outgoingQty > avail.incomingQty + avail.available) {
      score += 20;
      flags.push("DEMAND_EXCEEDS_SUPPLY");
    }
  } else {
    // No availability data = unknown = moderate risk
    score += 30;
    flags.push("NO_AVAILABILITY_DATA");
  }

  // Inventory at or below reorder point
  if (comp.reorderPoint > 0 && comp.inventoryLevel <= comp.reorderPoint) {
    score += 10;
    flags.push("AT_REORDER_POINT");
  }

  return Math.min(100, score);
}

function scoreDelivery(comp: BOMComponent, ctx: ScoringContext, flags: string[]): number {
  let score = 0;

  if (comp.replenishmentMethod !== "purchase") {
    // Internally produced items have lower delivery risk
    return 10;
  }

  // Single-source risk
  if (comp.vendorNo) {
    // Check if there's only one vendor supplying this item
    const vendorsForItem = new Set(
      ctx.purchaseOrders
        .filter((po) => po.lines.some((l) => l.itemNo === comp.itemNo))
        .map((po) => po.vendorNo),
    );
    if (vendorsForItem.size <= 1) {
      score += 30;
      flags.push("SINGLE_SOURCE");
    }
  } else {
    score += 20;
    flags.push("NO_VENDOR_ASSIGNED");
  }

  // Long lead time itself is a delivery risk
  if (comp.leadTimeDays > 60) {
    score += 25;
    flags.push("LONG_LEAD_TIME_GT60");
  } else if (comp.leadTimeDays > 30) {
    score += 15;
    flags.push("LONG_LEAD_TIME_GT30");
  } else if (comp.leadTimeDays > 14) {
    score += 5;
  }

  // Vendor health score integration
  if (comp.vendorNo && ctx.vendorHealthScores) {
    const vendorHealth = ctx.vendorHealthScores.find((v) => v.vendorNo === comp.vendorNo);
    if (vendorHealth && vendorHealth.overallScore < 50) {
      score += 15;
      flags.push("VENDOR_POOR_HEALTH");
    }
  }

  // Check for open POs that might be late — "released" means confirmed/open in BC
  const openPOs = ctx.purchaseOrders.filter(
    (po) => (po.status === "open" || po.status === "released") && po.lines.some((l) => l.itemNo === comp.itemNo),
  );
  for (const po of openPOs) {
    const expectedDate = new Date(po.expectedReceiptDate);
    if (!isNaN(expectedDate.getTime()) && expectedDate < new Date()) {
      score += 20;
      flags.push("OVERDUE_PO");
      break;
    }
  }

  return Math.min(100, score);
}

function scorePrice(comp: BOMComponent, _ctx: ScoringContext, flags: string[]): number {
  let score = 0;

  // High unit cost = higher impact of price changes
  if (comp.unitCost > 1000) {
    score += 20;
    flags.push("HIGH_VALUE_COMPONENT");
  } else if (comp.unitCost > 100) {
    score += 10;
  }

  // External commodity risk is factored in via the external dimension
  // Here we assess the component-level price sensitivity
  if (comp.replenishmentMethod === "purchase" && comp.unitCost > 0) {
    // Purchased components are exposed to market prices
    score += 15;
  }

  return Math.min(100, score);
}

function scoreLeadTime(comp: BOMComponent, ctx: ScoringContext, flags: string[]): number {
  let score = 0;

  const analysis = ctx.leadTimeAnalyses.find((a) => a.itemNo === comp.itemNo);

  if (analysis) {
    // Reliability-based scoring (invert: low reliability = high risk)
    score += Math.round((100 - analysis.reliabilityScore) * 0.5);

    // Variance penalty
    if (analysis.variance !== null && analysis.variance > 5) {
      score += 20;
      flags.push("HIGH_LEAD_TIME_VARIANCE");
    } else if (analysis.variance !== null && analysis.variance > 2) {
      score += 10;
    }

    // Trend penalty
    if (analysis.trend === "increasing") {
      score += 15;
      flags.push("LEAD_TIME_TREND_UP");
    }

    // On-time percentage
    if (analysis.onTimePercentage < 50) {
      score += 20;
      flags.push("LOW_ON_TIME_DELIVERY");
    } else if (analysis.onTimePercentage < 80) {
      score += 10;
    }
  } else {
    // No history = moderate risk
    score += 20;
  }

  return Math.min(100, score);
}

function scoreExternal(comp: BOMComponent, ctx: ScoringContext, flags: string[]): number {
  if (!ctx.externalFactors) return 20; // Default moderate if no data

  const ext = ctx.externalFactors;
  let score = 0;

  // Weight external factors
  score += ext.weatherRisk * 0.2;
  score += ext.freightRisk * 0.25;
  score += ext.geopoliticalRisk * 0.25;
  score += ext.economicRisk * 0.15;
  score += ext.commodityPriceRisk * 0.15;

  if (score > 60) {
    flags.push("HIGH_EXTERNAL_RISK");
  }

  // Additional flag for specific external details
  for (const detail of ext.details) {
    if (detail.toLowerCase().includes(comp.itemName.toLowerCase())) {
      score += 10;
      flags.push("COMPONENT_MENTIONED_IN_RISK_ALERT");
    }
  }

  return Math.min(100, Math.round(score));
}

/**
 * Categorize risk level from numeric score.
 */
export function riskLevel(score: number): "critical" | "high" | "medium" | "low" {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

/**
 * Get the top-N highest risk components.
 */
export function topRisks(scores: RiskScore[], n = 10): RiskScore[] {
  return scores.slice(0, n);
}
