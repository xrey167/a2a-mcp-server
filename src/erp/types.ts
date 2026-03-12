/**
 * ERP-agnostic interfaces for supply chain data.
 * Used by both Business Central and Odoo connectors.
 */

// ── Core Entities ────────────────────────────────────────────────

export interface BOMComponent {
  itemNo: string;
  itemName: string;
  quantityPer: number;
  unitOfMeasure: string;
  replenishmentMethod: "purchase" | "production" | "assembly" | "transfer";
  vendorNo?: string;
  vendorName?: string;
  leadTimeDays: number;
  unitCost: number;
  safetyStock: number;
  inventoryLevel: number;
  reorderPoint: number;
  /** Scrap percentage (0-100) — yield loss factor */
  scrapPercent?: number;
  /** Item category / group for classification */
  itemCategory?: string;
  /** Lot sizing policy from ERP planning parameters */
  lotSizingPolicy?: "lot_for_lot" | "fixed_order_qty" | "eoq" | "order" | "maximum_qty";
  /** Fixed/max order quantity (used with lot sizing) */
  orderQuantity?: number;
  /** Minimum order quantity */
  minimumOrderQty?: number;
  /** Order multiple (rounding) */
  orderMultiple?: number;
  /** Vendor country (for risk assessment) */
  vendorCountry?: string;
  /** BOM version / effectivity date */
  bomVersionCode?: string;
  /** Child components if this is a sub-assembly */
  children?: BOMComponent[];
}

export interface RoutingStep {
  operationNo: string;
  description: string;
  workCenterNo: string;
  workCenterName: string;
  setupTimeMinutes: number;
  runTimeMinutes: number;
  waitTimeMinutes: number;
  moveTimeMinutes: number;
}

export interface ProductionOrder {
  id: string;
  number: string;
  itemNo: string;
  itemName: string;
  quantity: number;
  dueDate: string;
  startDate: string;
  status: "planned" | "firm_planned" | "released" | "finished";
  components: BOMComponent[];
  routings: RoutingStep[];
}

export interface SalesLine {
  lineNo: number;
  itemNo: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  requestedDeliveryDate: string;
  promisedDeliveryDate?: string;
}

export interface SalesOrder {
  id: string;
  number: string;
  customerNo: string;
  customerName: string;
  orderDate: string;
  requestedDeliveryDate: string;
  status: "open" | "released" | "pending_approval" | "pending_prepayment";
  lines: SalesLine[];
}

export interface Vendor {
  no: string;
  name: string;
  country: string;
  city?: string;
  leadTimeDays: number;
  currencyCode: string;
  blocked: boolean;
}

export interface PurchaseOrder {
  id: string;
  number: string;
  vendorNo: string;
  vendorName: string;
  orderDate: string;
  expectedReceiptDate: string;
  status: "open" | "released" | "pending_approval";
  lines: Array<{
    itemNo: string;
    itemName: string;
    quantity: number;
    unitCost: number;
    expectedReceiptDate: string;
  }>;
}

export interface ItemAvailability {
  itemNo: string;
  itemName: string;
  inventory: number;
  reserved: number;
  available: number;
  incomingQty: number;
  outgoingQty: number;
}

// ── Receipt History (for actual lead time calculation) ────────────

export interface PostedReceipt {
  /** Source PO number */
  purchaseOrderNo: string;
  vendorNo: string;
  vendorName: string;
  itemNo: string;
  itemName: string;
  quantity: number;
  /** When the PO was placed */
  orderDate: string;
  /** When receipt was originally expected */
  expectedDate: string;
  /** When goods were actually received */
  actualReceiptDate: string;
  /** Actual lead time in days (actualReceiptDate - orderDate) */
  actualLeadTimeDays: number;
  /** Planned lead time in days (expectedDate - orderDate) */
  plannedLeadTimeDays: number;
  /** Variance in days (actual - planned, positive = late) */
  varianceDays: number;
}

// ── Work Center / Capacity Data ──────────────────────────────────

export interface WorkCenterData {
  id: string;
  name: string;
  /** Capacity per day in minutes */
  capacityMinutesPerDay: number;
  /** Efficiency percentage (0-100) */
  efficiencyPercent: number;
  /** Number of machines/resources */
  machineCount: number;
  /** Calendar: working days per week */
  workingDaysPerWeek: number;
  /** Is blocked / under maintenance? */
  blocked: boolean;
}

// ── Transfer Orders ──────────────────────────────────────────────

export interface TransferOrder {
  id: string;
  number: string;
  fromLocation: string;
  toLocation: string;
  itemNo: string;
  itemName: string;
  quantity: number;
  shipmentDate: string;
  receiptDate: string;
  status: "open" | "shipped" | "received";
}

// ── Graph Structures (for Critical Path) ─────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  type: "item" | "operation" | "vendor" | "milestone";
  durationDays: number;
  earliestStart?: number;
  earliestFinish?: number;
  latestStart?: number;
  latestFinish?: number;
  slack?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface SupplyChainGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  criticalPath: string[];
  totalDurationDays: number;
}

// ── Risk Structures ──────────────────────────────────────────────

export interface RiskScore {
  componentId: string;
  componentName: string;
  overallScore: number;
  dimensions: {
    availability: number;
    delivery: number;
    price: number;
    leadTime: number;
    external: number;
  };
  flags: string[];
}

export interface Intervention {
  id: string;
  type: "make_or_buy" | "safety_stock" | "dual_source" | "advance_purchase" | "reschedule";
  componentId: string;
  componentName: string;
  priority: "critical" | "high" | "medium" | "low";
  description: string;
  estimatedCostImpact: number;
  estimatedRiskReduction: number;
  details: Record<string, unknown>;
}

// ── ERP Connector Interface ──────────────────────────────────────

export interface ERPConnector {
  readonly system: "bc" | "odoo";

  testConnection(): Promise<{ ok: boolean; message: string }>;

  getProductionOrders(filters?: {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    itemFilter?: string;
  }): Promise<ProductionOrder[]>;

  getSalesOrders(filters?: {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<SalesOrder[]>;

  getBOMComponents(itemNo: string, depth?: number): Promise<BOMComponent[]>;

  getVendors(): Promise<Vendor[]>;

  getPurchaseOrders(filters?: {
    vendorNo?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<PurchaseOrder[]>;

  getItemAvailability(itemNos: string[]): Promise<ItemAvailability[]>;

  /**
   * Fetch posted purchase receipts for actual lead time tracking.
   * Returns historical receipt data with actual vs. planned dates.
   */
  getPostedReceipts(filters?: {
    itemNo?: string;
    vendorNo?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  }): Promise<PostedReceipt[]>;

  /**
   * Fetch production order routing lines (work center operations).
   * Returns routing steps with setup/run times for a production order.
   */
  getProductionRoutings(productionOrderId: string): Promise<RoutingStep[]>;

  /**
   * Fetch work center master data for capacity planning.
   */
  getWorkCenters(): Promise<WorkCenterData[]>;

  /**
   * Fetch transfer orders between locations.
   */
  getTransferOrders(filters?: {
    dateFrom?: string;
    dateTo?: string;
  }): Promise<TransferOrder[]>;
}

// ── ERP Connection Config ────────────────────────────────────────

export interface BCConnectionConfig {
  system: "bc";
  baseUrl: string;
  tenantId: string;
  environment: string;
  company: string;
  auth:
    | { type: "oauth2"; clientId: string; clientSecret: string }
    | { type: "apikey"; key: string };
}

export interface OdooConnectionConfig {
  system: "odoo";
  url: string;
  database: string;
  username: string;
  apiKey: string;
}

export type ERPConnectionConfig = BCConnectionConfig | OdooConnectionConfig;
