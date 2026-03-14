/**
 * SMED (Single-Minute Exchange of Die) Hotspot Analysis
 *
 * Identifies work centers where setup time reduction yields the
 * greatest capacity gains. Prioritizes by impact × utilization.
 */

import type { RoutingStep, WorkCenterData } from "../erp/types.js";
import type { WorkCenter, CapacityLoad } from "./types.js";

function log(msg: string) {
  process.stderr.write(`[smed-analysis] ${msg}\n`);
}

export interface SMEDCandidate {
  workCenterId: string;
  workCenterName: string;

  // Current setup metrics
  avgSetupTimeMinutes: number;
  totalSetupTimePerWeek: number;
  setupFrequencyPerWeek: number;
  setupTimeAsPercentOfCapacity: number;

  // Impact analysis
  currentUtilization: number;
  capacityGainAt50Percent: number;   // minutes/week at 50% reduction
  capacityGainAt75Percent: number;
  additionalUnitsAt50Percent: number;

  // Prioritization
  priorityScore: number;             // 0–100
  priorityRank: number;

  // Classification
  classification: "quick_win" | "medium_effort" | "major_project";
  rationale: string;

  // Affected products
  affectedItems: Array<{ itemNo: string; itemName: string; setupTimeMinutes: number }>;
}

export interface SMEDOptions {
  top?: number;
  minSetupMinutes?: number;
}

/**
 * Analyze setup time reduction opportunities across all work centers.
 */
export function analyzeSMEDOpportunities(
  routingSteps: RoutingStep[],
  workCenters: WorkCenter[],
  capacityLoads: CapacityLoad[],
  options?: SMEDOptions,
): SMEDCandidate[] {
  const top = options?.top ?? 10;
  const minSetup = options?.minSetupMinutes ?? 5;

  const wcMap = new Map(workCenters.map((wc) => [wc.id, wc]));
  const capMap = new Map(capacityLoads.map((cl) => [cl.workCenterId, cl]));

  // Group routing steps by work center
  const wcSteps = new Map<string, RoutingStep[]>();
  for (const step of routingSteps) {
    const arr = wcSteps.get(step.workCenterNo) ?? [];
    arr.push(step);
    wcSteps.set(step.workCenterNo, arr);
  }

  const candidates: SMEDCandidate[] = [];

  for (const [wcId, steps] of wcSteps) {
    const wc = wcMap.get(wcId);
    if (!wc) continue;

    // Calculate setup metrics
    const setupTimes = steps.map((s) => s.setupTimeMinutes).filter((t) => t > 0);
    if (setupTimes.length === 0) continue;

    const avgSetupTime = setupTimes.reduce((a, b) => a + b, 0) / setupTimes.length;
    if (avgSetupTime < minSetup) continue;

    // Estimate weekly frequency (assume each routing step runs once per week as baseline)
    const setupFrequencyPerWeek = setupTimes.length;
    const totalSetupPerWeek = setupTimes.reduce((a, b) => a + b, 0);

    // Weekly capacity
    const daysPerWeek = wc.workingDaysPerWeek ?? 5;
    const weeklyCapacity = wc.capacityMinutesPerDay * wc.efficiency * wc.unitCount * daysPerWeek;
    const setupPercent = weeklyCapacity > 0
      ? Math.round((totalSetupPerWeek / weeklyCapacity) * 100)
      : 0;

    // Utilization from capacity loads
    const cap = capMap.get(wcId);
    const utilization = cap?.averageUtilization ?? 0;

    // Capacity gains
    const gain50 = Math.round(totalSetupPerWeek * 0.5);
    const gain75 = Math.round(totalSetupPerWeek * 0.75);

    // Additional units (using average run time per step)
    const avgRunTime = steps.reduce((s, st) => s + st.runTimeMinutes, 0) / steps.length;
    const additionalUnits50 = avgRunTime > 0 ? Math.round(gain50 / avgRunTime) : 0;

    // Priority score: higher when both utilization and setup % are high
    const priorityScore = Math.min(100, Math.round(
      (setupPercent * 0.4) + (utilization * 0.4) + (avgSetupTime > 60 ? 20 : avgSetupTime > 30 ? 10 : 0),
    ));

    // Classification
    let classification: SMEDCandidate["classification"];
    let rationale: string;
    if (avgSetupTime <= 30) {
      classification = "quick_win";
      rationale = `Average setup ${Math.round(avgSetupTime)}min — standard SMED workshop (2-3 days) likely sufficient`;
    } else if (avgSetupTime <= 120) {
      classification = "medium_effort";
      rationale = `Average setup ${Math.round(avgSetupTime)}min — requires tooling changes and process redesign`;
    } else {
      classification = "major_project";
      rationale = `Average setup ${Math.round(avgSetupTime)}min — major equipment/fixture investment needed`;
    }

    // Affected items
    const affectedItems = steps
      .filter((s) => s.setupTimeMinutes > 0)
      .map((s) => ({
        itemNo: s.operationNo, // Best available identifier
        itemName: s.description,
        setupTimeMinutes: s.setupTimeMinutes,
      }));

    candidates.push({
      workCenterId: wcId,
      workCenterName: wc.name,
      avgSetupTimeMinutes: Math.round(avgSetupTime * 10) / 10,
      totalSetupTimePerWeek: totalSetupPerWeek,
      setupFrequencyPerWeek,
      setupTimeAsPercentOfCapacity: setupPercent,
      currentUtilization: utilization,
      capacityGainAt50Percent: gain50,
      capacityGainAt75Percent: gain75,
      additionalUnitsAt50Percent: additionalUnits50,
      priorityScore,
      priorityRank: 0, // Set after sorting
      classification,
      rationale,
      affectedItems,
    });
  }

  // Sort by priority score descending
  candidates.sort((a, b) => b.priorityScore - a.priorityScore);

  // Assign ranks
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].priorityRank = i + 1;
  }

  log(`analyzed ${candidates.length} SMED candidates, top priority: ${candidates[0]?.workCenterName ?? "none"}`);
  return candidates.slice(0, top);
}
