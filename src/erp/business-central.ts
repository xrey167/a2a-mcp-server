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
      const components = await this.getBOMComponents(r.sourceNo as string);
      orders.push({
        id: String(r.id ?? r.systemId ?? ""),
        number: String(r.no ?? ""),
        itemNo: String(r.sourceNo ?? ""),
        itemName: String(r.description ?? ""),
        quantity: Number(r.quantity ?? 0),
        dueDate: String(r.dueDate ?? ""),
        startDate: String(r.startingDate ?? r.dueDate ?? ""),
        status: mapBCProdStatus(String(r.status ?? "")),
        components,
        routings: [], // Routing lines would need a separate endpoint
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
      };

      // Recurse into sub-assemblies
      if (depth > 1 && component.replenishmentMethod !== "purchase") {
        component.children = await this.getBOMComponents(childItemNo, depth - 1);
      }

      components.push(component);
    }

    return components;
  }

  async getVendors(): Promise<Vendor[]> {
    const raw = await this.odata<Record<string, unknown>>("vendors", { $top: "1000" });
    return raw.map((r) => ({
      no: String(r.number ?? ""),
      name: String(r.displayName ?? ""),
      country: String(r.addressCountryRegion ?? ""),
      city: r.addressCity ? String(r.addressCity) : undefined,
      leadTimeDays: 0, // Not directly available on vendor entity
      currencyCode: String(r.currencyCode ?? ""),
      blocked: String(r.blocked ?? "") !== " ",
    }));
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
