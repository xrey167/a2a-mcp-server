/**
 * Data Worker Agent — data processing, transformation, and analysis.
 *
 * Port: 8088
 *
 * Skills:
 *   parse_csv      — Parse CSV text into structured JSON records
 *   parse_json     — Validate, query (JSONPath-like), and transform JSON data
 *   transform_data — Apply map/filter/sort/group/aggregate operations on datasets
 *   analyze_data   — Compute statistics (mean, median, stddev, percentiles, correlations)
 *   pivot_table    — Create pivot table summaries from flat data
 *   data_brief     — AI-generated narrative analysis of a dataset via ask_claude
 *   remember/recall — Shared persistent memory
 */

import Fastify from "fastify";
import { z } from "zod";
import { handleMemorySkill } from "../worker-memory.js";
import { buildA2AResponse, buildA2AError, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { callPeer } from "../peer.js";
import { sanitizeUserInput } from "../prompt-sanitizer.js";

const PORT = 8088;
const NAME = "data-agent";
const FETCH_TIMEOUT = 30_000;
const UA = "A2A-Data-Agent/1.0";

// ── Zod Schemas ──────────────────────────────────────────────────

const DataSchemas = {
  parse_csv: z.looseObject({
    csv: z.string().min(1),
    delimiter: z.string().optional().default(","),
    hasHeader: z.boolean().optional().default(true),
    limit: z.number().int().positive().optional(),
  }),

  parse_json: z.looseObject({
    json: z.string().min(1),
    query: z.string().optional(),
  }),

  transform_data: z.looseObject({
    data: z.unknown(),
    operations: z.array(z.object({
      op: z.enum(["map", "filter", "sort", "group", "aggregate", "flatten", "unique", "take", "skip", "rename", "pick", "omit"]),
      field: z.string().optional(),
      fields: z.array(z.string()).optional(),
      value: z.unknown().optional(),
      direction: z.enum(["asc", "desc"]).optional().default("asc"),
      fn: z.enum(["sum", "avg", "min", "max", "count", "concat"]).optional(),
    })),
  }),

  analyze_data: z.looseObject({
    data: z.unknown(),
    fields: z.array(z.string()).optional(),
    percentiles: z.array(z.number()).optional().default([25, 50, 75, 90, 95, 99]),
  }),

  pivot_table: z.looseObject({
    data: z.unknown(),
    rowField: z.string(),
    colField: z.string().optional(),
    valueField: z.string(),
    aggregation: z.enum(["sum", "avg", "count", "min", "max"]).optional().default("sum"),
  }),

  fetch_dataset: z.looseObject({
    /** URL of a CSV or JSON resource to fetch */
    url: z.string().url(),
    /** Format hint — "auto" detects from Content-Type or file extension (default) */
    format: z.enum(["csv", "json", "auto"]).optional().default("auto"),
    /** CSV delimiter (default ",") */
    delimiter: z.string().optional().default(","),
    /** CSV has header row (default true) */
    hasHeader: z.boolean().optional().default(true),
    /** Max rows to return */
    limit: z.number().int().positive().optional(),
    /** Dot-notation path into JSON to extract the target array (e.g. "data.records") */
    jsonPath: z.string().optional(),
  }),

  data_brief: z.looseObject({
    /** Dataset to analyse — array of records (objects or primitives) */
    data: z.unknown(),
    /** Optional question or focus for the AI (e.g. "what drives the revenue variance?") */
    question: z.string().optional(),
    /** Subset of fields to include in the analysis (default: all) */
    fields: z.array(z.string()).optional(),
    /** Max records to analyse — avoids huge prompt (default 500) */
    maxRecords: z.number().int().positive().optional().default(500),
  }),
};

// ── Agent Card ───────────────────────────────────────────────────

const AGENT_CARD = {
  name: NAME,
  description: "Data agent — CSV/JSON parsing, data transformation, statistical analysis, pivot tables",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "parse_csv", name: "Parse CSV", description: "Parse CSV text into structured JSON records with configurable delimiter and header detection" },
    { id: "parse_json", name: "Parse JSON", description: "Validate JSON and optionally query it with dot-notation path expressions" },
    { id: "transform_data", name: "Transform Data", description: "Apply chained operations (map, filter, sort, group, aggregate, flatten, unique) on datasets" },
    { id: "analyze_data", name: "Analyze Data", description: "Compute statistical summaries: count, mean, median, stddev, min, max, percentiles, and value distributions" },
    { id: "pivot_table", name: "Pivot Table", description: "Create pivot table summaries from flat data with configurable row/column/value fields and aggregation" },
    { id: "fetch_dataset", name: "Fetch Dataset", description: "Fetch a CSV or JSON dataset from a URL and parse it into structured records. Auto-detects format from Content-Type. Supports jsonPath drill-down for nested JSON APIs." },
    { id: "data_brief", name: "Data Brief", description: "AI-generated narrative analysis of a dataset: runs statistical analysis then calls ask_claude to produce a plain-language summary of patterns, outliers, and insights. Accepts an optional question to focus the analysis." },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

// ── CSV Parser ───────────────────────────────────────────────────

function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCsv(csv: string, delimiter: string, hasHeader: boolean, limit?: number): Record<string, unknown>[] | string[][] {
  const lines = csv.split("\n").filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];

  if (hasHeader) {
    const headers = parseCsvLine(lines[0], delimiter);
    const dataLines = limit ? lines.slice(1, 1 + limit) : lines.slice(1);
    return dataLines.map(line => {
      const values = parseCsvLine(line, delimiter);
      const record: Record<string, unknown> = {};
      for (let i = 0; i < headers.length; i++) {
        const val = values[i] ?? "";
        // Auto-detect numbers
        const num = Number(val);
        record[headers[i]] = val !== "" && !isNaN(num) ? num : val;
      }
      return record;
    });
  }

  const dataLines = limit ? lines.slice(0, limit) : lines;
  return dataLines.map(line => parseCsvLine(line, delimiter));
}

// ── JSON Query ───────────────────────────────────────────────────

function queryJson(data: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      if (!isNaN(idx)) {
        current = current[idx];
      } else if (part === "*") {
        return current;
      } else {
        // Map over array items
        current = current.map(item => {
          if (typeof item === "object" && item !== null) return (item as Record<string, unknown>)[part];
          return undefined;
        }).filter(v => v !== undefined);
      }
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

// ── Data Transformations ─────────────────────────────────────────

type DataRow = Record<string, unknown>;

function applyOperations(data: unknown, operations: Array<{
  op: string;
  field?: string;
  fields?: string[];
  value?: unknown;
  direction?: string;
  fn?: string;
}>): unknown {
  let current = Array.isArray(data) ? [...data] : [data];

  for (const op of operations) {
    switch (op.op) {
      case "filter": {
        if (!op.field || op.value === undefined) break;
        current = current.filter(row => {
          const rowObj = row as DataRow;
          const fieldVal = rowObj[op.field!];
          if (typeof op.value === "string" && op.value.startsWith(">")) {
            return Number(fieldVal) > Number(op.value.slice(1));
          }
          if (typeof op.value === "string" && op.value.startsWith("<")) {
            return Number(fieldVal) < Number(op.value.slice(1));
          }
          if (typeof op.value === "string" && op.value.startsWith("!=")) {
            return fieldVal !== op.value.slice(2);
          }
          if (typeof op.value === "string" && op.value.startsWith("~")) {
            return String(fieldVal).toLowerCase().includes(String(op.value.slice(1)).toLowerCase());
          }
          return fieldVal === op.value;
        });
        break;
      }
      case "sort": {
        if (!op.field) break;
        const dir = op.direction === "desc" ? -1 : 1;
        current.sort((a, b) => {
          const aVal = (a as DataRow)[op.field!];
          const bVal = (b as DataRow)[op.field!];
          if (typeof aVal === "number" && typeof bVal === "number") return (aVal - bVal) * dir;
          return String(aVal).localeCompare(String(bVal)) * dir;
        });
        break;
      }
      case "group": {
        if (!op.field) break;
        const groups: Record<string, unknown[]> = {};
        for (const row of current) {
          const key = String((row as DataRow)[op.field!] ?? "null");
          (groups[key] ??= []).push(row);
        }
        return groups;
      }
      case "aggregate": {
        if (!op.field || !op.fn) break;
        const values = current.map(r => Number((r as DataRow)[op.field!])).filter(n => !isNaN(n));
        switch (op.fn) {
          case "sum": return values.reduce((a, b) => a + b, 0);
          case "avg": return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
          case "min": return values.length ? Math.min(...values) : null;
          case "max": return values.length ? Math.max(...values) : null;
          case "count": return values.length;
          case "concat": return current.map(r => (r as DataRow)[op.field!]).join(", ");
        }
        break;
      }
      case "flatten": {
        current = current.flat();
        break;
      }
      case "unique": {
        if (current.length > 50_000) throw new Error("unique: input exceeds 50,000 rows");
        if (op.field) {
          const seen = new Set<string>();
          current = current.filter(row => {
            const val = String((row as DataRow)[op.field!]);
            if (seen.has(val)) return false;
            seen.add(val);
            return true;
          });
        } else {
          current = [...new Set(current.map(r => JSON.stringify(r)))].map(s => JSON.parse(s));
        }
        break;
      }
      case "take": {
        const n = typeof op.value === "number" ? op.value : 10;
        current = current.slice(0, n);
        break;
      }
      case "skip": {
        const n = typeof op.value === "number" ? op.value : 0;
        current = current.slice(n);
        break;
      }
      case "pick": {
        if (!op.fields || op.fields.length === 0) break;
        current = current.map(row => {
          const rowObj = row as DataRow;
          const picked: DataRow = {};
          for (const f of op.fields!) {
            if (f in rowObj) picked[f] = rowObj[f];
          }
          return picked;
        });
        break;
      }
      case "omit": {
        if (!op.fields || op.fields.length === 0) break;
        const omitSet = new Set(op.fields);
        current = current.map(row => {
          const rowObj = row as DataRow;
          const kept: DataRow = {};
          for (const [k, v] of Object.entries(rowObj)) {
            if (!omitSet.has(k)) kept[k] = v;
          }
          return kept;
        });
        break;
      }
      case "rename": {
        if (!op.field || typeof op.value !== "string") break;
        current = current.map(row => {
          const rowObj = row as DataRow;
          const newRow: DataRow = {};
          for (const [k, v] of Object.entries(rowObj)) {
            newRow[k === op.field ? op.value as string : k] = v;
          }
          return newRow;
        });
        break;
      }
    }
  }

  return current;
}

// ── Statistical Analysis ─────────────────────────────────────────

interface FieldStats {
  count: number;
  type: "numeric" | "categorical" | "mixed";
  // Numeric stats
  mean?: number;
  median?: number;
  stddev?: number;
  min?: number;
  max?: number;
  sum?: number;
  percentiles?: Record<string, number>;
  // Categorical stats
  uniqueValues?: number;
  topValues?: Array<{ value: string; count: number; percent: string }>;
  // Missing
  nullCount: number;
}

function computePercentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function analyzeField(values: unknown[], percentileList: number[]): FieldStats {
  const nullCount = values.filter(v => v === null || v === undefined || v === "").length;
  const nonNull = values.filter(v => v !== null && v !== undefined && v !== "");
  const numbers = nonNull.map(Number).filter(n => !isNaN(n));

  if (numbers.length > nonNull.length * 0.8 && numbers.length > 0) {
    // Numeric field
    const sorted = [...numbers].sort((a, b) => a - b);
    const sum = numbers.reduce((a, b) => a + b, 0);
    const mean = sum / numbers.length;
    const variance = numbers.reduce((acc, n) => acc + (n - mean) ** 2, 0) / numbers.length;

    const percentiles: Record<string, number> = {};
    for (const p of percentileList) {
      percentiles[`p${p}`] = computePercentile(sorted, p);
    }

    return {
      count: values.length,
      type: "numeric",
      mean: Math.round(mean * 1000) / 1000,
      median: computePercentile(sorted, 50),
      stddev: Math.round(Math.sqrt(variance) * 1000) / 1000,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      sum: Math.round(sum * 1000) / 1000,
      percentiles,
      nullCount,
    };
  }

  // Categorical field
  const freq = new Map<string, number>();
  for (const v of nonNull) {
    const key = String(v);
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  const topValues = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([value, count]) => ({
      value,
      count,
      percent: `${Math.round((count / nonNull.length) * 100)}%`,
    }));

  return {
    count: values.length,
    type: "categorical",
    uniqueValues: freq.size,
    topValues,
    nullCount,
  };
}

function analyzeData(data: unknown[], fields?: string[], percentiles: number[] = [25, 50, 75, 90, 95, 99]): Record<string, FieldStats> {
  if (data.length === 0) return {};

  const allFields = fields ?? Object.keys(data[0] as DataRow);
  const result: Record<string, FieldStats> = {};

  for (const field of allFields) {
    const values = data.map(row => (row as DataRow)[field]);
    result[field] = analyzeField(values, percentiles);
  }

  return result;
}

// ── Pivot Table ──────────────────────────────────────────────────

function createPivotTable(
  data: unknown[],
  rowField: string,
  colField: string | undefined,
  valueField: string,
  aggregation: string,
): unknown {
  if (!colField) {
    // Single-dimension pivot: group by rowField, aggregate valueField
    const groups = new Map<string, number[]>();
    for (const row of data) {
      const r = row as DataRow;
      const key = String(r[rowField] ?? "null");
      const val = Number(r[valueField]);
      if (!isNaN(val)) {
        (groups.get(key) ?? (groups.set(key, []), groups.get(key))!).push(val);
      }
    }

    const result: Record<string, number> = {};
    for (const [key, vals] of groups) {
      result[key] = aggregate(vals, aggregation);
    }
    return result;
  }

  // Two-dimension pivot
  const rowKeys = new Set<string>();
  const colKeys = new Set<string>();
  const cells = new Map<string, number[]>();

  for (const row of data) {
    const r = row as DataRow;
    const rk = String(r[rowField] ?? "null");
    const ck = String(r[colField] ?? "null");
    const val = Number(r[valueField]);
    rowKeys.add(rk);
    colKeys.add(ck);
    if (!isNaN(val)) {
      const cellKey = `${rk}||${ck}`;
      (cells.get(cellKey) ?? (cells.set(cellKey, []), cells.get(cellKey))!).push(val);
    }
  }

  const table: Record<string, Record<string, number>> = {};
  for (const rk of rowKeys) {
    table[rk] = {};
    for (const ck of colKeys) {
      const vals = cells.get(`${rk}||${ck}`) ?? [];
      table[rk][ck] = vals.length > 0 ? aggregate(vals, aggregation) : 0;
    }
  }
  return table;
}

function aggregate(values: number[], fn: string): number {
  if (values.length === 0) return 0;
  switch (fn) {
    case "sum": return Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
    case "avg": return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
    case "count": return values.length;
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
    default: return values.reduce((a, b) => a + b, 0);
  }
}

// ── Live Data Ingestion ───────────────────────────────────────────

async function fetchDataset(
  url: string,
  format: string,
  delimiter: string,
  hasHeader: boolean,
  limit?: number,
  jsonPath?: string,
): Promise<{ format: string; rowCount: number; columns: string[]; data: unknown[] }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  // Detect format from Content-Type or URL extension when "auto"
  let resolved = format;
  const ct = res.headers.get("content-type") ?? "";
  if (resolved === "auto") {
    const urlLower = url.toLowerCase();
    if (ct.includes("text/csv") || ct.includes("application/csv") || urlLower.endsWith(".csv") || urlLower.includes(".csv?")) {
      resolved = "csv";
    } else {
      resolved = "json"; // default: treat as JSON
    }
  }
  // Bail early on HTML responses (redirects, error pages) regardless of format hint
  if (ct.includes("text/html") || ct.includes("application/xhtml")) {
    throw new Error(`fetch_dataset received HTML response from ${url} — likely a redirect or error page, not a dataset`);
  }

  const body = await res.text();
  let rows: unknown[];

  if (resolved === "csv") {
    const parsed = parseCsv(body, delimiter, hasHeader, limit);
    rows = parsed as unknown[];
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      process.stderr.write(`[${NAME}] fetch_dataset JSON parse error for ${url}: ${(err as Error).message}\n`);
      throw new Error(`Response is not valid JSON: ${(err as Error).message}`);
    }
    // Drill into nested path if requested
    if (jsonPath) {
      parsed = queryJson(parsed, jsonPath);
    }
    // Unwrap a single object into a 1-element array for consistency
    rows = Array.isArray(parsed) ? parsed : [parsed];
    if (limit) rows = rows.slice(0, limit);
  }

  // Extract column names from the first record
  const columns = rows.length > 0 && typeof rows[0] === "object" && rows[0] !== null
    ? Object.keys(rows[0] as Record<string, unknown>)
    : [];

  return { format: resolved, rowCount: rows.length, columns, data: rows };
}

// ── AI Data Brief ─────────────────────────────────────────────────

/** Max characters of serialised stats sent to the AI prompt to stay within token budget. */
const BRIEF_STATS_CHAR_LIMIT = 8_000;

async function generateDataBrief(
  data: unknown[],
  question: string | undefined,
  fields: string[] | undefined,
  maxRecords: number,
): Promise<string> {
  if (data.length === 0) throw new Error("data_brief: dataset is empty");

  const truncated = data.length > maxRecords;
  const sample = truncated ? data.slice(0, maxRecords) : data;

  const stats = analyzeData(sample, fields);
  const fieldNames = Object.keys(stats);
  if (fieldNames.length === 0) throw new Error("data_brief: no analysable fields found in dataset");

  // Serialise stats — truncate if too large to keep prompt manageable
  let statsText = safeStringify(stats, 2);
  if (statsText.length > BRIEF_STATS_CHAR_LIMIT) {
    statsText = statsText.slice(0, BRIEF_STATS_CHAR_LIMIT) + "\n... (truncated for brevity)";
  }

  const safeQuestion = question ? sanitizeUserInput(question, "question") : null;

  const prompt = `You are a data analyst writing a concise executive briefing for a business audience.

Dataset: ${sample.length} records${truncated ? ` (truncated from ${data.length})` : ""}, ${fieldNames.length} fields.
${safeQuestion ? `\nAnalyst question: ${safeQuestion}\n` : ""}
Statistical summary:
${statsText}

Write a clear, factual narrative (3–6 sentences) covering:
1. What the data represents and its scale
2. Key numeric patterns: standout means, ranges, or distributions
3. Notable categorical breakdowns or top values
4. Any anomalies, skews, or outliers worth flagging
${safeQuestion ? "5. A direct answer to the analyst question above" : ""}

Be specific with numbers. Do not speculate beyond what the statistics show.`;

  let brief: string;
  try {
    brief = await callPeer("ask_claude", { prompt }, prompt, 60_000);
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`[${NAME}] data_brief: callPeer ask_claude failed: ${cause.stack ?? cause.message}\n`);
    throw new Error(`data_brief: AI synthesis failed (${cause.message})`, { cause });
  }

  return safeStringify({
    recordCount: data.length,
    analysedRecords: sample.length,
    fieldCount: fieldNames.length,
    dataQuality: truncated ? "partial" : "ok",
    question: question ?? null,
    brief,
  }, 2);
}

// ── Skill Dispatcher ─────────────────────────────────────────────

async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;

  switch (skillId) {
    case "parse_csv": {
      const { csv, delimiter, hasHeader, limit } = DataSchemas.parse_csv.parse({
        csv: args.csv ?? text,
        ...args,
      });
      const result = parseCsv(csv, delimiter, hasHeader, limit);
      return safeStringify({ rowCount: Array.isArray(result) ? result.length : 0, data: result }, 2);
    }

    case "parse_json": {
      const { json, query } = DataSchemas.parse_json.parse({ json: args.json ?? text, ...args });
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        return `Invalid JSON: ${(err as Error).message}`;
      }
      if (query) {
        const result = queryJson(parsed, query);
        return safeStringify(result, 2);
      }
      return safeStringify(parsed, 2);
    }

    case "transform_data": {
      const { data, operations } = DataSchemas.transform_data.parse(args);
      let input = data;
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { return "Invalid data: expected JSON array or object"; }
      }
      const result = applyOperations(input, operations);
      return safeStringify(result, 2);
    }

    case "analyze_data": {
      const { data: rawData, fields, percentiles } = DataSchemas.analyze_data.parse(args);
      let data = rawData;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { return "Invalid data: expected JSON array"; }
      }
      if (!Array.isArray(data)) return "Expected an array of records";
      const stats = analyzeData(data, fields, percentiles);
      return safeStringify({
        recordCount: data.length,
        fieldCount: Object.keys(stats).length,
        fields: stats,
      }, 2);
    }

    case "pivot_table": {
      const { data: rawData, rowField, colField, valueField, aggregation } = DataSchemas.pivot_table.parse(args);
      let data = rawData;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { return "Invalid data: expected JSON array"; }
      }
      if (!Array.isArray(data)) return "Expected an array of records";
      const result = createPivotTable(data, rowField, colField, valueField, aggregation);
      return safeStringify(result, 2);
    }

    case "fetch_dataset": {
      const { url, format, delimiter, hasHeader, limit, jsonPath } = DataSchemas.fetch_dataset.parse(args);
      const result = await fetchDataset(url, format, delimiter, hasHeader, limit, jsonPath);
      return safeStringify(result, 2);
    }

    case "data_brief": {
      const { data: rawData, question, fields, maxRecords } = DataSchemas.data_brief.parse(args);
      let data = rawData;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { throw new Error("data_brief: data must be a JSON array of records"); }
      }
      if (!Array.isArray(data)) throw new Error("data_brief: data must be an array of records");
      return generateDataBrief(data, question, fields, maxRecords);
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
  const sid = skillId ?? "parse_csv";

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
