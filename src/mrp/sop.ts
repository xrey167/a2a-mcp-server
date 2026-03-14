/**
 * S&OP (Sales & Operations Planning) Dashboard
 *
 * Reconciles demand (from Q2O pipeline + forecasts) with supply
 * (from MRP planned orders + inventory + open POs). Identifies gaps,
 * calculates revenue-at-risk, and supports scenario simulation.
 */

import type { MRPRunResult, PlannedOrder } from "./types.js";

function log(msg: string) {
  process.stderr.write(`[sop] ${msg}\n`);
}

// ── Interfaces ──────────────────────────────────────────────────

export interface SOPDemandInput {
  confirmedOrders: Array<{ itemNo: string; quantity: number; dueDate: string; unitPrice?: number }>;
  forecastedDemand: Array<{ itemNo: string; quantity: number; period: string; confidence: number }>;
  salesAdjustments?: Array<{ itemNo: string; quantity: number; period: string; reason: string }>;
}

export interface SOPSupplyInput {
  availableCapacity: Array<{ workCenterId: string; period: string; availableMinutes: number }>;
  currentInventory: Array<{ itemNo: string; quantity: number; unitCost?: number }>;
  openPurchaseOrders: Array<{ itemNo: string; quantity: number; expectedDate: string }>;
  plannedOrders?: PlannedOrder[];
}

export interface SOPItemReconciliation {
  itemNo: string;
  itemName: string;

  // Demand side
  confirmedDemand: number;
  forecastedDemand: number;
  totalDemand: number;

  // Supply side
  currentStock: number;
  plannedProduction: number;
  plannedPurchase: number;
  totalSupply: number;

  // Gap
  gap: number;             // positive = surplus, negative = shortage
  gapStatus: "covered" | "at_risk" | "shortage";

  // Capacity
  capacityUtilization: number;
  capacityBottleneck: string | null;

  // Recommendation
  recommendation: string;
}

export interface SOPReconciliation {
  period: string;
  items: SOPItemReconciliation[];

  summary: {
    totalGap: number;
    itemsAtRisk: number;
    itemsInShortage: number;
    avgCapacityUtilization: number;
    revenueAtRisk: number;
  };
}

export type ScenarioAdjustment = {
  type: "demand_increase" | "demand_decrease" | "capacity_loss" | "supply_delay";
  percentage: number;
  items?: string[];
};

// ── Main Functions ──────────────────────────────────────────────

/**
 * Reconcile demand vs supply for a given set of periods.
 */
export function reconcileDemandSupply(
  demand: SOPDemandInput,
  supply: SOPSupplyInput,
  periods: string[],
): SOPReconciliation[] {
  const results: SOPReconciliation[] = [];

  for (const period of periods) {
    const itemMap = new Map<string, SOPItemReconciliation>();

    // Collect demand for this period
    for (const order of demand.confirmedOrders) {
      if (dateToPeriod(order.dueDate) === period) {
        const item = getOrCreateItem(itemMap, order.itemNo);
        item.confirmedDemand += order.quantity;
      }
    }

    for (const forecast of demand.forecastedDemand) {
      if (forecast.period === period) {
        const item = getOrCreateItem(itemMap, forecast.itemNo);
        item.forecastedDemand += Math.round(forecast.quantity * forecast.confidence);
      }
    }

    if (demand.salesAdjustments) {
      for (const adj of demand.salesAdjustments) {
        if (adj.period === period) {
          const item = getOrCreateItem(itemMap, adj.itemNo);
          item.forecastedDemand += adj.quantity;
        }
      }
    }

    // Collect supply for this period
    for (const inv of supply.currentInventory) {
      const item = itemMap.get(inv.itemNo);
      if (item) {
        item.currentStock = inv.quantity;
      }
    }

    for (const po of supply.openPurchaseOrders) {
      if (dateToPeriod(po.expectedDate) === period) {
        const item = itemMap.get(po.itemNo);
        if (item) {
          item.plannedPurchase += po.quantity;
        }
      }
    }

    if (supply.plannedOrders) {
      for (const order of supply.plannedOrders) {
        if (dateToPeriod(order.dueDate) === period) {
          const item = itemMap.get(order.itemNo);
          if (item) {
            if (order.type === "purchase") {
              item.plannedPurchase += order.quantity;
            } else {
              item.plannedProduction += order.quantity;
            }
          }
        }
      }
    }

    // Calculate gaps and generate recommendations
    const items: SOPItemReconciliation[] = [];
    let totalGap = 0;
    let itemsAtRisk = 0;
    let itemsInShortage = 0;
    let revenueAtRisk = 0;

    for (const item of itemMap.values()) {
      item.totalDemand = item.confirmedDemand + item.forecastedDemand;
      item.totalSupply = item.currentStock + item.plannedProduction + item.plannedPurchase;
      item.gap = item.totalSupply - item.totalDemand;

      if (item.gap >= 0) {
        item.gapStatus = "covered";
        item.recommendation = item.gap > item.totalDemand * 0.5
          ? "Surplus detected — consider reducing planned orders or shifting supply to other periods"
          : "Demand covered — maintain current plan";
      } else if (item.gap >= -item.totalDemand * 0.1) {
        item.gapStatus = "at_risk";
        item.recommendation = "Near shortage — expedite open POs or increase planned production";
        itemsAtRisk++;
      } else {
        item.gapStatus = "shortage";
        item.recommendation = "Critical shortage — immediate action required: expedite, dual-source, or adjust demand";
        itemsInShortage++;
        revenueAtRisk += Math.abs(item.gap) * 100; // Rough estimate
      }

      totalGap += item.gap;
      items.push(item);
    }

    // Capacity utilization from supply input
    const capacityUtils = supply.availableCapacity
      .filter((c) => c.period === period)
      .map((c) => c.availableMinutes);
    const avgCapUtil = capacityUtils.length > 0
      ? Math.round(capacityUtils.reduce((a, b) => a + b, 0) / capacityUtils.length)
      : 0;

    results.push({
      period,
      items: items.sort((a, b) => a.gap - b.gap), // Worst gaps first
      summary: {
        totalGap,
        itemsAtRisk,
        itemsInShortage,
        avgCapacityUtilization: avgCapUtil,
        revenueAtRisk,
      },
    });
  }

  log(`reconciled ${results.length} periods, ${results.reduce((s, r) => s + r.items.length, 0)} item-period combos`);
  return results;
}

/**
 * Simulate a scenario adjustment on top of a base reconciliation.
 */
export function simulateScenario(
  baseReconciliation: SOPReconciliation,
  adjustment: ScenarioAdjustment,
): SOPReconciliation {
  const factor = adjustment.percentage / 100;
  const affectedItems = adjustment.items
    ? new Set(adjustment.items)
    : null;

  const adjustedItems = baseReconciliation.items.map((item) => {
    const affected = !affectedItems || affectedItems.has(item.itemNo);
    if (!affected) return { ...item };

    const adjusted = { ...item };

    switch (adjustment.type) {
      case "demand_increase":
        adjusted.forecastedDemand = Math.round(item.forecastedDemand * (1 + factor));
        break;
      case "demand_decrease":
        adjusted.forecastedDemand = Math.round(item.forecastedDemand * (1 - factor));
        break;
      case "capacity_loss":
        adjusted.plannedProduction = Math.round(item.plannedProduction * (1 - factor));
        break;
      case "supply_delay":
        adjusted.plannedPurchase = Math.round(item.plannedPurchase * (1 - factor * 0.5));
        break;
    }

    adjusted.totalDemand = adjusted.confirmedDemand + adjusted.forecastedDemand;
    adjusted.totalSupply = adjusted.currentStock + adjusted.plannedProduction + adjusted.plannedPurchase;
    adjusted.gap = adjusted.totalSupply - adjusted.totalDemand;

    if (adjusted.gap >= 0) {
      adjusted.gapStatus = "covered";
      adjusted.recommendation = "Covered under scenario";
    } else if (adjusted.gap >= -adjusted.totalDemand * 0.1) {
      adjusted.gapStatus = "at_risk";
      adjusted.recommendation = "At risk under scenario — prepare contingency";
    } else {
      adjusted.gapStatus = "shortage";
      adjusted.recommendation = "Shortage under scenario — immediate mitigation needed";
    }

    return adjusted;
  });

  const itemsAtRisk = adjustedItems.filter((i) => i.gapStatus === "at_risk").length;
  const itemsInShortage = adjustedItems.filter((i) => i.gapStatus === "shortage").length;
  const revenueAtRisk = adjustedItems
    .filter((i) => i.gap < 0)
    .reduce((s, i) => s + Math.abs(i.gap) * 100, 0);

  return {
    period: baseReconciliation.period,
    items: adjustedItems.sort((a, b) => a.gap - b.gap),
    summary: {
      totalGap: adjustedItems.reduce((s, i) => s + i.gap, 0),
      itemsAtRisk,
      itemsInShortage,
      avgCapacityUtilization: baseReconciliation.summary.avgCapacityUtilization,
      revenueAtRisk,
    },
  };
}

/**
 * Generate a consensus plan with recommendations.
 */
export function generateConsensusPlan(
  reconciliations: SOPReconciliation[],
): { recommendations: string[]; actions: Array<{ itemNo: string; action: string; priority: string }> } {
  const actions: Array<{ itemNo: string; action: string; priority: string }> = [];
  const recommendations: string[] = [];

  for (const recon of reconciliations) {
    for (const item of recon.items) {
      if (item.gapStatus === "shortage") {
        actions.push({
          itemNo: item.itemNo,
          action: `Increase supply by ${Math.abs(item.gap)} units for period ${recon.period}`,
          priority: "critical",
        });
      } else if (item.gapStatus === "at_risk") {
        actions.push({
          itemNo: item.itemNo,
          action: `Monitor closely and prepare buffer for period ${recon.period}`,
          priority: "high",
        });
      }
    }

    if (recon.summary.itemsInShortage > 0) {
      recommendations.push(
        `Period ${recon.period}: ${recon.summary.itemsInShortage} items in shortage, revenue at risk: ${recon.summary.revenueAtRisk}`,
      );
    }
  }

  if (actions.length === 0) {
    recommendations.push("All periods covered — demand and supply are balanced");
  }

  return { recommendations, actions };
}

// ── Helpers ─────────────────────────────────────────────────────

function dateToPeriod(dateStr: string): string {
  // Convert date to YYYY-MM period
  return dateStr.slice(0, 7);
}

function getOrCreateItem(
  map: Map<string, SOPItemReconciliation>,
  itemNo: string,
): SOPItemReconciliation {
  let item = map.get(itemNo);
  if (!item) {
    item = {
      itemNo,
      itemName: itemNo,
      confirmedDemand: 0,
      forecastedDemand: 0,
      totalDemand: 0,
      currentStock: 0,
      plannedProduction: 0,
      plannedPurchase: 0,
      totalSupply: 0,
      gap: 0,
      gapStatus: "covered",
      capacityUtilization: 0,
      capacityBottleneck: null,
      recommendation: "",
    };
    map.set(itemNo, item);
  }
  return item;
}
