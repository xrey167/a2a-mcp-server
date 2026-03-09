/**
 * Refreshes the Google OAuth access token for the Stitch MCP in ~/.claude.json.
 * Uses the Gemini CLI's installed-app credentials (public, safe to commit per Google's docs).
 * Run with: bun scripts/refresh-stitch-token.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CLAUDE_JSON = join(homedir(), ".claude.json");
const GEMINI_CREDS = join(homedir(), ".gemini", "oauth_creds.json");

const TOKEN_URL = "https://oauth2.googleapis.com/token";

async function refreshToken(): Promise<{ access_token: string; expires_in: number }> {
  const creds = JSON.parse(readFileSync(GEMINI_CREDS, "utf-8"));
  // client_id/client_secret come from ~/.gemini/oauth_creds.json (Gemini CLI installed-app credentials)
  const CLIENT_ID = creds.client_id as string;
  const CLIENT_SECRET = creds.client_secret as string;
  const refresh_token = creds.refresh_token as string;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("No client_id/client_secret in ~/.gemini/oauth_creds.json");
  if (!refresh_token) throw new Error("No refresh_token in ~/.gemini/oauth_creds.json");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };

  // Update ~/.gemini/oauth_creds.json so the Gemini CLI also benefits
  creds.access_token = data.access_token;
  creds.expiry_date = Date.now() + data.expires_in * 1000;
  writeFileSync(GEMINI_CREDS, JSON.stringify(creds, null, 2));

  return data;
}

function updateClaudeJson(accessToken: string) {
  const config = JSON.parse(readFileSync(CLAUDE_JSON, "utf-8"));
  const stitch = config?.mcpServers?.stitch;
  if (!stitch) throw new Error('No "stitch" entry in ~/.claude.json mcpServers');

  stitch.headers = { ...stitch.headers, Authorization: `Bearer ${accessToken}` };
  writeFileSync(CLAUDE_JSON, JSON.stringify(config, null, 2));
}

// ── Main ─────────────────────────────────────────────────────────

const { access_token, expires_in } = await refreshToken();
updateClaudeJson(access_token);

const expiresAt = new Date(Date.now() + expires_in * 1000).toLocaleTimeString();
process.stderr.write(`[stitch-token] refreshed — expires at ${expiresAt} (${expires_in}s)\n`);
process.stderr.write(`[stitch-token] ~/.claude.json updated\n`);
