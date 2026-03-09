// src/truncate.ts
// Smart output truncation inspired by MCX patterns.
// Prevents context window blow-up by capping large outputs.

const DEFAULT_MAX_LENGTH = 25_000; // characters
const DEFAULT_HEAD_RATIO = 0.6;    // 60% head, 40% tail

export interface TruncateOptions {
  maxLength?: number;
  headRatio?: number;
}

/**
 * Smart-truncate a multi-line string: keep head lines + tail lines,
 * insert a "[N lines truncated]" marker in the middle.
 */
export function smartTruncate(input: string, opts: TruncateOptions = {}): string {
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  if (input.length <= maxLength) return input;

  const lines = input.split("\n");
  if (lines.length <= 2) {
    // Single-line or two-line content — use character-based truncation
    return truncateMiddle(input, maxLength);
  }

  const headRatio = opts.headRatio ?? DEFAULT_HEAD_RATIO;
  // Figure out how many lines fit in head vs tail budget
  const headBudget = Math.floor(maxLength * headRatio);
  const tailBudget = maxLength - headBudget;

  let headLen = 0;
  let headEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const nextLen = headLen + lines[i].length + 1; // +1 for \n
    if (nextLen > headBudget) break;
    headLen = nextLen;
    headEnd = i + 1;
  }

  let tailLen = 0;
  let tailStart = lines.length;
  for (let i = lines.length - 1; i >= headEnd; i--) {
    const nextLen = tailLen + lines[i].length + 1;
    if (nextLen > tailBudget) break;
    tailLen = nextLen;
    tailStart = i;
  }

  const truncated = lines.length - headEnd - (lines.length - tailStart);
  if (truncated <= 0) {
    // Edge case: all lines fit (shouldn't happen given length check, but be safe)
    return input.slice(0, maxLength);
  }

  const headPart = lines.slice(0, headEnd).join("\n");
  const tailPart = lines.slice(tailStart).join("\n");
  return `${headPart}\n\n[... ${truncated} lines truncated ...]\n\n${tailPart}`;
}

/**
 * Character-based middle truncation for single-line content (e.g. long JSON).
 */
export function truncateMiddle(input: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
  if (input.length <= maxLength) return input;

  const headLen = Math.floor(maxLength * 0.6);
  const tailLen = maxLength - headLen - 40; // leave room for marker
  if (tailLen <= 0) return input.slice(0, maxLength);

  const skipped = input.length - headLen - tailLen;
  return `${input.slice(0, headLen)} [... ${skipped} chars truncated ...] ${input.slice(-tailLen)}`;
}

/**
 * Truncate an array by keeping first N + last M items,
 * inserting a truncation marker in between.
 */
export function truncateArray<T>(
  arr: T[],
  maxItems: number = 100,
  headItems?: number,
): T[] {
  if (arr.length <= maxItems) return arr;

  const head = headItems ?? Math.ceil(maxItems * 0.6);
  const tail = maxItems - head;

  const skipped = arr.length - head - tail;
  return [
    ...arr.slice(0, head),
    { __truncated: true, skipped, total: arr.length } as unknown as T,
    ...arr.slice(-tail),
  ];
}

/**
 * Cap a response string at maxLength with smart truncation.
 * Use this to ensure MCP tool responses don't blow up the context window.
 */
export function capResponse(input: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
  return smartTruncate(input, { maxLength });
}
