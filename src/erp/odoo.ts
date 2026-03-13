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
  PostedReceipt,
  RoutingStep,
  WorkCenterData,
  TransferOrder,
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
      const routings = await this.getProductionRoutings(String(r.id));

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
        routings,
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
    vendorCountry?: string;
    leadTimeDays: number;
    unitCost: number;
    safetyStock: number;
    inventoryLevel: number;
    reorderPoint: number;
    itemCategory?: string;
    scrapPercent?: number;
    costingMethod?: string;
    lotSizingPolicy?: BOMComponent["lotSizingPolicy"];
    orderQuantity?: number;
    minimumOrderQty?: number;
    orderMultiple?: number;
  }> {
    const raw = await this.searchRead("product.product", [["id", "=", productId]], [
      "standard_price", "qty_available", "seller_ids",
      "produce_delay", "sale_delay", "categ_id",
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
    let vendorCountry: string | undefined;
    let leadTimeDays = Number(p.produce_delay ?? p.sale_delay ?? 0);

    // Item category
    const categId = p.categ_id as [number, string] | undefined;
    const itemCategory = categId ? categId[1] : undefined;

    // Get primary vendor with country
    if (sellerIds.length > 0) {
      const sellers = await this.searchRead("product.supplierinfo", [
        ["id", "in", sellerIds],
      ], ["partner_id", "delay", "min_qty"], 1);
      if (sellers.length > 0) {
        const partner = (sellers[0].partner_id as [number, string]) ?? [0, ""];
        vendorNo = String(partner[0]);
        vendorName = partner[1];
        leadTimeDays = Number(sellers[0].delay ?? leadTimeDays);

        // Fetch vendor country
        try {
          const vendorData = await this.searchRead("res.partner", [
            ["id", "=", partner[0]],
          ], ["country_id"], 1);
          if (vendorData.length > 0) {
            const countryId = vendorData[0].country_id as [number, string] | undefined;
            vendorCountry = countryId ? countryId[1] : undefined;
          }
        } catch { /* ignore */ }
      }
    }

    // Determine replenishment from BOM existence + scrap percentage
    let replenishmentMethod: BOMComponent["replenishmentMethod"] = "purchase";
    let scrapPercent: number | undefined;
    try {
      const boms = await this.searchRead("mrp.bom", [
        ["product_id", "=", productId],
      ], ["id", "type", "product_qty", "scrap"], 1);
      if (boms.length > 0) {
        const bomType = String(boms[0].type ?? "normal");
        replenishmentMethod = bomType === "subcontract" ? "purchase" : "production";
        const bomScrap = Number(boms[0].scrap ?? 0);
        if (bomScrap > 0) scrapPercent = bomScrap;
      }
    } catch {
      // mrp module may not be installed
    }

    // Get orderpoint for safety stock / reorder point / lot sizing
    let safetyStock = 0;
    let reorderPoint = 0;
    let lotSizingPolicy: BOMComponent["lotSizingPolicy"] | undefined;
    let orderQuantity: number | undefined;
    let minimumOrderQty: number | undefined;
    let orderMultiple: number | undefined;
    try {
      const orderpoints = await this.searchRead("stock.warehouse.orderpoint", [
        ["product_id", "=", productId],
      ], ["product_min_qty", "product_max_qty", "qty_multiple"], 1);
      if (orderpoints.length > 0) {
        const op = orderpoints[0];
        reorderPoint = Number(op.product_min_qty ?? 0);
        safetyStock = reorderPoint; // In Odoo, min qty acts as safety stock
        const maxQty = Number(op.product_max_qty ?? 0);
        const qtyMultiple = Number(op.qty_multiple ?? 0);

        // Derive lot sizing policy from orderpoint configuration
        if (maxQty > 0 && reorderPoint > 0) {
          lotSizingPolicy = "maximum_qty";
          orderQuantity = maxQty;
          minimumOrderQty = reorderPoint;
          // qty_multiple is an order rounding multiple when used with min/max
          if (qtyMultiple > 1) orderMultiple = qtyMultiple;
        } else if (qtyMultiple > 0) {
          lotSizingPolicy = "fixed_order_qty";
          orderQuantity = qtyMultiple;
        } else {
          lotSizingPolicy = "lot_for_lot";
        }
      }
    } catch {
      // stock module variations
    }

    // Fetch costing method from product category
    let costingMethod: string | undefined;
    if (categId) {
      try {
        const cats = await this.searchRead("product.category", [
          ["id", "=", categId[0]],
        ], ["property_cost_method"], 1);
        if (cats.length > 0 && cats[0].property_cost_method) {
          costingMethod = String(cats[0].property_cost_method);
        }
      } catch { /* category costing not available */ }
    }

    return {
      replenishmentMethod,
      vendorNo,
      vendorName,
      vendorCountry,
      leadTimeDays,
      unitCost: Number(p.standard_price ?? 0),
      safetyStock,
      inventoryLevel: Number(p.qty_available ?? 0),
      reorderPoint,
      itemCategory,
      scrapPercent,
      costingMethod,
      lotSizingPolicy,
      orderQuantity,
      minimumOrderQty,
      orderMultiple,
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
      } else if (depth <= 1 && component.replenishmentMethod !== "purchase") {
        component.truncated = true;
        log(`BOM truncated at depth limit for item ${pid[0]}`);
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
      "property_supplier_payment_term_id", "active",
    ], 1000);

    // Fetch supplier info records for lead time data (delay field)
    const vendorLeadTimes = new Map<number, number[]>();
    try {
      const supplierInfo = await this.searchRead("product.supplierinfo", [], [
        "partner_id", "delay",
      ], 2000);
      for (const si of supplierInfo) {
        const partnerId = ((si.partner_id as [number, string]) ?? [0])[0];
        const delay = Number(si.delay ?? 0);
        if (partnerId && delay > 0) {
          if (!vendorLeadTimes.has(partnerId)) vendorLeadTimes.set(partnerId, []);
          vendorLeadTimes.get(partnerId)!.push(delay);
        }
      }
      log(`enriched vendor lead times from ${vendorLeadTimes.size} vendors in product.supplierinfo`);
    } catch {
      log("product.supplierinfo not available — vendor lead times will be 0");
    }

    return raw.map((r) => {
      const partnerId = Number(r.id);
      const leadTimes = vendorLeadTimes.get(partnerId);
      const avgLeadTime = leadTimes && leadTimes.length > 0
        ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length)
        : 0;

      return {
        no: String(r.id),
        name: String(r.name ?? ""),
        country: String((r.country_id as [number, string])?.[1] ?? ""),
        city: r.city ? String(r.city) : undefined,
        leadTimeDays: avgLeadTime,
        currencyCode: "",
        blocked: r.active === false,
        paymentTermsCode: r.property_supplier_payment_term_id
          ? String((r.property_supplier_payment_term_id as [number, string])?.[1] ?? "")
          : undefined,
      };
    });
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

  async getPostedReceipts(filters?: {
    itemNo?: string;
    vendorNo?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  }): Promise<PostedReceipt[]> {
    try {
      // Odoo: stock.move with picking_type = incoming, state = done
      const domain: unknown[][] = [
        ["state", "=", "done"],
        ["picking_type_id.code", "=", "incoming"],
      ];
      if (filters?.itemNo) domain.push(["product_id", "=", parseInt(filters.itemNo, 10)]);
      if (filters?.dateFrom) domain.push(["date", ">=", filters.dateFrom]);
      if (filters?.dateTo) domain.push(["date", "<=", filters.dateTo]);

      const raw = await this.searchRead("stock.move", domain, [
        "product_id", "product_uom_qty", "date", "create_date",
        "origin", "picking_id",
      ], filters?.limit ?? 500);

      const receipts: PostedReceipt[] = [];
      for (const r of raw) {
        const productId = (r.product_id as [number, string]) ?? [0, ""];
        const actualDate = String(r.date ?? "").slice(0, 10);
        const createDate = String(r.create_date ?? "").slice(0, 10);
        const origin = String(r.origin ?? "");

        // Try to find the original PO for dates
        let orderDate = createDate;
        let expectedDate = createDate;
        let vendorNo = "";
        let vendorName = "";

        if (origin) {
          try {
            const pos = await this.searchRead("purchase.order", [
              ["name", "=", origin],
            ], ["date_order", "date_planned", "partner_id"], 1);
            if (pos.length > 0) {
              orderDate = String(pos[0].date_order ?? "").slice(0, 10);
              expectedDate = String(pos[0].date_planned ?? "").slice(0, 10);
              const partner = (pos[0].partner_id as [number, string]) ?? [0, ""];
              vendorNo = String(partner[0]);
              vendorName = partner[1] ?? "";
            }
          } catch { /* PO lookup optional */ }
        }

        const dayMs = 86400000;
        const orderMs = new Date(orderDate).getTime();
        const expectedMs = new Date(expectedDate).getTime();
        const actualMs = new Date(actualDate).getTime();
        const actualLeadDays = isNaN(orderMs) || isNaN(actualMs) ? 0 : Math.ceil((actualMs - orderMs) / dayMs);
        const plannedLeadDays = isNaN(orderMs) || isNaN(expectedMs) ? 0 : Math.ceil((expectedMs - orderMs) / dayMs);

        receipts.push({
          purchaseOrderNo: origin,
          vendorNo,
          vendorName,
          itemNo: String(productId[0]),
          itemName: productId[1] ?? "",
          quantity: Number(r.product_uom_qty ?? 0),
          orderDate,
          expectedDate,
          actualReceiptDate: actualDate,
          actualLeadTimeDays: actualLeadDays,
          plannedLeadTimeDays: plannedLeadDays,
          varianceDays: actualLeadDays - plannedLeadDays,
        });
      }

      log(`fetched ${receipts.length} posted receipts`);
      return receipts;
    } catch (err) {
      log(`posted receipts fetch failed: ${err}`);
      return [];
    }
  }

  async getProductionRoutings(productionOrderId: string): Promise<RoutingStep[]> {
    try {
      const moId = parseInt(productionOrderId, 10);
      if (isNaN(moId)) return [];

      // Odoo: mrp.workorder linked to production order
      const raw = await this.searchRead("mrp.workorder", [
        ["production_id", "=", moId],
      ], [
        "name", "workcenter_id", "duration_expected",
        "duration", "state",
      ], 100);

      return raw.map((r, idx) => {
        const wcId = (r.workcenter_id as [number, string]) ?? [0, ""];
        const totalMinutes = Number(r.duration_expected ?? 0);
        return {
          operationNo: String(idx + 1).padStart(2, "0"),
          description: String(r.name ?? ""),
          workCenterNo: String(wcId[0]),
          workCenterName: wcId[1] ?? "",
          setupTimeMinutes: 0, // Odoo doesn't separate setup/run in workorder
          runTimeMinutes: totalMinutes,
          waitTimeMinutes: 0,
          moveTimeMinutes: 0,
        };
      });
    } catch {
      return [];
    }
  }

  async getWorkCenters(): Promise<WorkCenterData[]> {
    try {
      const raw = await this.searchRead("mrp.workcenter", [], [
        "id", "name", "capacity", "time_efficiency",
        "oee_target", "working_state", "costs_hour",
        "time_start", "time_stop", "resource_calendar_id",
      ], 200);

      // Fetch resource calendars for shift/hours data
      const calendarIds = raw
        .map((r) => {
          const cal = r.resource_calendar_id as [number, string] | false;
          return cal ? cal[0] : null;
        })
        .filter((id): id is number => id !== null);

      const calendarMap = new Map<number, { name: string; hoursPerDay: number; daysPerWeek: number; shifts: Array<{ name: string; startTime: string; endTime: string; daysOfWeek: number[] }> }>();

      if (calendarIds.length > 0) {
        try {
          const uniqueIds = [...new Set(calendarIds)];
          const calendars = await this.searchRead("resource.calendar", [
            ["id", "in", uniqueIds],
          ], ["id", "name", "hours_per_week", "attendance_ids"], 50);

          for (const cal of calendars) {
            const hoursPerWeek = Number(cal.hours_per_week ?? 40);
            const daysPerWeek = hoursPerWeek > 0 ? Math.min(7, Math.round(hoursPerWeek / 8)) : 5;

            // Fetch attendance lines (shift definitions)
            const shifts: Array<{ name: string; startTime: string; endTime: string; daysOfWeek: number[] }> = [];
            const attendanceIds = cal.attendance_ids as number[] ?? [];
            if (attendanceIds.length > 0) {
              try {
                const attendances = await this.searchRead("resource.calendar.attendance", [
                  ["id", "in", attendanceIds],
                ], ["id", "name", "hour_from", "hour_to", "dayofweek"], 100);

                // Group by name to combine days
                const shiftMap = new Map<string, { name: string; startTime: string; endTime: string; days: Set<number> }>();
                for (const att of attendances) {
                  const name = String(att.name ?? "Shift");
                  const from = Number(att.hour_from ?? 0);
                  const to = Number(att.hour_to ?? 0);
                  const key = `${name}-${from}-${to}`;
                  if (!shiftMap.has(key)) {
                    shiftMap.set(key, {
                      name,
                      startTime: formatHour(from),
                      endTime: formatHour(to),
                      days: new Set(),
                    });
                  }
                  shiftMap.get(key)!.days.add(Number(att.dayofweek ?? 0));
                }
                for (const s of shiftMap.values()) {
                  shifts.push({ name: s.name, startTime: s.startTime, endTime: s.endTime, daysOfWeek: [...s.days].sort() });
                }
              } catch {
                log("could not fetch calendar attendance lines");
              }
            }

            calendarMap.set(Number(cal.id), {
              name: String(cal.name ?? ""),
              hoursPerDay: hoursPerWeek / daysPerWeek,
              daysPerWeek,
              shifts,
            });
          }
          log(`fetched ${calendarMap.size} resource calendars`);
        } catch {
          log("resource.calendar not available — using defaults");
        }
      }

      // Fetch OEE productivity data (actual performance)
      const wcIds = raw.map((r) => Number(r.id));
      const oeeMap = new Map<number, number>();
      if (wcIds.length > 0) {
        try {
          const productivity = await this.searchRead("mrp.workcenter.productivity", [
            ["workcenter_id", "in", wcIds],
            ["date_end", "!=", false],
          ], ["workcenter_id", "duration", "loss_id"], 500);

          // Compute actual OEE per work center: productive time / total time
          const wcTotals = new Map<number, { productive: number; total: number }>();
          for (const p of productivity) {
            const wcId = ((p.workcenter_id as [number, string]) ?? [0])[0];
            const duration = Number(p.duration ?? 0);
            if (!wcTotals.has(wcId)) wcTotals.set(wcId, { productive: 0, total: 0 });
            const t = wcTotals.get(wcId)!;
            t.total += duration;
            // loss_id = false means productive time (no loss)
            if (!p.loss_id || p.loss_id === false) t.productive += duration;
          }
          for (const [wcId, totals] of wcTotals) {
            if (totals.total > 0) {
              oeeMap.set(wcId, Math.round((totals.productive / totals.total) * 100));
            }
          }
          log(`computed OEE for ${oeeMap.size} work centers`);
        } catch {
          log("mrp.workcenter.productivity not available — skipping OEE");
        }
      }

      return raw.map((r) => {
        const id = Number(r.id);
        const calRef = r.resource_calendar_id as [number, string] | false;
        const calData = calRef ? calendarMap.get(calRef[0]) : undefined;
        const hoursPerDay = calData?.hoursPerDay ?? 8;

        return {
          id: String(id),
          name: String(r.name ?? ""),
          capacityMinutesPerDay: Number(r.capacity ?? 1) * hoursPerDay * 60,
          efficiencyPercent: Number(r.time_efficiency ?? 100),
          machineCount: Number(r.capacity ?? 1),
          workingDaysPerWeek: calData?.daysPerWeek ?? 5,
          blocked: String(r.working_state ?? "normal") === "blocked",
          oeeTarget: Number(r.oee_target ?? 0) || undefined,
          oeeActual: oeeMap.get(id) ?? undefined,
          avgSetupTimeMinutes: Number(r.time_start ?? 0) + Number(r.time_stop ?? 0) || undefined,
          costPerHour: Number(r.costs_hour ?? 0) || undefined,
          calendar: calData ? {
            name: calData.name,
            hoursPerDay: calData.hoursPerDay,
            daysPerWeek: calData.daysPerWeek,
            shifts: calData.shifts.length > 0 ? calData.shifts : undefined,
          } : undefined,
        };
      });
    } catch (err) {
      log(`work centers fetch failed: ${err}`);
      return [];
    }
  }

  async getTransferOrders(filters?: {
    dateFrom?: string;
    dateTo?: string;
  }): Promise<TransferOrder[]> {
    try {
      // Odoo: stock.picking with picking_type internal
      const domain: unknown[][] = [
        ["picking_type_id.code", "=", "internal"],
      ];
      if (filters?.dateFrom) domain.push(["scheduled_date", ">=", filters.dateFrom]);
      if (filters?.dateTo) domain.push(["scheduled_date", "<=", filters.dateTo]);

      const raw = await this.searchRead("stock.picking", domain, [
        "id", "name", "location_id", "location_dest_id",
        "scheduled_date", "date_done", "state",
        "move_ids_without_package",
      ], 200);

      const transfers: TransferOrder[] = [];
      for (const r of raw) {
        const fromLoc = (r.location_id as [number, string]) ?? [0, ""];
        const toLoc = (r.location_dest_id as [number, string]) ?? [0, ""];
        const moveIds = r.move_ids_without_package as number[] ?? [];

        // Get first move line for item info
        if (moveIds.length > 0) {
          const moves = await this.searchRead("stock.move", [
            ["id", "in", moveIds.slice(0, 1)],
          ], ["product_id", "product_uom_qty"], 1);

          if (moves.length > 0) {
            const pid = (moves[0].product_id as [number, string]) ?? [0, ""];
            transfers.push({
              id: String(r.id),
              number: String(r.name ?? ""),
              fromLocation: fromLoc[1] ?? "",
              toLocation: toLoc[1] ?? "",
              itemNo: String(pid[0]),
              itemName: pid[1] ?? "",
              quantity: Number(moves[0].product_uom_qty ?? 0),
              shipmentDate: String(r.scheduled_date ?? "").slice(0, 10),
              receiptDate: String(r.date_done ?? r.scheduled_date ?? "").slice(0, 10),
              status: mapOdooTransferStatus(String(r.state ?? "")),
            });
          }
        }
      }

      log(`fetched ${transfers.length} transfer orders`);
      return transfers;
    } catch (err) {
      log(`transfer orders fetch failed: ${err}`);
      return [];
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/** Convert Odoo float hours (e.g. 8.5) to HH:mm string */
function formatHour(h: number): string {
  const hours = Math.floor(h);
  const minutes = Math.round((h - hours) * 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
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

function mapOdooTransferStatus(state: string): TransferOrder["status"] {
  switch (state) {
    case "done": return "received";
    case "assigned": case "confirmed": return "shipped";
    default: return "open";
  }
}
