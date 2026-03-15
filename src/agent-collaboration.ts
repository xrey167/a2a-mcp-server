/**
 * Agent Collaboration — multi-agent consensus and negotiation protocol.
 *
 * Enables patterns not possible with simple delegation:
 *   - Fan-out: send the same query to multiple agents and merge results
 *   - Consensus: agents vote/score and the best result wins
 *   - Debate: agents critique each other's outputs for refinement
 *   - Map-reduce: distribute work across agents and aggregate
 *
 * No other A2A project offers structured multi-agent collaboration protocols.
 *
 * Usage:
 *   const result = await collaborate({
 *     strategy: "consensus",
 *     query: "What's the best architecture for this app?",
 *     agents: ["ai-agent", "code-agent", "design-agent"],
 *     mergeStrategy: "best_score",
 *   }, dispatch);
 */

import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────

export type CollaborationStrategy = "fan_out" | "consensus" | "debate" | "map_reduce";
export type MergeStrategy = "concat" | "best_score" | "majority_vote" | "custom";

export interface CollaborationRequest {
  /** Collaboration strategy */
  strategy: CollaborationStrategy;
  /** The query or task to collaborate on */
  query: string;
  /** Agent names or skill IDs to involve */
  agents: string[];
  /** How to merge results (default: concat for fan_out, best_score for consensus) */
  mergeStrategy?: MergeStrategy;
  /** For debate: max rounds of refinement (default: 2) */
  maxRounds?: number;
  /** For map_reduce: items to distribute across agents */
  items?: unknown[];
  /** Timeout per agent call in ms (default: 60000) */
  timeoutMs?: number;
  /** Custom merge prompt (used when mergeStrategy is "custom") */
  mergePrompt?: string;
  /** Agent/skill to use for scoring/synthesis (default: "ask_claude") */
  judgeAgent?: string;
}

export interface AgentResponse {
  agent: string;
  result: string;
  score?: number;
  durationMs: number;
  error?: string;
  round?: number;
}

export interface CollaborationResult {
  id: string;
  strategy: CollaborationStrategy;
  /** Final merged output */
  output: string;
  /** Individual agent responses */
  responses: AgentResponse[];
  /** Agreement score (0-1) for consensus strategies */
  agreement?: number;
  /** Number of rounds (for debate) */
  rounds?: number;
  totalDurationMs: number;
  /** Warning when consensus/scoring degraded (e.g. judge returned invalid JSON) */
  warning?: string;
}

export type CollabDispatchFn = (skillId: string, args: Record<string, unknown>, text: string) => Promise<string>;

// ── Execution ────────────────────────────────────────────────────

export async function collaborate(
  request: CollaborationRequest,
  dispatch: CollabDispatchFn,
): Promise<CollaborationResult> {
  const startTime = Date.now();
  const id = randomUUID();

  switch (request.strategy) {
    case "fan_out":
      return fanOut(id, request, dispatch, startTime);
    case "consensus":
      return consensus(id, request, dispatch, startTime);
    case "debate":
      return debate(id, request, dispatch, startTime);
    case "map_reduce":
      return mapReduce(id, request, dispatch, startTime);
    default:
      throw new Error(`Unknown collaboration strategy: ${request.strategy}`);
  }
}

// ── Fan-Out: parallel queries, merge results ─────────────────────

async function fanOut(
  id: string,
  request: CollaborationRequest,
  dispatch: CollabDispatchFn,
  startTime: number,
): Promise<CollaborationResult> {
  const responses = await queryAgents(request.agents, request.query, dispatch, request.timeoutMs);

  const merge = request.mergeStrategy ?? "concat";
  let output: string;

  if (merge === "concat") {
    output = responses
      .filter(r => !r.error)
      .map(r => `[${r.agent}]\n${r.result}`)
      .join("\n\n---\n\n");
  } else if (merge === "best_score" || merge === "majority_vote") {
    process.stderr.write(`[collaboration] merge strategy "${merge}" is not meaningful for fan_out — falling back to concat\n`);
    output = responses.filter(r => !r.error).map(r => `[${r.agent}]\n${r.result}`).join("\n\n---\n\n");
  } else if (merge === "custom" && request.mergePrompt) {
    const responseSummary = responses
      .filter(r => !r.error)
      .map(r => `<response agent="${r.agent}">\n${r.result}\n</response>`)
      .join("\n");
    const judgeAgent = request.judgeAgent ?? "ask_claude";
    output = await dispatch(judgeAgent, {
      prompt: `<merge_instructions>\n${request.mergePrompt}\n</merge_instructions>\n\n<responses>\n${responseSummary}\n</responses>`,
    }, request.mergePrompt);
  } else {
    output = responses.filter(r => !r.error).map(r => r.result).join("\n\n");
  }

  return {
    id,
    strategy: "fan_out",
    output,
    responses,
    totalDurationMs: Date.now() - startTime,
  };
}

// ── Consensus: agents score each other, best wins ────────────────

async function consensus(
  id: string,
  request: CollaborationRequest,
  dispatch: CollabDispatchFn,
  startTime: number,
): Promise<CollaborationResult> {
  // Phase 1: Get responses from all agents
  const responses = await queryAgents(request.agents, request.query, dispatch, request.timeoutMs);
  const validResponses = responses.filter(r => !r.error);

  if (validResponses.length === 0) {
    return { id, strategy: "consensus", output: "No agents responded successfully", responses, totalDurationMs: Date.now() - startTime };
  }

  if (validResponses.length === 1) {
    return { id, strategy: "consensus", output: validResponses[0]?.result ?? "", responses, agreement: 1, totalDurationMs: Date.now() - startTime };
  }

  // Phase 2: Have an AI score all responses
  const responseSummary = validResponses
    .map((r, i) => `<option id="${i}" agent="${r.agent}">\n${r.result}\n</option>`)
    .join("\n");

  const judgeAgent = request.judgeAgent ?? "ask_claude";
  const scoringPrompt = `You are judging multiple agent responses to a query.

<query>
${request.query}
</query>

<responses>
${responseSummary}
</responses>

Rate each option on quality (1-10) and explain briefly. Then pick the best one.
Reply with JSON: { "scores": [{"id": 0, "score": 8, "reason": "..."}, ...], "bestId": 0, "agreement": 0.85 }
"agreement" is 0-1 indicating how much the responses agree with each other.`;

  try {
    const scoring = await dispatch(judgeAgent, { prompt: scoringPrompt }, scoringPrompt);
    const parsed = JSON.parse(scoring);
    const bestId = parsed.bestId ?? 0;
    const agreement = parsed.agreement ?? 0;

    // Attach scores to responses
    for (const score of parsed.scores ?? []) {
      const idx = score.id;
      if (idx >= 0 && idx < validResponses.length) {
        validResponses[idx]!.score = score.score;
      }
    }

    return {
      id,
      strategy: "consensus",
      output: validResponses[bestId]?.result ?? validResponses[0]?.result ?? "",
      responses,
      agreement,
      totalDurationMs: Date.now() - startTime,
    };
  } catch {
    // Fallback: return the first response with explicit degradation warning.
    // Callers MUST check for the `warning` field to know consensus was not achieved.
    const warning = "Consensus scoring failed: judge returned invalid JSON. Falling back to first response (unscored). This result has NOT been validated by consensus — treat with lower confidence.";
    process.stderr.write(`[collaboration] ${warning}\n`);
    return {
      id,
      strategy: "consensus",
      output: validResponses[0]?.result ?? "",
      responses,
      agreement: 0,
      totalDurationMs: Date.now() - startTime,
      warning,
    };
  }
}

// ── Debate: agents critique and refine each other ────────────────

async function debate(
  id: string,
  request: CollaborationRequest,
  dispatch: CollabDispatchFn,
  startTime: number,
): Promise<CollaborationResult> {
  const maxRounds = request.maxRounds ?? 2;
  const allResponses: AgentResponse[] = [];

  // Round 1: Initial responses
  let currentResponses = await queryAgents(request.agents, request.query, dispatch, request.timeoutMs);
  allResponses.push(...currentResponses);

  for (let round = 1; round < maxRounds; round++) {
    const validPrev = currentResponses.filter(r => !r.error);
    if (validPrev.length < 2) break;

    // Each agent critiques others and refines their answer
    const critiqueTasks = request.agents.map(async (agent) => {
      // Filter by agent identity (not index) to correctly exclude self even when some agents failed
      const others = validPrev.filter(r => r.agent !== agent);
      const othersSummary = others
        .map(r => `<perspective agent="${r.agent}">\n${r.result}\n</perspective>`)
        .join("\n");

      const myPrev = validPrev.find(r => r.agent === agent);
      const prompt = `You previously answered:
<previous_answer>
${myPrev?.result ?? "(no previous answer)"}
</previous_answer>

Other agents responded:
${othersSummary}

<original_question>
${request.query}
</original_question>

Consider the other perspectives. If they raise valid points you missed, improve your answer. If you disagree, explain why.
Provide your refined answer.`;

      const agentStart = Date.now();
      const timeoutMs = request.timeoutMs ?? 60_000;
      try {
        let timerId: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          dispatch(agent, { prompt }, prompt),
          new Promise<never>((_, reject) => {
            timerId = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
          }),
        ]).finally(() => clearTimeout(timerId));
        return { agent, result, durationMs: Date.now() - agentStart, round: round + 1 } as AgentResponse;
      } catch (err) {
        return { agent, result: "", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - agentStart, round: round + 1 } as AgentResponse;
      }
    });

    currentResponses = await Promise.all(critiqueTasks);
    allResponses.push(...currentResponses);
  }

  // Final synthesis
  const finalResponses = currentResponses.filter(r => !r.error);
  let output: string;

  const judgeAgent = request.judgeAgent ?? "ask_claude";
  if (finalResponses.length > 1) {
    const summary = finalResponses
      .map(r => `<perspective agent="${r.agent}">\n${r.result}\n</perspective>`)
      .join("\n");
    try {
      output = await dispatch(judgeAgent, {
        prompt: `Synthesize these refined perspectives into a single coherent answer:\n\n${summary}\n\n<original_question>\n${request.query}\n</original_question>`,
      }, "");
    } catch {
      output = finalResponses[0]?.result ?? "";
    }
  } else {
    output = finalResponses[0]?.result ?? "No agents completed the debate";
  }

  return {
    id,
    strategy: "debate",
    output,
    responses: allResponses,
    rounds: Math.min(maxRounds, allResponses.length / request.agents.length),
    totalDurationMs: Date.now() - startTime,
  };
}

// ── Map-Reduce: distribute items across agents ───────────────────

async function mapReduce(
  id: string,
  request: CollaborationRequest,
  dispatch: CollabDispatchFn,
  startTime: number,
): Promise<CollaborationResult> {
  const items = request.items ?? [];
  if (items.length === 0) {
    return { id, strategy: "map_reduce", output: "No items to process", responses: [], totalDurationMs: Date.now() - startTime };
  }

  // Distribute items across agents round-robin; only use as many agents as there are items
  if (request.agents.length === 0) {
    return { id, strategy: "map_reduce", output: "No agents available for map_reduce", responses: [], totalDurationMs: Date.now() - startTime };
  }
  const agentCount = Math.min(request.agents.length, items.length);
  const chunks: Array<{ agent: string; items: unknown[] }> = request.agents.slice(0, agentCount).map(a => ({ agent: a, items: [] }));
  for (let i = 0; i < items.length; i++) {
    chunks[i % agentCount]!.items.push(items[i]);
  }

  // Map phase: each agent processes its chunk
  const responses = await Promise.all(
    chunks.map(async (chunk) => {
      const agentStart = Date.now();
      try {
        const prompt = `${request.query}\n\nProcess these items:\n${JSON.stringify(chunk.items, null, 2)}`;
        const result = await dispatch(chunk.agent, { prompt, items: chunk.items }, prompt);
        return { agent: chunk.agent, result, durationMs: Date.now() - agentStart } as AgentResponse;
      } catch (err) {
        return { agent: chunk.agent, result: "", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - agentStart } as AgentResponse;
      }
    }),
  );

  // Reduce phase: merge results
  const validResults = responses.filter(r => !r.error);
  let output: string;

  if (request.mergePrompt) {
    const resultsSummary = validResults.map(r => r.result).join("\n\n");
    const judgeAgent = request.judgeAgent ?? "ask_claude";
    try {
      output = await dispatch(judgeAgent, {
        prompt: `<merge_instructions>\n${request.mergePrompt}\n</merge_instructions>\n\n<partial_results>\n${resultsSummary}\n</partial_results>`,
      }, "");
    } catch {
      output = resultsSummary;
    }
  } else {
    output = validResults.map(r => r.result).join("\n\n");
  }

  return {
    id,
    strategy: "map_reduce",
    output,
    responses,
    totalDurationMs: Date.now() - startTime,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

async function queryAgents(
  agents: string[],
  query: string,
  dispatch: CollabDispatchFn,
  timeoutMs = 60_000,
): Promise<AgentResponse[]> {
  return Promise.all(
    agents.map(async (agent) => {
      const agentStart = Date.now();
      try {
        let timerId: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          dispatch(agent, { prompt: query, message: query }, query),
          new Promise<never>((_, reject) => {
            timerId = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
          }),
        ]).finally(() => clearTimeout(timerId));
        return { agent, result, durationMs: Date.now() - agentStart };
      } catch (err) {
        return { agent, result: "", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - agentStart };
      }
    }),
  );
}
