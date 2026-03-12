/**
 * Lot Sizing Algorithms for MRP planned order quantities.
 *
 * Policies:
 *   - Lot-for-Lot (L4L): Order exactly the net requirement
 *   - Fixed Order Quantity: Always order a fixed amount
 *   - Economic Order Quantity (EOQ): Optimal balance of ordering vs. holding cost
 *   - Period Order Quantity (POQ): Combine N periods of demand
 *   - Min/Max: Order up to max when below min
 */

import type { LotSizingPolicy } from "./types.js";

/**
 * Calculate order quantity based on lot sizing policy.
 *
 * @param netRequirement - The net requirement to cover
 * @param policy - The lot sizing policy to apply
 * @param periodsAhead - Demand in upcoming periods (for POQ)
 * @returns The order quantity (>= netRequirement)
 */
export function calculateLotSize(
  netRequirement: number,
  policy: LotSizingPolicy,
  periodsAhead?: number[],
): number {
  if (netRequirement <= 0) return 0;

  switch (policy.type) {
    case "lot_for_lot":
      return netRequirement;

    case "fixed_order_qty":
      // Order in multiples of fixed quantity
      return Math.ceil(netRequirement / policy.quantity) * policy.quantity;

    case "eoq": {
      const eoq = computeEOQ(policy.annualDemand, policy.orderingCost, policy.holdingCostRate);
      // Order at least the net requirement, but round up to EOQ multiple
      return Math.max(netRequirement, Math.ceil(netRequirement / eoq) * eoq);
    }

    case "period_order_qty": {
      // Combine this period plus N-1 future periods
      if (!periodsAhead || periodsAhead.length === 0) return netRequirement;
      const combinedDemand = netRequirement +
        periodsAhead.slice(0, policy.periods - 1).reduce((a, b) => a + b, 0);
      return Math.max(netRequirement, combinedDemand);
    }

    case "min_max":
      // If below min, order up to max
      if (netRequirement <= policy.min) return policy.min;
      if (netRequirement > policy.max) return netRequirement; // can't cap below need
      return policy.max;
  }
}

/**
 * Classic EOQ formula: sqrt(2 * D * S / H)
 *   D = annual demand
 *   S = ordering/setup cost per order
 *   H = annual holding cost per unit
 */
function computeEOQ(annualDemand: number, orderingCost: number, holdingCostRate: number): number {
  if (holdingCostRate <= 0 || annualDemand <= 0) return annualDemand;
  const eoq = Math.sqrt((2 * annualDemand * orderingCost) / holdingCostRate);
  return Math.max(1, Math.round(eoq));
}

/**
 * Get a human-readable name for a lot sizing policy.
 */
export function policyName(policy: LotSizingPolicy): string {
  switch (policy.type) {
    case "lot_for_lot": return "L4L";
    case "fixed_order_qty": return `FOQ(${policy.quantity})`;
    case "eoq": return "EOQ";
    case "period_order_qty": return `POQ(${policy.periods})`;
    case "min_max": return `Min/Max(${policy.min}/${policy.max})`;
  }
}
