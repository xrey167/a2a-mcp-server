/**
 * MRP Types — data structures for Material Requirements Planning.
 *
 * Extends the ERP types with planning-specific concepts:
 *   - Time-phased demand/supply buckets
 *   - Net requirements
 *   - Planned orders with action messages
 *   - Pegging records (demand ↔ supply links)
 *   - Capacity loads per work center
 */

// ── Planning Horizon ─────────────────────────────────────────────

export type BucketSize = "day" | "week" | "month";

export interface PlanningHorizon {
  startDate: string;   // ISO date
  endDate: string;     // ISO date
  bucketSize: BucketSize;
  buckets: PlanningBucket[];
}

export interface PlanningBucket {
  index: number;
  startDate: string;
  endDate: string;
  label: string;      // e.g. "W12 2026" or "2026-03-15"
}

// ── Demand Planning ──────────────────────────────────────────────

export interface DemandSource {
  type: "sales_order" | "production_order" | "forecast" | "safety_stock" | "dependent";
  sourceId: string;   // SO number, PO number, etc.
  sourceLineNo?: number;
}

export interface DemandRecord {
  itemNo: string;
  itemName: string;
  quantity: number;
  dueDate: string;
  source: DemandSource;
  /** BOM level: 0 = end item, 1+ = component */
  bomLevel: number;
}

export interface TimePhasedDemand {
  itemNo: string;
  itemName: string;
  buckets: Array<{
    bucketIndex: number;
    grossDemand: number;
    demandRecords: DemandRecord[];
  }>;
  totalDemand: number;
}

// ── Supply Records ───────────────────────────────────────────────

export interface SupplyRecord {
  type: "on_hand" | "purchase_order" | "production_order" | "planned_order";
  sourceId: string;
  itemNo: string;
  quantity: number;
  availableDate: string;
}

export interface TimePhasedSupply {
  itemNo: string;
  buckets: Array<{
    bucketIndex: number;
    scheduledReceipts: number;
    supplyRecords: SupplyRecord[];
  }>;
  onHand: number;
}

// ── Gross-to-Net ─────────────────────────────────────────────────

export interface NetRequirement {
  itemNo: string;
  itemName: string;
  buckets: Array<{
    bucketIndex: number;
    grossRequirement: number;
    scheduledReceipts: number;
    projectedOnHand: number;
    netRequirement: number;
    plannedOrderReceipt: number;
    plannedOrderRelease: number;
  }>;
}

// ── Lot Sizing ───────────────────────────────────────────────────

export type LotSizingPolicy =
  | { type: "lot_for_lot" }
  | { type: "fixed_order_qty"; quantity: number }
  | { type: "eoq"; annualDemand: number; orderingCost: number; holdingCostRate: number }
  | { type: "period_order_qty"; periods: number }
  | { type: "min_max"; min: number; max: number };

export interface LotSizingConfig {
  /** Default policy for items without specific config */
  defaultPolicy: LotSizingPolicy;
  /** Per-item overrides */
  itemPolicies: Map<string, LotSizingPolicy>;
}

// ── Planned Orders ───────────────────────────────────────────────

export type ActionMessage =
  | "create"
  | "reschedule_in"   // move earlier
  | "reschedule_out"  // move later
  | "cancel"          // demand removed
  | "expedite";       // urgent, needs attention

export interface PlannedOrder {
  id: string;
  itemNo: string;
  itemName: string;
  quantity: number;
  orderDate: string;       // when to place the order (due - lead time)
  dueDate: string;         // when needed
  type: "purchase" | "production" | "transfer";
  vendorNo?: string;
  vendorName?: string;
  /** MRP action message */
  action: ActionMessage;
  /** BOM level that generated this */
  bomLevel: number;
  /** Source demand that triggered this order */
  peggedDemand: PeggingRecord[];
  /** Safety lead time buffer added (days) */
  safetyBuffer: number;
  /** Lot sizing policy applied */
  lotSizingPolicy: string;
  /** Status: planned orders can be firmed */
  status: "planned" | "firmed";
}

// ── Pegging ──────────────────────────────────────────────────────

export interface PeggingRecord {
  demandItemNo: string;
  demandSourceType: string;
  demandSourceId: string;
  demandQuantity: number;
  demandDate: string;
  supplyItemNo: string;
  supplySourceType: string;
  supplySourceId: string;
  supplyQuantity: number;
  supplyDate: string;
  /** Quantity of this demand covered by this supply */
  peggedQuantity: number;
  /** Is this fully covered? */
  isCovered: boolean;
}

export interface PeggingTree {
  /** Top-level demand (e.g., sales order line) */
  rootDemand: {
    sourceType: string;
    sourceId: string;
    itemNo: string;
    itemName: string;
    quantity: number;
    dueDate: string;
  };
  /** All pegs in this tree, tracing through BOM levels */
  pegs: PeggingRecord[];
  /** Uncovered demand (shortages) */
  shortages: Array<{
    itemNo: string;
    itemName: string;
    shortageQuantity: number;
    neededBy: string;
  }>;
}

// ── Capacity Planning ────────────────────────────────────────────

export interface WorkCenter {
  id: string;
  name: string;
  /** Available capacity in minutes per day */
  capacityMinutesPerDay: number;
  /** Efficiency factor (0-1, e.g. 0.85 = 85% efficiency) */
  efficiency: number;
  /** Number of machines/resources */
  unitCount: number;
  /** Working days per week (default: 5) — from ERP calendar */
  workingDaysPerWeek?: number;
}

export interface CapacityLoad {
  workCenterId: string;
  workCenterName: string;
  buckets: Array<{
    bucketIndex: number;
    /** Required capacity in minutes */
    requiredMinutes: number;
    /** Available capacity in minutes */
    availableMinutes: number;
    /** Utilization percentage */
    utilization: number;
    /** Overloaded? */
    overloaded: boolean;
    /** Contributing orders */
    orders: Array<{
      orderType: string;
      orderId: string;
      itemNo: string;
      setupMinutes: number;
      runMinutes: number;
    }>;
  }>;
  /** Overall utilization across all buckets */
  averageUtilization: number;
  /** Peak utilization */
  peakUtilization: number;
  /** Number of overloaded buckets */
  overloadedBuckets: number;
}

// ── MRP Run Result ───────────────────────────────────────────────

export interface MRPRunResult {
  timestamp: string;
  horizon: PlanningHorizon;
  /** Net requirements per item */
  netRequirements: NetRequirement[];
  /** Generated planned orders */
  plannedOrders: PlannedOrder[];
  /** Pegging trees (demand → supply trace) */
  pegging: PeggingTree[];
  /** Capacity loads per work center */
  capacityLoads: CapacityLoad[];
  /** Exception messages / alerts */
  exceptions: MRPException[];
  /** Summary statistics */
  summary: MRPSummary;
  /** Pegging cache for incremental rebuilds on subsequent runs */
  peggingCache?: unknown;
}

export interface MRPException {
  severity: "critical" | "warning" | "info";
  type: "shortage" | "overload" | "late_order" | "excess" | "past_due" | "no_vendor";
  itemNo?: string;
  itemName?: string;
  workCenterId?: string;
  message: string;
  bucket?: number;
  suggestedAction?: string;
}

export interface MRPSummary {
  totalItems: number;
  itemsWithNetRequirements: number;
  plannedPurchaseOrders: number;
  plannedProductionOrders: number;
  totalShortages: number;
  totalExceptions: number;
  overloadedWorkCenters: number;
  coveragePercentage: number;
}
