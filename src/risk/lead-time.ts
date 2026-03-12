/**
 * Lead time analysis for supply chain components.
 *
 * Uses PostedReceipt data (actual receipt dates) for ground-truth lead time analysis.
 * Falls back to PO expected dates when no receipt history is available.
 */

import type { BOMComponent, PurchaseOrder, PostedReceipt } from "../erp/types.js";

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
  /** Average days late (positive) or early (negative) based on actual receipts */
  avgDeliveryVariance: number | null;
  /** Standard deviation of lead times — measures consistency */
  leadTimeStdDev: number | null;
  /** Data source used for analysis */
  dataSource: "posted_receipts" | "purchase_orders" | "none";
}

/**
 * Analyze lead times using PostedReceipt data (preferred) with PO fallback.
 */
export function analyzeLeadTimes(
  components: BOMComponent[],
  purchaseOrders: PurchaseOrder[],
  postedReceipts?: PostedReceipt[],
): LeadTimeAnalysis[] {
  const results: LeadTimeAnalysis[] = [];

  function walk(comps: BOMComponent[]) {
    for (const comp of comps) {
      if (comp.replenishmentMethod === "purchase") {
        const analysis = analyzeComponentLeadTime(comp, purchaseOrders, postedReceipts ?? []);
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
  postedReceipts: PostedReceipt[],
): LeadTimeAnalysis {
  // Prefer posted receipts — they have actual receipt dates
  const receipts = postedReceipts.filter((r) => r.itemNo === comp.itemNo);

  if (receipts.length > 0) {
    return analyzeFromReceipts(comp, receipts);
  }

  // Fall back to PO expected dates (less accurate, no actual receipt date)
  return analyzeFromPurchaseOrders(comp, purchaseOrders);
}

/**
 * Analyze using PostedReceipt data — ground truth with actual receipt dates.
 */
function analyzeFromReceipts(
  comp: BOMComponent,
  receipts: PostedReceipt[],
): LeadTimeAnalysis {
  const actualLeadTimes = receipts
    .filter((r) => r.actualLeadTimeDays > 0)
    .map((r) => r.actualLeadTimeDays);

  if (actualLeadTimes.length === 0) {
    return emptyResult(comp, "posted_receipts", receipts.length);
  }

  const avgActual = actualLeadTimes.reduce((a, b) => a + b, 0) / actualLeadTimes.length;
  const variance = avgActual - comp.leadTimeDays;

  // On-time: actual receipt within planned lead time
  const onTimeCount = receipts.filter((r) => r.varianceDays <= 0).length;
  const onTimePercentage = (onTimeCount / receipts.length) * 100;

  // Average delivery variance from receipt data (positive = late)
  const avgDeliveryVariance = receipts.reduce((sum, r) => sum + r.varianceDays, 0) / receipts.length;

  // Standard deviation for consistency scoring
  const stdDev = calculateStdDev(actualLeadTimes);

  const trend = detectTrend(actualLeadTimes);

  // Reliability score — uses actual data
  let reliabilityScore = 100;
  if (variance > 0) reliabilityScore -= Math.min(variance * 5, 40);
  reliabilityScore -= Math.max(0, (100 - onTimePercentage) * 0.4);
  if (trend === "increasing") reliabilityScore -= 10;
  // Penalize high variability (inconsistent supplier)
  if (stdDev !== null && stdDev > comp.leadTimeDays * 0.3) reliabilityScore -= 10;
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
    historyCount: receipts.length,
    avgDeliveryVariance: Math.round(avgDeliveryVariance * 10) / 10,
    leadTimeStdDev: stdDev !== null ? Math.round(stdDev * 10) / 10 : null,
    dataSource: "posted_receipts",
  };
}

/**
 * Fallback: analyze using PO expected dates (no actual receipt date available).
 */
function analyzeFromPurchaseOrders(
  comp: BOMComponent,
  purchaseOrders: PurchaseOrder[],
): LeadTimeAnalysis {
  const relevantPOs = purchaseOrders.filter((po) =>
    po.lines.some((l) => l.itemNo === comp.itemNo),
  );

  if (relevantPOs.length === 0) {
    return emptyResult(comp, "none", 0);
  }

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
    return emptyResult(comp, "purchase_orders", relevantPOs.length);
  }

  const avgActual = leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length;
  const variance = avgActual - comp.leadTimeDays;
  const onTimePercentage = (onTimeCount / leadTimes.length) * 100;
  const trend = detectTrend(leadTimes);
  const stdDev = calculateStdDev(leadTimes);

  let reliabilityScore = 100;
  if (variance > 0) reliabilityScore -= Math.min(variance * 5, 40);
  reliabilityScore -= Math.max(0, (100 - onTimePercentage) * 0.4);
  if (trend === "increasing") reliabilityScore -= 10;
  // Discount score slightly since we only have expected dates, not actual
  reliabilityScore = Math.round(reliabilityScore * 0.9);
  reliabilityScore = Math.max(0, Math.min(100, reliabilityScore));

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
    avgDeliveryVariance: Math.round(variance * 10) / 10,
    leadTimeStdDev: stdDev !== null ? Math.round(stdDev * 10) / 10 : null,
    dataSource: "purchase_orders",
  };
}

function emptyResult(
  comp: BOMComponent,
  dataSource: LeadTimeAnalysis["dataSource"],
  historyCount: number,
): LeadTimeAnalysis {
  return {
    itemNo: comp.itemNo,
    itemName: comp.itemName,
    plannedLeadTimeDays: comp.leadTimeDays,
    actualLeadTimeDays: null,
    variance: null,
    trend: "unknown",
    reliabilityScore: 50,
    onTimePercentage: 0,
    historyCount,
    avgDeliveryVariance: null,
    leadTimeStdDev: null,
    dataSource,
  };
}

/**
 * Detect lead time trend using simple linear regression on recent values.
 */
function detectTrend(values: number[]): LeadTimeAnalysis["trend"] {
  if (values.length < 3) return "unknown";

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

function calculateStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1));
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
