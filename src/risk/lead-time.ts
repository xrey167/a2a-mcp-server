/**
 * Lead time analysis for supply chain components.
 *
 * Analyzes delivery reliability, trend detection, and vendor scoring.
 */

import type { BOMComponent, PurchaseOrder } from "../erp/types.js";

export interface LeadTimeAnalysis {
  itemNo: string;
  itemName: string;
  plannedLeadTimeDays: number;
  actualLeadTimeDays: number | null;
  variance: number | null;
  trend: "increasing" | "stable" | "decreasing" | "unknown";
  reliabilityScore: number; // 0-100
  onTimePercentage: number;
  historyCount: number;
}

/**
 * Analyze lead times for components based on historical purchase orders.
 */
export function analyzeLeadTimes(
  components: BOMComponent[],
  purchaseOrders: PurchaseOrder[],
): LeadTimeAnalysis[] {
  const results: LeadTimeAnalysis[] = [];

  function walk(comps: BOMComponent[]) {
    for (const comp of comps) {
      if (comp.replenishmentMethod === "purchase") {
        const analysis = analyzeComponentLeadTime(comp, purchaseOrders);
        results.push(analysis);
      }
      if (comp.children) walk(comp.children);
    }
  }

  walk(components);
  return results.sort((a, b) => a.reliabilityScore - b.reliabilityScore);
}

function analyzeComponentLeadTime(
  comp: BOMComponent,
  purchaseOrders: PurchaseOrder[],
): LeadTimeAnalysis {
  // Find POs containing this item
  const relevantPOs = purchaseOrders.filter((po) =>
    po.lines.some((l) => l.itemNo === comp.itemNo),
  );

  if (relevantPOs.length === 0) {
    return {
      itemNo: comp.itemNo,
      itemName: comp.itemName,
      plannedLeadTimeDays: comp.leadTimeDays,
      actualLeadTimeDays: null,
      variance: null,
      trend: "unknown",
      reliabilityScore: 50, // Unknown = neutral
      onTimePercentage: 0,
      historyCount: 0,
    };
  }

  // Calculate actual lead times from PO data
  const leadTimes: number[] = [];
  let onTimeCount = 0;

  for (const po of relevantPOs) {
    const line = po.lines.find((l) => l.itemNo === comp.itemNo);
    if (!line) continue;

    const orderDate = new Date(po.orderDate);
    const receiptDate = new Date(line.expectedReceiptDate || po.expectedReceiptDate);

    if (isNaN(orderDate.getTime()) || isNaN(receiptDate.getTime())) continue;

    const days = Math.ceil(
      (receiptDate.getTime() - orderDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    leadTimes.push(days);

    if (days <= comp.leadTimeDays) onTimeCount++;
  }

  if (leadTimes.length === 0) {
    return {
      itemNo: comp.itemNo,
      itemName: comp.itemName,
      plannedLeadTimeDays: comp.leadTimeDays,
      actualLeadTimeDays: null,
      variance: null,
      trend: "unknown",
      reliabilityScore: 50,
      onTimePercentage: 0,
      historyCount: relevantPOs.length,
    };
  }

  const avgActual = leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length;
  const variance = avgActual - comp.leadTimeDays;
  const onTimePercentage = (onTimeCount / leadTimes.length) * 100;
  const trend = detectTrend(leadTimes);

  // Reliability score: penalize variance and late deliveries
  let reliabilityScore = 100;
  if (variance > 0) reliabilityScore -= Math.min(variance * 5, 40);
  reliabilityScore -= Math.max(0, (100 - onTimePercentage) * 0.4);
  if (trend === "increasing") reliabilityScore -= 10;
  reliabilityScore = Math.max(0, Math.min(100, Math.round(reliabilityScore)));

  return {
    itemNo: comp.itemNo,
    itemName: comp.itemName,
    plannedLeadTimeDays: comp.leadTimeDays,
    actualLeadTimeDays: Math.round(avgActual),
    variance: Math.round(variance * 10) / 10,
    trend,
    reliabilityScore,
    onTimePercentage: Math.round(onTimePercentage),
    historyCount: leadTimes.length,
  };
}

/**
 * Detect lead time trend using simple linear regression on recent values.
 */
function detectTrend(values: number[]): LeadTimeAnalysis["trend"] {
  if (values.length < 3) return "unknown";

  // Use last 10 values for trend
  const recent = values.slice(-10);
  const n = recent.length;
  const indices = recent.map((_, i) => i);

  const sumX = indices.reduce((a, b) => a + b, 0);
  const sumY = recent.reduce((a, b) => a + b, 0);
  const sumXY = indices.reduce((acc, x, i) => acc + x * recent[i], 0);
  const sumX2 = indices.reduce((acc, x) => acc + x * x, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  if (slope > 0.5) return "increasing";
  if (slope < -0.5) return "decreasing";
  return "stable";
}

/**
 * Identify components with critical lead time issues.
 */
export function findCriticalLeadTimeIssues(
  analyses: LeadTimeAnalysis[],
  options?: { reliabilityThreshold?: number; varianceThreshold?: number },
): LeadTimeAnalysis[] {
  const reliabilityThreshold = options?.reliabilityThreshold ?? 60;
  const varianceThreshold = options?.varianceThreshold ?? 5;

  return analyses.filter((a) =>
    a.reliabilityScore < reliabilityThreshold ||
    (a.variance !== null && a.variance > varianceThreshold) ||
    a.trend === "increasing",
  );
}
