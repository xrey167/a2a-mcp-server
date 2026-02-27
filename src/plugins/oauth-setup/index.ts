/**
 * oauth_setup plugin — browser OAuth2 flow for any provider.
 *
 * Starts a local redirect server, opens the auth URL in the browser,
 * captures the authorization code, exchanges it for tokens, and saves
 * them to ~/.a2a-mcp-auth.json (same format as mcp-auth.ts).
 *
 * Built-in provider presets (all fields can be overridden):
 *   google   — stitch.googleapis.com and any Google API
 *   github   — GitHub OAuth Apps
 *   linear   — Linear (use API key instead, but OAuth supported)
 *
 * Actions:
 *   start    — begin OAuth flow (opens browser, waits for redirect)
 *   refresh  — use stored refresh_token to get a new access_token
 *   list     — show all stored OAuth entries in ~/.a2a-mcp-auth.json
 *   revoke   — remove an entry from ~/.a2a-mcp-auth.json
 *
 * Usage:
 *   oauth_setup { action: "start", provider: "google", serverName: "stitch",
 *                 clientId: "...", clientSecret: "..." }
 *
 *   oauth_setup { action: "refresh", serverName: "stitch" }
 *   oauth_setup { action: "list" }
 *   oauth_setup { action: "revoke", serverName: "stitch" }
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomBytes, createHash } from "crypto";
import { execFile } from "child_process";
import type { Skill } from "../../skills.js";

// ── Config ────────────────────────────────────────────────────────

const AUTH_FILE = join(homedir(), ".a2a-mcp-auth.json");
const REDIRECT_PORT = 9876;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

// ── Provider presets ──────────────────────────────────────────────

interface ProviderPreset {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  pkce?: boolean;
}

const PROVIDERS: Record<string, ProviderPreset> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/cloud-platform", "openid", "email"],
    pkce: false,
  },
  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:user"],
    pkce: false,
  },
  linear: {
    authUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: ["read", "write"],
    pkce: false,
  },
};

// ── Auth file helpers ─────────────────────────────────────────────

function readAuthFile(): Record<string, unknown> {
  if (!existsSync(AUTH_FILE)) return {};
  try { return JSON.parse(readFileSync(AUTH_FILE, "utf-8")); } catch { return {}; }
}

function writeAuthFile(data: Record<string, unknown>) {
  writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ── PKCE helpers ──────────────────────────────────────────────────

function generatePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── Local redirect server ─────────────────────────────────────────

function waitForCode(timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("OAuth timeout — no redirect received within 2 minutes"));
    }, timeoutMs);

    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html" });
      if (code) {
        res.end("<h1>Authentication successful!</h1><p>You can close this tab and return to Claude.</p>");
        clearTimeout(timer);
        server.close();
        resolve(code);
      } else {
        res.end(`<h1>Authentication failed</h1><p>${error ?? "Unknown error"}</p>`);
        clearTimeout(timer);
        server.close();
        reject(new Error(`OAuth error: ${error ?? "unknown"}`));
      }
    });

    server.listen(REDIRECT_PORT);
  });
}

// ── Open browser (safe: no shell — args passed as array) ──────────

function openBrowser(url: string): void {
  const [cmd, ...args] =
    process.platform === "darwin"  ? ["open", url] :
    process.platform === "win32"   ? ["cmd", "/c", "start", "", url] :
                                     ["xdg-open", url];
  execFile(cmd, args, () => {}); // ignore errors (non-fatal)
}

// ── Token exchange ────────────────────────────────────────────────

async function exchangeCode(
  tokenUrl: string,
  code: string,
  clientId: string,
  clientSecret: string | undefined,
  pkceVerifier: string | undefined,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...(pkceVerifier ? { code_verifier: pkceVerifier } : {}),
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: body.toString(),
  });

  const data = await res.json() as any;
  if (!res.ok || data.error) throw new Error(data.error_description ?? data.error ?? `HTTP ${res.status}`);
  return data;
}

async function refreshToken(
  tokenUrl: string,
  refreshTok: string,
  clientId: string,
  clientSecret?: string,
): Promise<{ access_token: string; expires_in?: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTok,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: body.toString(),
  });

  const data = await res.json() as any;
  if (!res.ok || data.error) throw new Error(data.error_description ?? data.error ?? `HTTP ${res.status}`);
  return data;
}

// ── Actions ───────────────────────────────────────────────────────

async function startFlow(args: Record<string, unknown>): Promise<string> {
  const serverName  = args.serverName as string;
  const providerKey = (args.provider as string) ?? "google";
  const preset      = PROVIDERS[providerKey];
  if (!preset) return `Unknown provider: ${providerKey}. Available: ${Object.keys(PROVIDERS).join(", ")}`;

  const clientId     = args.clientId as string;
  const clientSecret = args.clientSecret as string | undefined;
  const extraScopes  = (args.scopes as string[] | undefined) ?? [];
  const scopes       = [...preset.scopes, ...extraScopes];

  if (!clientId) return "clientId is required";
  if (!serverName) return "serverName is required (used as key in ~/.a2a-mcp-auth.json)";

  const state = randomBytes(8).toString("hex");
  const pkce  = preset.pkce ? generatePkce() : undefined;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: scopes.join(" "),
    state,
    access_type: "offline",   // Google: request refresh token
    prompt: "consent",        // Google: always show consent screen (ensures refresh token)
    ...(pkce ? { code_challenge: pkce.challenge, code_challenge_method: "S256" } : {}),
  });

  const authUrl = `${preset.authUrl}?${params.toString()}`;

  process.stderr.write(`[oauth-setup] Opening browser for ${serverName} (${providerKey})...\n`);
  openBrowser(authUrl);

  const lines = [
    `Opening browser for ${serverName} OAuth (${providerKey})...`,
    ``,
    `If the browser didn't open, visit:`,
    authUrl,
    ``,
    `Waiting for redirect (2 min timeout)...`,
  ];

  let code: string;
  try {
    code = await waitForCode();
  } catch (err) {
    return `${lines.join("\n")}\n\nFailed: ${err}`;
  }

  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(preset.tokenUrl, code, clientId, clientSecret, pkce?.verifier);
  } catch (err) {
    return `Code received but token exchange failed: ${err}`;
  }

  const expiresAt = tokens.expires_in
    ? Math.floor(Date.now() / 1000) + tokens.expires_in - 60
    : undefined;

  const auth: Record<string, unknown> = {
    type: "oauth2",
    accessToken: tokens.access_token,
    clientId,
    tokenUrl: preset.tokenUrl,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };

  const existing = readAuthFile();
  writeAuthFile({ ...existing, [serverName]: auth });

  return [
    `✓ OAuth complete for "${serverName}"`,
    `  Access token: ${tokens.access_token.slice(0, 20)}...`,
    `  Refresh token: ${tokens.refresh_token ? "✓ stored" : "✗ not provided (try adding prompt=consent or offline_access scope)"}`,
    `  Expires: ${expiresAt ? new Date(expiresAt * 1000).toISOString() : "unknown"}`,
    `  Saved to: ${AUTH_FILE}`,
  ].join("\n");
}

async function refreshAction(args: Record<string, unknown>): Promise<string> {
  const serverName = args.serverName as string;
  if (!serverName) return "serverName is required";

  const existing = readAuthFile();
  const entry = existing[serverName] as any;
  if (!entry) return `No entry found for "${serverName}" in ${AUTH_FILE}`;
  if (entry.type !== "oauth2") return `"${serverName}" is type "${entry.type}", not oauth2`;
  if (!entry.refreshToken) return `No refresh token stored for "${serverName}"`;

  let tokens: { access_token: string; expires_in?: number };
  try {
    tokens = await refreshToken(entry.tokenUrl, entry.refreshToken, entry.clientId, entry.clientSecret);
  } catch (err) {
    return `Refresh failed: ${err}`;
  }

  const expiresAt = tokens.expires_in
    ? Math.floor(Date.now() / 1000) + tokens.expires_in - 60
    : entry.expiresAt;

  writeAuthFile({
    ...existing,
    [serverName]: { ...entry, accessToken: tokens.access_token, expiresAt },
  });

  return [
    `✓ Refreshed token for "${serverName}"`,
    `  New access token: ${tokens.access_token.slice(0, 20)}...`,
    `  Expires: ${expiresAt ? new Date(expiresAt * 1000).toISOString() : "unknown"}`,
  ].join("\n");
}

function listAction(): string {
  const existing = readAuthFile();
  if (Object.keys(existing).length === 0) return `No entries in ${AUTH_FILE}`;
  const lines = [`Entries in ${AUTH_FILE}:`];
  for (const [name, entry] of Object.entries(existing) as [string, any][]) {
    const type = entry.type ?? "unknown";
    const extra = type === "oauth2"
      ? ` | expires: ${entry.expiresAt ? new Date(entry.expiresAt * 1000).toISOString() : "?"} | refresh: ${entry.refreshToken ? "✓" : "✗"}`
      : type === "bearer" ? ` | token: ${(entry.token ?? "").slice(0, 12)}...` : "";
    lines.push(`  ${name}: ${type}${extra}`);
  }
  return lines.join("\n");
}

function revokeAction(args: Record<string, unknown>): string {
  const serverName = args.serverName as string;
  if (!serverName) return "serverName is required";
  const existing = readAuthFile();
  if (!existing[serverName]) return `No entry found for "${serverName}"`;
  const { [serverName]: _, ...rest } = existing;
  writeAuthFile(rest);
  return `Removed "${serverName}" from ${AUTH_FILE}`;
}

// ── Skill export ──────────────────────────────────────────────────

export const skills: Skill[] = [
  {
    id: "oauth_setup",
    name: "OAuth Setup",
    description: "Browser OAuth2 flow for any provider. Stores tokens in ~/.a2a-mcp-auth.json for use with use_mcp_tool. Actions: start, refresh, list, revoke.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "refresh", "list", "revoke"],
          description: "start: open browser flow. refresh: use stored refresh_token. list: show all entries. revoke: remove entry.",
        },
        provider: {
          type: "string",
          enum: ["google", "github", "linear"],
          description: "Built-in provider preset. Default: google.",
        },
        serverName: {
          type: "string",
          description: "Key used in ~/.a2a-mcp-auth.json (e.g. 'stitch', 'github-mcp'). Required for start/refresh/revoke.",
        },
        clientId: {
          type: "string",
          description: "OAuth2 client ID. Required for start.",
        },
        clientSecret: {
          type: "string",
          description: "OAuth2 client secret. Optional for PKCE flows.",
        },
        scopes: {
          type: "array",
          items: { type: "string" },
          description: "Additional OAuth scopes to request (merged with provider defaults).",
        },
      },
      required: ["action"],
    },
    run: async (args) => {
      const action = args.action as string;
      if (action === "start")   return startFlow(args);
      if (action === "refresh") return refreshAction(args);
      if (action === "list")    return listAction();
      if (action === "revoke")  return revokeAction(args);
      return `Unknown action: ${action}`;
    },
  },
];
