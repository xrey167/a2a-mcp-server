/**
 * BOM Cycle Detection & Depth Guard
 *
 * Prevents infinite recursion in BOM walks caused by circular references
 * (e.g., item A → B → C → A) or excessively deep hierarchies.
 *
 * Used by: demand-plan, pegging, scoring, critical-path.
 */

function log(msg: string) {
  process.stderr.write(`[bom-guard] ${msg}\n`);
}

/** Maximum BOM recursion depth before aborting */
export const MAX_BOM_DEPTH = 20;

/**
 * Check if visiting `itemNo` would create a cycle or exceed depth.
 * Returns true if recursion should STOP (cycle detected or depth exceeded).
 */
export function shouldStopRecursion(
  itemNo: string,
  visited: Set<string>,
  depth: number,
): boolean {
  if (visited.has(itemNo)) {
    log(`circular BOM detected at "${itemNo}" — skipping to prevent infinite loop`);
    return true;
  }
  if (depth > MAX_BOM_DEPTH) {
    log(`BOM depth limit (${MAX_BOM_DEPTH}) exceeded at "${itemNo}" — truncating`);
    return true;
  }
  return false;
}
