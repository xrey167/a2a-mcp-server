/**
 * Run `claude -p` as a subprocess for AI responses.
 * CLAUDECODE is unset so Claude Code's OAuth is used automatically.
 * --strict-mcp-config with an empty config prevents the subprocess from
 * trying to spawn MCP servers (which would conflict with the already-running
 * orchestrator ports 8080-8086 and cause an indefinite hang).
 */
export async function runClaudeCLI(prompt: string, model: string, timeoutMs = 90_000): Promise<string> {
  const proc = Bun.spawn(
    [
      "claude", "-p", prompt,
      "--model", model,
      "--output-format", "text",
      "--dangerously-skip-permissions",
      "--mcp-config", '{"mcpServers":{}}',
      "--strict-mcp-config",
    ],
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
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs)
  );

  return Promise.race([cliDone(), deadline]);
}
