/**
 * MCP Auth — OAuth2 / bearer token management for external MCP servers.
 *
 * Config: ~/.a2a-mcp-auth.json
 * Format:
 *   {
 *     "server-name": {
 *       "type": "bearer",
 *       "token": "ghp_..."
 *     },
 *     "server-name": {
 *       "type": "header",
 *       "headers": { "X-Api-Key": "..." }
 *     },
 *     "server-name": {
 *       "type": "oauth2",
 *       "accessToken": "...",
 *       "refreshToken": "...",
 *       "clientId": "...",
 *       "clientSecret": "...",
 *       "tokenUrl": "https://...",
 *       "expiresAt": 1740000000
 *     }
 *   }
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const AUTH_FILE = join(homedir(), ".a2a-mcp-auth.json");

// ── Types ────────────────────────────────────────────────────────

interface BearerAuth {
  type: "bearer";
  token: string;
}

interface HeaderAuth {
  type: "header";
  headers: Record<string, string>;
}

interface OAuth2Auth {
  type: "oauth2";
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  expiresAt: number; // unix seconds
}

type McpAuth = BearerAuth | HeaderAuth | OAuth2Auth;

// ── Read / write helpers ─────────────────────────────────────────

function readAuthFile(): Record<string, McpAuth> {
  if (!existsSync(AUTH_FILE)) return {};
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
  } catch (e) {
    process.stderr.write(`[mcp-auth] failed to read ${AUTH_FILE}, returning empty auth: ${e}\n`);
    return {};
  }
}

function writeAuthFile(data: Record<string, McpAuth>) {
  try {
    writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    process.stderr.write(`[mcp-auth] failed to write ${AUTH_FILE}: ${err}\n`);
  }
}

// ── OAuth2 refresh ───────────────────────────────────────────────

async function refreshOAuth2(serverName: string, auth: OAuth2Auth): Promise<OAuth2Auth> {
  process.stderr.write(`[mcp-auth] refreshing OAuth2 token for ${serverName}\n`);

  const res = await fetch(auth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: HTTP ${res.status}`);
  }

  const json = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const updated: OAuth2Auth = {
    ...auth,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? auth.refreshToken,
    expiresAt: json.expires_in
      ? Math.floor(Date.now() / 1000) + json.expires_in - 60 // 60s buffer
      : auth.expiresAt,
  };

  // Persist refreshed token
  const all = readAuthFile();
  all[serverName] = updated;
  writeAuthFile(all);

  return updated;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Returns HTTP headers to inject for the given MCP server.
 * For oauth2, auto-refreshes if the token is expired.
 * Returns {} if no auth is configured.
 */
export async function getAuthHeaders(serverName: string): Promise<Record<string, string>> {
  const all = readAuthFile();
  let auth = all[serverName];
  if (!auth) return {};

  if (auth.type === "bearer") {
    return { Authorization: `Bearer ${auth.token}` };
  }

  if (auth.type === "header") {
    return auth.headers;
  }

  if (auth.type === "oauth2") {
    const now = Math.floor(Date.now() / 1000);
    if (now >= auth.expiresAt) {
      try {
        auth = await refreshOAuth2(serverName, auth);
      } catch (err) {
        process.stderr.write(`[mcp-auth] token refresh failed for ${serverName}: ${err}\n`);
      }
    }
    return { Authorization: `Bearer ${auth.accessToken}` };
  }

  return {};
}

/**
 * Save or update auth config for a server.
 * Use this to bootstrap new MCP server credentials.
 */
export function setAuth(serverName: string, auth: McpAuth) {
  const all = readAuthFile();
  all[serverName] = auth;
  writeAuthFile(all);
  process.stderr.write(`[mcp-auth] saved ${auth.type} auth for ${serverName}\n`);
}

/** List all servers that have auth configured. */
export function listAuthServers(): Array<{ server: string; type: string }> {
  const all = readAuthFile();
  return Object.entries(all).map(([server, a]) => ({ server, type: a.type }));
}
