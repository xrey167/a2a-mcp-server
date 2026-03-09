// src/safe-json.ts
// Circular-reference-safe JSON serialization using WeakSet tracking.

/**
 * JSON.stringify replacement that handles circular references gracefully.
 * Instead of throwing, it replaces circular references with "[Circular]".
 */
export function safeStringify(value: unknown, indent?: number): string {
  const seen = new WeakSet();

  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    // Handle BigInt
    if (typeof val === "bigint") return val.toString();
    // Handle undefined in arrays (JSON.stringify converts to null, which is fine)
    return val;
  }, indent);
}

/**
 * Safe JSON.parse that returns a default value on failure instead of throwing.
 */
export function safeParse<T = unknown>(input: string, fallback?: T): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return (fallback ?? input) as T;
  }
}
