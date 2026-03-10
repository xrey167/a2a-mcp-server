// src/output-filter.ts
// RTK-inspired output filter engine — reduces LLM token consumption by
// applying a declarative pipeline of transformations to skill results.
//
// Pipeline stages (in order):
//   1. ANSI escape stripping
//   2. Regex replacements
//   3. Line filtering (strip/keep by pattern)
//   4. Error extraction (test runners)
//   5. Head/tail line selection
//   6. Absolute line cap

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getConfig } from "./config.js";

// ── Types ────────────────────────────────────────────────────────

export interface FilterContext {
  skillId: string;
  workerName: string;
  command?: string;
  exitCode?: number;
}

export interface FilterResult {
  output: string;
  originalLength: number;
  filteredLength: number;
  savedTokens: number;
  filtersApplied: string[];
  teeFile?: string;
}

interface FilterRule {
  matchSkill?: string;
  matchCommand?: string;
  stripAnsi?: boolean;
  replace?: Array<{ pattern: string; replacement: string }>;
  stripLinesMatching?: string[];
  keepLinesMatching?: string[];
  extractErrors?: boolean;
  headLines?: number;
  tailLines?: number;
  maxLines?: number;
  onEmpty?: string;
}

interface FilterConfig {
  filters: Record<string, FilterRule>;
  defaults: {
    stripAnsi: boolean;
    maxLines: number;
  };
}

// ── ANSI Stripping ───────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// ── Built-in Filter Rules ────────────────────────────────────────

const BUILTIN_FILTERS: Record<string, FilterRule> = {
  "git-status": {
    matchSkill: "run_shell",
    matchCommand: "^git\\s+status",
    stripAnsi: true,
    stripLinesMatching: [
      "^\\s*\\(use \"git ",
      "^\\s*$",
    ],
    headLines: 50,
  },
  "git-diff": {
    matchSkill: "run_shell",
    matchCommand: "^git\\s+diff",
    stripAnsi: true,
    headLines: 200,
    tailLines: 20,
  },
  "git-log": {
    matchSkill: "run_shell",
    matchCommand: "^git\\s+log",
    stripAnsi: true,
    headLines: 50,
  },
  "npm-install": {
    matchSkill: "run_shell",
    matchCommand: "^(npm|bun|yarn|pnpm)\\s+(install|i|add)\\b",
    stripAnsi: true,
    stripLinesMatching: [
      "^npm warn",
      "^npm notice",
      "^\\s*$",
      "^\\d+ packages? .* looking for funding",
      "^\\s+run `npm fund`",
    ],
    headLines: 30,
    tailLines: 5,
  },
  "npm-ls": {
    matchSkill: "run_shell",
    matchCommand: "^(npm|bun|pnpm)\\s+(ls|list)\\b",
    stripAnsi: true,
    stripLinesMatching: ["deduped$"],
    headLines: 60,
  },
  "test-output": {
    matchSkill: "run_shell",
    matchCommand: "(jest|vitest|bun\\s+test|pytest|cargo\\s+test|mocha|ava)\\b",
    stripAnsi: true,
    extractErrors: true,
    headLines: 10,
    tailLines: 30,
  },
  "docker-ps": {
    matchSkill: "run_shell",
    matchCommand: "^docker\\s+(ps|images)",
    stripAnsi: true,
    replace: [
      { pattern: "([a-f0-9]{12})[a-f0-9]+", replacement: "$1" },
      { pattern: "sha256:[a-f0-9]{64}", replacement: "sha256:..." },
    ],
    headLines: 50,
  },
  "kubectl": {
    matchSkill: "run_shell",
    matchCommand: "^kubectl\\s+",
    stripAnsi: true,
    headLines: 80,
    tailLines: 10,
  },
  "ls-long": {
    matchSkill: "run_shell",
    matchCommand: "^ls\\s+-.*l|^ls\\s+--",
    stripAnsi: true,
    headLines: 60,
    tailLines: 10,
  },
  "find-output": {
    matchSkill: "run_shell",
    matchCommand: "^find\\s+",
    stripAnsi: true,
    headLines: 100,
    tailLines: 20,
  },
  "log-output": {
    matchSkill: "run_shell",
    matchCommand: "(tail|journalctl|docker\\s+logs)\\b",
    stripAnsi: true,
    replace: [
      // Collapse repeated identical lines
      { pattern: "(^.+$)(\\n\\1)+", replacement: "$1 (repeated)" },
    ],
    headLines: 50,
    tailLines: 30,
  },
  "cargo-build": {
    matchSkill: "run_shell",
    matchCommand: "^cargo\\s+(build|clippy)",
    stripAnsi: true,
    stripLinesMatching: [
      "^\\s+Compiling\\s+",
      "^\\s+Downloading\\s+",
      "^\\s+Downloaded\\s+",
    ],
    headLines: 30,
    tailLines: 20,
  },
};

// ── Config Loading ───────────────────────────────────────────────

let userConfig: FilterConfig | null = null;

function loadUserFilters(): FilterConfig {
  if (userConfig) return userConfig;

  const defaults = { stripAnsi: true, maxLines: 200 };
  const customPath = join(process.env.HOME ?? homedir(), ".a2a-mcp", "filters.json");

  if (existsSync(customPath)) {
    try {
      const raw = JSON.parse(readFileSync(customPath, "utf-8"));
      userConfig = {
        filters: raw.filters ?? {},
        defaults: { ...defaults, ...raw.defaults },
      };
    } catch (e) {
      process.stderr.write(`[output-filter] failed to load ${customPath}: ${e}\n`);
      userConfig = { filters: {}, defaults };
    }
  } else {
    userConfig = { filters: {}, defaults };
  }

  return userConfig;
}

// ── Matching ─────────────────────────────────────────────────────

function findMatchingRules(ctx: FilterContext): Array<{ name: string; rule: FilterRule }> {
  const config = loadUserFilters();
  const allRules = { ...BUILTIN_FILTERS, ...config.filters };
  const matches: Array<{ name: string; rule: FilterRule }> = [];

  for (const [name, rule] of Object.entries(allRules)) {
    if (rule.matchSkill && rule.matchSkill !== ctx.skillId) continue;
    if (rule.matchCommand && ctx.command) {
      try {
        if (!new RegExp(rule.matchCommand, "i").test(ctx.command)) continue;
      } catch { continue; }
    } else if (rule.matchCommand && !ctx.command) {
      continue;
    }
    matches.push({ name, rule });
  }

  return matches;
}

// ── Error Extraction ─────────────────────────────────────────────

function extractTestErrors(output: string): string {
  const lines = output.split("\n");
  const errorLines: string[] = [];
  let inErrorBlock = false;
  let summaryStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect summary section (usually at the end)
    if (/^(Tests?|Test Suites?|FAILED|PASS|FAIL|ERROR|test result):?\s/i.test(line) ||
        /^\d+\s+(passing|failing|passed|failed)/i.test(line) ||
        /^(Tests|Snapshots|Time):/i.test(line)) {
      summaryStarted = true;
      errorLines.push(line);
      continue;
    }

    if (summaryStarted) {
      errorLines.push(line);
      continue;
    }

    // Detect error/failure lines
    if (/^\s*(FAIL|ERROR|✕|✗|×|FAILED|panic|error\[)/i.test(line) ||
        /^\s+at\s+/.test(line) ||
        /^\s+\d+\s+\|/.test(line) ||
        /AssertionError|Error:|Expected|Received|assert/i.test(line)) {
      inErrorBlock = true;
      errorLines.push(line);
      continue;
    }

    if (inErrorBlock) {
      // Continue capturing error context until a blank line or new test
      if (line.trim() === "" || /^\s*(✓|✔|PASS|ok\s)/i.test(line)) {
        inErrorBlock = false;
        errorLines.push(""); // blank separator
      } else {
        errorLines.push(line);
      }
    }
  }

  if (errorLines.length === 0) return output;
  return errorLines.join("\n").trim();
}

// ── Pipeline ─────────────────────────────────────────────────────

export function applyFilters(output: string, ctx: FilterContext): FilterResult {
  const config = loadUserFilters();
  const ofConfig = getConfig().outputFilter;

  // Master switch
  if (!ofConfig?.enabled) {
    return {
      output,
      originalLength: output.length,
      filteredLength: output.length,
      savedTokens: 0,
      filtersApplied: [],
    };
  }

  const originalLength = output.length;
  const filtersApplied: string[] = [];
  let result = output;

  // Find matching rules
  const rules = findMatchingRules(ctx);

  // Stage 1: ANSI stripping (always on by default)
  const shouldStripAnsi = rules.some(r => r.rule.stripAnsi) || config.defaults.stripAnsi;
  if (shouldStripAnsi && ANSI_RE.test(result)) {
    result = stripAnsi(result);
    filtersApplied.push("ansi-strip");
  }

  if (rules.length === 0) {
    // Apply default maxLines only
    const lines = result.split("\n");
    if (lines.length > config.defaults.maxLines) {
      const head = lines.slice(0, Math.floor(config.defaults.maxLines * 0.7));
      const tail = lines.slice(-Math.floor(config.defaults.maxLines * 0.3));
      result = [...head, `\n... (${lines.length - head.length - tail.length} lines omitted) ...\n`, ...tail].join("\n");
      filtersApplied.push("default-cap");
    }
  }

  for (const { name, rule } of rules) {
    // Stage 2: Regex replacements
    if (rule.replace) {
      for (const { pattern, replacement } of rule.replace) {
        try {
          result = result.replace(new RegExp(pattern, "gm"), replacement);
        } catch { /* skip invalid regex */ }
      }
      filtersApplied.push(`${name}:replace`);
    }

    // Stage 3: Line filtering
    if (rule.stripLinesMatching) {
      const patterns = rule.stripLinesMatching.map(p => { try { return new RegExp(p); } catch { return null; } }).filter(Boolean) as RegExp[];
      if (patterns.length > 0) {
        const lines = result.split("\n");
        result = lines.filter(line => !patterns.some(p => p.test(line))).join("\n");
        filtersApplied.push(`${name}:strip-lines`);
      }
    }
    if (rule.keepLinesMatching) {
      const patterns = rule.keepLinesMatching.map(p => { try { return new RegExp(p); } catch { return null; } }).filter(Boolean) as RegExp[];
      if (patterns.length > 0) {
        const lines = result.split("\n");
        result = lines.filter(line => patterns.some(p => p.test(line))).join("\n");
        filtersApplied.push(`${name}:keep-lines`);
      }
    }

    // Stage 4: Error extraction
    if (rule.extractErrors && ctx.exitCode !== undefined && ctx.exitCode !== 0) {
      const extracted = extractTestErrors(result);
      if (extracted.length < result.length) {
        result = extracted;
        filtersApplied.push(`${name}:extract-errors`);
      }
    }

    // Stage 5: Head/tail selection
    if (rule.headLines || rule.tailLines) {
      const lines = result.split("\n");
      const headN = rule.headLines ?? 0;
      const tailN = rule.tailLines ?? 0;
      if (lines.length > headN + tailN) {
        const head = lines.slice(0, headN);
        const tail = tailN > 0 ? lines.slice(-tailN) : [];
        const omitted = lines.length - headN - tailN;
        result = [...head, `\n... (${omitted} lines omitted) ...\n`, ...tail].join("\n");
        filtersApplied.push(`${name}:head-tail`);
      }
    }

    // Stage 6: Absolute line cap
    if (rule.maxLines) {
      const lines = result.split("\n");
      if (lines.length > rule.maxLines) {
        result = lines.slice(0, rule.maxLines).join("\n") + `\n... (truncated at ${rule.maxLines} lines)`;
        filtersApplied.push(`${name}:max-lines`);
      }
    }

    // Empty handling
    if (rule.onEmpty && result.trim() === "") {
      result = rule.onEmpty;
    }
  }

  const filteredLength = result.length;
  const savedChars = originalLength - filteredLength;
  const savedTokens = Math.ceil(savedChars / 4);

  return {
    output: result,
    originalLength,
    filteredLength,
    savedTokens: Math.max(0, savedTokens),
    filtersApplied,
  };
}

// ── Command Filter (for worker-level use) ────────────────────────

export function applyCommandFilter(output: string, command: string, exitCode?: number): string {
  const result = applyFilters(output, {
    skillId: "run_shell",
    workerName: "shell-agent",
    command,
    exitCode,
  });
  return result.output;
}

// ── Stats ────────────────────────────────────────────────────────

let totalFiltered = 0;
let totalSavedTokens = 0;

export function recordFilterStats(result: FilterResult): void {
  if (result.filtersApplied.length > 0) {
    totalFiltered++;
    totalSavedTokens += result.savedTokens;
  }
}

export function getFilterStats() {
  return {
    totalFiltered,
    totalSavedTokens,
    estimatedSavedChars: totalSavedTokens * 4,
  };
}

/** Reset user config (for reloading) */
export function resetFilterConfig(): void {
  userConfig = null;
}
