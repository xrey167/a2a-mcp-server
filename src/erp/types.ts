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
