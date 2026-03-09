import { memory } from "./memory.js";

/**
 * Handles the "remember" and "recall" skills shared across all workers.
 * Returns the result string, or null if skillId is not a memory skill.
 * Call this at the top of each worker's handleSkill to eliminate the 5×
 * copy-paste of identical switch cases.
 */
export function handleMemorySkill(
  agentName: string,
  skillId: string,
  args: Record<string, unknown>,
): string | null {
  switch (skillId) {
    case "remember": {
      const key = args.key as string;
      const value = args.value as string;
      memory.set(agentName, key, value);
      return `Remembered: ${key}`;
    }
    case "recall": {
      const key = args.key as string | undefined;
      if (key) return memory.get(agentName, key) ?? `No memory found for key: ${key}`;
      return JSON.stringify(memory.all(agentName), null, 2);
    }
    default:
      return null;
  }
}
