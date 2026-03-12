/**
 * Pegging Module — links demand to supply for full traceability.
 *
 * Two directions:
 *   - Top-down: "Sales order SO-123 needs component X, covered by PO-456"
 *   - Bottom-up: "If supplier Y is 5 days late, orders SO-123 and SO-789 are affected"
 *
 * Pegging creates an allocation chain from end-item demand through BOM levels
 * down to the supply sources (inventory, purchase orders, planned orders).
 */

import type {
  SalesOrder,
  ProductionOrder,
  PurchaseOrder,
  ItemAvailability,
  BOMComponent,
} from "../erp/types.js";
import type {
  PeggingRecord,
  PeggingTree,
  PlannedOrder,
  NetRequirement,
} from "./types.js";
import { shouldStopRecursion } from "./bom-guard.js";

function log(msg: string) {
  process.stderr.write(`[mrp-pegging] ${msg}\n`);
}

export interface PeggingInput {
  salesOrders: SalesOrder[];
  productionOrders: ProductionOrder[];
  purchaseOrders: PurchaseOrder[];
  availability: ItemAvailability[];
  plannedOrders: PlannedOrder[];
  netRequirements: Map<string, NetRequirement>;
}

/**
 * Build pegging trees tracing each sales order demand through the supply chain.
 */
export function buildPeggingTrees(input: PeggingInput): PeggingTree[] {
  const trees: PeggingTree[] = [];
  const availMap = new Map(input.availability.map((a) => [a.itemNo, a]));

  // Build a supply index: itemNo → available supply sources
  const supplyIndex = buildSupplyIndex(input);

  for (const so of input.salesOrders) {
    if (so.status !== "open" && so.status !== "released") continue;

    for (const line of so.lines) {
      const tree: PeggingTree = {
        rootDemand: {
          sourceType: "sales_order",
          sourceId: so.number,
          itemNo: line.itemNo,
          itemName: line.itemName,
          quantity: line.quantity,
          dueDate: line.requestedDeliveryDate || so.requestedDeliveryDate,
        },
        pegs: [],
        shortages: [],
      };

      // Peg the end-item demand to supply
      pegItem(
        line.itemNo,
        line.itemName,
        line.quantity,
        line.requestedDeliveryDate || so.requestedDeliveryDate,
        "sales_order",
        so.number,
        supplyIndex,
        tree,
      );

      // Now trace dependent demand through production orders (with cycle detection)
      pegDependentDemand(line.itemNo, line.quantity, input.productionOrders, supplyIndex, tree, new Set([line.itemNo]), 0);

      trees.push(tree);
    }
  }

  log(`built ${trees.length} pegging trees`);
  return trees;
}

interface SupplySlot {
  type: "on_hand" | "purchase_order" | "production_order" | "planned_order";
  sourceId: string;
  itemNo: string;
  remainingQty: number;
  date: string;
  vendorNo?: string;
}

function buildSupplyIndex(input: PeggingInput): Map<string, SupplySlot[]> {
  const index = new Map<string, SupplySlot[]>();

  const getSlots = (itemNo: string): SupplySlot[] => {
    let slots = index.get(itemNo);
    if (!slots) {
      slots = [];
      index.set(itemNo, slots);
    }
    return slots;
  };

  // On-hand inventory
  for (const avail of input.availability) {
    if (avail.available > 0) {
      getSlots(avail.itemNo).push({
        type: "on_hand",
        sourceId: "INVENTORY",
        itemNo: avail.itemNo,
        remainingQty: avail.available,
        date: new Date().toISOString().slice(0, 10),
      });
    }
  }

  // Purchase orders
  for (const po of input.purchaseOrders) {
    if (po.status === "released") continue;
    for (const line of po.lines) {
      getSlots(line.itemNo).push({
        type: "purchase_order",
        sourceId: po.number,
        itemNo: line.itemNo,
        remainingQty: line.quantity,
        date: line.expectedReceiptDate,
        vendorNo: po.vendorNo,
      });
    }
  }

  // Production orders (they supply the parent item)
  for (const prod of input.productionOrders) {
    if (prod.status === "finished") continue;
    getSlots(prod.itemNo).push({
      type: "production_order",
      sourceId: prod.number,
      itemNo: prod.itemNo,
      remainingQty: prod.quantity,
      date: prod.dueDate,
    });
  }

  // Planned orders
  for (const po of input.plannedOrders) {
    getSlots(po.itemNo).push({
      type: "planned_order",
      sourceId: po.id,
      itemNo: po.itemNo,
      remainingQty: po.quantity,
      date: po.dueDate,
    });
  }

  // Sort each item's supply by date (FIFO allocation)
  for (const [, slots] of index) {
    slots.sort((a, b) => a.date.localeCompare(b.date));
  }

  return index;
}

function pegItem(
  itemNo: string,
  itemName: string,
  demandQty: number,
  demandDate: string,
  demandSourceType: string,
  demandSourceId: string,
  supplyIndex: Map<string, SupplySlot[]>,
  tree: PeggingTree,
): void {
  let remaining = demandQty;
  const slots = supplyIndex.get(itemNo) ?? [];

  for (const slot of slots) {
    if (remaining <= 0) break;
    if (slot.remainingQty <= 0) continue;

    const pegQty = Math.min(remaining, slot.remainingQty);
    slot.remainingQty -= pegQty;
    remaining -= pegQty;

    tree.pegs.push({
      demandItemNo: itemNo,
      demandSourceType,
      demandSourceId,
      demandQuantity: demandQty,
      demandDate,
      supplyItemNo: slot.itemNo,
      supplySourceType: slot.type,
      supplySourceId: slot.sourceId,
      supplyQuantity: slot.remainingQty + pegQty,
      supplyDate: slot.date,
      peggedQuantity: pegQty,
      isCovered: remaining <= 0,
    });
  }

  if (remaining > 0) {
    tree.shortages.push({
      itemNo,
      itemName,
      shortageQuantity: remaining,
      neededBy: demandDate,
    });
  }
}

function pegDependentDemand(
  parentItemNo: string,
  parentQty: number,
  productionOrders: ProductionOrder[],
  supplyIndex: Map<string, SupplySlot[]>,
  tree: PeggingTree,
  visited: Set<string> = new Set(),
  depth: number = 0,
): void {
  // Find production orders for the parent item
  const relevantOrders = productionOrders.filter(
    (o) => o.itemNo === parentItemNo && o.status !== "finished",
  );

  for (const order of relevantOrders) {
    for (const comp of order.components) {
      const requiredQty = comp.quantityPer * parentQty;
      const compDue = new Date(order.dueDate);
      compDue.setDate(compDue.getDate() - comp.leadTimeDays);

      pegItem(
        comp.itemNo,
        comp.itemName,
        requiredQty,
        compDue.toISOString().slice(0, 10),
        "dependent",
        order.number,
        supplyIndex,
        tree,
      );

      // Recurse for sub-assemblies (with cycle detection)
      if (comp.replenishmentMethod === "production" || comp.replenishmentMethod === "assembly") {
        if (!shouldStopRecursion(comp.itemNo, visited, depth)) {
          const childVisited = new Set(visited);
          childVisited.add(comp.itemNo);
          pegDependentDemand(comp.itemNo, requiredQty, productionOrders, supplyIndex, tree, childVisited, depth + 1);
        }
      }
    }
  }
}

// ── Incremental Pegging ──────────────────────────────────────────

export interface PeggingCache {
  trees: PeggingTree[];
  /** Fingerprints of demand records per item */
  demandFingerprints: Map<string, string>;
  /** Fingerprints of supply records per item */
  supplyFingerprints: Map<string, string>;
  timestamp: string;
}

/**
 * Build pegging trees incrementally — only re-peg items where demand or supply changed.
 * Falls back to full rebuild when > 50% of items changed.
 */
export function buildPeggingTreesIncremental(
  input: PeggingInput,
  previousCache?: PeggingCache,
): { trees: PeggingTree[]; cache: PeggingCache } {
  // Build current fingerprints
  const currentDemandFP = buildDemandFingerprints(input);
  const currentSupplyFP = buildSupplyFingerprints(input);

  // No previous cache — full build
  if (!previousCache) {
    log("incremental pegging: no cache — full rebuild");
    const trees = buildPeggingTrees(input);
    return {
      trees,
      cache: {
        trees,
        demandFingerprints: currentDemandFP,
        supplyFingerprints: currentSupplyFP,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Detect changed items
  const allItems = new Set([
    ...currentDemandFP.keys(),
    ...currentSupplyFP.keys(),
    ...previousCache.demandFingerprints.keys(),
    ...previousCache.supplyFingerprints.keys(),
  ]);

  const changedItems = new Set<string>();
  for (const itemNo of allItems) {
    const demandChanged = (currentDemandFP.get(itemNo) ?? "") !== (previousCache.demandFingerprints.get(itemNo) ?? "");
    const supplyChanged = (currentSupplyFP.get(itemNo) ?? "") !== (previousCache.supplyFingerprints.get(itemNo) ?? "");
    if (demandChanged || supplyChanged) changedItems.add(itemNo);
  }

  // If > 50% changed, full rebuild is cheaper
  if (changedItems.size > allItems.size * 0.5) {
    log(`incremental pegging: ${changedItems.size}/${allItems.size} items changed — full rebuild`);
    const trees = buildPeggingTrees(input);
    return {
      trees,
      cache: {
        trees,
        demandFingerprints: currentDemandFP,
        supplyFingerprints: currentSupplyFP,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Incremental: keep unchanged trees, rebuild affected ones
  log(`incremental pegging: ${changedItems.size}/${allItems.size} items changed — selective rebuild`);

  // Find which root demand trees are affected (their items overlap with changed set)
  const unchangedTrees: PeggingTree[] = [];
  const affectedRootItems = new Set<string>();

  for (const tree of previousCache.trees) {
    const treeItems = new Set([
      tree.rootDemand.itemNo,
      ...tree.pegs.map((p) => p.demandItemNo),
      ...tree.pegs.map((p) => p.supplyItemNo),
    ]);
    const isAffected = [...treeItems].some((item) => changedItems.has(item));
    if (isAffected) {
      affectedRootItems.add(tree.rootDemand.itemNo);
    } else {
      unchangedTrees.push(tree);
    }
  }

  // Rebuild only affected trees using the same logic as full build
  const supplyIndex = buildSupplyIndex(input);
  const rebuiltTrees: PeggingTree[] = [];

  for (const so of input.salesOrders) {
    if (so.status !== "open" && so.status !== "released") continue;
    for (const line of so.lines) {
      if (!affectedRootItems.has(line.itemNo)) continue;

      const tree: PeggingTree = {
        rootDemand: {
          sourceType: "sales_order",
          sourceId: so.number,
          itemNo: line.itemNo,
          itemName: line.itemName,
          quantity: line.quantity,
          dueDate: line.requestedDeliveryDate || so.requestedDeliveryDate,
        },
        pegs: [],
        shortages: [],
      };

      pegItem(
        line.itemNo, line.itemName, line.quantity,
        line.requestedDeliveryDate || so.requestedDeliveryDate,
        "sales_order", so.number, supplyIndex, tree,
      );
      pegDependentDemand(line.itemNo, line.quantity, input.productionOrders, supplyIndex, tree, new Set([line.itemNo]), 0);
      rebuiltTrees.push(tree);
    }
  }

  const trees = [...unchangedTrees, ...rebuiltTrees];
  log(`incremental pegging: ${unchangedTrees.length} reused, ${rebuiltTrees.length} rebuilt`);

  return {
    trees,
    cache: {
      trees,
      demandFingerprints: currentDemandFP,
      supplyFingerprints: currentSupplyFP,
      timestamp: new Date().toISOString(),
    },
  };
}

function buildDemandFingerprints(input: PeggingInput): Map<string, string> {
  const fp = new Map<string, string>();
  const demandByItem = new Map<string, string[]>();

  for (const so of input.salesOrders) {
    for (const line of so.lines) {
      if (!demandByItem.has(line.itemNo)) demandByItem.set(line.itemNo, []);
      demandByItem.get(line.itemNo)!.push(`${so.number}:${line.quantity}:${line.requestedDeliveryDate}`);
    }
  }
  for (const po of input.productionOrders) {
    if (!demandByItem.has(po.itemNo)) demandByItem.set(po.itemNo, []);
    demandByItem.get(po.itemNo)!.push(`${po.number}:${po.quantity}:${po.dueDate}`);
  }

  for (const [itemNo, records] of demandByItem) {
    fp.set(itemNo, String(Bun.hash(records.sort().join("|"))));
  }
  return fp;
}

function buildSupplyFingerprints(input: PeggingInput): Map<string, string> {
  const fp = new Map<string, string>();
  const supplyByItem = new Map<string, string[]>();

  for (const a of input.availability) {
    if (!supplyByItem.has(a.itemNo)) supplyByItem.set(a.itemNo, []);
    supplyByItem.get(a.itemNo)!.push(`INV:${a.available}`);
  }
  for (const po of input.purchaseOrders) {
    for (const line of po.lines) {
      if (!supplyByItem.has(line.itemNo)) supplyByItem.set(line.itemNo, []);
      supplyByItem.get(line.itemNo)!.push(`PO:${po.number}:${line.quantity}:${line.expectedReceiptDate}`);
    }
  }
  for (const po of input.plannedOrders) {
    if (!supplyByItem.has(po.itemNo)) supplyByItem.set(po.itemNo, []);
    supplyByItem.get(po.itemNo)!.push(`PLN:${po.id}:${po.quantity}:${po.dueDate}`);
  }

  for (const [itemNo, records] of supplyByItem) {
    fp.set(itemNo, String(Bun.hash(records.sort().join("|"))));
  }
  return fp;
}

// ── Impact Analysis ──────────────────────────────────────────────

export interface SupplyImpact {
  affectedOrders: Array<{
    orderType: string;
    orderId: string;
    itemNo: string;
    itemName: string;
    originalDueDate: string;
    impactedQuantity: number;
  }>;
  cascadeDepth: number;
  totalAffectedQuantity: number;
}

/**
 * Analyze the impact of a supply delay on downstream orders.
 * "If component X is delayed by N days, which orders are affected?"
 */
export function analyzeSupplyImpact(
  itemNo: string,
  delayDays: number,
  peggingTrees: PeggingTree[],
): SupplyImpact {
  const affected: SupplyImpact["affectedOrders"] = [];
  let totalQty = 0;
  let maxDepth = 0;

  // Multi-level cascade: find all items affected by the delay, then trace their impact too
  const MAX_CASCADE = 10;
  const processedItems = new Set<string>();
  const itemQueue: Array<{ item: string; depth: number }> = [{ item: itemNo, depth: 1 }];

  while (itemQueue.length > 0) {
    const { item: currentItem, depth } = itemQueue.shift()!;
    if (processedItems.has(currentItem)) continue;
    if (depth > MAX_CASCADE) continue;
    processedItems.add(currentItem);

    for (const tree of peggingTrees) {
      // Find pegs where this item is a supply source
      const relevantPegs = tree.pegs.filter((p) => p.supplyItemNo === currentItem);

      for (const peg of relevantPegs) {
        // The delayed supply date
        const delayedDate = new Date(peg.supplyDate);
        delayedDate.setDate(delayedDate.getDate() + delayDays);
        const delayedStr = delayedDate.toISOString().slice(0, 10);

        // If delayed past demand date → impact
        if (delayedStr > peg.demandDate) {
          affected.push({
            orderType: tree.rootDemand.sourceType,
            orderId: tree.rootDemand.sourceId,
            itemNo: tree.rootDemand.itemNo,
            itemName: tree.rootDemand.itemName,
            originalDueDate: tree.rootDemand.dueDate,
            impactedQuantity: peg.peggedQuantity,
          });
          totalQty += peg.peggedQuantity;
          if (depth > maxDepth) maxDepth = depth;

          // Cascade: the demand item is now also delayed — trace its consumers
          if (!processedItems.has(peg.demandItemNo)) {
            itemQueue.push({ item: peg.demandItemNo, depth: depth + 1 });
          }
        }
      }
    }
  }

  // Deduplicate by orderId
  const uniqueOrders = new Map<string, (typeof affected)[0]>();
  for (const order of affected) {
    const key = `${order.orderType}-${order.orderId}`;
    const existing = uniqueOrders.get(key);
    if (existing) {
      existing.impactedQuantity += order.impactedQuantity;
    } else {
      uniqueOrders.set(key, { ...order });
    }
  }

  return {
    affectedOrders: Array.from(uniqueOrders.values()),
    cascadeDepth: maxDepth,
    totalAffectedQuantity: totalQty,
  };
}
