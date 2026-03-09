// src/search.ts
// Enhanced FTS5 search with Porter stemming + trigram dual tables,
// content chunking, vocabulary extraction, and fuzzy Levenshtein fallback.
// Inspired by MCX search patterns.

// ── Content Chunking ──────────────────────────────────────────────

const MARKDOWN_HEADING_RE = /^#{1,4}\s+.+$/m;

/**
 * Auto-detect content type and chunk accordingly.
 */
export function chunkContent(content: string, label?: string): Array<{ title: string; body: string }> {
  if (MARKDOWN_HEADING_RE.test(content)) {
    return chunkMarkdown(content);
  }
  return chunkPlainText(content, label);
}

/**
 * Split markdown by headings, maintaining a hierarchical title stack.
 * Preserves code blocks intact.
 */
export function chunkMarkdown(content: string): Array<{ title: string; body: string }> {
  const lines = content.split("\n");
  const chunks: Array<{ title: string; body: string }> = [];
  const titleStack: string[] = [];
  let currentBody: string[] = [];
  let currentLevel = 0;
  let inCodeBlock = false;

  function flush() {
    if (currentBody.length > 0) {
      const title = titleStack.length > 0 ? titleStack.join(" > ") : "Untitled";
      const body = currentBody.join("\n").trim();
      if (body) chunks.push({ title, body });
      currentBody = [];
    }
  }

  for (const line of lines) {
    // Track code blocks to avoid treating # inside code as headings
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      currentBody.push(line);
      continue;
    }

    if (inCodeBlock) {
      currentBody.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flush();
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      // Pop titles at same or deeper level
      while (titleStack.length >= level) titleStack.pop();
      titleStack.push(title);
      currentLevel = level;
    } else {
      currentBody.push(line);
    }
  }

  flush();
  return chunks;
}

/**
 * Split plain text into chunks. Strategy:
 * 1. If blank-line splitting yields 3-200 sections, use those.
 * 2. Otherwise, fixed-size chunks with 2-line overlap.
 */
export function chunkPlainText(
  content: string,
  label?: string,
  chunkSize: number = 2000,
): Array<{ title: string; body: string }> {
  // Strategy 1: blank-line splitting
  const sections = content.split(/\n\s*\n/).filter(s => s.trim());
  if (sections.length >= 3 && sections.length <= 200) {
    return sections.map((body, i) => ({
      title: label ? `${label} [${i + 1}/${sections.length}]` : `Section ${i + 1}`,
      body: body.trim(),
    }));
  }

  // Strategy 2: fixed-size chunks with overlap
  const lines = content.split("\n");
  const chunks: Array<{ title: string; body: string }> = [];
  const overlap = 2;

  for (let i = 0; i < lines.length; i += chunkSize - overlap) {
    const slice = lines.slice(i, i + chunkSize);
    const idx = chunks.length + 1;
    chunks.push({
      title: label ? `${label} [chunk ${idx}]` : `Chunk ${idx}`,
      body: slice.join("\n").trim(),
    });
    if (i + chunkSize >= lines.length) break;
  }

  return chunks.length > 0 ? chunks : [{ title: label ?? "Content", body: content.trim() }];
}


// ── Vocabulary & Fuzzy Correction ─────────────────────────────────

const WORD_RE = /\b[a-z_][a-z0-9_]*\b/gi;

/**
 * Extract vocabulary terms from text (words >= 3 chars).
 */
export function buildVocabulary(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(WORD_RE)) {
    const word = match[0].toLowerCase();
    if (word.length >= 3) seen.add(word);
  }
  return [...seen];
}

/**
 * Levenshtein distance with single-row O(min(n,m)) space optimization.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) [a, b] = [b, a];

  const row = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) row[i] = i;

  for (let j = 1; j <= b.length; j++) {
    let prev = row[0];
    row[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(
        row[i] + 1,      // deletion
        row[i - 1] + 1,  // insertion
        prev + cost,      // substitution
      );
      prev = row[i];
      row[i] = next;
    }
  }

  return row[a.length];
}

/**
 * Fuzzy-correct a word against a vocabulary set.
 * Returns the best match within maxDistance, or the original word.
 */
export function fuzzyCorrect(word: string, vocabulary: string[], maxDistance: number = 2): string {
  if (word.length < 3) return word;

  let bestMatch = word;
  let bestDist = maxDistance + 1;

  for (const candidate of vocabulary) {
    // Quick length-based prune
    if (Math.abs(candidate.length - word.length) > maxDistance) continue;

    const dist = levenshtein(word.toLowerCase(), candidate);
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = candidate;
      if (dist === 0) break; // exact match
    }
  }

  return bestMatch;
}


// ── FTS5 Query Building ───────────────────────────────────────────

/**
 * Build an FTS5 query from natural language input.
 * Splits into terms >= 2 chars, wraps each in quotes, joins with OR.
 */
export function buildFtsQuery(input: string): string {
  const terms = input
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 2)
    .map(t => t.replace(/['"]/g, "")); // strip quotes

  if (terms.length === 0) return input;

  return terms.map(t => `"${t}"`).join(" OR ");
}

/**
 * Score terms by IDF-like distinctiveness with bonuses for code-style names.
 */
export function getDistinctiveTerms(
  terms: string[],
  docFreqs: Map<string, number>,
  totalDocs: number,
): Array<{ term: string; score: number }> {
  return terms
    .map(term => {
      const df = docFreqs.get(term) ?? 1;
      let score = Math.log((totalDocs + 1) / (df + 1)); // IDF

      // Bonuses for code-style identifiers
      if (term.includes("_")) score *= 1.5;          // snake_case
      if (/[a-z][A-Z]/.test(term)) score *= 1.5;     // camelCase
      if (/^[A-Z][a-z]/.test(term)) score *= 1.3;    // PascalCase
      if (term.length >= 8) score *= 1.2;             // long terms

      return { term, score };
    })
    .sort((a, b) => b.score - a.score);
}


// ── Search Result Snippets ────────────────────────────────────────

/**
 * Extract a snippet around the first match position (+/- 300 chars).
 */
export function extractSnippet(text: string, query: string, radius: number = 300): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);

  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);

  let snippet = text.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  return snippet;
}

/**
 * Highlight query terms in a snippet by wrapping in **bold**.
 */
export function highlightSnippet(snippet: string, query: string): string {
  const terms = query.split(/\s+/).filter(t => t.length >= 2);
  let result = snippet;
  for (const term of terms) {
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    result = result.replace(re, "**$1**");
  }
  return result;
}
