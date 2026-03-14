/**
 * Digital Twin — Asset Model Layer
 *
 * Defines the asset hierarchy, data point schema, and physics-based
 * behavioral models for the digital twin.
 */

export interface DataPoint {
  name: string;
  unit: string;
  sampleRateHz: number;
  source: "plc" | "scada" | "mqtt" | "rest";
  value?: number;
  timestamp?: number;
}

export interface AssetModel {
  id: string;
  name: string;
  assetType: string;
  dataPoints: DataPoint[];
  children?: AssetModel[];
}

export interface PhysicsModel {
  name: string;
  type: "first-principles" | "ml" | "hybrid";
  inputs: string[];
  outputs: string[];
  compute: (inputs: Record<string, number>) => Record<string, number>;
}

export interface AnomalyRule {
  parameter: string;
  condition: "above" | "below" | "outside_range";
  threshold: number;
  upperThreshold?: number;
  severity: "warning" | "critical";
}

export interface KPI {
  name: string;
  formula: string;
  target: number;
  unit: string;
  compute: (data: Record<string, number>) => number;
}

// ── OEE Model (built-in) ────────────────────────────────────────

export function computeOEE(
  availability: number,
  performance: number,
  quality: number,
): { oee: number; availability: number; performance: number; quality: number } {
  return {
    oee: Math.round(availability * performance * quality * 10000) / 100,
    availability: Math.round(availability * 10000) / 100,
    performance: Math.round(performance * 10000) / 100,
    quality: Math.round(quality * 10000) / 100,
  };
}

// ── Thermal Model (example first-principles) ────────────────────

export const thermalModel: PhysicsModel = {
  name: "thermal-equilibrium",
  type: "first-principles",
  inputs: ["ambientTemp", "powerInput", "coolingRate"],
  outputs: ["steadyStateTemp", "timeConstant"],
  compute: (inputs) => {
    const { ambientTemp = 20, powerInput = 1000, coolingRate = 50 } = inputs;
    const steadyStateTemp = ambientTemp + powerInput / Math.max(1, coolingRate);
    const timeConstant = 1 / Math.max(0.01, coolingRate / 1000);
    return { steadyStateTemp: Math.round(steadyStateTemp * 10) / 10, timeConstant: Math.round(timeConstant * 10) / 10 };
  },
};

// ── Vibration Model (example) ───────────────────────────────────

export const vibrationModel: PhysicsModel = {
  name: "vibration-analysis",
  type: "first-principles",
  inputs: ["rpm", "bearingAge", "loadFactor"],
  outputs: ["expectedVibration", "remainingLife"],
  compute: (inputs) => {
    const { rpm = 1500, bearingAge = 0, loadFactor = 1 } = inputs;
    const baseVibration = rpm * 0.001 * loadFactor;
    const ageFactor = 1 + bearingAge * 0.0001;
    const expectedVibration = Math.round(baseVibration * ageFactor * 100) / 100;
    const remainingLife = Math.max(0, Math.round(10000 - bearingAge * loadFactor));
    return { expectedVibration, remainingLife };
  },
};
