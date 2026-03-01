/**
 * Run `claude -p` as a subprocess for AI responses when the Anthropic SDK
 * is unavailable (no API key, network error, etc.).
 * CLAUDECODE is unset so Claude Code's OAuth refresh is used automatically.
 *
 * Uses Bun.spawn (async) to avoid blocking the event loop, and Promise.race
 * against a hard kill-timer so the caller never hangs if the CLI gets stuck
 * (e.g. when spawned from inside a running Claude Code session where the MCP
 * server ports are already occupied and the subprocess stalls).
 */
export async function runClaudeCLI(prompt: string, model: string, timeoutMs = 60_000): Promise<string> {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--model", model, "--output-format", "text", "--dangerously-skip-permissions"],
    {
      env: { ...process.env, CLAUDECODE: undefined } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const cliDone = async () => {
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(stderr.trim() || `claude CLI exited with code ${exitCode}`);
    }
    return stdout.trim();
  };

  // Hard kill-timer: if the CLI stalls, reject immediately so callers aren't blocked.
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill(9);
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms — set ANTHROPIC_API_KEY for reliable inference`));
    }, timeoutMs)
  );

  return Promise.race([cliDone(), deadline]);
}
