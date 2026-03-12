/**
 * Infrastructure Worker Agent — infrastructure cascade analysis, supply chain mapping,
 * chokepoint assessment, redundancy scoring, and dependency graph traversal.
 *
 * Port: 8093
 *
 * Inspired by World Monitor's infrastructure-cascade, supply-chain, and
 * critical infrastructure modules.
 *
 * Skills:
 *   cascade_analysis    — BFS cascade failure simulation through infrastructure dependency graph
 *   supply_chain_map    — Map supply chain routes with risk scoring per leg
 *   chokepoint_assess   — Assess strategic chokepoint vulnerability and traffic impact
 *   redundancy_score    — Score infrastructure redundancy for a region or corridor
 *   dependency_graph    — Build and query infrastructure dependency graphs
 *   remember/recall     — Shared persistent memory
 */

import Fastify from "fastify";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { buildA2AResponse, buildA2AError, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";
import { getPersona, watchPersonas } from "../persona-loader.js";

const PORT = 8093;
const NAME = "infra-agent";

// ── Zod Schemas ──────────────────────────────────────────────────

const NodeTypeEnum = z.enum(["cable", "pipeline", "port", "chokepoint", "country", "datacenter", "powerplant", "refinery", "exchange", "hub"]);
const EdgeTypeEnum = z.enum(["serves", "lands_at", "trade_dependency", "controls_access", "powers", "feeds", "connects", "routes_through"]);

const InfraSchemas = {
  cascade_analysis: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      type: z.string(),
      name: z.string(),
      capacity: z.number().optional().default(1),
      redundancy: z.number().min(0).max(1).optional().default(0),
      metadata: z.record(z.unknown()).optional().default({}),
    })).min(1),
    edges: z.array(z.object({
      from: z.string(),
      to: z.string(),
      type: z.string().optional().default("connects"),
      strength: z.number().min(0).max(1).optional().default(1),
      redundancy: z.number().min(0).max(1).optional().default(0),
    })).min(1),
    failedNodes: z.array(z.string()).min(1),
    maxDepth: z.number().int().positive().optional().default(3),
    significanceThreshold: z.number().min(0).max(1).optional().default(0.05),
  }).passthrough(),

  supply_chain_map: z.object({
    routes: z.array(z.object({
      id: z.string().optional(),
      name: z.string(),
      legs: z.array(z.object({
        from: z.string(),
        to: z.string(),
        mode: z.enum(["sea", "rail", "road", "air", "pipeline"]).optional().default("sea"),
        distanceKm: z.number().optional().default(0),
        transitDays: z.number().optional().default(0),
        chokepoints: z.array(z.string()).optional().default([]),
        riskFactors: z.array(z.string()).optional().default([]),
      })),
      commodity: z.string().optional().default(""),
      volumePerYear: z.number().optional().default(0),
    })).min(1),
  }).passthrough(),

  chokepoint_assess: z.object({
    chokepoints: z.array(z.object({
      name: z.string(),
      lat: z.number().optional(),
      lon: z.number().optional(),
      dailyTransits: z.number().optional().default(0),
      oilFlowMbpd: z.number().optional().default(0),
      lngFlowMtpa: z.number().optional().default(0),
      widthKm: z.number().optional().default(0),
      alternatives: z.array(z.string()).optional().default([]),
      threats: z.array(z.string()).optional().default([]),
      controllingEntities: z.array(z.string()).optional().default([]),
    })).min(1),
  }).passthrough(),

  redundancy_score: z.object({
    region: z.string(),
    infrastructure: z.object({
      submarineCables: z.number().optional().default(0),
      internetExchanges: z.number().optional().default(0),
      powerPlants: z.number().optional().default(0),
      ports: z.number().optional().default(0),
      pipelines: z.number().optional().default(0),
      airports: z.number().optional().default(0),
      railConnections: z.number().optional().default(0),
      datacenters: z.number().optional().default(0),
    }),
    thresholds: z.object({
      submarineCables: z.number().optional().default(3),
      internetExchanges: z.number().optional().default(2),
      powerPlants: z.number().optional().default(3),
      ports: z.number().optional().default(2),
      pipelines: z.number().optional().default(2),
      airports: z.number().optional().default(2),
      railConnections: z.number().optional().default(2),
      datacenters: z.number().optional().default(2),
    }).optional().default({}),
  }).passthrough(),

  dependency_graph: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      type: z.string(),
      name: z.string(),
      criticality: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
    })).min(1),
    edges: z.array(z.object({
      from: z.string(),
      to: z.string(),
      type: z.string().optional().default("depends_on"),
      weight: z.number().min(0).max(1).optional().default(1),
    })),
    query: z.enum(["stats", "critical_path", "single_points_of_failure", "impact_of", "depends_on"]).optional().default("stats"),
    targetNode: z.string().optional(),
  }).passthrough(),
};

// ── Agent Card ───────────────────────────────────────────────────

const AGENT_CARD = {
  name: NAME,
  description: "Infrastructure agent — cascade failure analysis, supply chain mapping, chokepoint assessment, redundancy scoring, and dependency graph analysis",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "cascade_analysis", name: "Cascade Analysis", description: "Simulate cascade failures through infrastructure dependency graph using BFS traversal" },
    { id: "supply_chain_map", name: "Supply Chain Map", description: "Map supply chain routes with per-leg risk scoring, chokepoint exposure, and transit analysis" },
    { id: "chokepoint_assess", name: "Chokepoint Assess", description: "Assess strategic chokepoint vulnerability based on traffic, width, alternatives, and threats" },
    { id: "redundancy_score", name: "Redundancy Score", description: "Score infrastructure redundancy for a region across cables, ports, power, pipelines, etc." },
    { id: "dependency_graph", name: "Dependency Graph", description: "Build dependency graphs and query: critical paths, single points of failure, impact analysis" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────

function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ── Cascade Failure Analysis (BFS) ───────────────────────────────

interface InfraNode {
  id: string;
  type: string;
  name: string;
  capacity: number;
  redundancy: number;
  metadata: Record<string, unknown>;
}

interface InfraEdge {
  from: string;
  to: string;
  type: string;
  strength: number;
  redundancy: number;
}

interface CascadeImpact {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  depth: number;
  impactScore: number;
  propagationPath: string[];
}

function simulateCascade(
  nodes: InfraNode[],
  edges: InfraEdge[],
  failedNodes: string[],
  maxDepth: number,
  significanceThreshold: number,
): { impactedNodes: CascadeImpact[]; totalImpact: number; maxDepthReached: number; cascadeChain: string[][] } {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Build adjacency list (from → to[])
  const adj = new Map<string, Array<{ to: string; strength: number; redundancy: number }>>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push({ to: e.to, strength: e.strength, redundancy: e.redundancy });
  }

  // BFS cascade
  const visited = new Set<string>(failedNodes);
  const impacts: CascadeImpact[] = [];
  const cascadeChain: string[][] = [failedNodes];

  let frontier = failedNodes.map(id => ({ id, depth: 0, path: [id], score: 1 }));
  let maxDepthReached = 0;

  while (frontier.length > 0 && maxDepthReached < maxDepth) {
    const nextFrontier: typeof frontier = [];
    const depthLayer: string[] = [];

    for (const current of frontier) {
      const neighbors = adj.get(current.id) ?? [];

      for (const edge of neighbors) {
        if (visited.has(edge.to)) continue;

        const targetNode = nodeMap.get(edge.to);
        if (!targetNode) continue;

        // Impact attenuated by edge strength, target redundancy
        const propagatedImpact = current.score * edge.strength * (1 - edge.redundancy) * (1 - targetNode.redundancy);

        if (propagatedImpact < significanceThreshold) continue;

        visited.add(edge.to);
        const path = [...current.path, edge.to];

        impacts.push({
          nodeId: edge.to,
          nodeName: targetNode.name,
          nodeType: targetNode.type,
          depth: current.depth + 1,
          impactScore: round(propagatedImpact, 4),
          propagationPath: path,
        });

        depthLayer.push(edge.to);
        nextFrontier.push({ id: edge.to, depth: current.depth + 1, path, score: propagatedImpact });
      }
    }

    if (depthLayer.length > 0) cascadeChain.push(depthLayer);
    frontier = nextFrontier;
    maxDepthReached++;
  }

  // Sort by impact score descending
  impacts.sort((a, b) => b.impactScore - a.impactScore);
  const totalImpact = round(impacts.reduce((s, i) => s + i.impactScore, 0), 2);

  return { impactedNodes: impacts, totalImpact, maxDepthReached, cascadeChain };
}

// ── Supply Chain Mapping ─────────────────────────────────────────

interface RouteLeg {
  from: string;
  to: string;
  mode: string;
  distanceKm: number;
  transitDays: number;
  chokepoints: string[];
  riskFactors: string[];
}

interface Route {
  id?: string;
  name: string;
  legs: RouteLeg[];
  commodity: string;
  volumePerYear: number;
}

const MODE_RISK_BASE: Record<string, number> = {
  sea: 0.3,
  pipeline: 0.2,
  rail: 0.15,
  road: 0.25,
  air: 0.1,
};

interface RouteAnalysis {
  name: string;
  commodity: string;
  totalDistanceKm: number;
  totalTransitDays: number;
  legCount: number;
  overallRiskScore: number;
  chokepoints: string[];
  legs: Array<RouteLeg & { riskScore: number }>;
  vulnerabilities: string[];
}

function analyzeRoutes(routes: Route[]): RouteAnalysis[] {
  return routes.map(route => {
    let totalDist = 0;
    let totalDays = 0;
    const allChokepoints = new Set<string>();
    const vulnerabilities: string[] = [];
    let maxLegRisk = 0;

    const analyzedLegs = route.legs.map(leg => {
      totalDist += leg.distanceKm;
      totalDays += leg.transitDays;
      leg.chokepoints.forEach(cp => allChokepoints.add(cp));

      // Risk scoring per leg
      let riskScore = MODE_RISK_BASE[leg.mode] ?? 0.2;
      riskScore += leg.chokepoints.length * 0.15; // Each chokepoint adds risk
      riskScore += leg.riskFactors.length * 0.1;  // Each risk factor adds risk
      if (leg.distanceKm > 10000) riskScore += 0.1; // Long distance penalty
      riskScore = Math.min(1, riskScore);

      if (riskScore > maxLegRisk) maxLegRisk = riskScore;

      if (leg.chokepoints.length > 0) {
        vulnerabilities.push(`${leg.from}→${leg.to}: exposed to ${leg.chokepoints.join(", ")}`);
      }
      if (leg.riskFactors.length > 0) {
        vulnerabilities.push(`${leg.from}→${leg.to}: ${leg.riskFactors.join(", ")}`);
      }

      return { ...leg, riskScore: round(riskScore, 3) };
    });

    // Overall risk = weighted average of leg risks, biased toward worst leg
    const avgLegRisk = analyzedLegs.reduce((s, l) => s + l.riskScore, 0) / analyzedLegs.length;
    const overallRiskScore = round((avgLegRisk * 0.6 + maxLegRisk * 0.4), 3);

    return {
      name: route.name,
      commodity: route.commodity,
      totalDistanceKm: totalDist,
      totalTransitDays: totalDays,
      legCount: route.legs.length,
      overallRiskScore,
      chokepoints: [...allChokepoints],
      legs: analyzedLegs,
      vulnerabilities,
    };
  }).sort((a, b) => b.overallRiskScore - a.overallRiskScore);
}

// ── Chokepoint Assessment ────────────────────────────────────────

interface Chokepoint {
  name: string;
  lat?: number;
  lon?: number;
  dailyTransits: number;
  oilFlowMbpd: number;
  lngFlowMtpa: number;
  widthKm: number;
  alternatives: string[];
  threats: string[];
  controllingEntities: string[];
}

interface ChokepointAssessment {
  name: string;
  vulnerabilityScore: number;
  vulnerabilityLevel: string;
  trafficIntensity: string;
  hasAlternatives: boolean;
  alternativeCount: number;
  threatCount: number;
  factors: Record<string, number>;
}

function assessChokepoints(chokepoints: Chokepoint[]): ChokepointAssessment[] {
  return chokepoints.map(cp => {
    const factors: Record<string, number> = {};

    // Traffic intensity (0-25 points)
    const transitScore = Math.min(25, cp.dailyTransits / 4);
    factors.trafficVolume = round(transitScore);

    // Energy flow criticality (0-25 points)
    const energyScore = Math.min(25, (cp.oilFlowMbpd * 3 + cp.lngFlowMtpa * 2));
    factors.energyCriticality = round(energyScore);

    // Width vulnerability — narrower = more vulnerable (0-20 points)
    const widthScore = cp.widthKm > 0 ? Math.min(20, 20 / (cp.widthKm / 2)) : 10;
    factors.widthVulnerability = round(widthScore);

    // Alternatives — fewer = more vulnerable (0-15 points)
    const altScore = cp.alternatives.length === 0 ? 15 : Math.max(0, 15 - cp.alternatives.length * 5);
    factors.alternativeScarcity = round(altScore);

    // Threats (0-15 points)
    const threatScore = Math.min(15, cp.threats.length * 5);
    factors.threatExposure = round(threatScore);

    const total = transitScore + energyScore + widthScore + altScore + threatScore;
    const vulnerabilityScore = round(Math.min(100, total), 1);

    let vulnerabilityLevel: string;
    if (vulnerabilityScore >= 75) vulnerabilityLevel = "critical";
    else if (vulnerabilityScore >= 55) vulnerabilityLevel = "high";
    else if (vulnerabilityScore >= 35) vulnerabilityLevel = "medium";
    else vulnerabilityLevel = "low";

    let trafficIntensity: string;
    if (cp.dailyTransits >= 50) trafficIntensity = "very_high";
    else if (cp.dailyTransits >= 20) trafficIntensity = "high";
    else if (cp.dailyTransits >= 5) trafficIntensity = "moderate";
    else trafficIntensity = "low";

    return {
      name: cp.name,
      vulnerabilityScore,
      vulnerabilityLevel,
      trafficIntensity,
      hasAlternatives: cp.alternatives.length > 0,
      alternativeCount: cp.alternatives.length,
      threatCount: cp.threats.length,
      factors,
    };
  }).sort((a, b) => b.vulnerabilityScore - a.vulnerabilityScore);
}

// ── Redundancy Scoring ───────────────────────────────────────────

interface RedundancyResult {
  region: string;
  overallScore: number;
  level: string;
  breakdown: Record<string, { count: number; threshold: number; score: number; status: string }>;
  weaknesses: string[];
  strengths: string[];
}

function scoreRedundancy(
  region: string,
  infra: Record<string, number>,
  thresholds: Record<string, number>,
): RedundancyResult {
  const breakdown: Record<string, { count: number; threshold: number; score: number; status: string }> = {};
  const weaknesses: string[] = [];
  const strengths: string[] = [];
  let totalScore = 0;
  let categories = 0;

  for (const [key, count] of Object.entries(infra)) {
    const threshold = (thresholds as Record<string, number>)[key] ?? 2;
    // Score: 0-100 per category, logarithmic scaling
    let score: number;
    if (count === 0) score = 0;
    else if (count >= threshold * 2) score = 100;
    else score = Math.min(100, (count / threshold) * 60 + Math.log2(count + 1) * 10);
    score = round(score, 1);

    let status: string;
    if (score >= 80) { status = "robust"; strengths.push(`${key}: ${count} (robust)`); }
    else if (score >= 50) { status = "adequate"; }
    else if (score >= 20) { status = "vulnerable"; weaknesses.push(`${key}: only ${count} (threshold: ${threshold})`); }
    else { status = "critical"; weaknesses.push(`${key}: ${count} — critically low (threshold: ${threshold})`); }

    breakdown[key] = { count, threshold, score, status };
    totalScore += score;
    categories++;
  }

  const overallScore = categories > 0 ? round(totalScore / categories, 1) : 0;

  let level: string;
  if (overallScore >= 80) level = "robust";
  else if (overallScore >= 60) level = "adequate";
  else if (overallScore >= 40) level = "vulnerable";
  else level = "critical";

  return { region, overallScore, level, breakdown, weaknesses, strengths };
}

// ── Dependency Graph Analysis ────────────────────────────────────

interface GraphNode {
  id: string;
  type: string;
  name: string;
  criticality: string;
}

interface GraphEdge {
  from: string;
  to: string;
  type: string;
  weight: number;
}

const CRITICALITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function analyzeGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  query: string,
  targetNode?: string,
): Record<string, unknown> {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const adjOut = new Map<string, GraphEdge[]>(); // outgoing
  const adjIn = new Map<string, GraphEdge[]>();  // incoming

  for (const e of edges) {
    if (!adjOut.has(e.from)) adjOut.set(e.from, []);
    adjOut.get(e.from)!.push(e);
    if (!adjIn.has(e.to)) adjIn.set(e.to, []);
    adjIn.get(e.to)!.push(e);
  }

  switch (query) {
    case "stats": {
      // In-degree and out-degree per node
      const nodeStats = nodes.map(n => ({
        id: n.id,
        name: n.name,
        type: n.type,
        criticality: n.criticality,
        inDegree: (adjIn.get(n.id) ?? []).length,
        outDegree: (adjOut.get(n.id) ?? []).length,
        totalDegree: (adjIn.get(n.id) ?? []).length + (adjOut.get(n.id) ?? []).length,
      }));
      nodeStats.sort((a, b) => b.totalDegree - a.totalDegree);

      return {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        avgDegree: round(edges.length * 2 / nodes.length),
        criticalNodes: nodes.filter(n => n.criticality === "critical").length,
        nodeStats: nodeStats.slice(0, 20),
      };
    }

    case "single_points_of_failure": {
      // Nodes whose removal disconnects dependents
      const spofs: Array<{ id: string; name: string; type: string; dependentCount: number; dependents: string[] }> = [];

      for (const node of nodes) {
        const dependents = (adjOut.get(node.id) ?? []).map(e => e.to);
        // Check if any dependent has only this node as source
        const singleDependents: string[] = [];
        for (const depId of dependents) {
          const sources = (adjIn.get(depId) ?? []).map(e => e.from);
          if (sources.length === 1) singleDependents.push(depId);
        }
        if (singleDependents.length > 0) {
          spofs.push({
            id: node.id,
            name: node.name,
            type: node.type,
            dependentCount: singleDependents.length,
            dependents: singleDependents.map(d => nodeMap.get(d)?.name ?? d),
          });
        }
      }

      spofs.sort((a, b) => b.dependentCount - a.dependentCount);
      return { singlePointsOfFailure: spofs, count: spofs.length };
    }

    case "critical_path": {
      // Find the path through the most critical nodes
      const criticalNodes = nodes
        .filter(n => n.criticality === "critical" || n.criticality === "high")
        .sort((a, b) => (CRITICALITY_WEIGHT[b.criticality] ?? 0) - (CRITICALITY_WEIGHT[a.criticality] ?? 0));

      return {
        criticalNodes: criticalNodes.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
          criticality: n.criticality,
          connections: (adjOut.get(n.id) ?? []).length + (adjIn.get(n.id) ?? []).length,
        })),
        count: criticalNodes.length,
      };
    }

    case "impact_of": {
      if (!targetNode) return { error: "targetNode required for impact_of query" };
      // BFS to find all downstream dependents
      const visited = new Set<string>([targetNode]);
      let frontier = [targetNode];
      const impacted: Array<{ id: string; name: string; depth: number }> = [];
      let depth = 0;

      while (frontier.length > 0) {
        depth++;
        const next: string[] = [];
        for (const id of frontier) {
          for (const edge of (adjOut.get(id) ?? [])) {
            if (visited.has(edge.to)) continue;
            visited.add(edge.to);
            const node = nodeMap.get(edge.to);
            impacted.push({ id: edge.to, name: node?.name ?? edge.to, depth });
            next.push(edge.to);
          }
        }
        frontier = next;
        if (depth > 10) break;
      }

      return {
        targetNode,
        targetName: nodeMap.get(targetNode)?.name ?? targetNode,
        impactedCount: impacted.length,
        impacted,
      };
    }

    case "depends_on": {
      if (!targetNode) return { error: "targetNode required for depends_on query" };
      // BFS upstream to find all dependencies
      const visited = new Set<string>([targetNode]);
      let frontier = [targetNode];
      const dependencies: Array<{ id: string; name: string; depth: number }> = [];
      let depth = 0;

      while (frontier.length > 0) {
        depth++;
        const next: string[] = [];
        for (const id of frontier) {
          for (const edge of (adjIn.get(id) ?? [])) {
            if (visited.has(edge.from)) continue;
            visited.add(edge.from);
            const node = nodeMap.get(edge.from);
            dependencies.push({ id: edge.from, name: node?.name ?? edge.from, depth });
            next.push(edge.from);
          }
        }
        frontier = next;
        if (depth > 10) break;
      }

      return {
        targetNode,
        targetName: nodeMap.get(targetNode)?.name ?? targetNode,
        dependencyCount: dependencies.length,
        dependencies,
      };
    }

    default:
      return { error: `Unknown query type: ${query}` };
  }
}

// ── Skill Dispatcher ─────────────────────────────────────────────

function handleSkill(skillId: string, args: Record<string, unknown>, text: string): string {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;

  switch (skillId) {
    case "cascade_analysis": {
      const { nodes, edges, failedNodes, maxDepth, significanceThreshold } = InfraSchemas.cascade_analysis.parse(args);
      const result = simulateCascade(nodes, edges, failedNodes, maxDepth, significanceThreshold);
      return safeStringify({
        failedNodes,
        impactedCount: result.impactedNodes.length,
        ...result,
      }, 2);
    }

    case "supply_chain_map": {
      const { routes } = InfraSchemas.supply_chain_map.parse(args);
      const analyzed = analyzeRoutes(routes);
      const allChokepoints = new Set(analyzed.flatMap(r => r.chokepoints));
      return safeStringify({
        totalRoutes: analyzed.length,
        uniqueChokepoints: [...allChokepoints],
        highestRisk: analyzed[0]?.overallRiskScore ?? 0,
        routes: analyzed,
      }, 2);
    }

    case "chokepoint_assess": {
      const { chokepoints } = InfraSchemas.chokepoint_assess.parse(args);
      const assessed = assessChokepoints(chokepoints);
      const byLevel: Record<string, number> = {};
      for (const cp of assessed) byLevel[cp.vulnerabilityLevel] = (byLevel[cp.vulnerabilityLevel] ?? 0) + 1;
      return safeStringify({
        totalChokepoints: assessed.length,
        byVulnerabilityLevel: byLevel,
        chokepoints: assessed,
      }, 2);
    }

    case "redundancy_score": {
      const { region, infrastructure, thresholds } = InfraSchemas.redundancy_score.parse(args);
      const result = scoreRedundancy(region, infrastructure, thresholds);
      return safeStringify(result, 2);
    }

    case "dependency_graph": {
      const { nodes, edges, query, targetNode } = InfraSchemas.dependency_graph.parse(args);
      const result = analyzeGraph(nodes, edges, query, targetNode);
      return safeStringify(result, 2);
    }

    default:
      return `Unknown skill: ${skillId}`;
  }
}

// ── Fastify Server ───────────────────────────────────────────────

const app = Fastify({ logger: false });

app.get("/.well-known/agent.json", async () => AGENT_CARD);

app.get("/healthz", async () => ({
  status: "ok",
  agent: NAME,
  uptime: process.uptime(),
  skills: AGENT_CARD.skills.map(s => s.id),
}));

app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
  const data = request.body;
  if (data?.method !== "tasks/send") {
    reply.code(404);
    return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
  }

  const sizeErr = checkRequestSize(data);
  if (sizeErr) { reply.code(413); return { jsonrpc: "2.0", error: { code: -32000, message: sizeErr } }; }

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "cascade_analysis";

  try {
    const result = handleSkill(sid, args ?? {}, text);
    return buildA2AResponse(data.id, taskId, result);
  } catch (err) {
    reply.code(500);
    return buildA2AError(data.id, err);
  }
});

getPersona(NAME);
watchPersonas();

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
