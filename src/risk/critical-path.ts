/**
 * Critical Path Method (CPM) implementation for supply chain analysis.
 *
 * Builds a dependency graph from BOM components and their lead times,
 * then calculates the critical path, slack times, and total duration.
 */

import type { BOMComponent, SupplyChainGraph, GraphNode, GraphEdge } from "../erp/types.js";
import { shouldStopRecursion } from "../mrp/bom-guard.js";

/**
 * Build a supply chain graph from BOM components and compute the critical path.
 */
export function computeCriticalPath(
  rootItemNo: string,
  rootItemName: string,
  components: BOMComponent[],
): SupplyChainGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeMap = new Map<string, GraphNode>();

  // Add root node (the finished product)
  const rootNode: GraphNode = {
    id: rootItemNo,
    label: rootItemName,
    type: "milestone",
    durationDays: 0,
  };
  nodes.push(rootNode);
  nodeMap.set(rootNode.id, rootNode);

  // Recursively add component nodes
  addComponentNodes(rootItemNo, components, nodes, edges, nodeMap);

  // Forward pass: compute earliest start/finish
  const sorted = topologicalSort(nodes, edges);
  for (const nodeId of sorted) {
    const node = nodeMap.get(nodeId)!;
    const predecessors = edges.filter((e) => e.to === nodeId);

    if (predecessors.length === 0) {
      node.earliestStart = 0;
      node.earliestFinish = node.durationDays;
    } else {
      node.earliestStart = Math.max(
        ...predecessors.map((e) => nodeMap.get(e.from)!.earliestFinish ?? 0),
      );
      node.earliestFinish = node.earliestStart + node.durationDays;
    }
  }

  // Total project duration — guard against Math.max(...[]) = -Infinity if nodes is ever empty
  const finishes = nodes.map((n) => n.earliestFinish ?? 0);
  const totalDurationDays = finishes.length > 0 ? Math.max(...finishes) : 0;

  // Backward pass: compute latest start/finish
  for (const nodeId of sorted.reverse()) {
    const node = nodeMap.get(nodeId)!;
    const successors = edges.filter((e) => e.from === nodeId);

    if (successors.length === 0) {
      node.latestFinish = totalDurationDays;
      node.latestStart = totalDurationDays - node.durationDays;
    } else {
      node.latestFinish = Math.min(
        ...successors.map((e) => nodeMap.get(e.to)!.latestStart ?? totalDurationDays),
      );
      node.latestStart = node.latestFinish - node.durationDays;
    }

    node.slack = (node.latestStart ?? 0) - (node.earliestStart ?? 0);
  }

  // Critical path: nodes with zero slack
  const criticalPath = nodes
    .filter((n) => n.slack === 0 && n.durationDays > 0)
    .sort((a, b) => (a.earliestStart ?? 0) - (b.earliestStart ?? 0))
    .map((n) => n.id);

  return { nodes, edges, criticalPath, totalDurationDays };
}

function addComponentNodes(
  parentId: string,
  components: BOMComponent[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeMap: Map<string, GraphNode>,
  visited: Set<string> = new Set(),
  depth: number = 0,
): void {
  for (const comp of components) {
    // Avoid duplicates (same component used in multiple assemblies)
    if (!nodeMap.has(comp.itemNo)) {
      const node: GraphNode = {
        id: comp.itemNo,
        label: comp.itemName,
        type: comp.replenishmentMethod === "purchase" ? "vendor" : "item",
        durationDays: comp.leadTimeDays,
      };
      nodes.push(node);
      nodeMap.set(comp.itemNo, node);
    }

    edges.push({
      from: comp.itemNo,
      to: parentId,
      label: `${comp.quantityPer} ${comp.unitOfMeasure}`,
    });

    // Recurse into sub-assemblies (with cycle detection)
    if (comp.children && comp.children.length > 0) {
      if (!shouldStopRecursion(comp.itemNo, visited, depth)) {
        const childVisited = new Set(visited);
        childVisited.add(comp.itemNo);
        addComponentNodes(comp.itemNo, comp.children, nodes, edges, nodeMap, childVisited, depth + 1);
      }
    }
  }
}

/**
 * Topological sort using Kahn's algorithm.
 * Returns node IDs in dependency order (leaves first).
 */
function topologicalSort(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const edge of edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    adjacency.get(edge.from)!.push(edge.to);
  }

  const queue = nodes
    .filter((n) => (inDegree.get(n.id) ?? 0) === 0)
    .map((n) => n.id);

  const sorted: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  return sorted;
}

/**
 * Find long-lead-time components that exceed a threshold.
 */
export function findLongLeadItems(
  components: BOMComponent[],
  thresholdDays: number,
): BOMComponent[] {
  const results: BOMComponent[] = [];

  function walk(comps: BOMComponent[], visited: Set<string> = new Set(), depth: number = 0) {
    for (const c of comps) {
      if (c.leadTimeDays >= thresholdDays) {
        results.push(c);
      }
      if (c.children && !shouldStopRecursion(c.itemNo, visited, depth)) {
        const childVisited = new Set(visited);
        childVisited.add(c.itemNo);
        walk(c.children, childVisited, depth + 1);
      }
    }
  }

  walk(components);
  return results.sort((a, b) => b.leadTimeDays - a.leadTimeDays);
}

/**
 * Identify single-source components (only one vendor).
 */
export function findSingleSourceComponents(components: BOMComponent[]): BOMComponent[] {
  const results: BOMComponent[] = [];

  function walk(comps: BOMComponent[], visited: Set<string> = new Set(), depth: number = 0) {
    for (const c of comps) {
      if (c.replenishmentMethod === "purchase" && c.vendorNo) {
        results.push(c);
      }
      if (c.children && !shouldStopRecursion(c.itemNo, visited, depth)) {
        const childVisited = new Set(visited);
        childVisited.add(c.itemNo);
        walk(c.children, childVisited, depth + 1);
      }
    }
  }

  walk(components);
  return results;
}
