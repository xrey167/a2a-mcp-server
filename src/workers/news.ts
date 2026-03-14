/**
 * News Worker Agent — RSS feed fetching, news aggregation, clustering, and signal detection.
 *
 * Port: 8089
 *
 * Skills:
 *   fetch_rss       — Fetch and parse a single RSS/Atom feed into structured articles
 *   aggregate_feeds — Fetch multiple feeds, merge and deduplicate articles
 *   classify_news   — Classify articles by category and threat/importance level
 *   cluster_news    — Cluster similar articles using text similarity (Jaccard index)
 *   detect_signals  — Detect anomalous signals: velocity spikes, emerging topics
 *   remember/recall — Shared persistent memory
 */

import Fastify from "fastify";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { buildA2AResponse, buildA2AError, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { validateUrlNotInternal } from "../worker-utils.js";

const PORT = 8089;
const NAME = "news-agent";

// ── Zod Schemas ──────────────────────────────────────────────────

const NewsSchemas = {
  fetch_rss: z.object({
    url: z.string().url(),
    limit: z.number().int().positive().optional().default(50),
    timeout: z.number().int().positive().optional().default(15000),
  }).passthrough(),

  aggregate_feeds: z.object({
    urls: z.array(z.string().url()).min(1).max(50),
    limit: z.number().int().positive().optional().default(100),
    dedup: z.boolean().optional().default(true),
    sortBy: z.enum(["date", "title"]).optional().default("date"),
  }).passthrough(),

  classify_news: z.object({
    articles: z.array(z.object({
      title: z.string(),
      description: z.string().optional().default(""),
      source: z.string().optional().default(""),
    })).min(1),
  }).passthrough(),

  cluster_news: z.object({
    articles: z.array(z.object({
      title: z.string(),
      description: z.string().optional().default(""),
      source: z.string().optional().default(""),
      link: z.string().optional().default(""),
      pubDate: z.string().optional().default(""),
    })).min(1),
    threshold: z.number().min(0).max(1).optional().default(0.3),
  }).passthrough(),

  detect_signals: z.object({
    articles: z.array(z.object({
      title: z.string(),
      description: z.string().optional().default(""),
      source: z.string().optional().default(""),
      pubDate: z.string().optional().default(""),
      category: z.string().optional().default(""),
    })).min(1),
    baselineHours: z.number().positive().optional().default(24),
    spikeMultiplier: z.number().positive().optional().default(3),
  }).passthrough(),
};

// ── Agent Card ───────────────────────────────────────────────────

const AGENT_CARD = {
  name: NAME,
  description: "News agent — RSS/Atom feed parsing, multi-source aggregation, article clustering, classification, and signal detection",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "fetch_rss", name: "Fetch RSS", description: "Fetch and parse an RSS/Atom feed into structured article records" },
    { id: "aggregate_feeds", name: "Aggregate Feeds", description: "Fetch multiple RSS feeds, merge, deduplicate, and sort articles" },
    { id: "classify_news", name: "Classify News", description: "Classify articles by category (conflict, economic, tech, etc.) and importance level" },
    { id: "cluster_news", name: "Cluster News", description: "Group similar articles into clusters using Jaccard text similarity" },
    { id: "detect_signals", name: "Detect Signals", description: "Detect anomalous patterns: topic velocity spikes, emerging stories, source concentration" },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

// ── RSS/Atom Parser ──────────────────────────────────────────────

interface Article {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  source: string;
  category: string;
}

/**
 * Lightweight regex-based RSS/Atom parser.
 *
 * Limitations:
 * - This is NOT a full XML parser; it uses regex extraction which can fail on
 *   malformed XML, deeply nested tags, or namespace-prefixed duplicates.
 * - Self-closing tags with content attributes (e.g. Atom <link href="..."/>)
 *   are handled specially but other self-closing patterns may be missed.
 * - CDATA sections are supported (see extractTag), but nested CDATA or CDATA
 *   containing "]]>" literals will not parse correctly.
 * - Feeds with unusual encodings or XML declarations may cause issues.
 * - For production use with diverse feed sources, consider a proper XML/RSS
 *   parsing library (e.g. fast-xml-parser, rss-parser).
 */

/**
 * Minimal XML tag extractor — no dependency needed for RSS/Atom parsing.
 * Extracts the text content of the first occurrence of a tag.
 * Handles CDATA sections (e.g. <title><![CDATA[Some <b>text</b>]]></title>).
 */
function extractTag(xml: string, tag: string): string {
  // Handle CDATA sections
  const cdataPattern = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const cdataMatch = xml.match(cdataPattern);
  if (cdataMatch) return cdataMatch[1].trim();

  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(pattern);
  return match ? match[1].trim().replace(/<[^>]+>/g, "") : "";
}

/** Extract href from Atom link tag */
function extractAtomLink(xml: string): string {
  const match = xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>|<link[^>]*>([^<]+)<\/link>/i);
  if (match) return (match[1] ?? match[2] ?? "").trim();
  return "";
}

function parseRssFeed(xml: string, sourceUrl: string, limit: number): Article[] {
  const articles: Article[] = [];

  // Detect feed type
  const isAtom = xml.includes("<feed") && xml.includes("xmlns=\"http://www.w3.org/2005/Atom\"") || xml.includes("<entry>");

  if (isAtom) {
    // Atom feed
    const entries = xml.split(/<entry[\s>]/i).slice(1);
    for (const entry of entries.slice(0, limit)) {
      articles.push({
        title: extractTag(entry, "title"),
        link: extractAtomLink(entry) || extractTag(entry, "id"),
        description: extractTag(entry, "summary") || extractTag(entry, "content"),
        pubDate: extractTag(entry, "published") || extractTag(entry, "updated"),
        source: sourceUrl,
        category: extractTag(entry, "category") || "",
      });
    }
  } else {
    // RSS 2.0 / RSS 1.0
    const items = xml.split(/<item[\s>]/i).slice(1);
    for (const item of items.slice(0, limit)) {
      articles.push({
        title: extractTag(item, "title"),
        link: extractTag(item, "link") || extractAtomLink(item),
        description: extractTag(item, "description") || extractTag(item, "content:encoded"),
        pubDate: extractTag(item, "pubDate") || extractTag(item, "dc:date"),
        source: sourceUrl,
        category: extractTag(item, "category") || "",
      });
    }
  }

  return articles.filter(a => a.title.length > 0);
}

// validateUrlNotInternal() imported from ../worker-utils.js

async function fetchRss(url: string, limit: number, timeout: number): Promise<Article[]> {
  validateUrlNotInternal(url);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { "User-Agent": "A2A-News-Agent/1.0", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const xml = await res.text();
  return parseRssFeed(xml, url, limit);
}

// ── Deduplication ────────────────────────────────────────────────

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function deduplicateArticles(articles: Article[]): Article[] {
  const seen = new Set<string>();
  return articles.filter(a => {
    // Deduplicate by normalized title or link
    const key = normalizeTitle(a.title);
    if (seen.has(key)) return false;
    if (a.link && seen.has(a.link)) return false;
    seen.add(key);
    if (a.link) seen.add(a.link);
    return true;
  });
}

// ── Classification ───────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  conflict: ["war", "attack", "missile", "strike", "military", "troops", "combat", "invasion", "bomb", "airstrike", "casualties", "killed", "wounded", "ceasefire", "frontline"],
  geopolitics: ["sanctions", "diplomacy", "summit", "treaty", "nato", "un ", "g7", "g20", "bilateral", "ambassador", "foreign minister", "state department"],
  economic: ["gdp", "inflation", "interest rate", "federal reserve", "central bank", "recession", "stock", "market", "trade deficit", "unemployment", "fiscal"],
  cyber: ["hack", "breach", "ransomware", "malware", "cyber", "vulnerability", "exploit", "apt", "phishing", "ddos"],
  climate: ["earthquake", "hurricane", "flood", "wildfire", "drought", "tsunami", "volcano", "storm", "climate change", "emissions"],
  tech: ["ai ", "artificial intelligence", "machine learning", "startup", "silicon valley", "tech company", "semiconductor", "chip", "quantum", "blockchain"],
  energy: ["oil", "opec", "crude", "natural gas", "pipeline", "lng", "renewable", "solar", "wind energy", "nuclear energy", "petroleum"],
  humanitarian: ["refugee", "displacement", "famine", "humanitarian", "aid", "crisis", "poverty", "migration", "asylum"],
};

const CRITICAL_TERMS = ["breaking", "urgent", "emergency", "crisis", "war declared", "nuclear", "invasion", "mass casualt"];
const HIGH_TERMS = ["escalat", "tension", "sanction", "deploy", "mobiliz", "threat", "alert", "surge"];

// Pre-compiled regex for category keyword matching — avoids iterating all keywords per article.
// Each category gets a single regex that matches any of its keywords in one pass.
const CATEGORY_KEYWORD_REGEX: Array<{ category: string; regex: RegExp; keywords: string[] }> =
  Object.entries(CATEGORY_KEYWORDS).map(([cat, keywords]) => ({
    category: cat,
    regex: new RegExp(keywords.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi"),
    keywords,
  }));

function classifyArticle(title: string, description: string): { category: string; importance: string; score: number } {
  const text = `${title} ${description}`.toLowerCase();

  // Category detection — uses pre-compiled regex for efficient matching
  let bestCategory = "general";
  let bestCatScore = 0;
  for (const { category, regex } of CATEGORY_KEYWORD_REGEX) {
    regex.lastIndex = 0;
    let matches = 0;
    while (regex.exec(text) !== null) matches++;
    if (matches > bestCatScore) {
      bestCatScore = matches;
      bestCategory = category;
    }
  }

  // Importance scoring
  let importance = "low";
  let score = 0;
  for (const term of CRITICAL_TERMS) {
    if (text.includes(term)) { importance = "critical"; score = 5; break; }
  }
  if (score === 0) {
    for (const term of HIGH_TERMS) {
      if (text.includes(term)) { importance = "high"; score = 3; break; }
    }
  }
  if (score === 0 && bestCatScore >= 2) {
    importance = "medium";
    score = 2;
  }
  if (score === 0) {
    importance = "low";
    score = 1;
  }

  return { category: bestCategory, importance, score };
}

// ── Clustering (Jaccard Similarity) ──────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(t => t.length > 2) // skip very short words
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface Cluster {
  id: number;
  articles: Array<{ title: string; source: string; link: string; pubDate: string }>;
  representativeTitle: string;
  size: number;
}

function clusterArticles(
  articles: Array<{ title: string; description?: string; source?: string; link?: string; pubDate?: string }>,
  threshold: number,
): Cluster[] {
  const tokenSets = articles.map(a => tokenize(`${a.title} ${a.description ?? ""}`));
  const assigned = new Array(articles.length).fill(-1);
  const clusters: Cluster[] = [];

  for (let i = 0; i < articles.length; i++) {
    if (assigned[i] >= 0) continue;

    // Start new cluster
    const clusterId = clusters.length;
    const cluster: Cluster = {
      id: clusterId,
      articles: [{
        title: articles[i].title,
        source: articles[i].source ?? "",
        link: articles[i].link ?? "",
        pubDate: articles[i].pubDate ?? "",
      }],
      representativeTitle: articles[i].title,
      size: 1,
    };
    assigned[i] = clusterId;

    // Find similar articles
    for (let j = i + 1; j < articles.length; j++) {
      if (assigned[j] >= 0) continue;
      const sim = jaccardSimilarity(tokenSets[i], tokenSets[j]);
      if (sim >= threshold) {
        assigned[j] = clusterId;
        cluster.articles.push({
          title: articles[j].title,
          source: articles[j].source ?? "",
          link: articles[j].link ?? "",
          pubDate: articles[j].pubDate ?? "",
        });
        cluster.size++;
      }
    }

    clusters.push(cluster);
  }

  // Sort clusters by size descending
  return clusters.sort((a, b) => b.size - a.size);
}

// ── Signal Detection ─────────────────────────────────────────────

interface Signal {
  type: string;
  topic: string;
  count: number;
  baseline: number;
  multiplier: number;
  articles: string[];
}

function detectSignals(
  articles: Array<{ title: string; description?: string; source?: string; pubDate?: string; category?: string }>,
  baselineHours: number,
  spikeMultiplier: number,
): { signals: Signal[]; topicCounts: Record<string, number>; sourceCounts: Record<string, number> } {
  const now = Date.now();
  const baselineCutoff = now - baselineHours * 60 * 60 * 1000;
  const recentCutoff = now - (baselineHours / 4) * 60 * 60 * 1000; // Recent = last quarter of baseline window

  // Separate articles into baseline and recent
  const baseline: typeof articles = [];
  const recent: typeof articles = [];

  for (const a of articles) {
    const ts = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    if (ts > recentCutoff) {
      recent.push(a);
    } else if (ts > baselineCutoff) {
      baseline.push(a);
    } else {
      // No valid date — include in baseline
      baseline.push(a);
    }
  }

  // Extract topics (significant bigrams and keywords)
  function extractTopics(text: string): string[] {
    const lower = text.toLowerCase();
    const words = lower.replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3);
    const topics: string[] = [];
    // Single keywords from category terms — uses pre-compiled regex for O(n) matching per category
    for (const { regex } of CATEGORY_KEYWORD_REGEX) {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(lower)) !== null) {
        topics.push(m[0].trim());
      }
    }
    // Bigrams
    for (let i = 0; i < words.length - 1; i++) {
      topics.push(`${words[i]} ${words[i + 1]}`);
    }
    return topics;
  }

  // Count topics in baseline and recent
  const baselineTopics = new Map<string, number>();
  const recentTopics = new Map<string, number>();

  for (const a of baseline) {
    for (const topic of extractTopics(`${a.title} ${a.description ?? ""}`)) {
      baselineTopics.set(topic, (baselineTopics.get(topic) ?? 0) + 1);
    }
  }
  for (const a of recent) {
    for (const topic of extractTopics(`${a.title} ${a.description ?? ""}`)) {
      recentTopics.set(topic, (recentTopics.get(topic) ?? 0) + 1);
    }
  }

  // Normalize baseline to recent time window
  const baselineWindowHours = baselineHours * 0.75;
  const recentWindowHours = baselineHours * 0.25;
  const normFactor = recentWindowHours / (baselineWindowHours || 1);

  // Detect spikes
  const signals: Signal[] = [];
  for (const [topic, recentCount] of recentTopics) {
    const baselineCount = (baselineTopics.get(topic) ?? 0) * normFactor;
    const effectiveBaseline = Math.max(baselineCount, 1);
    const multiplier = recentCount / effectiveBaseline;

    if (multiplier >= spikeMultiplier && recentCount >= 2) {
      const relatedArticles = recent
        .filter(a => `${a.title} ${a.description ?? ""}`.toLowerCase().includes(topic))
        .map(a => a.title)
        .slice(0, 5);

      signals.push({
        type: "velocity_spike",
        topic,
        count: recentCount,
        baseline: Math.round(effectiveBaseline * 100) / 100,
        multiplier: Math.round(multiplier * 100) / 100,
        articles: relatedArticles,
      });
    }
  }

  // Sort signals by multiplier descending
  signals.sort((a, b) => b.multiplier - a.multiplier);

  // Source concentration
  const sourceCounts: Record<string, number> = {};
  for (const a of articles) {
    const src = a.source || "unknown";
    sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
  }

  // Overall topic counts
  const topicCounts: Record<string, number> = {};
  for (const [topic, count] of recentTopics) {
    if (count >= 2) topicCounts[topic] = count;
  }

  return {
    signals: signals.slice(0, 20),
    topicCounts,
    sourceCounts,
  };
}

// ── Skill Dispatcher ─────────────────────────────────────────────

async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;

  switch (skillId) {
    case "fetch_rss": {
      const { url, limit, timeout } = NewsSchemas.fetch_rss.parse({ url: args.url ?? text, ...args });
      const articles = await fetchRss(url, limit, timeout);
      return safeStringify({ feedUrl: url, articleCount: articles.length, articles }, 2);
    }

    case "aggregate_feeds": {
      const { urls, limit, dedup, sortBy } = NewsSchemas.aggregate_feeds.parse(args);
      const results = await Promise.allSettled(
        urls.map(url => fetchRss(url, Math.ceil(limit / urls.length) + 10, 15000))
      );
      let allArticles: Article[] = [];
      const errors: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "fulfilled") {
          allArticles.push(...r.value);
        } else {
          errors.push(`${urls[i]}: ${r.reason?.message ?? "failed"}`);
        }
      }
      if (dedup) allArticles = deduplicateArticles(allArticles);
      if (sortBy === "date") {
        allArticles.sort((a, b) => {
          const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
          const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
          return db - da;
        });
      } else {
        allArticles.sort((a, b) => a.title.localeCompare(b.title));
      }
      allArticles = allArticles.slice(0, limit);
      return safeStringify({
        feedCount: urls.length,
        successCount: urls.length - errors.length,
        articleCount: allArticles.length,
        errors: errors.length > 0 ? errors : undefined,
        articles: allArticles,
      }, 2);
    }

    case "classify_news": {
      const { articles } = NewsSchemas.classify_news.parse(args);
      const classified = articles.map(a => ({
        title: a.title,
        source: a.source,
        ...classifyArticle(a.title, a.description),
      }));
      // Summary counts
      const byCat: Record<string, number> = {};
      const byImportance: Record<string, number> = {};
      for (const c of classified) {
        byCat[c.category] = (byCat[c.category] ?? 0) + 1;
        byImportance[c.importance] = (byImportance[c.importance] ?? 0) + 1;
      }
      return safeStringify({
        totalArticles: classified.length,
        byCategory: byCat,
        byImportance: byImportance,
        articles: classified,
      }, 2);
    }

    case "cluster_news": {
      const { articles, threshold } = NewsSchemas.cluster_news.parse(args);
      const clusters = clusterArticles(articles, threshold);
      return safeStringify({
        totalArticles: articles.length,
        clusterCount: clusters.length,
        multiArticleClusters: clusters.filter(c => c.size > 1).length,
        clusters,
      }, 2);
    }

    case "detect_signals": {
      const { articles, baselineHours, spikeMultiplier } = NewsSchemas.detect_signals.parse(args);
      const result = detectSignals(articles, baselineHours, spikeMultiplier);
      return safeStringify({
        totalArticles: articles.length,
        signalCount: result.signals.length,
        ...result,
      }, 2);
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
  const sid = skillId ?? "fetch_rss";

  try {
    const result = await handleSkill(sid, args ?? {}, text);
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
