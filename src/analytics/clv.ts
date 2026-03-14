/**
 * Customer Lifetime Value (CLV) Calculator
 *
 * Simplified BG/NBD model: CLV = avgRevenue/month × expectedLifetime × margin.
 * Uses order history from Q2O pipeline data.
 */

function log(msg: string) {
  process.stderr.write(`[clv] ${msg}\n`);
}

export interface CustomerOrderHistory {
  customerId: string;
  customerName: string;
  orders: Array<{
    orderId: string;
    value: number;
    date: string;
    productGroup?: string;
  }>;
  firstOrderDate: string;
  lastOrderDate: string;
  churnProbability?: number;  // 0-100, from Customer 360 churn risk
}

export interface CLVResult {
  customerId: string;
  customerName: string;
  clv: number;
  avgOrderValue: number;
  orderFrequencyPerYear: number;
  expectedLifetimeMonths: number;
  marginPercent: number;
  totalHistoricRevenue: number;
  orderCount: number;
  segment: "platinum" | "gold" | "silver" | "bronze";
  churnRisk: "low" | "medium" | "high";
}

export interface CLVSegmentation {
  segments: Array<{
    name: string;
    customerCount: number;
    totalCLV: number;
    avgCLV: number;
    percentOfTotal: number;
  }>;
  totalCLV: number;
  totalCustomers: number;
}

/**
 * Calculate CLV for a single customer.
 */
export function calculateCLV(
  customer: CustomerOrderHistory,
  options?: { marginPercent?: number; discountRate?: number },
): CLVResult {
  const margin = (options?.marginPercent ?? 30) / 100;
  const orders = customer.orders;

  if (orders.length === 0) {
    return {
      customerId: customer.customerId,
      customerName: customer.customerName,
      clv: 0,
      avgOrderValue: 0,
      orderFrequencyPerYear: 0,
      expectedLifetimeMonths: 0,
      marginPercent: margin * 100,
      totalHistoricRevenue: 0,
      orderCount: 0,
      segment: "bronze",
      churnRisk: "high",
    };
  }

  const totalRevenue = orders.reduce((s, o) => s + o.value, 0);
  const avgOrderValue = totalRevenue / orders.length;

  // Calculate order frequency
  const first = new Date(customer.firstOrderDate);
  const last = new Date(customer.lastOrderDate);
  const spanMonths = Math.max(1, (last.getTime() - first.getTime()) / (30.44 * 24 * 60 * 60 * 1000));
  const ordersPerMonth = orders.length / spanMonths;
  const orderFrequencyPerYear = Math.round(ordersPerMonth * 12 * 10) / 10;

  // Expected lifetime (BG/NBD simplified)
  const churnProb = (customer.churnProbability ?? 20) / 100;
  const retentionRate = 1 - churnProb;
  const expectedLifetimeMonths = retentionRate > 0
    ? Math.round(1 / (1 - retentionRate) * 12)
    : 12;

  // Monthly revenue × lifetime × margin
  const monthlyRevenue = avgOrderValue * ordersPerMonth;
  const clv = Math.round(monthlyRevenue * expectedLifetimeMonths * margin * 100) / 100;

  // Segment
  let segment: CLVResult["segment"];
  if (clv >= 50000) segment = "platinum";
  else if (clv >= 20000) segment = "gold";
  else if (clv >= 5000) segment = "silver";
  else segment = "bronze";

  const churnRisk: CLVResult["churnRisk"] = churnProb >= 0.5 ? "high" : churnProb >= 0.25 ? "medium" : "low";

  log(`CLV for ${customer.customerName}: ${clv} (${segment}, ${orders.length} orders)`);

  return {
    customerId: customer.customerId,
    customerName: customer.customerName,
    clv,
    avgOrderValue: Math.round(avgOrderValue * 100) / 100,
    orderFrequencyPerYear,
    expectedLifetimeMonths,
    marginPercent: margin * 100,
    totalHistoricRevenue: Math.round(totalRevenue * 100) / 100,
    orderCount: orders.length,
    segment,
    churnRisk,
  };
}

/**
 * Segment customers by CLV.
 */
export function segmentByCLV(
  customers: CustomerOrderHistory[],
  options?: { marginPercent?: number },
): CLVSegmentation {
  const results = customers.map((c) => calculateCLV(c, options));
  const totalCLV = results.reduce((s, r) => s + r.clv, 0);

  const segmentNames = ["platinum", "gold", "silver", "bronze"] as const;
  const segments = segmentNames.map((name) => {
    const inSegment = results.filter((r) => r.segment === name);
    return {
      name,
      customerCount: inSegment.length,
      totalCLV: Math.round(inSegment.reduce((s, r) => s + r.clv, 0) * 100) / 100,
      avgCLV: inSegment.length > 0
        ? Math.round(inSegment.reduce((s, r) => s + r.clv, 0) / inSegment.length * 100) / 100
        : 0,
      percentOfTotal: totalCLV > 0
        ? Math.round(inSegment.reduce((s, r) => s + r.clv, 0) / totalCLV * 100)
        : 0,
    };
  });

  return { segments, totalCLV: Math.round(totalCLV * 100) / 100, totalCustomers: customers.length };
}
