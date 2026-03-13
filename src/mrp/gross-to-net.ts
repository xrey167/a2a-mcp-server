/**
 * Gross-to-Net Engine — the core MRP calculation.
 *
 * For each item in each time bucket:
 *   Net Requirement = Gross Requirement - Scheduled Receipts - Projected On-Hand
 *
 * If Net Requirement > 0 → generate Planned Order Receipt (lot-sized)
 *   Planned Order Release = Planned Order Receipt offset by lead time
 *
 * The projected on-hand carries forward across buckets, so surplus
 * in one period reduces requirements in the next.
 */

import type {
  BOMComponent,
  PurchaseOrder,
  ProductionOrder,
  ItemAvailability,
} from "../erp/types.js";
import type {
  PlanningHorizon,
  TimePhasedDemand,
  TimePhasedSupply,
  NetRequirement,
  LotSizingPolicy,
  LotSizingConfig,
  SupplyRecord,
} from "./types.js";
import { calculateLotSize, policyName } from "./lot-sizing.js";

function log(msg: string) {
  process.stderr.write(`[mrp-g2n] ${msg}\n`);
}

// ── Supply Aggregation ───────────────────────────────────────────

/**
 * Build time-phased supply from existing POs, production orders, and on-hand inventory.
 */
export function buildSupplyPlan(
  itemNos: string[],
  purchaseOrders: PurchaseOrder[],
  productionOrders: ProductionOrder[],
  availability: ItemAvailability[],
  horizon: PlanningHorizon,
): Map<string, TimePhasedSupply> {
  const result = new Map<string, TimePhasedSupply>();
  const availMap = new Map(availability.map((a) => [a.itemNo, a]));

  for (const itemNo of itemNos) {
    const avail = availMap.get(itemNo);
    const onHand = avail ? avail.available : 0;

    const supply: TimePhasedSupply = {
      itemNo,
      buckets: horizon.buckets.map((b) => ({
        bucketIndex: b.index,
        scheduledReceipts: 0,
        supplyRecords: [],
      })),
      onHand,
    };

    result.set(itemNo, supply);
  }

  // Add PO scheduled receipts
  for (const po of purchaseOrders) {
    if (po.status === "released") continue; // already received
    for (const line of po.lines) {
      const supply = result.get(line.itemNo);
      if (!supply) continue;
      const bucketIdx = dateToBucket(line.expectedReceiptDate, horizon);
      const bucket = supply.buckets[bucketIdx];
      if (bucket) {
        bucket.scheduledReceipts += line.quantity;
        bucket.supplyRecords.push({
          type: "purchase_order",
          sourceId: po.number,
          itemNo: line.itemNo,
          quantity: line.quantity,
          availableDate: line.expectedReceiptDate,
        });
      }
    }
  }

  // Add production order receipts (the parent item being produced)
  for (const prod of productionOrders) {
    if (prod.status === "finished") continue;
    const supply = result.get(prod.itemNo);
    if (!supply) continue;
    const bucketIdx = dateToBucket(prod.dueDate, horizon);
    const bucket = supply.buckets[bucketIdx];
    if (bucket) {
      bucket.scheduledReceipts += prod.quantity;
      bucket.supplyRecords.push({
        type: "production_order",
        sourceId: prod.number,
        itemNo: prod.itemNo,
        quantity: prod.quantity,
        availableDate: prod.dueDate,
      });
    }
  }

  return result;
}

function dateToBucket(dateStr: string, horizon: PlanningHorizon): number {
  for (const bucket of horizon.buckets) {
    if (dateStr >= bucket.startDate && dateStr < bucket.endDate) {
      return bucket.index;
    }
  }
  if (dateStr < horizon.startDate) return 0;
  return horizon.buckets.length - 1;
}

// ── Gross-to-Net Calculation ─────────────────────────────────────

export interface GrossToNetInput {
  demandPlan: Map<string, TimePhasedDemand>;
  supplyPlan: Map<string, TimePhasedSupply>;
  components: BOMComponent[];
  horizon: PlanningHorizon;
  lotSizingConfig: LotSizingConfig;
  /** Safety lead time to add to lead times (days). Default: 0 */
  safetyLeadTimeDays?: number;
}

export interface GrossToNetResult {
  netRequirements: Map<string, NetRequirement>;
  /** Items, policy, and lead time info used */
  itemMetadata: Map<string, {
    leadTimeDays: number;
    safetyStock: number;
    lotSizingPolicy: string;
    replenishmentMethod: string;
  }>;
}

/**
 * Run the gross-to-net calculation for all items.
 *
 * For each item, for each bucket:
 *   1. Gross requirement = demand in this bucket
 *   2. Scheduled receipts = supply expected in this bucket
 *   3. Projected on-hand = previous on-hand + receipts - gross requirement + planned receipt
 *   4. If projected on-hand < 0 → net requirement exists → generate planned order
 *   5. Planned order release = receipt bucket offset by lead time
 */
export function calculateGrossToNet(input: GrossToNetInput): GrossToNetResult {
  const {
    demandPlan,
    supplyPlan,
    components,
    horizon,
    lotSizingConfig,
    safetyLeadTimeDays = 0,
  } = input;

  const compMap = new Map(components.map((c) => [c.itemNo, c]));
  const netRequirements = new Map<string, NetRequirement>();
  const itemMetadata = new Map<string, {
    leadTimeDays: number;
    safetyStock: number;
    lotSizingPolicy: string;
    replenishmentMethod: string;
  }>();

  // Process each item with demand
  for (const [itemNo, demand] of demandPlan) {
    const comp = compMap.get(itemNo);
    const supply = supplyPlan.get(itemNo);
    const onHand = supply?.onHand ?? 0;
    const safetyStock = comp?.safetyStock ?? 0;
    const leadTimeDays = (comp?.leadTimeDays ?? 0) + safetyLeadTimeDays;
    const policy = lotSizingConfig.itemPolicies.get(itemNo) ?? lotSizingConfig.defaultPolicy;

    itemMetadata.set(itemNo, {
      leadTimeDays,
      safetyStock,
      lotSizingPolicy: policyName(policy),
      replenishmentMethod: comp?.replenishmentMethod ?? "purchase",
    });

    const nr: NetRequirement = {
      itemNo,
      itemName: demand.itemName,
      buckets: [],
    };

    let projectedOnHand = onHand;

    for (let i = 0; i < horizon.buckets.length; i++) {
      const grossReq = demand.buckets[i]?.grossDemand ?? 0;
      const scheduledReceipts = supply?.buckets[i]?.scheduledReceipts ?? 0;

      // Projected position before planned order
      const projectedBeforePlanned = projectedOnHand + scheduledReceipts - grossReq;

      let netReq = 0;
      let plannedOrderReceipt = 0;

      // Need to cover demand AND maintain safety stock
      if (projectedBeforePlanned < safetyStock) {
        netReq = safetyStock - projectedBeforePlanned;
        // Apply lot sizing
        const futuredemands = demand.buckets.slice(i + 1).map((b) => b.grossDemand);
        plannedOrderReceipt = calculateLotSize(netReq, policy, futuredemands, comp?.orderMultiple);
      }

      // Calculate the release bucket (offset by lead time)
      const leadTimeBuckets = leadTimeToBuckets(leadTimeDays, horizon);
      const releaseBucket = Math.max(0, i - leadTimeBuckets);

      projectedOnHand = projectedBeforePlanned + plannedOrderReceipt;

      nr.buckets.push({
        bucketIndex: i,
        grossRequirement: grossReq,
        scheduledReceipts,
        projectedOnHand,
        netRequirement: Math.max(0, netReq),
        plannedOrderReceipt,
        plannedOrderRelease: plannedOrderReceipt > 0 ? releaseBucket : 0,
      });
    }

    netRequirements.set(itemNo, nr);
  }

  log(`gross-to-net completed for ${netRequirements.size} items`);
  return { netRequirements, itemMetadata };
}

/**
 * Convert lead time days into number of buckets.
 */
function leadTimeToBuckets(days: number, horizon: PlanningHorizon): number {
  switch (horizon.bucketSize) {
    case "day": return days;
    case "week": return Math.ceil(days / 7);
    case "month": return Math.ceil(days / 30);
  }
}
