/**
 * Digital Twin — Simulation Engine
 *
 * Runs physics/ML models against incoming sensor data,
 * evaluates anomaly rules, computes KPIs, and maintains
 * simulation state.
 */

import type { AssetModel, PhysicsModel, AnomalyRule, KPI, DataPoint } from "./model.js";

export interface SimulationState {
  assetId: string;
  tick: number;
  timestamp: number;
  sensorValues: Record<string, number>;
  modelOutputs: Record<string, Record<string, number>>;
  anomalies: AnomalyEvent[];
  kpiValues: Record<string, number>;
}

export interface AnomalyEvent {
  parameter: string;
  value: number;
  threshold: number;
  severity: "warning" | "critical";
  timestamp: number;
  message: string;
}

export class SimulationEngine {
  private state: SimulationState;
  private models: PhysicsModel[];
  private rules: AnomalyRule[];
  private kpis: KPI[];

  constructor(
    asset: AssetModel,
    models: PhysicsModel[],
    rules: AnomalyRule[],
    kpis: KPI[],
  ) {
    this.models = models;
    this.rules = rules;
    this.kpis = kpis;
    this.state = {
      assetId: asset.id,
      tick: 0,
      timestamp: Date.now(),
      sensorValues: {},
      modelOutputs: {},
      anomalies: [],
      kpiValues: {},
    };
  }

  /** Ingest a batch of sensor readings and advance simulation by one tick. */
  step(readings: Array<{ name: string; value: number; timestamp?: number }>): SimulationState {
    this.state.tick++;
    this.state.timestamp = Date.now();
    this.state.anomalies = [];

    // Update sensor values
    for (const r of readings) {
      this.state.sensorValues[r.name] = r.value;
    }

    // Run physics models
    for (const model of this.models) {
      const inputs: Record<string, number> = {};
      for (const inputName of model.inputs) {
        if (inputName in this.state.sensorValues) {
          inputs[inputName] = this.state.sensorValues[inputName];
        }
      }
      const outputs = model.compute(inputs);
      this.state.modelOutputs[model.name] = outputs;

      // Merge model outputs into sensor values for downstream use
      for (const [k, v] of Object.entries(outputs)) {
        this.state.sensorValues[k] = v;
      }
    }

    // Evaluate anomaly rules
    for (const rule of this.rules) {
      const value = this.state.sensorValues[rule.parameter];
      if (value === undefined) continue;

      let triggered = false;
      if (rule.condition === "above" && value > rule.threshold) triggered = true;
      if (rule.condition === "below" && value < rule.threshold) triggered = true;
      if (rule.condition === "outside_range" && (value < rule.threshold || value > (rule.upperThreshold ?? rule.threshold))) triggered = true;

      if (triggered) {
        this.state.anomalies.push({
          parameter: rule.parameter,
          value,
          threshold: rule.threshold,
          severity: rule.severity,
          timestamp: this.state.timestamp,
          message: `${rule.parameter} = ${value} ${rule.condition} threshold ${rule.threshold}`,
        });
      }
    }

    // Compute KPIs
    for (const kpi of this.kpis) {
      this.state.kpiValues[kpi.name] = kpi.compute(this.state.sensorValues);
    }

    return { ...this.state, anomalies: [...this.state.anomalies] };
  }

  /** Get current simulation state (read-only snapshot). */
  getState(): SimulationState {
    return { ...this.state, anomalies: [...this.state.anomalies] };
  }

  /** Reset simulation to initial state. */
  reset(): void {
    this.state.tick = 0;
    this.state.timestamp = Date.now();
    this.state.sensorValues = {};
    this.state.modelOutputs = {};
    this.state.anomalies = [];
    this.state.kpiValues = {};
  }
}
