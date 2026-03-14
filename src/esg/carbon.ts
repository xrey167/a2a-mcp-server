/**
 * Carbon Footprint Calculator
 *
 * Calculates CO2 equivalent emissions per product/supply chain using:
 *   - Transport distances (from infra agent supply_chain_map)
 *   - Emission factors (DEFRA/GHG Protocol embedded tables)
 *   - Energy mix per country (embedded static data)
 *
 * Supports Scope 1/2/3 breakdown and nearshoring scenario comparison.
 */

import type { BOMComponent } from "../erp/types.js";

function log(msg: string) {
  process.stderr.write(`[carbon] ${msg}\n`);
}

// ── Interfaces ──────────────────────────────────────────────────

export interface SupplyChainRoute {
  vendorId: string;
  vendorName: string;
  country: string;
  transportMode: "sea" | "air" | "rail" | "road";
  distanceKm: number;
  weightKg: number;
}

export interface CarbonBreakdown {
  transport: number;
  manufacturing: number;
  rawMaterial: number;
  packaging: number;
}

export interface SupplierCarbon {
  vendorId: string;
  vendorName: string;
  country: string;
  kgCO2e: number;
  transportMode: "sea" | "air" | "rail" | "road";
  distanceKm: number;
}

export interface CarbonScenario {
  name: string;
  totalKgCO2e: number;
  reduction: number;      // % reduction vs current
  costDelta: number;       // % cost difference
}

export interface CarbonFootprint {
  itemNo: string;
  totalKgCO2e: number;

  breakdown: CarbonBreakdown;
  bySupplier: SupplierCarbon[];

  scenarios?: CarbonScenario[];

  scope1: number;  // Direct emissions
  scope2: number;  // Purchased energy
  scope3: number;  // Supply chain (upstream)
}

// ── Emission Factor Tables ──────────────────────────────────────

/** kg CO2e per tonne-km by transport mode (DEFRA 2023 approximate) */
const TRANSPORT_EMISSION_FACTORS: Record<string, number> = {
  sea: 0.016,    // Container ship
  air: 0.602,    // Air freight
  rail: 0.028,   // Freight rail
  road: 0.105,   // HGV average
};

/** kg CO2e per kWh by country (energy grid mix, approximate) */
const GRID_EMISSION_FACTORS: Record<string, number> = {
  DE: 0.380, FR: 0.056, PL: 0.700, CZ: 0.450, SE: 0.013,
  NO: 0.008, CH: 0.012, AT: 0.090, NL: 0.340, DK: 0.120,
  FI: 0.070, GB: 0.210, US: 0.380, JP: 0.460, KR: 0.420,
  CN: 0.560, IN: 0.720, BR: 0.080, MX: 0.420, TR: 0.460,
  TH: 0.470, VN: 0.600, ID: 0.720, PH: 0.630, BD: 0.630,
  HU: 0.260, RO: 0.300, BG: 0.410, IT: 0.230, ES: 0.170,
};

/** Estimated manufacturing energy consumption per kg of output (kWh/kg) by sector */
const MFG_ENERGY_PER_KG = 2.5; // Generic manufacturing average

/** Raw material emission factor (kg CO2e per EUR of material cost, rough proxy) */
const RAW_MATERIAL_FACTOR = 0.5; // kg CO2e per EUR

/** Packaging emission factor (kg CO2e per kg product) */
const PACKAGING_FACTOR = 0.15;

// ── Main Function ───────────────────────────────────────────────

export function calculateCarbonFootprint(
  itemNo: string,
  bomComponents: BOMComponent[],
  supplyChainRoutes: SupplyChainRoute[],
  options?: { includeScenarios?: boolean },
): CarbonFootprint {
  let transportTotal = 0;
  let manufacturingTotal = 0;
  let rawMaterialTotal = 0;
  let packagingTotal = 0;
  const bySupplier: SupplierCarbon[] = [];

  // Calculate per-supplier emissions
  for (const route of supplyChainRoutes) {
    // Transport emissions
    const tonnage = route.weightKg / 1000;
    const factor = TRANSPORT_EMISSION_FACTORS[route.transportMode] ?? TRANSPORT_EMISSION_FACTORS.road;
    const transportEmission = tonnage * route.distanceKm * factor;
    transportTotal += transportEmission;

    // Manufacturing emissions (based on country energy mix)
    const gridFactor = GRID_EMISSION_FACTORS[route.country] ?? 0.4;
    const mfgEmission = route.weightKg * MFG_ENERGY_PER_KG * gridFactor;
    manufacturingTotal += mfgEmission;

    bySupplier.push({
      vendorId: route.vendorId,
      vendorName: route.vendorName,
      country: route.country,
      kgCO2e: Math.round((transportEmission + mfgEmission) * 100) / 100,
      transportMode: route.transportMode,
      distanceKm: route.distanceKm,
    });
  }

  // Raw material emissions (based on BOM cost as proxy)
  for (const comp of bomComponents) {
    rawMaterialTotal += comp.unitCost * comp.quantityPer * RAW_MATERIAL_FACTOR;
  }

  // Packaging (simplified)
  const totalWeight = supplyChainRoutes.reduce((s, r) => s + r.weightKg, 0);
  packagingTotal = totalWeight * PACKAGING_FACTOR;

  const totalKgCO2e = Math.round((transportTotal + manufacturingTotal + rawMaterialTotal + packagingTotal) * 100) / 100;

  // Scope breakdown
  const scope1 = Math.round(manufacturingTotal * 0.1 * 100) / 100;  // ~10% direct
  const scope2 = Math.round(manufacturingTotal * 0.9 * 100) / 100;  // ~90% energy
  const scope3 = Math.round((transportTotal + rawMaterialTotal + packagingTotal) * 100) / 100;

  // Scenarios
  let scenarios: CarbonScenario[] | undefined;
  if (options?.includeScenarios) {
    scenarios = generateScenarios(supplyChainRoutes, bomComponents, totalKgCO2e);
  }

  const result: CarbonFootprint = {
    itemNo,
    totalKgCO2e,
    breakdown: {
      transport: Math.round(transportTotal * 100) / 100,
      manufacturing: Math.round(manufacturingTotal * 100) / 100,
      rawMaterial: Math.round(rawMaterialTotal * 100) / 100,
      packaging: Math.round(packagingTotal * 100) / 100,
    },
    bySupplier: bySupplier.sort((a, b) => b.kgCO2e - a.kgCO2e),
    scenarios,
    scope1,
    scope2,
    scope3,
  };

  log(`carbon footprint for ${itemNo}: ${totalKgCO2e} kg CO2e (transport=${Math.round(transportTotal)}, mfg=${Math.round(manufacturingTotal)})`);
  return result;
}

// ── Scenario Generation ─────────────────────────────────────────

const EU_COUNTRY_CODES = new Set(["DE", "FR", "PL", "CZ", "AT", "NL", "SE", "IT", "ES", "DK", "FI", "HU", "RO", "BG"]);

function calcReduction(currentTotal: number, scenarioTotal: number): number {
  if (currentTotal <= 0) return 0;
  return Math.round(((currentTotal - scenarioTotal) / currentTotal) * 100);
}

function generateScenarios(
  routes: SupplyChainRoute[],
  bom: BOMComponent[],
  currentTotal: number,
): CarbonScenario[] {
  const scenarios: CarbonScenario[] = [];

  // Scenario 1: Switch all air freight to sea
  const hasAir = routes.some((r) => r.transportMode === "air");
  if (hasAir) {
    const adjusted = routes.map((r) =>
      r.transportMode === "air" ? { ...r, transportMode: "sea" as const, distanceKm: r.distanceKm * 1.3 } : r,
    );
    const result = calculateCarbonFootprint("scenario", bom, adjusted);
    scenarios.push({
      name: "Switch air freight to sea",
      totalKgCO2e: result.totalKgCO2e,
      reduction: calcReduction(currentTotal, result.totalKgCO2e),
      costDelta: -5, // Sea is cheaper
    });
  }

  // Scenario 2: Nearshoring to Poland (EU, moderate cost)
  const nonEU = routes.filter((r) => !EU_COUNTRY_CODES.has(r.country));
  if (nonEU.length > 0) {
    const adjusted = routes.map((r) =>
      !EU_COUNTRY_CODES.has(r.country)
        ? { ...r, country: "PL", distanceKm: 800, transportMode: "road" as const }
        : r,
    );
    const result = calculateCarbonFootprint("scenario", bom, adjusted);
    scenarios.push({
      name: "Nearshoring to Poland",
      totalKgCO2e: result.totalKgCO2e,
      reduction: calcReduction(currentTotal, result.totalKgCO2e),
      costDelta: 15, // Higher labor cost
    });
  }

  // Scenario 3: Rail instead of road (EU suppliers)
  const hasRoad = routes.some((r) => r.transportMode === "road");
  if (hasRoad) {
    const adjusted = routes.map((r) =>
      r.transportMode === "road" ? { ...r, transportMode: "rail" as const } : r,
    );
    const result = calculateCarbonFootprint("scenario", bom, adjusted);
    scenarios.push({
      name: "Switch road to rail",
      totalKgCO2e: result.totalKgCO2e,
      reduction: calcReduction(currentTotal, result.totalKgCO2e),
      costDelta: 2,
    });
  }

  return scenarios;
}
