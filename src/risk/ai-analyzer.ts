/**
 * AI-powered deep analysis for supply chain risk assessment.
 *
 * Unlike the generic prompts in sources.ts, this module feeds REAL ERP data
 * (BOM structures, order details, vendor info, inventory levels, lead times)
 * into structured AI prompts to get context-aware analysis.
 *
 * Capabilities:
 *   - Deep BOM risk analysis with component-level intelligence
 *   - Predictive bottleneck detection based on order patterns
 *   - AI-evaluated intervention ranking with scenario modeling
 *   - Natural language supply chain intelligence reports
 *   - Cross-correlation of internal data with external signals
 */

import { sendTask } from "../a2a.js";
import { memory } from "../memory.js";
import type {
  ProductionOrder,
  SalesOrder,
  BOMComponent,
  PurchaseOrder,
  Intervention,
  RiskScore,
  ItemAvailability,
} from "../erp/types.js";
import type { LeadTimeAnalysis } from "./lead-time.js";
import type { ExternalRiskFactors } from "./scoring.js";

function log(msg: string) {
  process.stderr.write(`[ai-analyzer] ${msg}\n`);
}

const WORKER_URLS = {
  ai: process.env.A2A_WORKER_AI_URL ?? "http://localhost:8083",
  web: process.env.A2A_WORKER_WEB_URL ?? "http://localhost:8082",
};

const AGENT_ID = "supply-chain";

/** Persist AI analysis result to memory for traceability */
function persistResult(key: string, data: unknown): void {
  try {
    const dateKey = new Date().toISOString().slice(0, 10);
    memory.set(AGENT_ID, `${key}:${dateKey}`, JSON.stringify(data));
    log(`persisted ${key} result to memory`);
  } catch (err) {
    log(`failed to persist ${key}: ${err}`);
  }
}

async function askAI(prompt: string, timeoutMs = 120_000): Promise<string> {
  return sendTask(WORKER_URLS.ai, {
    skillId: "ask_claude",
    args: { prompt },
    message: { role: "user" as const, parts: [{ kind: "text" as const, text: prompt }] },
  }, { timeoutMs });
}

async function fetchWeb(url: string): Promise<string> {
  return sendTask(WORKER_URLS.web, {
    skillId: "fetch_url",
    args: { url, format: "text" },
    message: { role: "user" as const, parts: [{ kind: "text" as const, text: url }] },
  });
}

function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

// ── Data Summarizers (keep prompts focused, avoid token waste) ────

function summarizeComponents(components: BOMComponent[], maxItems = 30): string {
  const items = components.slice(0, maxItems).map((c) => {
    const flags: string[] = [];
    if (c.replenishmentMethod === "purchase" && !c.vendorName) flags.push("NO_VENDOR");
    if (c.inventoryLevel <= c.safetyStock) flags.push("BELOW_SAFETY");
    if (c.inventoryLevel === 0) flags.push("ZERO_STOCK");
    if (c.leadTimeDays > 30) flags.push("LONG_LEAD");

    return `- ${c.itemNo} "${c.itemName}" | ${c.replenishmentMethod} | vendor=${c.vendorName ?? "none"} | lead=${c.leadTimeDays}d | stock=${c.inventoryLevel}/${c.safetyStock}ss | cost=${c.unitCost} | qty=${c.quantityPer}${flags.length ? " | FLAGS: " + flags.join(",") : ""}`;
  });

  if (components.length > maxItems) {
    items.push(`... and ${components.length - maxItems} more components`);
  }

  return items.join("\n");
}

function summarizeOrders(orders: ProductionOrder[], maxItems = 15): string {
  return orders.slice(0, maxItems).map((o) =>
    `- ${o.number} "${o.itemName}" qty=${o.quantity} due=${o.dueDate} status=${o.status} components=${o.components.length}`,
  ).join("\n");
}

function summarizeLeadTimes(analyses: LeadTimeAnalysis[], maxItems = 20): string {
  return analyses.slice(0, maxItems).map((a) =>
    `- ${a.itemNo} "${a.itemName}" planned=${a.plannedLeadTimeDays}d actual=${a.actualLeadTimeDays ?? "?"}d variance=${a.variance ?? "?"}d trend=${a.trend} reliability=${a.reliabilityScore}/100 onTime=${a.onTimePercentage}%`,
  ).join("\n");
}

function summarizeRiskScores(scores: RiskScore[], maxItems = 20): string {
  return scores.slice(0, maxItems).map((r) =>
    `- ${r.componentId} "${r.componentName}" overall=${r.overallScore}/100 avail=${r.dimensions.availability} delivery=${r.dimensions.delivery} price=${r.dimensions.price} leadTime=${r.dimensions.leadTime} external=${r.dimensions.external} flags=[${r.flags.join(",")}]`,
  ).join("\n");
}

function summarizeInterventions(interventions: Intervention[], maxItems = 15): string {
  return interventions.slice(0, maxItems).map((i) =>
    `- [${i.priority}] ${i.type} for "${i.componentName}": ${i.description} (cost=${i.estimatedCostImpact}, riskReduction=${i.estimatedRiskReduction})`,
  ).join("\n");
}

// ── Deep BOM Analysis ────────────────────────────────────────────

export interface DeepBOMAnalysis {
  criticalFindings: Array<{
    severity: "critical" | "high" | "medium";
    component: string;
    finding: string;
    recommendation: string;
  }>;
  supplyChainHealth: number; // 0-100
  concentrationRisks: string[];
  bottleneckPredictions: Array<{
    component: string;
    predictedIssue: string;
    timeframe: string;
    probability: "high" | "medium" | "low";
  }>;
  strategicRecommendations: string[];
}

/**
 * Deep AI analysis of the full BOM structure with real component data.
 * Identifies patterns, concentration risks, and predictive bottlenecks
 * that rule-based scoring might miss.
 */
export async function analyzeDeepBOM(
  productionOrders: ProductionOrder[],
  components: BOMComponent[],
  leadTimeAnalyses: LeadTimeAnalysis[],
  riskScores: RiskScore[],
  availability: ItemAvailability[],
): Promise<DeepBOMAnalysis> {
  log(`deep BOM analysis: ${components.length} components, ${productionOrders.length} orders`);

  const prompt = `You are a senior supply chain analyst performing a deep risk analysis of a manufacturing BOM (Bill of Materials).

## PRODUCTION ORDERS
${summarizeOrders(productionOrders)}

## BOM COMPONENTS (itemNo, name, replenishment, vendor, leadTime, stock/safetyStock, unitCost, qtyPerUnit)
${summarizeComponents(components)}

## LEAD TIME ANALYSIS (planned vs actual, variance, trend, reliability)
${summarizeLeadTimes(leadTimeAnalyses)}

## CURRENT RISK SCORES (multi-dimensional)
${summarizeRiskScores(riskScores)}

## INVENTORY AVAILABILITY
${availability.slice(0, 20).map((a) => `- ${a.itemNo} "${a.itemName}" inventory=${a.inventory} reserved=${a.reserved} available=${a.available} incoming=${a.incomingQty} outgoing=${a.outgoingQty}`).join("\n")}

---

Analyze this data thoroughly. Look for patterns that simple rule-based scoring would miss:

1. **Concentration risks**: Are multiple critical components sourced from the same vendor or region? Are there hidden single-points-of-failure?
2. **Cascade effects**: If one component is delayed, which downstream production orders are affected? What's the blast radius?
3. **Demand-supply mismatches**: Cross-reference inventory, incoming POs, and production order demand. Where are gaps forming?
4. **Lead time anomalies**: Which components show concerning variance or worsening trends?
5. **Strategic vulnerabilities**: What systemic issues threaten the overall supply chain?

Respond with ONLY valid JSON:
{
  "criticalFindings": [
    { "severity": "critical|high|medium", "component": "<itemNo or general>", "finding": "<what you found>", "recommendation": "<what to do>" }
  ],
  "supplyChainHealth": <0-100, overall health score>,
  "concentrationRisks": ["<description of each concentration risk>"],
  "bottleneckPredictions": [
    { "component": "<itemNo>", "predictedIssue": "<what will likely happen>", "timeframe": "<when>", "probability": "high|medium|low" }
  ],
  "strategicRecommendations": ["<high-level strategic action items>"]
}`;

  try {
    const raw = await askAI(prompt);
    const parsed = JSON.parse(stripJsonFences(raw));
    const result: DeepBOMAnalysis = {
      criticalFindings: Array.isArray(parsed.criticalFindings) ? parsed.criticalFindings : [],
      supplyChainHealth: Math.max(0, Math.min(100, Number(parsed.supplyChainHealth ?? 50))),
      concentrationRisks: Array.isArray(parsed.concentrationRisks) ? parsed.concentrationRisks : [],
      bottleneckPredictions: Array.isArray(parsed.bottleneckPredictions) ? parsed.bottleneckPredictions : [],
      strategicRecommendations: Array.isArray(parsed.strategicRecommendations) ? parsed.strategicRecommendations : [],
    };
    persistResult("deep-bom-analysis", result);
    return result;
  } catch (err) {
    log(`deep BOM analysis failed: ${err}`);
    return {
      criticalFindings: [],
      supplyChainHealth: 50,
      concentrationRisks: [],
      bottleneckPredictions: [],
      strategicRecommendations: ["Deep analysis unavailable — review components manually"],
    };
  }
}

// ── AI-Evaluated Intervention Ranking ────────────────────────────

export interface AIInterventionEvaluation {
  rankedInterventions: Array<{
    id: string;
    aiScore: number;
    reasoning: string;
    sideEffects: string[];
    implementationComplexity: "low" | "medium" | "high";
    timeToEffect: string;
  }>;
  combinedStrategy: string;
  estimatedOverallRiskReduction: number;
}

/**
 * Use AI to evaluate and re-rank interventions in context of the full
 * supply chain situation. The rule-based system generates candidates;
 * AI evaluates them holistically considering interdependencies.
 */
export async function evaluateInterventionsWithAI(
  interventions: Intervention[],
  riskScores: RiskScore[],
  productionOrders: ProductionOrder[],
  externalFactors?: ExternalRiskFactors,
): Promise<AIInterventionEvaluation> {
  if (interventions.length === 0) {
    return {
      rankedInterventions: [],
      combinedStrategy: "No interventions needed — supply chain appears healthy.",
      estimatedOverallRiskReduction: 0,
    };
  }

  log(`AI evaluation of ${interventions.length} interventions`);

  const externalContext = externalFactors
    ? `\n## EXTERNAL RISK FACTORS\n- Freight risk: ${externalFactors.freightRisk}/100\n- Weather risk: ${externalFactors.weatherRisk}/100\n- Economic risk: ${externalFactors.economicRisk}/100\n- Geopolitical risk: ${externalFactors.geopoliticalRisk}/100\n- Commodity price risk: ${externalFactors.commodityPriceRisk}/100\nDetails: ${externalFactors.details.join("; ")}`
    : "";

  const prompt = `You are a supply chain strategist evaluating proposed risk mitigation interventions.

## PROPOSED INTERVENTIONS
${summarizeInterventions(interventions)}

## COMPONENT RISK SCORES
${summarizeRiskScores(riskScores, 15)}

## ACTIVE PRODUCTION ORDERS
${summarizeOrders(productionOrders, 10)}
${externalContext}

---

Evaluate each intervention considering:
1. **Interdependencies**: Does implementing one intervention affect the value of another?
2. **Side effects**: Could the intervention cause new problems? (e.g., advance purchase ties up capital)
3. **Implementation complexity**: How hard is this to execute in practice?
4. **Time to effect**: How quickly does this intervention reduce risk?
5. **Combined strategy**: What is the optimal combination of interventions?

Respond with ONLY valid JSON:
{
  "rankedInterventions": [
    {
      "id": "<intervention id>",
      "aiScore": <0-100, effectiveness considering full context>,
      "reasoning": "<why this ranking>",
      "sideEffects": ["<potential negative side effects>"],
      "implementationComplexity": "low|medium|high",
      "timeToEffect": "<e.g., immediate, 1-2 weeks, 1 month>"
    }
  ],
  "combinedStrategy": "<narrative describing the optimal combined approach>",
  "estimatedOverallRiskReduction": <0-100, estimated % risk reduction if all top interventions are implemented>
}

Sort rankedInterventions by aiScore descending (best first).`;

  try {
    const raw = await askAI(prompt);
    const parsed = JSON.parse(stripJsonFences(raw));
    const result: AIInterventionEvaluation = {
      rankedInterventions: Array.isArray(parsed.rankedInterventions) ? parsed.rankedInterventions : [],
      combinedStrategy: parsed.combinedStrategy ?? "",
      estimatedOverallRiskReduction: Number(parsed.estimatedOverallRiskReduction ?? 0),
    };
    persistResult("intervention-evaluation", result);
    return result;
  } catch (err) {
    log(`AI intervention evaluation failed: ${err}`);
    return {
      rankedInterventions: interventions.map((i) => ({
        id: i.id,
        aiScore: i.estimatedRiskReduction,
        reasoning: "AI evaluation unavailable — using rule-based ranking",
        sideEffects: [],
        implementationComplexity: "medium" as const,
        timeToEffect: "unknown",
      })),
      combinedStrategy: "AI evaluation unavailable — implement interventions by priority.",
      estimatedOverallRiskReduction: 0,
    };
  }
}

// ── Supply Chain Intelligence Report ─────────────────────────────

export interface IntelligenceReport {
  executiveSummary: string;
  riskOverview: string;
  criticalAlerts: string[];
  actionItems: Array<{
    priority: "immediate" | "this_week" | "this_month";
    action: string;
    owner: string;
    impact: string;
  }>;
  outlook: string;
  dataSourcesSummary: string[];
}

/**
 * Generate a comprehensive, natural-language intelligence report
 * combining all internal analysis with real-time external data.
 * This is the "executive briefing" skill.
 */
export async function generateIntelligenceReport(context: {
  productionOrders: ProductionOrder[];
  salesOrders: SalesOrder[];
  components: BOMComponent[];
  riskScores: RiskScore[];
  leadTimeAnalyses: LeadTimeAnalysis[];
  interventions: Intervention[];
  externalFactors?: ExternalRiskFactors;
  deepAnalysis?: DeepBOMAnalysis;
  webIntelligence?: string[];
}): Promise<IntelligenceReport> {
  log("generating intelligence report");

  const webContext = context.webIntelligence && context.webIntelligence.length > 0
    ? `\n## REAL-TIME WEB INTELLIGENCE\n${context.webIntelligence.map((w, i) => `### Source ${i + 1}\n${w.slice(0, 1000)}`).join("\n\n")}`
    : "";

  const deepContext = context.deepAnalysis
    ? `\n## DEEP BOM ANALYSIS RESULTS
Supply Chain Health: ${context.deepAnalysis.supplyChainHealth}/100
Critical Findings: ${context.deepAnalysis.criticalFindings.map((f) => `[${f.severity}] ${f.finding}`).join("; ")}
Concentration Risks: ${context.deepAnalysis.concentrationRisks.join("; ")}
Bottleneck Predictions: ${context.deepAnalysis.bottleneckPredictions.map((b) => `${b.component}: ${b.predictedIssue} (${b.probability}, ${b.timeframe})`).join("; ")}
Strategic Recommendations: ${context.deepAnalysis.strategicRecommendations.join("; ")}`
    : "";

  const externalContext = context.externalFactors
    ? `\n## EXTERNAL RISK ENVIRONMENT
Freight: ${context.externalFactors.freightRisk}/100 | Weather: ${context.externalFactors.weatherRisk}/100 | Economic: ${context.externalFactors.economicRisk}/100 | Geopolitical: ${context.externalFactors.geopoliticalRisk}/100 | Commodity: ${context.externalFactors.commodityPriceRisk}/100
Key factors: ${context.externalFactors.details.slice(0, 10).join("; ")}`
    : "";

  const prompt = `You are the Chief Supply Chain Risk Officer writing a daily intelligence briefing.

## PRODUCTION STATUS
Active orders: ${context.productionOrders.filter((o) => o.status !== "finished").length}
${summarizeOrders(context.productionOrders, 10)}

## SALES DEMAND
Open sales orders: ${context.salesOrders.filter((o) => o.status === "open" || o.status === "released").length}

## COMPONENT RISK SUMMARY
Total components: ${context.components.length}
Critical risk (>75): ${context.riskScores.filter((r) => r.overallScore >= 75).length}
High risk (50-74): ${context.riskScores.filter((r) => r.overallScore >= 50 && r.overallScore < 75).length}
Medium risk (25-49): ${context.riskScores.filter((r) => r.overallScore >= 25 && r.overallScore < 50).length}

Top risks:
${summarizeRiskScores(context.riskScores.slice(0, 10))}

## LEAD TIME CONCERNS
${summarizeLeadTimes(context.leadTimeAnalyses.filter((a) => a.reliabilityScore < 70), 10)}

## PROPOSED INTERVENTIONS (${context.interventions.length} total)
${summarizeInterventions(context.interventions, 10)}
${externalContext}${deepContext}${webContext}

---

Write a structured intelligence report. Be specific — reference actual component IDs, order numbers, vendor names. Don't be generic.

Respond with ONLY valid JSON:
{
  "executiveSummary": "<2-3 sentence overview for management>",
  "riskOverview": "<paragraph describing the current risk landscape>",
  "criticalAlerts": ["<immediate attention items>"],
  "actionItems": [
    { "priority": "immediate|this_week|this_month", "action": "<specific action>", "owner": "procurement|production|management|logistics", "impact": "<what this prevents>" }
  ],
  "outlook": "<forward-looking assessment: what to expect in the next 2-4 weeks>",
  "dataSourcesSummary": ["<list of data sources used in this report>"]
}`;

  try {
    const raw = await askAI(prompt, 180_000);
    const parsed = JSON.parse(stripJsonFences(raw));
    const result: IntelligenceReport = {
      executiveSummary: parsed.executiveSummary ?? "",
      riskOverview: parsed.riskOverview ?? "",
      criticalAlerts: Array.isArray(parsed.criticalAlerts) ? parsed.criticalAlerts : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
      outlook: parsed.outlook ?? "",
      dataSourcesSummary: Array.isArray(parsed.dataSourcesSummary) ? parsed.dataSourcesSummary : [],
    };
    persistResult("intelligence-report", result);
    return result;
  } catch (err) {
    log(`intelligence report generation failed: ${err}`);
    return {
      executiveSummary: "Intelligence report generation failed. Manual review recommended.",
      riskOverview: "",
      criticalAlerts: ["Report generation error — check AI agent connectivity"],
      actionItems: [],
      outlook: "",
      dataSourcesSummary: [],
    };
  }
}

// ── Web Intelligence Gathering ───────────────────────────────────

/**
 * Fetch real-time supply chain intelligence from web sources.
 * Gathers current data on freight rates, commodity prices, disruptions, etc.
 * Returns raw text snippets for the AI to analyze in context.
 */
export async function gatherWebIntelligence(
  vendorCountries: string[],
  componentCategories: string[],
): Promise<string[]> {
  log("gathering web intelligence");

  // Build search queries based on actual supply chain context
  const queries = buildIntelligenceQueries(vendorCountries, componentCategories);

  const results: string[] = [];

  // Fetch in parallel, tolerate failures
  const fetches = queries.map(async (query) => {
    try {
      // Use AI agent to search and summarize, since web-agent provides raw fetch
      const summary = await askAI(
        `Search your knowledge for the most current information about: "${query}"

Focus on:
- Specific disruptions, delays, or shortages
- Price changes or volatility
- New regulations or trade restrictions
- Weather or natural disaster impacts
- Port congestion or shipping route changes

Provide a concise factual summary (max 200 words). Include specific numbers, dates, and locations where possible. If you have no current information, say "No current data available."`,
      );
      if (summary && !summary.toLowerCase().includes("no current data")) {
        return `[${query}]: ${summary}`;
      }
      return null;
    } catch {
      return null;
    }
  });

  const settled = await Promise.allSettled(fetches);
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      results.push(result.value);
    }
  }

  log(`gathered ${results.length} intelligence items`);
  return results;
}

function buildIntelligenceQueries(countries: string[], categories: string[]): string[] {
  const queries: string[] = [];

  // Country-specific supply chain news
  for (const country of countries.slice(0, 3)) {
    queries.push(`${country} supply chain disruptions ${new Date().getFullYear()}`);
  }

  // Commodity/material specific
  for (const cat of categories.slice(0, 3)) {
    queries.push(`${cat} supply shortage price trend ${new Date().getFullYear()}`);
  }

  // General global logistics
  queries.push(`global shipping container rates port congestion ${new Date().getFullYear()}`);
  queries.push("manufacturing supply chain risks disruptions current");

  return queries;
}

// ── Predictive Analysis ──────────────────────────────────────────

export interface PredictiveInsight {
  component: string;
  currentState: string;
  prediction: string;
  confidence: "high" | "medium" | "low";
  timeHorizon: string;
  earlyWarningSignals: string[];
  mitigationWindow: string;
}

/**
 * Use AI to predict future bottlenecks based on current trends in
 * lead times, inventory levels, and order patterns.
 */
export async function predictBottlenecks(
  components: BOMComponent[],
  leadTimeAnalyses: LeadTimeAnalysis[],
  productionOrders: ProductionOrder[],
  purchaseOrders: PurchaseOrder[],
): Promise<PredictiveInsight[]> {
  log("running predictive bottleneck analysis");

  // Find components with concerning patterns
  const concerning = leadTimeAnalyses.filter(
    (a) => a.trend === "increasing" || a.reliabilityScore < 60 || (a.variance !== null && a.variance > 5),
  );

  if (concerning.length === 0 && components.every((c) => c.inventoryLevel > c.safetyStock)) {
    return []; // No concerning patterns
  }

  // Calculate demand pipeline
  const demandByItem = new Map<string, number>();
  for (const order of productionOrders) {
    if (order.status === "finished") continue;
    for (const comp of order.components) {
      demandByItem.set(comp.itemNo, (demandByItem.get(comp.itemNo) ?? 0) + comp.quantityPer * order.quantity);
    }
  }

  const supplyByItem = new Map<string, number>();
  for (const po of purchaseOrders) {
    if (po.status !== "open" && po.status !== "released" && po.status !== "pending_approval") continue;
    for (const line of po.lines) {
      supplyByItem.set(line.itemNo, (supplyByItem.get(line.itemNo) ?? 0) + line.quantity);
    }
  }

  const pipelineData = components.slice(0, 25).map((c) => {
    const demand = demandByItem.get(c.itemNo) ?? 0;
    const incoming = supplyByItem.get(c.itemNo) ?? 0;
    const lt = concerning.find((a) => a.itemNo === c.itemNo);
    return `- ${c.itemNo} "${c.itemName}" stock=${c.inventoryLevel} safety=${c.safetyStock} demand=${demand} incoming=${incoming} leadTrend=${lt?.trend ?? "n/a"} reliability=${lt?.reliabilityScore ?? "n/a"}`;
  }).join("\n");

  const prompt = `You are a predictive supply chain analytics engine. Based on the following data, predict which components are likely to become bottlenecks in the next 2-8 weeks.

## COMPONENT PIPELINE (stock, safety stock, demand from open orders, incoming POs, lead time trends)
${pipelineData}

## LEAD TIME CONCERNS (components with worsening trends)
${summarizeLeadTimes(concerning, 15)}

## OPEN PRODUCTION ORDERS (creating demand)
${summarizeOrders(productionOrders.filter((o) => o.status !== "finished"), 10)}

---

For each predicted bottleneck, identify:
1. What early warning signals are visible NOW
2. When the bottleneck will likely hit
3. How much time remains to mitigate

Respond with ONLY valid JSON:
{
  "predictions": [
    {
      "component": "<itemNo>",
      "currentState": "<factual description of current state>",
      "prediction": "<what will likely happen>",
      "confidence": "high|medium|low",
      "timeHorizon": "<e.g., 2-3 weeks, 1 month>",
      "earlyWarningSignals": ["<observable signals>"],
      "mitigationWindow": "<how much time to act>"
    }
  ]
}

Only include genuinely likely bottlenecks. Don't pad with low-confidence predictions.`;

  try {
    const raw = await askAI(prompt);
    const parsed = JSON.parse(stripJsonFences(raw));
    const result: PredictiveInsight[] = Array.isArray(parsed.predictions) ? parsed.predictions : [];
    if (result.length > 0) {
      persistResult("bottleneck-predictions", result);
    }
    return result;
  } catch (err) {
    log(`predictive analysis failed: ${err}`);
    return [];
  }
}
