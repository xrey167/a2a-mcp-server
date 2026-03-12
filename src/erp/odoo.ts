/**
 * Odoo ERP Connector
 *
 * Connects to Odoo via JSON-RPC API.
 * Reads manufacturing orders, sales orders, BOMs, vendors, and purchase orders.
 */

import type {
  ERPConnector,
  OdooConnectionConfig,
  ProductionOrder,
  SalesOrder,
  BOMComponent,
  Vendor,
  PurchaseOrder,
  ItemAvailability,
} from "./types.js";

function log(msg: string) {
  process.stderr.write(`[odoo-connector] ${msg}\n`);
}

export class OdooConnector implements ERPConnector {
  readonly system = "odoo" as const;
  private config: OdooConnectionConfig;
  private uid: number | null = null;

  constructor(config: OdooConnectionConfig) {
    this.config = config;
  }

  // ── JSON-RPC Helpers ────────────────────────────────────────────

  private async jsonRpc(service: string, method: string, args: unknown[]): Promise<unknown> {
    const url = `${this.config.url}/jsonrpc`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: Date.now(),
        params: { service, method, args },
      }),
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Redirect detected (${res.status}) — rejected`);
    }

    if (!res.ok) {
      throw new Error(`Odoo RPC error: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as { result?: unknown; error?: { message: string; data?: { message: string } } };
    if (json.error) {
      throw new Error(`Odoo error: ${json.error.data?.message ?? json.error.message}`);
    }
    return json.result;
  }

  private async authenticate(): Promise<number> {
    if (this.uid !== null) return this.uid;

    const uid = (await this.jsonRpc("common", "authenticate", [
      this.config.database,
      this.config.username,
      this.config.apiKey,
      {},
    ])) as number | false;

    if (!uid) throw new Error("Odoo authentication failed");
    this.uid = uid;
    return uid;
  }

  private async call(model: string, method: string, args: unknown[], kwargs?: Record<string, unknown>): Promise<unknown> {
    const uid = await this.authenticate();
    return this.jsonRpc("object", "execute_kw", [
      this.config.database,
      uid,
      this.config.apiKey,
      model,
      method,
      args,
      kwargs ?? {},
    ]);
  }

  private async searchRead(
    model: string,
    domain: unknown[][],
    fields: string[],
    limit = 500,
  ): Promise<Record<string, unknown>[]> {
    return (await this.call(model, "search_read", [domain], {
      fields,
      limit,
    })) as Record<string, unknown>[];
  }

  // ── ERPConnector Implementation ─────────────────────────────────

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate();
      return { ok: true, message: "Connected to Odoo" };
    } catch (err) {
      return { ok: false, message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async getProductionOrders(filters?: {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    itemFilter?: string;
  }): Promise<ProductionOrder[]> {
    const domain: unknown[][] = [];
    if (filters?.status) domain.push(["state", "=", mapOdooMOStatusReverse(filters.status)]);
    if (filters?.dateFrom) domain.push(["date_planned_start", ">=", filters.dateFrom]);
    if (filters?.dateTo) domain.push(["date_planned_start", "<=", filters.dateTo]);
    if (filters?.itemFilter) domain.push(["product_id.default_code", "ilike", filters.itemFilter]);

    const raw = await this.searchRead("mrp.production", domain, [
      "id", "name", "product_id", "product_qty", "date_planned_start",
      "date_planned_finished", "state", "move_raw_ids",
    ]);

    const orders: ProductionOrder[] = [];
    for (const r of raw) {
      const productId = (r.product_id as [number, string]) ?? [0, ""];
      const components = await this.getMOComponents(r.id as number);

      orders.push({
        id: String(r.id),
        number: String(r.name ?? ""),
        itemNo: String(productId[0]),
        itemName: productId[1] ?? "",
        quantity: Number(r.product_qty ?? 0),
        dueDate: String(r.date_planned_finished ?? ""),
        startDate: String(r.date_planned_start ?? ""),
        status: mapOdooMOStatus(String(r.state ?? "")),
        components,
        routings: [],
      });
    }

    return orders;
  }

  private async getMOComponents(moId: number): Promise<BOMComponent[]> {
    const raw = await this.searchRead("stock.move", [
      ["raw_material_production_id", "=", moId],
    ], [
      "product_id", "product_uom_qty", "product_uom",
    ]);

    const components: BOMComponent[] = [];
    for (const r of raw) {
      const productId = (r.product_id as [number, string]) ?? [0, ""];
      const productDetails = await this.getProductDetails(productId[0]);

      components.push({
        itemNo: String(productId[0]),
        itemName: productId[1] ?? "",
        quantityPer: Number(r.product_uom_qty ?? 0),
        unitOfMeasure: String((r.product_uom as [number, string])?.[1] ?? "Unit"),
        ...productDetails,
      });
    }

    return components;
  }

  private async getProductDetails(productId: number): Promise<{
    replenishmentMethod: BOMComponent["replenishmentMethod"];
    vendorNo?: string;
    vendorName?: string;
    leadTimeDays: number;
    unitCost: number;
    safetyStock: number;
    inventoryLevel: number;
    reorderPoint: number;
  }> {
    const raw = await this.searchRead("product.product", [["id", "=", productId]], [
      "standard_price", "qty_available", "seller_ids",
      "produce_delay", "sale_delay",
    ], 1);

    if (raw.length === 0) {
      return {
        replenishmentMethod: "purchase",
        leadTimeDays: 0,
        unitCost: 0,
        safetyStock: 0,
        inventoryLevel: 0,
        reorderPoint: 0,
      };
    }

    const p = raw[0];
    const sellerIds = p.seller_ids as number[] ?? [];
    let vendorNo: string | undefined;
    let vendorName: string | undefined;
    let leadTimeDays = Number(p.produce_delay ?? p.sale_delay ?? 0);

    // Get primary vendor
    if (sellerIds.length > 0) {
      const sellers = await this.searchRead("product.supplierinfo", [
        ["id", "in", sellerIds],
      ], ["partner_id", "delay"], 1);
      if (sellers.length > 0) {
        const partner = (sellers[0].partner_id as [number, string]) ?? [0, ""];
        vendorNo = String(partner[0]);
        vendorName = partner[1];
        leadTimeDays = Number(sellers[0].delay ?? leadTimeDays);
      }
    }

    // Determine replenishment from BOM existence
    let replenishmentMethod: BOMComponent["replenishmentMethod"] = "purchase";
    try {
      const boms = await this.searchRead("mrp.bom", [
        ["product_id", "=", productId],
      ], ["id", "type"], 1);
      if (boms.length > 0) {
        const bomType = String(boms[0].type ?? "normal");
        replenishmentMethod = bomType === "subcontract" ? "purchase" : "production";
      }
    } catch {
      // mrp module may not be installed
    }

    // Get orderpoint for safety stock / reorder point
    let safetyStock = 0;
    let reorderPoint = 0;
    try {
      const orderpoints = await this.searchRead("stock.warehouse.orderpoint", [
        ["product_id", "=", productId],
      ], ["product_min_qty", "product_max_qty"], 1);
      if (orderpoints.length > 0) {
        reorderPoint = Number(orderpoints[0].product_min_qty ?? 0);
        safetyStock = reorderPoint; // In Odoo, min qty acts as safety stock
      }
    } catch {
      // stock module variations
    }

    return {
      replenishmentMethod,
      vendorNo,
      vendorName,
      leadTimeDays,
      unitCost: Number(p.standard_price ?? 0),
      safetyStock,
      inventoryLevel: Number(p.qty_available ?? 0),
      reorderPoint,
    };
  }

  async getSalesOrders(filters?: {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<SalesOrder[]> {
    const domain: unknown[][] = [];
    if (filters?.status) domain.push(["state", "=", filters.status]);
    if (filters?.dateFrom) domain.push(["date_order", ">=", filters.dateFrom]);
    if (filters?.dateTo) domain.push(["date_order", "<=", filters.dateTo]);

    const raw = await this.searchRead("sale.order", domain, [
      "id", "name", "partner_id", "date_order",
      "commitment_date", "state", "order_line",
    ]);

    const orders: SalesOrder[] = [];
    for (const r of raw) {
      const partnerId = (r.partner_id as [number, string]) ?? [0, ""];
      const lineIds = r.order_line as number[] ?? [];
      const lines = await this.getSalesOrderLines(lineIds);

      orders.push({
        id: String(r.id),
        number: String(r.name ?? ""),
        customerNo: String(partnerId[0]),
        customerName: partnerId[1] ?? "",
        orderDate: String(r.date_order ?? ""),
        requestedDeliveryDate: String(r.commitment_date ?? r.date_order ?? ""),
        status: mapOdooSOStatus(String(r.state ?? "")),
        lines,
      });
    }

    return orders;
  }

  private async getSalesOrderLines(lineIds: number[]): Promise<SalesOrder["lines"]> {
    if (lineIds.length === 0) return [];

    const raw = await this.searchRead("sale.order.line", [
      ["id", "in", lineIds],
    ], [
      "sequence", "product_id", "product_uom_qty",
      "price_unit", "customer_lead",
    ]);

    return raw.map((l) => {
      const productId = (l.product_id as [number, string]) ?? [0, ""];
      return {
        lineNo: Number(l.sequence ?? 0),
        itemNo: String(productId[0]),
        itemName: productId[1] ?? "",
        quantity: Number(l.product_uom_qty ?? 0),
        unitPrice: Number(l.price_unit ?? 0),
        requestedDeliveryDate: "", // Derived from order commitment_date
      };
    });
  }

  async getBOMComponents(itemNo: string, depth = 3): Promise<BOMComponent[]> {
    const productId = parseInt(itemNo, 10);
    if (isNaN(productId)) return [];

    const boms = await this.searchRead("mrp.bom", [
      ["product_id", "=", productId],
    ], ["id", "bom_line_ids"], 1);

    if (boms.length === 0) return [];

    const lineIds = boms[0].bom_line_ids as number[] ?? [];
    if (lineIds.length === 0) return [];

    const raw = await this.searchRead("mrp.bom.line", [
      ["id", "in", lineIds],
    ], ["product_id", "product_qty", "product_uom_id"]);

    const components: BOMComponent[] = [];
    for (const r of raw) {
      const pid = (r.product_id as [number, string]) ?? [0, ""];
      const details = await this.getProductDetails(pid[0]);

      const component: BOMComponent = {
        itemNo: String(pid[0]),
        itemName: pid[1] ?? "",
        quantityPer: Number(r.product_qty ?? 0),
        unitOfMeasure: String((r.product_uom_id as [number, string])?.[1] ?? "Unit"),
        ...details,
      };

      if (depth > 1 && component.replenishmentMethod !== "purchase") {
        component.children = await this.getBOMComponents(String(pid[0]), depth - 1);
      }

      components.push(component);
    }

    return components;
  }

  async getVendors(): Promise<Vendor[]> {
    const raw = await this.searchRead("res.partner", [
      ["supplier_rank", ">", 0],
    ], [
      "id", "name", "country_id", "city",
      "property_supplier_payment_term_id",
    ], 1000);

    return raw.map((r) => ({
      no: String(r.id),
      name: String(r.name ?? ""),
      country: String((r.country_id as [number, string])?.[1] ?? ""),
      city: r.city ? String(r.city) : undefined,
      leadTimeDays: 0, // Not directly on partner
      currencyCode: "",
      blocked: false,
    }));
  }

  async getPurchaseOrders(filters?: {
    vendorNo?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<PurchaseOrder[]> {
    const domain: unknown[][] = [];
    if (filters?.vendorNo) domain.push(["partner_id", "=", parseInt(filters.vendorNo, 10)]);
    if (filters?.dateFrom) domain.push(["date_order", ">=", filters.dateFrom]);
    if (filters?.dateTo) domain.push(["date_order", "<=", filters.dateTo]);

    const raw = await this.searchRead("purchase.order", domain, [
      "id", "name", "partner_id", "date_order",
      "date_planned", "state", "order_line",
    ]);

    const orders: PurchaseOrder[] = [];
    for (const r of raw) {
      const partnerId = (r.partner_id as [number, string]) ?? [0, ""];
      const lineIds = r.order_line as number[] ?? [];

      let lines: PurchaseOrder["lines"] = [];
      if (lineIds.length > 0) {
        const rawLines = await this.searchRead("purchase.order.line", [
          ["id", "in", lineIds],
        ], ["product_id", "product_qty", "price_unit", "date_planned"]);

        lines = rawLines.map((l) => {
          const pid = (l.product_id as [number, string]) ?? [0, ""];
          return {
            itemNo: String(pid[0]),
            itemName: pid[1] ?? "",
            quantity: Number(l.product_qty ?? 0),
            unitCost: Number(l.price_unit ?? 0),
            expectedReceiptDate: String(l.date_planned ?? ""),
          };
        });
      }

      orders.push({
        id: String(r.id),
        number: String(r.name ?? ""),
        vendorNo: String(partnerId[0]),
        vendorName: partnerId[1] ?? "",
        orderDate: String(r.date_order ?? ""),
        expectedReceiptDate: String(r.date_planned ?? ""),
        status: mapOdooPOStatus(String(r.state ?? "")),
        lines,
      });
    }

    return orders;
  }

  async getItemAvailability(itemNos: string[]): Promise<ItemAvailability[]> {
    const ids = itemNos.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
    if (ids.length === 0) return [];

    const raw = await this.searchRead("product.product", [
      ["id", "in", ids],
    ], [
      "id", "name", "qty_available", "virtual_available",
      "incoming_qty", "outgoing_qty",
    ]);

    return raw.map((r) => ({
      itemNo: String(r.id),
      itemName: String(r.name ?? ""),
      inventory: Number(r.qty_available ?? 0),
      reserved: Number(r.qty_available ?? 0) - Number(r.virtual_available ?? 0),
      available: Number(r.virtual_available ?? 0),
      incomingQty: Number(r.incoming_qty ?? 0),
      outgoingQty: Number(r.outgoing_qty ?? 0),
    }));
  }
}

// ── Status Mapping ───────────────────────────────────────────────

function mapOdooMOStatus(state: string): ProductionOrder["status"] {
  switch (state) {
    case "confirmed": return "firm_planned";
    case "progress": case "to_close": return "released";
    case "done": return "finished";
    default: return "planned";
  }
}

function mapOdooMOStatusReverse(status: string): string {
  switch (status) {
    case "planned": return "draft";
    case "firm_planned": return "confirmed";
    case "released": return "progress";
    case "finished": return "done";
    default: return status;
  }
}

function mapOdooSOStatus(state: string): SalesOrder["status"] {
  switch (state) {
    case "sale": case "done": return "released";
    case "sent": return "pending_approval";
    default: return "open";
  }
}

function mapOdooPOStatus(state: string): PurchaseOrder["status"] {
  switch (state) {
    case "purchase": case "done": return "released";
    case "sent": case "to approve": return "pending_approval";
    default: return "open";
  }
}
