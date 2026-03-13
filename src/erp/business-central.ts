/**
 * Business Central ERP Connector
 *
 * Connects to Microsoft Dynamics 365 Business Central via OData v4 API.
 * Reads production orders, sales orders, BOM structures, vendors, and purchase orders.
 */

import type {
  ERPConnector,
  BCConnectionConfig,
  ProductionOrder,
  SalesOrder,
  BOMComponent,
  Vendor,
  PurchaseOrder,
  ItemAvailability,
  PostedReceipt,
  RoutingStep,
  WorkCenterData,
  MachineCenterData,
  TransferOrder,
} from "./types.js";

function log(msg: string) {
  process.stderr.write(`[bc-connector] ${msg}\n`);
}

export class BusinessCentralConnector implements ERPConnector {
  readonly system = "bc" as const;
  private config: BCConnectionConfig;
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(config: BCConnectionConfig) {
    this.config = config;
  }

  // ── Auth ────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (this.config.auth.type === "apikey") {
      this.accessToken = this.config.auth.key;
      this.tokenExpiry = Date.now() + 3_600_000; // 1h placeholder
      return this.accessToken;
    }

    const { clientId, clientSecret } = this.config.auth;
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://api.businesscentral.dynamics.com/.default",
    });

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`BC OAuth2 token request failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = json.access_token;
    this.tokenExpiry = Date.now() + json.expires_in * 1000 - 60_000; // refresh 1min early
    return this.accessToken;
  }

  private get baseApiUrl(): string {
    return `${this.config.baseUrl}/api/v2.0/companies(${this.config.company})`;
  }

  private async odata<T>(endpoint: string, params?: Record<string, string>): Promise<T[]> {
    const token = await this.getToken();
    const url = new URL(`${this.baseApiUrl}/${endpoint}`);

    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    log(`OData GET ${url.pathname}`);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: this.config.auth.type === "apikey"
          ? `Basic ${Buffer.from(`:${token}`).toString("base64")}`
          : `Bearer ${token}`,
        Accept: "application/json",
      },
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Redirect detected (${res.status}) — rejected`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`BC OData error ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as { value: T[] };
    return json.value ?? [];
  }

  // ── ERPConnector Implementation ─────────────────────────────────

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.odata("companies", { $top: "1" });
      return { ok: true, message: "Connected to Business Central" };
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
    const filterParts: string[] = [];
    if (filters?.status) filterParts.push(`status eq '${filters.status}'`);
    if (filters?.dateFrom) filterParts.push(`dueDate ge ${filters.dateFrom}`);
    if (filters?.dateTo) filterParts.push(`dueDate le ${filters.dateTo}`);
    if (filters?.itemFilter) filterParts.push(`contains(sourceNo, '${filters.itemFilter}')`);

    const params: Record<string, string> = { $top: "500" };
    if (filterParts.length > 0) params.$filter = filterParts.join(" and ");

    const raw = await this.odata<Record<string, unknown>>("productionOrders", params);

    const orders: ProductionOrder[] = [];
    for (const r of raw) {
      const orderId = String(r.id ?? r.systemId ?? "");
      const components = await this.getBOMComponents(r.sourceNo as string);
      const routings = await this.getProductionRoutings(orderId);
      orders.push({
        id: orderId,
        number: String(r.no ?? ""),
        itemNo: String(r.sourceNo ?? ""),
        itemName: String(r.description ?? ""),
        quantity: Number(r.quantity ?? 0),
        dueDate: String(r.dueDate ?? ""),
        startDate: String(r.startingDate ?? r.dueDate ?? ""),
        status: mapBCProdStatus(String(r.status ?? "")),
        components,
        routings,
      });
    }

    return orders;
  }

  async getSalesOrders(filters?: {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<SalesOrder[]> {
    const filterParts: string[] = [];
    if (filters?.status) filterParts.push(`status eq '${filters.status}'`);
    if (filters?.dateFrom) filterParts.push(`orderDate ge ${filters.dateFrom}`);
    if (filters?.dateTo) filterParts.push(`orderDate le ${filters.dateTo}`);

    const params: Record<string, string> = {
      $top: "500",
      $expand: "salesOrderLines",
    };
    if (filterParts.length > 0) params.$filter = filterParts.join(" and ");

    const raw = await this.odata<Record<string, unknown>>("salesOrders", params);

    return raw.map((r) => ({
      id: String(r.id ?? r.systemId ?? ""),
      number: String(r.number ?? ""),
      customerNo: String(r.customerNumber ?? ""),
      customerName: String(r.customerName ?? ""),
      orderDate: String(r.orderDate ?? ""),
      requestedDeliveryDate: String(r.requestedDeliveryDate ?? r.orderDate ?? ""),
      status: mapBCSalesStatus(String(r.status ?? "")),
      lines: mapBCSalesLines(r.salesOrderLines as Record<string, unknown>[] ?? []),
    }));
  }

  async getBOMComponents(itemNo: string, depth = 3): Promise<BOMComponent[]> {
    const params: Record<string, string> = {
      $filter: `parentItemNo eq '${itemNo}'`,
      $top: "200",
    };

    let raw: Record<string, unknown>[];
    try {
      raw = await this.odata<Record<string, unknown>>("bomComponents", params);
    } catch {
      // BOM endpoint may not exist or item has no BOM
      return [];
    }

    const components: BOMComponent[] = [];
    for (const r of raw) {
      const childItemNo = String(r.no ?? "");
      const component: BOMComponent = {
        itemNo: childItemNo,
        itemName: String(r.description ?? ""),
        quantityPer: Number(r.quantityPer ?? 0),
        unitOfMeasure: String(r.unitOfMeasureCode ?? "PCS"),
        replenishmentMethod: mapBCReplenishment(String(r.replenishmentSystem ?? "Purchase")),
        vendorNo: r.vendorNo ? String(r.vendorNo) : undefined,
        vendorName: r.vendorName ? String(r.vendorName) : undefined,
        leadTimeDays: Number(r.leadTimeCalculation ?? 0),
        unitCost: Number(r.unitCost ?? 0),
        safetyStock: Number(r.safetyStockQuantity ?? 0),
        inventoryLevel: Number(r.inventory ?? 0),
        reorderPoint: Number(r.reorderPoint ?? 0),
        // Planning parameters from BC Item Card
        scrapPercent: r.scrapPercent != null ? Number(r.scrapPercent) : undefined,
        itemCategory: r.itemCategoryCode ? String(r.itemCategoryCode) : undefined,
        lotSizingPolicy: r.reorderingPolicy ? mapBCLotSizing(String(r.reorderingPolicy)) : undefined,
        orderQuantity: r.reorderQuantity != null ? Number(r.reorderQuantity) : undefined,
        minimumOrderQty: r.minimumOrderQuantity != null ? Number(r.minimumOrderQuantity) : undefined,
        orderMultiple: r.orderMultiple != null ? Number(r.orderMultiple) : undefined,
        vendorCountry: r.vendorCountry ? String(r.vendorCountry) : undefined,
        bomVersionCode: r.productionBOMVersionCode ? String(r.productionBOMVersionCode) : undefined,
        costingMethod: r.costingMethod ? String(r.costingMethod) : undefined,
      };

      // Recurse into sub-assemblies
      if (depth > 1 && component.replenishmentMethod !== "purchase") {
        component.children = await this.getBOMComponents(childItemNo, depth - 1);
      } else if (depth <= 1 && component.replenishmentMethod !== "purchase") {
        component.truncated = true;
        log(`BOM truncated at depth limit for item ${childItemNo}`);
      }

      components.push(component);
    }

    return components;
  }

  async getVendors(): Promise<Vendor[]> {
    const raw = await this.odata<Record<string, unknown>>("vendors", { $top: "1000" });

    // Fetch item vendor catalog for lead time data
    const vendorLeadTimes = new Map<string, number[]>();
    try {
      const itemVendors = await this.odata<Record<string, unknown>>("itemVendors", {
        $top: "2000",
        $select: "vendorNo,leadTimeCalculation",
      });
      for (const iv of itemVendors) {
        const vendorNo = String(iv.vendorNo ?? "");
        const lt = parseBCDateFormula(String(iv.leadTimeCalculation ?? ""));
        if (vendorNo && lt > 0) {
          if (!vendorLeadTimes.has(vendorNo)) vendorLeadTimes.set(vendorNo, []);
          vendorLeadTimes.get(vendorNo)!.push(lt);
        }
      }
      log(`enriched vendor lead times from ${vendorLeadTimes.size} vendors in item vendor catalog`);
    } catch {
      log("itemVendors entity not available — vendor lead times will be 0");
    }

    return raw.map((r) => {
      const vendorNo = String(r.number ?? "");
      const leadTimes = vendorLeadTimes.get(vendorNo);
      const avgLeadTime = leadTimes && leadTimes.length > 0
        ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length)
        : 0;

      return {
        no: vendorNo,
        name: String(r.displayName ?? ""),
        country: String(r.addressCountryRegion ?? ""),
        city: r.addressCity ? String(r.addressCity) : undefined,
        leadTimeDays: avgLeadTime,
        currencyCode: String(r.currencyCode ?? ""),
        blocked: String(r.blocked ?? "") !== " ",
        paymentTermsCode: r.paymentTermsCode ? String(r.paymentTermsCode) : undefined,
      };
    });
  }

  async getPurchaseOrders(filters?: {
    vendorNo?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<PurchaseOrder[]> {
    const filterParts: string[] = [];
    if (filters?.vendorNo) filterParts.push(`buyFromVendorNumber eq '${filters.vendorNo}'`);
    if (filters?.dateFrom) filterParts.push(`orderDate ge ${filters.dateFrom}`);
    if (filters?.dateTo) filterParts.push(`orderDate le ${filters.dateTo}`);

    const params: Record<string, string> = {
      $top: "500",
      $expand: "purchaseOrderLines",
    };
    if (filterParts.length > 0) params.$filter = filterParts.join(" and ");

    const raw = await this.odata<Record<string, unknown>>("purchaseOrders", params);

    return raw.map((r) => ({
      id: String(r.id ?? r.systemId ?? ""),
      number: String(r.number ?? ""),
      vendorNo: String(r.buyFromVendorNumber ?? ""),
      vendorName: String(r.buyFromVendorName ?? ""),
      orderDate: String(r.orderDate ?? ""),
      expectedReceiptDate: String(r.expectedReceiptDate ?? ""),
      status: mapBCPOStatus(String(r.status ?? "")),
      lines: (r.purchaseOrderLines as Record<string, unknown>[] ?? []).map((l) => ({
        itemNo: String(l.lineObjectNumber ?? ""),
        itemName: String(l.description ?? ""),
        quantity: Number(l.quantity ?? 0),
        unitCost: Number(l.directUnitCost ?? 0),
        expectedReceiptDate: String(l.expectedReceiptDate ?? ""),
      })),
    }));
  }

  async getItemAvailability(itemNos: string[]): Promise<ItemAvailability[]> {
    const results: ItemAvailability[] = [];
    for (const itemNo of itemNos) {
      try {
        const raw = await this.odata<Record<string, unknown>>("items", {
          $filter: `number eq '${itemNo}'`,
          $top: "1",
        });
        if (raw.length > 0) {
          const r = raw[0];
          results.push({
            itemNo,
            itemName: String(r.displayName ?? ""),
            inventory: Number(r.inventory ?? 0),
            reserved: Number(r.reservedQuantity ?? 0),
            available: Number(r.inventory ?? 0) - Number(r.reservedQuantity ?? 0),
            incomingQty: Number(r.quantityOnPurchaseOrders ?? 0),
            outgoingQty: Number(r.quantityOnSalesOrders ?? 0),
          });
        }
      } catch (err) {
        log(`item availability lookup failed for ${itemNo}: ${err}`);
      }
    }
    return results;
  }

  async getPostedReceipts(filters?: {
    itemNo?: string;
    vendorNo?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  }): Promise<PostedReceipt[]> {
    const filterParts: string[] = [];
    if (filters?.itemNo) filterParts.push(`itemNo eq '${filters.itemNo}'`);
    if (filters?.vendorNo) filterParts.push(`buyFromVendorNo eq '${filters.vendorNo}'`);
    if (filters?.dateFrom) filterParts.push(`postingDate ge ${filters.dateFrom}`);
    if (filters?.dateTo) filterParts.push(`postingDate le ${filters.dateTo}`);

    const params: Record<string, string> = {
      $top: String(filters?.limit ?? 500),
      $orderby: "postingDate desc",
    };
    if (filterParts.length > 0) params.$filter = filterParts.join(" and ");

    try {
      // BC: Posted Purchase Receipts (purchaseReceipts entity)
      const raw = await this.odata<Record<string, unknown>>("purchaseReceipts", params);

      const receipts: PostedReceipt[] = [];
      for (const r of raw) {
        const orderDate = String(r.orderDate ?? "");
        const expectedDate = String(r.expectedReceiptDate ?? "");
        const actualDate = String(r.postingDate ?? "");

        const orderMs = new Date(orderDate).getTime();
        const expectedMs = new Date(expectedDate).getTime();
        const actualMs = new Date(actualDate).getTime();
        const dayMs = 86400000;

        const actualLeadDays = isNaN(orderMs) || isNaN(actualMs) ? 0 : Math.ceil((actualMs - orderMs) / dayMs);
        const plannedLeadDays = isNaN(orderMs) || isNaN(expectedMs) ? 0 : Math.ceil((expectedMs - orderMs) / dayMs);

        receipts.push({
          purchaseOrderNo: String(r.orderNo ?? ""),
          vendorNo: String(r.buyFromVendorNo ?? ""),
          vendorName: String(r.buyFromVendorName ?? ""),
          itemNo: String(r.itemNo ?? ""),
          itemName: String(r.description ?? ""),
          quantity: Number(r.quantity ?? 0),
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
      // BC: Production Order Routing Lines
      const raw = await this.odata<Record<string, unknown>>(
        `productionOrders(${productionOrderId})/prodOrderRoutingLines`,
        { $top: "100" },
      );

      return raw.map((r) => ({
        operationNo: String(r.operationNo ?? ""),
        description: String(r.description ?? ""),
        workCenterNo: String(r.no ?? r.workCenterNo ?? ""),
        workCenterName: String(r.workCenterName ?? r.description ?? ""),
        setupTimeMinutes: Number(r.setupTime ?? 0),
        runTimeMinutes: Number(r.runTime ?? 0),
        waitTimeMinutes: Number(r.waitTime ?? 0),
        moveTimeMinutes: Number(r.moveTime ?? 0),
      }));
    } catch {
      // Routing lines endpoint may not be available
      return [];
    }
  }

  async getWorkCenters(): Promise<WorkCenterData[]> {
    try {
      // Fetch work centers with full planning data
      const raw = await this.odata<Record<string, unknown>>("workCenters", {
        $top: "200",
        $select: "no,name,capacity,efficiency,blocked,directUnitCost,unitCostCalculation,shopCalendarCode,subcontracted",
      });

      // Fetch machine centers (child resources of work centers)
      let machineCentersRaw: Record<string, unknown>[] = [];
      try {
        machineCentersRaw = await this.odata<Record<string, unknown>>("machineCenters", {
          $top: "500",
          $select: "no,name,workCenterNo,capacity,efficiency,blocked,directUnitCost,setupTime",
        });
        log(`fetched ${machineCentersRaw.length} machine centers`);
      } catch {
        log("machine centers entity not available — skipping");
      }

      // Group machine centers by work center
      const mcByWC = new Map<string, MachineCenterData[]>();
      for (const mc of machineCentersRaw) {
        const wcNo = String(mc.workCenterNo ?? "");
        if (!wcNo) continue;
        const mapped: MachineCenterData = {
          id: String(mc.no ?? mc.id ?? ""),
          name: String(mc.name ?? ""),
          workCenterId: wcNo,
          capacityMinutesPerDay: Number(mc.capacity ?? 480),
          efficiencyPercent: Number(mc.efficiency ?? 100),
          blocked: String(mc.blocked ?? "") !== " " && String(mc.blocked ?? "") !== "",
          setupTimeMinutes: Number(mc.setupTime ?? 0),
          costPerHour: Number(mc.directUnitCost ?? 0),
        };
        if (!mcByWC.has(wcNo)) mcByWC.set(wcNo, []);
        mcByWC.get(wcNo)!.push(mapped);
      }

      return raw.map((r) => {
        const wcNo = String(r.no ?? r.id ?? "");
        const machines = mcByWC.get(wcNo) ?? [];
        const activeMachines = machines.filter((m) => !m.blocked);

        return {
          id: wcNo,
          name: String(r.name ?? ""),
          capacityMinutesPerDay: Number(r.capacity ?? 480),
          efficiencyPercent: Number(r.efficiency ?? 100),
          machineCount: activeMachines.length || 1,
          workingDaysPerWeek: 5,
          blocked: String(r.blocked ?? "") !== " " && String(r.blocked ?? "") !== "",
          costPerHour: Number(r.directUnitCost ?? 0) || undefined,
          isSubcontracted: String(r.subcontracted ?? "false").toLowerCase() === "true",
          machineCenters: machines.length > 0 ? machines : undefined,
          // BC shop calendar would require additional entity calls
          // For now, derive from machine count
          calendar: undefined,
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
    const filterParts: string[] = [];
    if (filters?.dateFrom) filterParts.push(`shipmentDate ge ${filters.dateFrom}`);
    if (filters?.dateTo) filterParts.push(`shipmentDate le ${filters.dateTo}`);

    const params: Record<string, string> = { $top: "200" };
    if (filterParts.length > 0) params.$filter = filterParts.join(" and ");

    try {
      const raw = await this.odata<Record<string, unknown>>("transferOrders", params);
      return raw.map((r) => ({
        id: String(r.id ?? r.systemId ?? ""),
        number: String(r.no ?? ""),
        fromLocation: String(r.transferFromCode ?? ""),
        toLocation: String(r.transferToCode ?? ""),
        itemNo: String(r.itemNo ?? ""),
        itemName: String(r.description ?? ""),
        quantity: Number(r.quantity ?? 0),
        shipmentDate: String(r.shipmentDate ?? ""),
        receiptDate: String(r.receiptDate ?? ""),
        status: mapBCTransferStatus(String(r.status ?? "")),
      }));
    } catch (err) {
      log(`transfer orders fetch failed: ${err}`);
      return [];
    }
  }
}

// ── Mapping Helpers ──────────────────────────────────────────────

function mapBCProdStatus(s: string): ProductionOrder["status"] {
  const lower = s.toLowerCase();
  if (lower.includes("released")) return "released";
  if (lower.includes("firm")) return "firm_planned";
  if (lower.includes("finish")) return "finished";
  return "planned";
}

function mapBCSalesStatus(s: string): SalesOrder["status"] {
  const lower = s.toLowerCase();
  if (lower.includes("released")) return "released";
  if (lower.includes("prepay")) return "pending_prepayment";
  if (lower.includes("approv")) return "pending_approval";
  return "open";
}

function mapBCPOStatus(s: string): PurchaseOrder["status"] {
  const lower = s.toLowerCase();
  if (lower.includes("released")) return "released";
  if (lower.includes("approv")) return "pending_approval";
  return "open";
}

function mapBCReplenishment(s: string): BOMComponent["replenishmentMethod"] {
  const lower = s.toLowerCase();
  if (lower.includes("prod")) return "production";
  if (lower.includes("assembl")) return "assembly";
  if (lower.includes("transfer")) return "transfer";
  return "purchase";
}

function mapBCSalesLines(lines: Record<string, unknown>[]): SalesOrder["lines"] {
  return lines.map((l) => ({
    lineNo: Number(l.sequence ?? 0),
    itemNo: String(l.lineObjectNumber ?? ""),
    itemName: String(l.description ?? ""),
    quantity: Number(l.quantity ?? 0),
    unitPrice: Number(l.unitPrice ?? 0),
    requestedDeliveryDate: String(l.shipmentDate ?? ""),
    promisedDeliveryDate: l.promisedDeliveryDate ? String(l.promisedDeliveryDate) : undefined,
  }));
}

function mapBCLotSizing(s: string): BOMComponent["lotSizingPolicy"] {
  const lower = s.toLowerCase();
  if (lower.includes("fixed")) return "fixed_order_qty";
  if (lower.includes("lot-for-lot") || lower.includes("lot for lot")) return "lot_for_lot";
  // BC "Order" reordering policy = lot-for-lot (one order per demand)
  if (lower.includes("order")) return "order";
  if (lower.includes("maximum") || lower.includes("max")) return "maximum_qty";
  return "lot_for_lot";
}

function mapBCTransferStatus(s: string): TransferOrder["status"] {
  const lower = s.toLowerCase();
  if (lower.includes("shipped")) return "shipped";
  if (lower.includes("received") || lower.includes("closed")) return "received";
  return "open";
}

/**
 * Parse BC DateFormula strings (e.g. "14D", "2W", "1M") into days.
 * Falls back to parsing as a plain number.
 */
function parseBCDateFormula(formula: string): number {
  if (!formula || formula.trim() === "") return 0;
  const cleaned = formula.trim().toUpperCase();

  // Try "14D", "2W", "1M", "1Y" patterns
  const match = cleaned.match(/^(\d+)\s*([DWMY]?)$/);
  if (match) {
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case "D": case "": return value;
      case "W": return value * 7;
      case "M": return value * 30;
      case "Y": return value * 365;
    }
  }

  // Fallback: try plain number
  const num = Number(cleaned);
  return isNaN(num) ? 0 : Math.round(num);
}
