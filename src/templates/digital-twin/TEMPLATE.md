# Digital Twin Template

**Pipeline**: digital-twin
**Category**: Manufacturing / Industry 4.0
**Stack**: TypeScript, Bun, MQTT, SQLite, D3.js

---

## Description

A manufacturing digital twin system that ingests IoT sensor data, runs physics-based or ML models to simulate asset behavior, detects anomalies, and provides real-time monitoring dashboards. Designed for production lines, CNC machines, assembly cells, and other industrial assets.

---

## Pre-Configured Features

- MQTT data ingestion with configurable topics and sample rates
- Time-series data storage in SQLite with automatic partitioning
- Physics-based simulation engine with extensible model interface
- Anomaly detection with configurable thresholds and severity levels
- OEE (Overall Equipment Effectiveness) calculation
- Real-time dashboard with gauge, time-series, and heatmap panels
- REST API for data queries and model management

---

## Project Structure

```
src/
  model.ts        — Asset model definitions and physics engine
  simulation.ts   — Simulation runner and state management
  ingestion.ts    — MQTT/REST data ingestion pipeline
  anomaly.ts      — Anomaly detection rules engine
  dashboard.ts    — Dashboard data API
  db.ts           — SQLite time-series storage
  index.ts        — Entry point
```

---

## Getting Started

```bash
bun install
bun run src/index.ts
```
