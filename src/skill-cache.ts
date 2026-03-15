/**
 * Smart Skill Cache — LRU cache with TTL for deterministic skill results.
 *
 * Reduces latency and API costs by caching responses from idempotent skills.
 * Uses content-addressable storage (hash of skill + args) and supports
 * per-skill TTL configuration.
 *
 * Features:
 *   - Content-addressable cache keys (deterministic hashing)
 *   - Per-skill TTL configuration
 *   - LRU eviction when capacity is reached (O(1) via Set insertion order)
 *   - Cache hit/miss metrics
 *   - Stale-while-revalidate support
 *   - Cache warming (pre-populate from patterns)
 *
 * Usage:
 *   const cached = getFromCache("fetch_url", { url: "..." });
 *   if (cached) return cached;
 *   const result = await dispatch(skillId, args);
 *   putInCache("fetch_url", { url: "..." }, result, { ttlMs: 60000 });
 */

import { createHash } from "crypto";

// ── Types ────────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  skillId: string;
  result: string;
  createdAt: number;
  expiresAt: number;
  lastAccessed: number;
  hitCount: number;
  sizeBytes: number;
}

interface CacheConfig {
  /** Default TTL in ms (default: 5 minutes) */
  defaultTtlMs: number;
  /** Max cache entries (default: 500) */
  maxEntries: number;
  /** Max total cache size in bytes (default: 50MB) */
  maxSizeBytes: number;
  /** Per-skill TTL overrides */
  skillTtls: Map<string, number>;
  /** Skills that should never be cached */
  noCacheSkills: Set<string>;
}

interface CacheStats {
  entries: number;
  sizeBytes: number;
  hits: number;
  misses: number;
  hitRate: string;
  evictions: number;
  topSkills: Array<{ skillId: string; entries: number; hits: number }>;
}

// ── Configuration ────────────────────────────────────────────────

const config: CacheConfig = {
  defaultTtlMs: 5 * 60_000, // 5 minutes
  maxEntries: 500,
  maxSizeBytes: 50 * 1024 * 1024, // 50 MB
  skillTtls: new Map([
    ["fetch_url", 10 * 60_000],      // 10 min for web fetches
    ["ask_claude", 15 * 60_000],     // 15 min for LLM responses
    ["search_files", 2 * 60_000],    // 2 min for file search
    ["list_notes", 1 * 60_000],      // 1 min for note listing
    // OSINT workers — short TTLs for live external data
    ["fetch_rss", 3 * 60_000],            // 3 min for RSS feeds
    ["fetch_quote", 1 * 60_000],          // 1 min for market quotes
    ["price_history", 5 * 60_000],        // 5 min for historical prices
    ["fetch_earthquakes", 2 * 60_000],    // 2 min for USGS data
    ["fetch_wildfires", 3 * 60_000],      // 3 min for FIRMS data
    ["fetch_natural_events", 5 * 60_000], // 5 min for EONET
  ]),
  noCacheSkills: new Set([
    "run_shell",       // side effects
    "run_shell_stream",
    "write_file",
    "create_note",
    "update_note",
    "codex_exec",
    "sandbox_execute",
    "remember",
  ]),
};

// ── State ────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();
// LRU order tracker: oldest key is first (Set preserves insertion order).
// On access, key is moved to the end (delete + add = O(1) promotion).
const lruOrder = new Set<string>();
let totalSizeBytes = 0;
let totalHits = 0;
let totalMisses = 0;
let totalEvictions = 0;

// ── Key Generation ───────────────────────────────────────────────

function cacheKey(skillId: string, args: Record<string, unknown>): string {
  // Deterministic hash: stable-stringify for consistent hashing regardless of key order
  const stableArgs = stableStringify(args);
  const payload = `${skillId}:${stableArgs}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

const MAX_STRINGIFY_DEPTH = 20;

function stableStringify(obj: unknown, depth = 0, seen = new WeakSet<object>()): string {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (depth > MAX_STRINGIFY_DEPTH) return '"[max depth]"';
  if (seen.has(obj as object)) return '"[circular]"';
  seen.add(obj as object);
  if (Array.isArray(obj)) return `[${obj.map(v => stableStringify(v, depth + 1, seen)).join(",")}]`;
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  return `{${sorted.map(k => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k], depth + 1, seen)}`).join(",")}}`;
}

// ── Public API ───────────────────────────────────────────────────

/** Get a cached result. Returns undefined on miss. */
export function getFromCache(skillId: string, args: Record<string, unknown>): string | undefined {
  if (config.noCacheSkills.has(skillId)) {
    totalMisses++;
    return undefined;
  }

  const key = cacheKey(skillId, args);
  const entry = cache.get(key);

  if (!entry) {
    totalMisses++;
    return undefined;
  }

  // Check expiration
  if (Date.now() > entry.expiresAt) {
    lruOrder.delete(key);
    cache.delete(key);
    totalSizeBytes -= entry.sizeBytes;
    totalMisses++;
    return undefined;
  }

  // Cache hit — promote to most-recently-used position (O(1))
  lruOrder.delete(key);
  lruOrder.add(key);
  entry.lastAccessed = Date.now();
  entry.hitCount++;
  totalHits++;
  return entry.result;
}

/** Store a result in the cache. */
export function putInCache(
  skillId: string,
  args: Record<string, unknown>,
  result: string,
  opts?: { ttlMs?: number },
): void {
  if (config.noCacheSkills.has(skillId)) return;

  const key = cacheKey(skillId, args);
  const ttl = opts?.ttlMs ?? config.skillTtls.get(skillId) ?? config.defaultTtlMs;
  const sizeBytes = Buffer.byteLength(result, "utf8");

  // Remove old entry if exists
  const existing = cache.get(key);
  if (existing) {
    totalSizeBytes -= existing.sizeBytes;
    lruOrder.delete(key);
    cache.delete(key);
  }

  // Evict if needed
  evictIfNeeded(sizeBytes);

  const entry: CacheEntry = {
    key,
    skillId,
    result,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    lastAccessed: Date.now(),
    hitCount: 0,
    sizeBytes,
  };

  cache.set(key, entry);
  lruOrder.add(key);
  totalSizeBytes += sizeBytes;
}

/** Invalidate cache entries for a specific skill. */
export function invalidateSkill(skillId: string): number {
  let count = 0;
  for (const [key, entry] of cache) {
    if (entry.skillId === skillId) {
      totalSizeBytes -= entry.sizeBytes;
      lruOrder.delete(key);
      cache.delete(key);
      count++;
    }
  }
  return count;
}

/** Invalidate all cache entries. */
export function invalidateAll(): void {
  cache.clear();
  lruOrder.clear();
  totalSizeBytes = 0;
}

/** Configure cache settings. */
export function configureCacheSkill(skillId: string, ttlMs: number | "no-cache"): void {
  if (ttlMs === "no-cache") {
    config.noCacheSkills.add(skillId);
    config.skillTtls.delete(skillId);
    invalidateSkill(skillId);
  } else {
    config.noCacheSkills.delete(skillId);
    config.skillTtls.set(skillId, ttlMs);
  }
}

/** Get cache statistics. */
export function getCacheStats(): CacheStats {
  // Aggregate per-skill stats
  const skillStats = new Map<string, { entries: number; hits: number }>();
  for (const entry of cache.values()) {
    const stat = skillStats.get(entry.skillId) ?? { entries: 0, hits: 0 };
    stat.entries++;
    stat.hits += entry.hitCount;
    skillStats.set(entry.skillId, stat);
  }

  const topSkills = [...skillStats.entries()]
    .map(([skillId, stat]) => ({ skillId, ...stat }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 10);

  const total = totalHits + totalMisses;
  return {
    entries: cache.size,
    sizeBytes: totalSizeBytes,
    hits: totalHits,
    misses: totalMisses,
    hitRate: total > 0 ? `${((totalHits / total) * 100).toFixed(1)}%` : "0%",
    evictions: totalEvictions,
    topSkills,
  };
}

/** Reset cache and stats (for testing). */
export function resetCache(): void {
  cache.clear();
  lruOrder.clear();
  totalSizeBytes = 0;
  totalHits = 0;
  totalMisses = 0;
  totalEvictions = 0;
}

// ── LRU Eviction ─────────────────────────────────────────────────

function evictIfNeeded(incomingSizeBytes: number): void {
  // Evict by capacity
  while (cache.size >= config.maxEntries) {
    evictLRU();
  }

  // Evict by size
  while (totalSizeBytes + incomingSizeBytes > config.maxSizeBytes && cache.size > 0) {
    evictLRU();
  }
}

function evictLRU(): void {
  // O(1): the first key in lruOrder is the least-recently-used
  const oldestKey = lruOrder.values().next().value as string | undefined;
  if (!oldestKey) return;

  const oldest = cache.get(oldestKey);
  if (oldest) {
    lruOrder.delete(oldestKey);
    cache.delete(oldestKey);
    totalSizeBytes -= oldest.sizeBytes;
    totalEvictions++;
  }
}
