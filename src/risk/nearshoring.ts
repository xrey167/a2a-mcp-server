/**
 * Nearshoring / Reshoring Analysis
 *
 * Multi-dimensional comparison of current vs. alternative sourcing
 * locations. Integrates ESG scores, carbon footprint, and OSINT
 * geopolitical risk data.
 */

function log(msg: string) {
  process.stderr.write(`[nearshoring] ${msg}\n`);
}

export interface CurrentSupplier {
  vendorId: string;
  vendorName: string;
  country: string;
  region: string;
  unitCost: number;
  leadTimeDays: number;
  transportMode: "sea" | "air" | "rail" | "road";
  distanceKm: number;
}

export interface TargetCountryData {
  country: string;
  region: string;
  laborCostIndex: number;         // Relative to current (100 = same)
  qualityIndex: number;            // 0-100
  ipProtectionScore: number;       // 0-100
  esgScore?: number;               // From ESG module
  carbonFootprint?: number;        // kg CO2e from carbon module
  geopoliticalRisk?: number;       // From OSINT signal agent
}

export interface NearshoringComparison {
  dimension: string;
  current: string | number;
  proposed: string | number;
  delta: string;
  advantage: "current" | "proposed" | "neutral";
}

export interface NearshoringScenario {
  name: string;
  targetCountry: string;
  targetRegion: string;

  comparison: NearshoringComparison[];

  // Individual dimensions
  laborCostIndex: number;
  transportCost: number;
  transportTimeDays: number;
  geopoliticalRisk: number;
  esgScore: number;
  carbonFootprint: number;
  qualityIndex: number;
  ipProtectionScore: number;

  // Aggregated
  tcoComparison: number;           // % vs current (+/-)
  riskComparison: number;          // % risk reduction
  overallRecommendation: "strongly_recommended" | "recommended" | "neutral" | "not_recommended";
  rationale: string;
}

// ── Static Data ─────────────────────────────────────────────────

const LABOR_COST_INDEX: Record<string, number> = {
  DE: 100, CH: 130, AT: 95, NL: 98, SE: 105, NO: 120, DK: 110,
  FI: 95, FR: 90, US: 85, GB: 80, JP: 80, KR: 60, CN: 30,
  IN: 15, BR: 25, MX: 20, PL: 35, CZ: 40, HU: 30, RO: 25,
  BG: 20, TR: 20, TH: 18, VN: 12, ID: 12, PH: 10, BD: 8,
  IT: 75, ES: 60, PT: 45, SK: 38, SI: 50, HR: 30, RS: 22,
};

const QUALITY_INDEX: Record<string, number> = {
  DE: 95, CH: 95, AT: 90, NL: 90, SE: 92, JP: 93, KR: 85,
  US: 88, GB: 85, FR: 85, IT: 82, ES: 78, PL: 75, CZ: 80,
  HU: 72, RO: 65, CN: 70, IN: 55, BR: 60, MX: 58, TR: 62,
  TH: 65, VN: 58, ID: 52, PH: 50, BD: 42, BG: 60, SK: 75,
};

const IP_PROTECTION: Record<string, number> = {
  DE: 90, CH: 92, AT: 88, NL: 90, SE: 90, US: 85, JP: 88,
  KR: 80, GB: 88, FR: 85, IT: 75, ES: 75, PL: 70, CZ: 72,
  HU: 65, RO: 55, CN: 40, IN: 45, BR: 45, MX: 40, TR: 45,
  TH: 50, VN: 35, ID: 35, PH: 35, BD: 30, BG: 55, SK: 68,
};

// Approximate transport distances from Germany (km)
const DISTANCE_FROM_DE: Record<string, number> = {
  PL: 600, CZ: 350, AT: 400, HU: 850, RO: 1500, BG: 1800,
  FR: 800, NL: 400, IT: 1000, ES: 1800, PT: 2200, SK: 600,
  TR: 2500, CN: 8500, IN: 7000, VN: 9000, TH: 8500, BD: 7500,
  US: 7500, JP: 9500, KR: 8500, MX: 9500, BR: 10000, ID: 11000,
  GB: 800, SE: 1200, DK: 600, NO: 1500, FI: 1800, CH: 500,
};

// ── Main Function ───────────────────────────────────────────────

export function evaluateNearshoring(
  currentSupplier: CurrentSupplier,
  targetCountries: TargetCountryData[],
): NearshoringScenario[] {
  const scenarios: NearshoringScenario[] = [];

  for (const target of targetCountries) {
    const laborCost = LABOR_COST_INDEX[target.country] ?? 50;
    const currentLaborCost = LABOR_COST_INDEX[currentSupplier.country] ?? 50;
    const laborCostIndex = Math.round((laborCost / currentLaborCost) * 100);

    const distanceKm = DISTANCE_FROM_DE[target.country] ?? 5000;
    const currentDistance = currentSupplier.distanceKm;

    // Transport cost estimate (relative, road from DE)
    const transportCost = Math.round(distanceKm * 0.05); // ~€0.05/km simplified
    const currentTransportCost = Math.round(currentDistance * 0.05);

    // Transport time estimate (road: ~60km/h average including stops)
    const transportTimeDays = Math.round(distanceKm / (60 * 10)); // 10h driving/day
    const currentTransportDays = Math.round(currentDistance / (60 * 10));

    const quality = target.qualityIndex ?? QUALITY_INDEX[target.country] ?? 60;
    const currentQuality = QUALITY_INDEX[currentSupplier.country] ?? 70;

    const ip = target.ipProtectionScore ?? IP_PROTECTION[target.country] ?? 50;
    const currentIP = IP_PROTECTION[currentSupplier.country] ?? 50;

    const esgScore = target.esgScore ?? 60;
    const geopoliticalRisk = target.geopoliticalRisk ?? 30;
    const carbonFootprint = target.carbonFootprint ?? (distanceKm * 0.016 * 10); // rough estimate

    // TCO comparison (weighted)
    const unitCostFactor = laborCostIndex / 100;
    const tcoComparison = Math.round(
      (unitCostFactor * 0.5 +
        (transportCost / Math.max(1, currentTransportCost)) * 0.15 +
        (1 - quality / 100) * 0.15 +
        (1 - ip / 100) * 0.1 +
        (geopoliticalRisk / 100) * 0.1) * 100 - 100,
    );

    // Risk comparison
    const currentRisk = (100 - currentQuality) * 0.3 + geopoliticalRisk * 0.4 + (100 - currentIP) * 0.3;
    const proposedRisk = (100 - quality) * 0.3 + geopoliticalRisk * 0.4 + (100 - ip) * 0.3;
    const riskComparison = Math.round(((currentRisk - proposedRisk) / Math.max(1, currentRisk)) * 100);

    // Build comparison table
    const comparison: NearshoringComparison[] = [
      { dimension: "Labor Cost Index", current: currentLaborCost, proposed: laborCost, delta: `${laborCostIndex > 100 ? "+" : ""}${laborCostIndex - 100}%`, advantage: laborCost < currentLaborCost ? "proposed" : laborCost > currentLaborCost ? "current" : "neutral" },
      { dimension: "Transport Distance (km)", current: currentDistance, proposed: distanceKm, delta: `${distanceKm < currentDistance ? "-" : "+"}${Math.abs(distanceKm - currentDistance)}km`, advantage: distanceKm < currentDistance ? "proposed" : "current" },
      { dimension: "Transport Time (days)", current: currentTransportDays, proposed: transportTimeDays, delta: `${transportTimeDays - currentTransportDays} days`, advantage: transportTimeDays < currentTransportDays ? "proposed" : transportTimeDays > currentTransportDays ? "current" : "neutral" },
      { dimension: "Quality Index", current: currentQuality, proposed: quality, delta: `${quality - currentQuality}`, advantage: quality > currentQuality ? "proposed" : quality < currentQuality ? "current" : "neutral" },
      { dimension: "IP Protection", current: currentIP, proposed: ip, delta: `${ip - currentIP}`, advantage: ip > currentIP ? "proposed" : ip < currentIP ? "current" : "neutral" },
      { dimension: "Geopolitical Risk", current: "varies", proposed: geopoliticalRisk, delta: `${geopoliticalRisk}%`, advantage: geopoliticalRisk < 30 ? "proposed" : geopoliticalRisk > 60 ? "current" : "neutral" },
      { dimension: "ESG Score", current: "varies", proposed: esgScore, delta: `${esgScore}/100`, advantage: esgScore > 70 ? "proposed" : esgScore < 50 ? "current" : "neutral" },
    ];

    // Recommendation
    let recommendation: NearshoringScenario["overallRecommendation"];
    let rationale: string;

    const advantages = comparison.filter((c) => c.advantage === "proposed").length;
    const disadvantages = comparison.filter((c) => c.advantage === "current").length;

    if (advantages >= 5 && tcoComparison < -10) {
      recommendation = "strongly_recommended";
      rationale = `${target.country} offers superior metrics in ${advantages} of ${comparison.length} dimensions with ${Math.abs(tcoComparison)}% TCO reduction`;
    } else if (advantages >= 4 && tcoComparison <= 5) {
      recommendation = "recommended";
      rationale = `${target.country} is favorable in ${advantages} dimensions with acceptable TCO impact`;
    } else if (advantages >= disadvantages) {
      recommendation = "neutral";
      rationale = `${target.country} shows mixed results — further analysis recommended`;
    } else {
      recommendation = "not_recommended";
      rationale = `${target.country} underperforms in ${disadvantages} dimensions — current sourcing preferred`;
    }

    scenarios.push({
      name: `Nearshoring to ${target.country} (${target.region})`,
      targetCountry: target.country,
      targetRegion: target.region,
      comparison,
      laborCostIndex,
      transportCost,
      transportTimeDays,
      geopoliticalRisk,
      esgScore,
      carbonFootprint,
      qualityIndex: quality,
      ipProtectionScore: ip,
      tcoComparison,
      riskComparison,
      overallRecommendation: recommendation,
      rationale,
    });
  }

  scenarios.sort((a, b) => {
    const order = { strongly_recommended: 0, recommended: 1, neutral: 2, not_recommended: 3 };
    return order[a.overallRecommendation] - order[b.overallRecommendation];
  });

  log(`evaluated ${scenarios.length} nearshoring scenarios, best: ${scenarios[0]?.targetCountry ?? "none"}`);
  return scenarios;
}
