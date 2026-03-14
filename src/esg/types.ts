/**
 * ESG (Environmental, Social, Governance) Types
 */

export interface ESGEnvironmental {
  score: number;                 // 0-100
  climateRiskExposure: number;
  carbonIntensityEstimate: "low" | "medium" | "high";
  waterStressLevel: "low" | "medium" | "high" | "unknown";
  details: string[];
}

export interface ESGSocial {
  score: number;
  conflictExposure: number;
  laborRightsIndex: "strong" | "moderate" | "weak" | "unknown";
  humanDevelopmentIndex: number;
  details: string[];
}

export interface ESGGovernance {
  score: number;
  corruptionPerceptionIndex: number;
  politicalStabilityIndex: number;
  ruleOfLawIndex: number;
  regulatoryQuality: number;
  details: string[];
}

export type ESGRating = "AAA" | "AA" | "A" | "BBB" | "BB" | "B" | "CCC" | "CC" | "C";

export interface ESGScore {
  entityId: string;
  entityType: "supplier" | "region" | "product";
  entityName: string;

  environmental: ESGEnvironmental;
  social: ESGSocial;
  governance: ESGGovernance;

  overallScore: number;          // Weighted average (E:40%, S:30%, G:30%)
  rating: ESGRating;
  trend: "improving" | "stable" | "declining";

  // Regulatory relevance
  csrdRelevant: boolean;         // EU Corporate Sustainability Reporting Directive
  supplyChainDueDiligence: boolean; // German LkSG / EU CSDDD

  assessedAt: string;
}

export interface ESGWeights {
  environmental: number;
  social: number;
  governance: number;
}

export const DEFAULT_ESG_WEIGHTS: ESGWeights = {
  environmental: 0.4,
  social: 0.3,
  governance: 0.3,
};

export interface ESGPortfolioOverview {
  totalEntities: number;
  averageScore: number;
  ratingDistribution: Record<ESGRating, number>;
  worstPerformers: ESGScore[];
  bestPerformers: ESGScore[];
  csrdRelevantCount: number;
  lksgRelevantCount: number;
}

export interface ESGGap {
  entityId: string;
  entityName: string;
  dimension: "environmental" | "social" | "governance";
  currentScore: number;
  targetScore: number;
  gap: number;
  recommendation: string;
  priority: "high" | "medium" | "low";
}
