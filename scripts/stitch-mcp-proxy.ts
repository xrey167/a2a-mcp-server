/**
 * Stitch MCP stdio proxy.
 *
 * Claude Code can't use header-auth HTTP MCP servers directly because it
 * always tries OAuth dynamic client registration first (which Google rejects).
 * This proxy runs as a stdio MCP server (no OAuth), reads the token from
 * ~/.gemini/oauth_creds.json, auto-refreshes when expired, and forwards
 * every MCP message to https://stitch.googleapis.com/mcp over HTTP.
 *
 * Register in ~/.claude.json:
 *   "stitch": {
 *     "type": "stdio",
 *     "command": "bun",
 *     "args": ["/Users/xrey/Developer/a2a-mcp-server/scripts/stitch-mcp-proxy.ts"]
 *   }
 */

import { createInterface } from "readline";

const STITCH_URL = "https://stitch.googleapis.com/mcp?project=organic-dryad-370521";

// ── Token management ─────────────────────────────────────────────
// Use gcloud auth — scoped to the user's own project, which has Stitch API enabled.

let cachedToken = "";
let tokenExpiry = 0;

function getValidToken(): string {
  // Refresh when within 5 minutes of expiry
  if (Date.now() < tokenExpiry - 5 * 60 * 1000) return cachedToken;

  const result = Bun.spawnSync(["gcloud", "auth", "print-access-token"], {
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`gcloud auth failed: ${result.stderr}`);

  cachedToken = result.stdout.toString().trim();
  tokenExpiry = Date.now() + 55 * 60 * 1000; // assume ~1h, refresh at 55min
  return cachedToken;
}

// ── MCP forwarding ───────────────────────────────────────────────

// SSE response accumulator — collect full SSE stream, return last data event
async function readSseResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  const lines = text.split("\n");
  let last: unknown = null;
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try { last = JSON.parse(line.slice(6)); } catch {}
    }
  }
  return last;
}

async function forwardToStitch(message: unknown): Promise<unknown> {
  const token = getValidToken();
  const res = await fetch(STITCH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "X-Goog-User-Project": "organic-dryad-370521",
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify(message),
  });

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return readSseResponse(res);
  }
  return res.json();
}

// ── stdio MCP transport ───────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: unknown;
  try { msg = JSON.parse(trimmed); } catch { return; }

  try {
    const response = await forwardToStitch(msg);
    if (response !== null && response !== undefined) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } catch (err) {
    const id = (msg as any)?.id ?? null;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id,
      error: { code: -32000, message: String(err) },
    }) + "\n");
  }
});
