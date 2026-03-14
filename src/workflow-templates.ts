// src/workflow-templates.ts
// Workflow playbook template loader and validator.
// Provides a static registry of built-in industry workflow playbooks
// and utilities to list, load, and validate them.

import type { WorkflowDefinition, WorkflowStep } from "./workflow-engine.js";

// ── Types ────────────────────────────────────────────────────────

export interface PlaybookMetadata {
  id: string;
  name: string;
  description: string;
  industry: string;
  category: string;
  estimatedDuration: string;
  prerequisites: string[];
  tags: string[];
}

export interface Playbook {
  metadata: PlaybookMetadata;
  workflow: WorkflowDefinition;
}

// ── Built-in Playbooks ──────────────────────────────────────────

const BUILTIN_PLAYBOOKS: Playbook[] = [
  // 1. Automotive PPAP
  {
    metadata: {
      id: "automotive-ppap",
      name: "Automotive PPAP (Production Part Approval Process)",
      description: "End-to-end PPAP submission workflow covering design records, process flow, FMEA, control plans, MSA, capability studies, and final PSW assembly.",
      industry: "automotive",
      category: "quality",
      estimatedDuration: "5-10 business days",
      prerequisites: ["Part drawings available", "Supplier selected", "GD&T specs confirmed"],
      tags: ["ppap", "iatf-16949", "quality", "supplier", "automotive"],
    },
    workflow: {
      id: "automotive-ppap",
      name: "Automotive PPAP Submission",
      description: "Automate PPAP Level 3 submission with agent-assisted document generation",
      steps: [
        {
          id: "gather-design-records",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "List all required PPAP Level 3 design records for an automotive part submission per AIAG guidelines. Include: design record, authorized engineering change docs, engineering approval, and dimensional results template." },
          label: "Gather design record requirements",
        },
        {
          id: "process-flow-diagram",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Generate a process flow diagram template for manufacturing a stamped metal automotive component. Include receiving inspection, forming, welding, coating, final inspection, and packaging steps." },
          dependsOn: ["gather-design-records"],
          label: "Generate process flow diagram",
        },
        {
          id: "pfmea-generation",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Create a Process FMEA (PFMEA) table based on the process flow: {{process-flow-diagram.result}}. Include severity, occurrence, detection ratings, and RPN calculations for each failure mode." },
          dependsOn: ["process-flow-diagram"],
          label: "Generate PFMEA",
        },
        {
          id: "control-plan",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Create a control plan based on this PFMEA: {{pfmea-generation.result}}. Include process parameters, specifications, measurement methods, sample sizes, and reaction plans." },
          dependsOn: ["pfmea-generation"],
          label: "Create control plan",
        },
        {
          id: "msa-plan",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Define a Measurement System Analysis (MSA) plan including Gage R&R study parameters, acceptable thresholds (%GRR < 10%), linearity and bias requirements. Reference the control plan measurements: {{control-plan.result}}" },
          dependsOn: ["control-plan"],
          label: "Plan measurement system analysis",
        },
        {
          id: "capability-study",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Outline a process capability study plan (Cpk/Ppk targets >= 1.67 for initial, >= 1.33 ongoing). Define sample size requirements and SPC chart setup for critical characteristics." },
          dependsOn: ["msa-plan"],
          label: "Define capability study plan",
        },
        {
          id: "psw-assembly",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Compile a Part Submission Warrant (PSW) summary document referencing all prior PPAP elements: design records ({{gather-design-records.result}}), process flow, PFMEA, control plan, MSA, and capability study. Format as a submission checklist with status for each element." },
          dependsOn: ["gather-design-records", "process-flow-diagram", "pfmea-generation", "control-plan", "msa-plan", "capability-study"],
          label: "Assemble PSW package",
        },
      ],
      maxConcurrency: 2,
    },
  },

  // 2. ERP Go-Live Cutover
  {
    metadata: {
      id: "erp-go-live-cutover",
      name: "ERP Go-Live Cutover",
      description: "Structured cutover workflow for ERP system go-live including data migration validation, integration testing, user readiness, and rollback planning.",
      industry: "manufacturing",
      category: "it-operations",
      estimatedDuration: "48-72 hours",
      prerequisites: ["UAT sign-off complete", "Data migration scripts tested", "Rollback plan documented"],
      tags: ["erp", "go-live", "cutover", "migration", "it"],
    },
    workflow: {
      id: "erp-go-live-cutover",
      name: "ERP Go-Live Cutover",
      description: "Manage ERP cutover with automated checkpoints and rollback gates",
      steps: [
        {
          id: "pre-cutover-checklist",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Generate a pre-cutover readiness checklist for an ERP go-live. Cover: data freeze confirmation, backup verification, integration endpoints validated, user accounts provisioned, support team on standby, communication plan sent, rollback criteria defined." },
          label: "Pre-cutover readiness check",
        },
        {
          id: "data-migration-validation",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Create a data migration validation plan covering: record count reconciliation, key field integrity checks, referential integrity validation, financial balance verification, and open order/PO migration accuracy. Define pass/fail criteria for each." },
          dependsOn: ["pre-cutover-checklist"],
          label: "Validate data migration",
        },
        {
          id: "integration-smoke-test",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Define integration smoke tests for a manufacturing ERP: test order-to-cash flow, procure-to-pay cycle, inventory transactions, MRP run, financial posting, and EDI partner connectivity. List expected results for each." },
          dependsOn: ["data-migration-validation"],
          label: "Run integration smoke tests",
        },
        {
          id: "user-access-verification",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Create a user access verification checklist: validate role-based access for each department (finance, warehouse, purchasing, production, sales), confirm SSO/MFA working, verify print queue and report access, test mobile app connectivity." },
          dependsOn: ["integration-smoke-test"],
          label: "Verify user access",
        },
        {
          id: "go-nogo-decision",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Based on the following cutover results, produce a Go/No-Go decision matrix: Pre-cutover: {{pre-cutover-checklist.result}}, Data migration: {{data-migration-validation.result}}, Integration tests: {{integration-smoke-test.result}}, User access: {{user-access-verification.result}}. Score each area and recommend Go or No-Go with rationale." },
          dependsOn: ["pre-cutover-checklist", "data-migration-validation", "integration-smoke-test", "user-access-verification"],
          label: "Go/No-Go decision",
        },
      ],
      maxConcurrency: 1,
    },
  },

  // 3. 5-Day Lean Kaizen Event
  {
    metadata: {
      id: "lean-kaizen-5day",
      name: "5-Day Lean Kaizen Event",
      description: "Structured 5-day rapid improvement event following lean methodology: current state mapping, waste identification, future state design, implementation, and sustainment planning.",
      industry: "manufacturing",
      category: "continuous-improvement",
      estimatedDuration: "5 business days",
      prerequisites: ["Value stream selected", "Team members assigned", "Management sponsor identified"],
      tags: ["lean", "kaizen", "continuous-improvement", "waste-reduction"],
    },
    workflow: {
      id: "lean-kaizen-5day",
      name: "5-Day Lean Kaizen Event",
      description: "Guide a structured rapid improvement kaizen event",
      steps: [
        {
          id: "day1-current-state",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Day 1 — Current State Analysis: Create a current state value stream map template for a manufacturing process. Include cycle times, changeover times, WIP levels, uptime, and information flow. Identify the 8 wastes (DOWNTIME mnemonic) checklist for the team to assess." },
          label: "Day 1: Current state mapping",
        },
        {
          id: "day2-waste-analysis",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Day 2 — Waste Identification: Based on this current state map: {{day1-current-state.result}}, identify top waste categories, calculate process cycle efficiency (value-add time / total lead time), and prioritize improvement opportunities using an impact-effort matrix template." },
          dependsOn: ["day1-current-state"],
          label: "Day 2: Waste identification",
        },
        {
          id: "day3-future-state",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Day 3 — Future State Design: Design a future state value stream map addressing the wastes identified: {{day2-waste-analysis.result}}. Include target cycle times, proposed flow improvements, pull system design, and leveling strategies. Calculate expected lead time reduction." },
          dependsOn: ["day2-waste-analysis"],
          label: "Day 3: Future state design",
        },
        {
          id: "day4-implementation",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Day 4 — Implementation Planning: Create a detailed implementation plan for the future state: {{day3-future-state.result}}. Break into immediate actions (this week), short-term (30 days), and medium-term (90 days). Assign responsibility categories and define measurable success criteria." },
          dependsOn: ["day3-future-state"],
          label: "Day 4: Implementation plan",
        },
        {
          id: "day5-sustainment",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Day 5 — Sustainment & Report-Out: Create a kaizen event summary report including: baseline metrics, target metrics, action items with owners, standard work documentation outline, visual management board design, 30-60-90 day audit schedule, and management presentation template." },
          dependsOn: ["day4-implementation"],
          label: "Day 5: Sustainment plan & report-out",
        },
      ],
      maxConcurrency: 1,
    },
  },

  // 4. Monthly S&OP Cycle
  {
    metadata: {
      id: "sop-monthly-cycle",
      name: "Monthly S&OP Cycle",
      description: "Sales and Operations Planning monthly cycle covering demand review, supply review, pre-S&OP alignment, and executive S&OP meeting preparation.",
      industry: "manufacturing",
      category: "planning",
      estimatedDuration: "5 business days (monthly cadence)",
      prerequisites: ["Historical sales data available", "Demand forecast model active", "Capacity plan current"],
      tags: ["s&op", "demand-planning", "supply-planning", "ibp"],
    },
    workflow: {
      id: "sop-monthly-cycle",
      name: "Monthly S&OP Cycle",
      description: "Orchestrate the monthly S&OP planning cycle",
      steps: [
        {
          id: "demand-review",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Prepare a demand review analysis template: compare statistical forecast vs. sales input, identify top variances by product family, flag new product introductions and phase-outs, calculate forecast accuracy (MAPE), and highlight demand risks/opportunities for the next 3 months." },
          label: "Demand review preparation",
        },
        {
          id: "supply-review",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Prepare a supply review template: assess capacity utilization by work center, identify bottleneck resources, evaluate supplier lead time trends, review inventory positions vs. targets (weeks of supply), and flag supply risks including material shortages and capacity constraints." },
          label: "Supply review preparation",
        },
        {
          id: "gap-analysis",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Perform a demand-supply gap analysis based on: Demand review: {{demand-review.result}}, Supply review: {{supply-review.result}}. Identify mismatches by product family, propose balancing strategies (overtime, outsourcing, inventory build, demand shaping), and quantify financial impact of each scenario." },
          dependsOn: ["demand-review", "supply-review"],
          label: "Demand-supply gap analysis",
        },
        {
          id: "pre-sop-alignment",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Create a pre-S&OP meeting agenda and decision log template. Include: gap resolution proposals from {{gap-analysis.result}}, scenario comparison (Plan A vs. Plan B), KPI dashboard (revenue, margin, OTIF, inventory turns), and open decisions requiring executive input." },
          dependsOn: ["gap-analysis"],
          label: "Pre-S&OP alignment",
        },
        {
          id: "executive-sop-pack",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Assemble an executive S&OP meeting pack: one-page executive summary, demand/supply alignment status, financial projection comparison, risk register with mitigations, recommended consensus plan, and key decisions needed. Reference: {{pre-sop-alignment.result}}" },
          dependsOn: ["pre-sop-alignment"],
          label: "Executive S&OP pack",
        },
      ],
      maxConcurrency: 2,
    },
  },

  // 5. Supplier Qualification Process
  {
    metadata: {
      id: "supplier-qualification",
      name: "Supplier Qualification Process",
      description: "End-to-end new supplier qualification covering initial assessment, capability evaluation, quality audit, trial order, and final approval.",
      industry: "manufacturing",
      category: "procurement",
      estimatedDuration: "15-30 business days",
      prerequisites: ["Supplier identified", "Commodity strategy defined", "Qualification criteria approved"],
      tags: ["supplier", "qualification", "procurement", "quality", "audit"],
    },
    workflow: {
      id: "supplier-qualification",
      name: "Supplier Qualification Process",
      description: "Qualify a new supplier through structured evaluation stages",
      steps: [
        {
          id: "initial-screening",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Create a supplier initial screening questionnaire covering: company profile, financial stability indicators, quality certifications (ISO 9001, IATF 16949, AS9100), capacity overview, geographic risk assessment, compliance (environmental, labor, conflict minerals), and references." },
          label: "Initial supplier screening",
        },
        {
          id: "capability-assessment",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Design a supplier capability assessment scorecard based on the screening: {{initial-screening.result}}. Evaluate: manufacturing capability, technical competence, quality management maturity, delivery performance history, cost competitiveness, and innovation potential. Use a weighted scoring model (1-5 scale)." },
          dependsOn: ["initial-screening"],
          label: "Capability assessment",
        },
        {
          id: "quality-audit-plan",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Create an on-site quality audit checklist for a supplier visit. Cover: incoming material control, process control, calibration program, nonconformance management, corrective action system, traceability, packaging/shipping, and continuous improvement culture. Include scoring criteria." },
          dependsOn: ["capability-assessment"],
          label: "Quality audit planning",
        },
        {
          id: "trial-order-spec",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Define trial order specifications: sample quantities, critical-to-quality dimensions, acceptance criteria, inspection plan (AQL levels), PPAP requirements (if automotive), first article inspection report template, and pass/fail thresholds." },
          dependsOn: ["quality-audit-plan"],
          label: "Trial order specification",
        },
        {
          id: "approval-package",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Compile a supplier approval decision package summarizing: screening results ({{initial-screening.result}}), capability score ({{capability-assessment.result}}), audit findings ({{quality-audit-plan.result}}), trial order results ({{trial-order-spec.result}}). Include a recommendation (approve/conditional/reject) with conditions and ongoing monitoring plan." },
          dependsOn: ["initial-screening", "capability-assessment", "quality-audit-plan", "trial-order-spec"],
          label: "Compile approval package",
        },
      ],
      maxConcurrency: 1,
    },
  },

  // 6. Digital Twin Setup
  {
    metadata: {
      id: "digital-twin-setup",
      name: "Digital Twin Setup",
      description: "Set up a digital twin for a manufacturing line covering data source mapping, model definition, sensor integration planning, simulation baseline, and dashboard configuration.",
      industry: "manufacturing",
      category: "industry-4.0",
      estimatedDuration: "10-20 business days",
      prerequisites: ["Physical asset identified", "Sensor inventory available", "Historian/SCADA access confirmed"],
      tags: ["digital-twin", "iiot", "industry-4.0", "simulation", "smart-manufacturing"],
    },
    workflow: {
      id: "digital-twin-setup",
      name: "Digital Twin Setup",
      description: "Configure a digital twin for a manufacturing asset or line",
      steps: [
        {
          id: "asset-inventory",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Create an asset inventory template for digital twin setup. Include: physical asset hierarchy (line > station > equipment > component), data points per asset (temperature, pressure, vibration, cycle count, power), current data sources (PLC, SCADA, historian, MES), and connectivity status." },
          label: "Asset and data source inventory",
        },
        {
          id: "data-model-design",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Design a digital twin data model based on the asset inventory: {{asset-inventory.result}}. Define entity relationships, time-series data schema, event/alarm model, metadata attributes, and data retention policies. Include a tag naming convention standard." },
          dependsOn: ["asset-inventory"],
          label: "Data model design",
        },
        {
          id: "sensor-integration",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Create a sensor integration plan: map each data point to its source protocol (OPC-UA, MQTT, Modbus, REST API), define polling intervals vs. change-of-value triggers, specify edge gateway requirements, and document data quality checks (range validation, staleness detection, gap handling)." },
          dependsOn: ["data-model-design"],
          label: "Sensor integration planning",
        },
        {
          id: "simulation-baseline",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Define a simulation baseline for the digital twin: establish normal operating parameters from historical data, create physics-based or ML-based behavioral models for key equipment, define anomaly detection thresholds, and document validation criteria comparing simulation outputs to real sensor data." },
          dependsOn: ["sensor-integration"],
          label: "Simulation baseline creation",
        },
        {
          id: "dashboard-config",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Design a digital twin monitoring dashboard: real-time 3D/2D visualization layout, KPI tiles (OEE, availability, performance, quality), alarm management panel, trend charts for critical parameters, predictive maintenance indicators, and role-based views (operator, maintenance, management). Reference: {{simulation-baseline.result}}" },
          dependsOn: ["simulation-baseline"],
          label: "Dashboard configuration",
        },
        {
          id: "validation-report",
          skillId: "delegate",
          args: { skillId: "ask_claude", message: "Create a digital twin validation and go-live report: compare twin predictions vs. actual plant data for a 1-week test period, calculate model accuracy metrics, document known limitations, define ongoing calibration schedule, and outline the roadmap for Phase 2 enhancements (what-if scenarios, prescriptive analytics)." },
          dependsOn: ["asset-inventory", "data-model-design", "sensor-integration", "simulation-baseline", "dashboard-config"],
          label: "Validation and go-live report",
        },
      ],
      maxConcurrency: 2,
    },
  },
];

// ── Playbook Index ──────────────────────────────────────────────

const playbookIndex = new Map<string, Playbook>();
for (const pb of BUILTIN_PLAYBOOKS) {
  playbookIndex.set(pb.metadata.id, pb);
}

// ── Validation ──────────────────────────────────────────────────

/**
 * Validate a workflow definition for structural correctness.
 * Checks for: unique step IDs, valid dependency references, DAG acyclicity,
 * and required fields.
 */
export function validatePlaybook(workflow: WorkflowDefinition): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!workflow.id) {
    errors.push("Workflow must have an id");
  }

  if (!workflow.steps || workflow.steps.length === 0) {
    errors.push("Workflow must have at least one step");
    return { valid: false, errors };
  }

  // Check unique step IDs
  const stepIds = new Set<string>();
  for (const step of workflow.steps) {
    if (!step.id) {
      errors.push("Every step must have an id");
      continue;
    }
    if (stepIds.has(step.id)) {
      errors.push(`Duplicate step id: "${step.id}"`);
    }
    stepIds.add(step.id);

    if (!step.skillId) {
      errors.push(`Step "${step.id}" must have a skillId`);
    }
  }

  // Check dependency references exist
  for (const step of workflow.steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep)) {
          errors.push(`Step "${step.id}" depends on unknown step "${dep}"`);
        }
        if (dep === step.id) {
          errors.push(`Step "${step.id}" depends on itself`);
        }
      }
    }
  }

  // Check for cycles using topological sort (Kahn's algorithm)
  if (errors.length === 0) {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const step of workflow.steps) {
      inDegree.set(step.id, 0);
      adjacency.set(step.id, []);
    }

    for (const step of workflow.steps) {
      if (step.dependsOn) {
        for (const dep of step.dependsOn) {
          adjacency.get(dep)?.push(step.id);
          inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    let visited = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      visited++;
      for (const neighbor of adjacency.get(current) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    if (visited !== workflow.steps.length) {
      errors.push("Workflow contains a dependency cycle");
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Public API ──────────────────────────────────────────────────

/**
 * List available playbook metadata, optionally filtered by industry, category, or tag.
 */
export function listPlaybooks(filter?: {
  industry?: string;
  category?: string;
  tag?: string;
}): PlaybookMetadata[] {
  let playbooks = BUILTIN_PLAYBOOKS.map(pb => pb.metadata);

  if (filter?.industry) {
    const industry = filter.industry.toLowerCase();
    playbooks = playbooks.filter(m => m.industry.toLowerCase() === industry);
  }
  if (filter?.category) {
    const category = filter.category.toLowerCase();
    playbooks = playbooks.filter(m => m.category.toLowerCase() === category);
  }
  if (filter?.tag) {
    const tag = filter.tag.toLowerCase();
    playbooks = playbooks.filter(m => m.tags.some(t => t.toLowerCase() === tag));
  }

  return playbooks;
}

/**
 * Load a specific playbook by ID. Returns null if not found.
 */
export function loadPlaybook(id: string): Playbook | null {
  return playbookIndex.get(id) ?? null;
}

/**
 * Get the total number of built-in playbooks.
 */
export function getPlaybookCount(): number {
  return BUILTIN_PLAYBOOKS.length;
}

/**
 * Get all unique industries represented in the playbook registry.
 */
export function getPlaybookIndustries(): string[] {
  const industries = new Set<string>();
  for (const pb of BUILTIN_PLAYBOOKS) {
    industries.add(pb.metadata.industry);
  }
  return Array.from(industries);
}

/**
 * Get all unique categories represented in the playbook registry.
 */
export function getPlaybookCategories(): string[] {
  const categories = new Set<string>();
  for (const pb of BUILTIN_PLAYBOOKS) {
    categories.add(pb.metadata.category);
  }
  return Array.from(categories);
}
