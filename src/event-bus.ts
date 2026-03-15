/**
 * Agent Event Bus — real-time pub/sub between agents.
 *
 * Enables decoupled inter-agent communication. Agents can publish events
 * and subscribe to topics without knowing about each other. This is the
 * foundation for reactive multi-agent systems.
 *
 * Features:
 *   - Topic-based pub/sub with wildcard matching (e.g. "agent.*", "workflow.#")
 *   - Event history with configurable retention
 *   - Dead letter queue for failed deliveries
 *   - Event replay from a given timestamp
 *   - Subscription filters (match on event fields)
 *
 * Usage:
 *   publish("agent.shell.completed", { taskId: "...", result: "..." });
 *   subscribe("agent.*", (event) => { ... });
 *   replay("agent.shell.completed", since);
 */

import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────

export interface AgentEvent {
  /** Unique event ID */
  id: string;
  /** Dot-separated topic (e.g. "agent.shell.completed") */
  topic: string;
  /** Event payload */
  data: unknown;
  /** Source agent or system component */
  source: string;
  /** ISO timestamp */
  timestamp: string;
  /** Correlation ID for tracing event chains */
  correlationId?: string;
  /** Optional metadata */
  meta?: Record<string, unknown>;
}

export interface Subscription {
  id: string;
  /** Topic pattern — supports * (one segment) and # (multiple segments) */
  pattern: string;
  /** Callback invoked on matching events */
  handler: (event: AgentEvent) => void | Promise<void>;
  /** Optional field-level filter: { "data.status": "completed" } */
  filter?: Record<string, unknown>;
  /** Subscriber name for debugging */
  name?: string;
  /** Created timestamp */
  createdAt: number;
  /** Number of events delivered to this subscriber */
  matchCount: number;
}

export interface DeadLetter {
  event: AgentEvent;
  subscriptionId: string;
  error: string;
  timestamp: number;
}

// ── Configuration ────────────────────────────────────────────────

const MAX_HISTORY = 1000;
const MAX_DEAD_LETTERS = 200;
const HISTORY_TTL_MS = 60 * 60 * 1000; // 1 hour
const STALE_SUB_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── State ────────────────────────────────────────────────────────

const subscriptions = new Map<string, Subscription>();
const eventHistory: AgentEvent[] = [];
const deadLetters: DeadLetter[] = [];

// ── Topic Matching ───────────────────────────────────────────────

/**
 * Match a topic against a pattern.
 * "*" matches exactly one segment, "#" matches zero or more segments.
 * Example: "agent.*.completed" matches "agent.shell.completed"
 * Example: "workflow.#" matches "workflow.step.1.done"
 */
function topicMatches(pattern: string, topic: string): boolean {
  const patternParts = pattern.split(".");
  const topicParts = topic.split(".");
  // Iterative DP to avoid exponential backtracking with multiple '#' wildcards
  const memo = new Map<string, boolean>();

  function match(pi: number, ti: number): boolean {
    const key = `${pi}:${ti}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    if (pi === patternParts.length && ti === topicParts.length) { memo.set(key, true); return true; }
    if (pi === patternParts.length) { memo.set(key, false); return false; }

    if (patternParts[pi] === "#") {
      // '#' matches zero or more segments
      for (let i = ti; i <= topicParts.length; i++) {
        if (match(pi + 1, i)) { memo.set(key, true); return true; }
      }
      memo.set(key, false);
      return false;
    }

    if (ti === topicParts.length) { memo.set(key, false); return false; }

    if (patternParts[pi] === "*" || patternParts[pi] === topicParts[ti]) {
      const result = match(pi + 1, ti + 1);
      memo.set(key, result);
      return result;
    }

    memo.set(key, false);
    return false;
  }

  return match(0, 0);
}

// ── Filter Matching ──────────────────────────────────────────────

function matchesFilter(event: AgentEvent, filter: Record<string, unknown>): boolean {
  for (const [path, expected] of Object.entries(filter)) {
    const actual = getNestedValue(event, path);
    if (actual !== expected) return false;
  }
  return true;
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ── Public API ───────────────────────────────────────────────────

/** Publish an event to all matching subscribers. */
export async function publish(
  topic: string,
  data: unknown,
  opts?: { source?: string; correlationId?: string; meta?: Record<string, unknown> },
): Promise<AgentEvent> {
  const event: AgentEvent = {
    id: randomUUID(),
    topic,
    data,
    source: opts?.source ?? "system",
    timestamp: new Date().toISOString(),
    correlationId: opts?.correlationId,
    meta: opts?.meta,
  };

  // Store in history
  eventHistory.push(event);
  pruneHistory();

  // Deliver to matching subscribers
  const deliveryPromises: Promise<void>[] = [];

  for (const [, sub] of subscriptions) {
    if (!topicMatches(sub.pattern, topic)) continue;
    if (sub.filter && !matchesFilter(event, sub.filter)) continue;

    sub.matchCount++;
    deliveryPromises.push(
      (async () => {
        try {
          await sub.handler(event);
        } catch (err) {
          deadLetters.push({
            event,
            subscriptionId: sub.id,
            error: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          });
          if (deadLetters.length > MAX_DEAD_LETTERS) {
            deadLetters.splice(0, deadLetters.length - MAX_DEAD_LETTERS);
          }
          process.stderr.write(`[event-bus] delivery failed for sub ${sub.id}: ${err}\n`);
        }
      })(),
    );
  }

  await Promise.allSettled(deliveryPromises);
  return event;
}

/** Subscribe to events matching a topic pattern. Returns subscription ID. */
export function subscribe(
  pattern: string,
  handler: (event: AgentEvent) => void | Promise<void>,
  opts?: { filter?: Record<string, unknown>; name?: string },
): string {
  const sub: Subscription = {
    id: randomUUID(),
    pattern,
    handler,
    filter: opts?.filter,
    name: opts?.name,
    createdAt: Date.now(),
    matchCount: 0,
  };
  subscriptions.set(sub.id, sub);
  process.stderr.write(`[event-bus] subscription created: ${sub.id} (${pattern})${opts?.name ? ` [${opts.name}]` : ""}\n`);
  return sub.id;
}

/** Unsubscribe by subscription ID. */
export function unsubscribe(subscriptionId: string): boolean {
  const existed = subscriptions.delete(subscriptionId);
  if (existed) process.stderr.write(`[event-bus] subscription removed: ${subscriptionId}\n`);
  return existed;
}

/** Replay events matching a topic pattern since a given timestamp. */
export function replay(
  pattern: string,
  sinceIso?: string,
  limit?: number,
): AgentEvent[] {
  const since = sinceIso ? new Date(sinceIso).getTime() : 0;
  const matching = eventHistory.filter(
    e => topicMatches(pattern, e.topic) && new Date(e.timestamp).getTime() >= since,
  );
  return limit ? matching.slice(-limit) : matching;
}

/** List all active subscriptions. */
export function listSubscriptions(): Array<{
  id: string;
  pattern: string;
  name?: string;
  createdAt: number;
  filter?: Record<string, unknown>;
}> {
  return [...subscriptions.values()].map(s => ({
    id: s.id,
    pattern: s.pattern,
    name: s.name,
    createdAt: s.createdAt,
    filter: s.filter,
  }));
}

/** Get dead letters for debugging. */
export function getDeadLetters(limit = 50): DeadLetter[] {
  return deadLetters.slice(-limit);
}

/** Get event bus stats. */
export function getEventBusStats(): {
  subscriptions: number;
  historySize: number;
  deadLetterCount: number;
  topicCounts: Record<string, number>;
} {
  const topicCounts: Record<string, number> = {};
  for (const event of eventHistory) {
    const base = event.topic.split(".").slice(0, 2).join(".");
    topicCounts[base] = (topicCounts[base] ?? 0) + 1;
  }

  return {
    subscriptions: subscriptions.size,
    historySize: eventHistory.length,
    deadLetterCount: deadLetters.length,
    topicCounts,
  };
}

/** Retry dead letters by re-publishing their events. Returns count of retried events. */
export async function replayDeadLetters(opts?: { limit?: number; olderThanMs?: number }): Promise<{
  retried: number;
  succeeded: number;
  failed: number;
  remaining: number;
}> {
  const limit = opts?.limit ?? 50;
  const cutoff = opts?.olderThanMs ? Date.now() - opts.olderThanMs : Infinity;

  // Take up to `limit` dead letters that are old enough
  const toRetry: DeadLetter[] = [];
  const kept: DeadLetter[] = [];
  for (const dl of deadLetters) {
    if (toRetry.length < limit && dl.timestamp <= cutoff) {
      toRetry.push(dl);
    } else {
      kept.push(dl);
    }
  }

  let succeeded = 0;
  let failed = 0;

  for (const dl of toRetry) {
    try {
      await publish(dl.event.topic, dl.event.data, {
        source: dl.event.source,
        correlationId: dl.event.correlationId,
        meta: { ...dl.event.meta, retriedFrom: dl.event.id },
      });
      succeeded++;
    } catch {
      // Re-add to dead letters if retry also fails
      kept.push(dl);
      failed++;
    }
  }

  // Replace dead letters array
  deadLetters.length = 0;
  deadLetters.push(...kept);

  return {
    retried: toRetry.length,
    succeeded,
    failed,
    remaining: deadLetters.length,
  };
}

/** Clear all state (for testing). */
export function resetEventBus(): void {
  subscriptions.clear();
  eventHistory.length = 0;
  deadLetters.length = 0;
}

// ── Internal ─────────────────────────────────────────────────────

function pruneHistory(): void {
  const now = Date.now();
  const cutoff = now - HISTORY_TTL_MS;
  // Find first index to keep (avoids O(n²) from repeated shift())
  let removeCount = 0;
  for (let i = 0; i < eventHistory.length; i++) {
    if (new Date(eventHistory[i].timestamp).getTime() < cutoff) {
      removeCount = i + 1;
    } else {
      break;
    }
  }
  // Also enforce max size
  const overCapacity = eventHistory.length - removeCount - MAX_HISTORY;
  if (overCapacity > 0) removeCount += overCapacity;
  if (removeCount > 0) eventHistory.splice(0, removeCount);

  // Prune stale subscriptions: created >24h ago and never matched any event
  for (const [id, sub] of subscriptions) {
    if (sub.matchCount === 0 && now - sub.createdAt > STALE_SUB_TTL_MS) {
      subscriptions.delete(id);
      process.stderr.write(`[event-bus] pruned stale subscription: ${id} (${sub.pattern})${sub.name ? ` [${sub.name}]` : ""}\n`);
    }
  }
}
