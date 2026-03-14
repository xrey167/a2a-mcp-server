/**
 * ESG Scoring Engine
 *
 * Calculates ESG scores from OSINT agent data:
 *   - Environmental: climate agent (assess_exposure, climate_anomalies)
 *   - Social: monitor agent (track_conflicts) + signal agent (instability_index)
 *   - Governance: signal agent (classify_threat, baseline_compare)
 *
 * Each dimension scored 0-100 where 100 = best rating.
 */

import type {
  ESGScore,
  ESGRating,
  ESGEnvironmental,
  ESGSocial,
  ESGGovernance,
  ESGWeights,
  ESGPortfolioOverview,
  ESGGap,
  DEFAULT_ESG_WEIGHTS,
} from "./types.js";

function log(msg: string) {
  process.stderr.write(`[esg-scoring] ${msg}\n`);
}

// ── Agent Data Interfaces ───────────────────────────────────────

export interface EnvironmentalAgentData {
  /** Climate risk exposure score from climate agent (0-100, higher = more risk) */
  exposureScore?: number;
  /** Number of natural events in the region */
  naturalEventCount?: number;
  /** Climate anomaly severity */
  anomalySeverity?: "none" | "low" | "medium" | "high";
  /** Country for energy mix lookup */
  country?: string;
}

export interface SocialAgentData {
  /** Number of active conflicts from monitor agent */
  activeConflicts?: number;
  /** Instability index from signal agent (0-100, higher = more unstable) */
  instabilityIndex?: number;
  /** Surge level from monitor agent */
  surgeLevel?: "none" | "low" | "medium" | "high";
  /** Country for HDI lookup */
  country?: string;
}

export interface GovernanceAgentData {
  /** Threat classification from signal agent */
  threatLevel?: "none" | "low" | "medium" | "high" | "critical";
  /** Baseline deviation from signal agent (-100 to +100) */
  baselineDeviation?: number;
  /** Country for governance indices lookup */
  country?: string;
}

export interface AgentData {
  environmental?: EnvironmentalAgentData;
  social?: SocialAgentData;
  governance?: GovernanceAgentData;
}

// ── Static Data ─────────────────────────────────────────────────

// HDI approximate values by country (0-1 scale)
const HDI_BY_COUNTRY: Record<string, number> = {
  DE: 0.942, CH: 0.962, AT: 0.916, NL: 0.941, SE: 0.947,
  NO: 0.961, DK: 0.948, FI: 0.940, FR: 0.903, US: 0.921,
  GB: 0.929, JP: 0.925, KR: 0.925, CN: 0.768, IN: 0.633,
  BR: 0.754, MX: 0.758, PL: 0.876, CZ: 0.889, HU: 0.846,
  RO: 0.821, BG: 0.795, TR: 0.838, TH: 0.800, VN: 0.726,
  ID: 0.713, PH: 0.699, BD: 0.614, PK: 0.544, ET: 0.498,
};

// Corruption Perception Index (0-100, higher = less corrupt)
const CPI_BY_COUNTRY: Record<string, number> = {
  DE: 79, CH: 82, AT: 74, NL: 80, SE: 83, NO: 84, DK: 90,
  FI: 87, FR: 72, US: 69, GB: 73, JP: 73, KR: 63, CN: 45,
  IN: 40, BR: 38, MX: 31, PL: 55, CZ: 56, HU: 42, RO: 46,
  BG: 43, TR: 36, TH: 36, VN: 42, ID: 34, PH: 33, BD: 25,
};

// Political stability index (0-100, higher = more stable)
const STABILITY_BY_COUNTRY: Record<string, number> = {
  DE: 75, CH: 90, AT: 80, NL: 80, SE: 85, NO: 88, DK: 82,
  FI: 85, FR: 60, US: 55, GB: 65, JP: 82, KR: 55, CN: 50,
  IN: 35, BR: 30, MX: 25, PL: 60, CZ: 70, HU: 50, RO: 55,
  BG: 50, TR: 25, TH: 35, VN: 55, ID: 45, PH: 30, BD: 25,
};

// Carbon intensity categories by country
const CARBON_INTENSITY: Record<string, "low" | "medium" | "high"> = {
  SE: "low", NO: "low", CH: "low", FR: "low", FI: "low", AT: "low",
  DE: "medium", GB: "medium", US: "medium", JP: "medium", KR: "medium",
  DK: "low", NL: "medium", PL: "high", CZ: "high", CN: "high",
  IN: "high", BR: "medium", MX: "medium", TR: "high", ID: "high",
};

// ── Scoring Functions ───────────────────────────────────────────

export function scoreEnvironmental(data: EnvironmentalAgentData): ESGEnvironmental {
  const details: string[] = [];
  let score = 80; // Start at good baseline

  // Climate risk exposure (from climate agent)
  const exposure = data.exposureScore ?? 20;
  score -= Math.round(exposure * 0.3);
  if (exposure > 60) details.push("High climate risk exposure");

  // Natural events
  if (data.naturalEventCount !== undefined) {
    if (data.naturalEventCount > 5) { score -= 15; details.push(`${data.naturalEventCount} natural events recorded`); }
    else if (data.naturalEventCount > 2) { score -= 8; }
  }

  // Anomaly severity
  if (data.anomalySeverity === "high") { score -= 15; details.push("Severe climate anomalies detected"); }
  else if (data.anomalySeverity === "medium") { score -= 8; }

  // Carbon intensity by country
  const country = data.country ?? "unknown";
  const carbonIntensity = CARBON_INTENSITY[country] ?? "medium";
  if (carbonIntensity === "high") { score -= 10; details.push(`High carbon intensity (${country})`); }
  else if (carbonIntensity === "low") { score += 5; }

  const waterStress = exposure > 50 ? "high" : exposure > 25 ? "medium" : "low";

  return {
    score: clamp(score),
    climateRiskExposure: exposure,
    carbonIntensityEstimate: carbonIntensity,
    waterStressLevel: waterStress,
    details,
  };
}

export function scoreSocial(data: SocialAgentData): ESGSocial {
  const details: string[] = [];
  let score = 80;

  // Conflict exposure (from monitor agent)
  const conflicts = data.activeConflicts ?? 0;
  if (conflicts > 3) { score -= 30; details.push(`${conflicts} active conflicts in region`); }
  else if (conflicts > 1) { score -= 15; details.push(`${conflicts} active conflicts nearby`); }
  else if (conflicts === 1) { score -= 5; }

  // Instability index (from signal agent)
  const instability = data.instabilityIndex ?? 30;
  score -= Math.round(instability * 0.3);
  if (instability > 60) details.push("High regional instability");

  // Surge level
  if (data.surgeLevel === "high") { score -= 15; details.push("Active conflict surge"); }
  else if (data.surgeLevel === "medium") { score -= 8; }

  // HDI by country
  const country = data.country ?? "unknown";
  const hdi = HDI_BY_COUNTRY[country] ?? 0.7;
  if (hdi < 0.6) { score -= 15; details.push(`Low HDI (${hdi.toFixed(3)})`); }
  else if (hdi < 0.7) { score -= 8; }
  else if (hdi > 0.9) { score += 5; }

  const laborRights: ESGSocial["laborRightsIndex"] = hdi > 0.85 ? "strong" : hdi > 0.7 ? "moderate" : "weak";

  return {
    score: clamp(score),
    conflictExposure: conflicts,
    laborRightsIndex: laborRights,
    humanDevelopmentIndex: hdi,
    details,
  };
}

export function scoreGovernance(data: GovernanceAgentData): ESGGovernance {
  const details: string[] = [];
  let score = 80;

  // Threat level (from signal agent)
  const threatPenalty: Record<string, number> = { none: 0, low: 5, medium: 15, high: 25, critical: 40 };
  const threat = data.threatLevel ?? "low";
  score -= threatPenalty[threat] ?? 10;
  if (threat === "high" || threat === "critical") details.push(`Governance threat level: ${threat}`);

  // Baseline deviation
  const deviation = data.baselineDeviation ?? 0;
  if (deviation > 20) { score -= 15; details.push("Significant governance baseline deviation"); }
  else if (deviation > 10) { score -= 8; }

  // Country indices
  const country = data.country ?? "unknown";
  const cpi = CPI_BY_COUNTRY[country] ?? 50;
  const stability = STABILITY_BY_COUNTRY[country] ?? 50;

  if (cpi < 40) { score -= 15; details.push(`High corruption risk (CPI: ${cpi})`); }
  else if (cpi < 55) { score -= 8; }

  if (stability < 40) { score -= 10; details.push(`Political instability (index: ${stability})`); }

  return {
    score: clamp(score),
    corruptionPerceptionIndex: cpi,
    politicalStabilityIndex: stability,
    ruleOfLawIndex: Math.round((cpi + stability) / 2),
    regulatoryQuality: Math.round(cpi * 0.8 + stability * 0.2),
    details,
  };
}

// ── Aggregate Scoring ───────────────────────────────────────────

const defaultWeights: ESGWeights = { environmental: 0.4, social: 0.3, governance: 0.3 };

export function calculateESGScore(
  entityId: string,
  entityType: ESGScore["entityType"],
  entityName: string,
  agentData: AgentData,
  weights?: Partial<ESGWeights>,
): ESGScore {
  const w = { ...defaultWeights, ...weights };

  const environmental = scoreEnvironmental(agentData.environmental ?? {});
  const social = scoreSocial(agentData.social ?? {});
  const governance = scoreGovernance(agentData.governance ?? {});

  const overallScore = Math.round(
    environmental.score * w.environmental +
    social.score * w.social +
    governance.score * w.governance,
  );

  const rating = scoreToRating(overallScore);

  // Determine trend (simplified: based on data quality)
  const trend: ESGScore["trend"] = "stable";

  // Regulatory flags
  const csrdRelevant = overallScore < 70;
  const supplyChainDueDiligence = social.score < 60 || governance.score < 50;

  const result: ESGScore = {
    entityId,
    entityType,
    entityName,
    environmental,
    social,
    governance,
    overallScore,
    rating,
    trend,
    csrdRelevant,
    supplyChainDueDiligence,
    assessedAt: new Date().toISOString(),
  };

  log(`ESG score for ${entityName}: ${overallScore} (${rating}), E=${environmental.score} S=${social.score} G=${governance.score}`);
  return result;
}

export function calculatePortfolioESG(scores: ESGScore[]): ESGPortfolioOverview {
  if (scores.length === 0) {
    return {
      totalEntities: 0,
      averageScore: 0,
      ratingDistribution: { AAA: 0, AA: 0, A: 0, BBB: 0, BB: 0, B: 0, CCC: 0, CC: 0, C: 0 },
      worstPerformers: [],
      bestPerformers: [],
      csrdRelevantCount: 0,
      lksgRelevantCount: 0,
    };
  }

  const sorted = [...scores].sort((a, b) => a.overallScore - b.overallScore);
  const ratingDist: Record<ESGRating, number> = { AAA: 0, AA: 0, A: 0, BBB: 0, BB: 0, B: 0, CCC: 0, CC: 0, C: 0 };
  for (const s of scores) ratingDist[s.rating]++;

  return {
    totalEntities: scores.length,
    averageScore: Math.round(scores.reduce((s, e) => s + e.overallScore, 0) / scores.length),
    ratingDistribution: ratingDist,
    worstPerformers: sorted.slice(0, 5),
    bestPerformers: sorted.slice(-5).reverse(),
    csrdRelevantCount: scores.filter((s) => s.csrdRelevant).length,
    lksgRelevantCount: scores.filter((s) => s.supplyChainDueDiligence).length,
  };
}

export function identifyESGGaps(
  scores: ESGScore[],
  targetScore = 70,
): ESGGap[] {
  const gaps: ESGGap[] = [];

  for (const score of scores) {
    for (const dim of ["environmental", "social", "governance"] as const) {
      const current = score[dim].score;
      if (current < targetScore) {
        const gap = targetScore - current;
        gaps.push({
          entityId: score.entityId,
          entityName: score.entityName,
          dimension: dim,
          currentScore: current,
          targetScore,
          gap,
          recommendation: getGapRecommendation(dim, current),
          priority: gap > 30 ? "high" : gap > 15 ? "medium" : "low",
        });
      }
    }
  }

  return gaps.sort((a, b) => b.gap - a.gap);
}

// ── Helpers ─────────────────────────────────────────────────────

function clamp(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreToRating(score: number): ESGRating {
  if (score >= 90) return "AAA";
  if (score >= 80) return "AA";
  if (score >= 70) return "A";
  if (score >= 60) return "BBB";
  if (score >= 50) return "BB";
  if (score >= 40) return "B";
  if (score >= 30) return "CCC";
  if (score >= 20) return "CC";
  return "C";
}

function getGapRecommendation(dimension: string, score: number): string {
  switch (dimension) {
    case "environmental":
      return score < 40
        ? "Critical: Conduct environmental audit, assess climate adaptation measures, evaluate alternative suppliers"
        : "Improve: Request supplier environmental certifications, assess carbon reduction plans";
    case "social":
      return score < 40
        ? "Critical: Immediate supply chain due diligence audit, assess labor conditions, evaluate alternatives"
        : "Improve: Request social audits, verify labor standards compliance";
    case "governance":
      return score < 40
        ? "Critical: Enhanced due diligence, anti-corruption assessment, consider supplier replacement"
        : "Improve: Request governance certifications, verify compliance programs";
    default:
      return "General improvement needed";
  }
}
