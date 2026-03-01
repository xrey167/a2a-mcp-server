import { spawnSync } from "child_process";

/**
 * Run `claude -p` as a subprocess for AI responses when the Anthropic SDK
 * is unavailable (no API key, network error, etc.).
 * CLAUDECODE is unset so Claude Code's OAuth refresh is used automatically.
 *
 * Unified implementation — previously duplicated between skills.ts (30s,
 * no --dangerously-skip-permissions) and workers/ai.ts (60s, with flag).
 */
export function runClaudeCLI(prompt: string, model: string, timeoutMs = 60_000): string {
  const result = spawnSync(
    "claude",
    ["-p", prompt, "--model", model, "--output-format", "text", "--dangerously-skip-permissions"],
    {
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...process.env, CLAUDECODE: undefined } as NodeJS.ProcessEnv,
    }
  );
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) throw new Error(result.stderr || "claude CLI failed");
  return result.stdout.trim();
}
