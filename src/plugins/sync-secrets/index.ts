/**
 * sync_secrets plugin — cross-platform credential sync via a2a-server memory.
 *
 * Central store: a2a-mcp-server's remember/recall skill (A2A HTTP endpoint).
 * Any machine that can reach SYNC_SERVER_URL can push/pull credentials.
 * All values are AES-256-GCM encrypted with a passphrase before storing.
 *
 * Config (env vars or ~/.a2a-sync.json):
 *   SYNC_SERVER_URL   — a2a-server endpoint (default: http://localhost:8080)
 *   SYNC_PASSPHRASE   — encryption passphrase (required for push/pull)
 *
 * Services synced:
 *   claude   → ~/.claude/credentials.json      (Claude Code OAuth)
 *   gemini   → ~/.gemini/oauth_creds.json       (Gemini CLI OAuth)
 *   codex    → ~/.codex/auth.json               (Codex / ChatGPT OAuth)
 *   mcp      → ~/.a2a-mcp-auth.json             (API keys for MCP servers)
 *
 * Deploy scenario:
 *   - Run a2a-server on a VPS / Tailscale node / exposed via ngrok
 *   - Set SYNC_SERVER_URL on every machine
 *   - Push once from primary machine, pull on every new machine
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { homedir } from "os";
import { join, dirname } from "path";
import type { Skill } from "../../skills.js";
import { fetchWithTimeout } from "../../a2a.js";

// ── Config ───────────────────────────────────────────────────────

const HOME = homedir();
const SYNC_CONFIG_FILE = join(HOME, ".a2a-sync.json");

interface SyncConfig {
  serverUrl: string;
  passphrase?: string;
}

function loadConfig(): SyncConfig {
  let file: Partial<SyncConfig> = {};
  if (existsSync(SYNC_CONFIG_FILE)) {
    try { file = JSON.parse(readFileSync(SYNC_CONFIG_FILE, "utf-8")); } catch {}
  }
  return {
    serverUrl: process.env.SYNC_SERVER_URL ?? file.serverUrl ?? "http://localhost:8080",
    passphrase: process.env.SYNC_PASSPHRASE ?? file.passphrase,
  };
}

// ── Credential paths ─────────────────────────────────────────────

const CREDENTIAL_PATHS = {
  claude: join(HOME, ".claude/credentials.json"),
  gemini: join(HOME, ".gemini/oauth_creds.json"),
  codex:  join(HOME, ".codex/auth.json"),
  mcp:    join(HOME, ".a2a-mcp-auth.json"),
} as const;

type Service = keyof typeof CREDENTIAL_PATHS;

// ── Encryption (AES-256-GCM) ─────────────────────────────────────

const ALGO = "aes-256-gcm";
const SALT = "a2a-sync-v1"; // fixed salt is fine since passphrase is user-chosen

function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, SALT, 32);
}

function encrypt(passphrase: string, plaintext: string): string {
  const key = deriveKey(passphrase);
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(hex):tag(hex):ciphertext(hex)
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(passphrase: string, payload: string): string {
  const [ivHex, tagHex, ciphertextHex] = payload.split(":");
  const key = deriveKey(passphrase);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf-8");
}

// ── A2A memory helpers ───────────────────────────────────────────

const MEMORY_AGENT = "sync-secrets";

async function rememberOnServer(serverUrl: string, key: string, value: string): Promise<void> {
  const res = await fetchWithTimeout(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "tasks/send", id: "sync-push",
      params: {
        id: `sync-${key}`,
        skillId: "remember",
        args: { key: `${MEMORY_AGENT}/${key}`, value },
        message: { role: "user", parts: [{ text: "" }] },
      },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${serverUrl}`);
}

async function recallFromServer(serverUrl: string, key: string): Promise<string | null> {
  const res = await fetchWithTimeout(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "tasks/send", id: "sync-pull",
      params: {
        id: `recall-${key}`,
        skillId: "recall",
        args: { key: `${MEMORY_AGENT}/${key}` },
        message: { role: "user", parts: [{ text: "" }] },
      },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${serverUrl}`);
  const data = await res.json() as any;
  const text = data?.result?.artifacts?.[0]?.parts?.[0]?.text ?? "";
  if (text.startsWith("No memory found")) return null;
  return text;
}

// ── File helpers ─────────────────────────────────────────────────

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// ── Actions ──────────────────────────────────────────────────────

async function push(passphrase: string, serverUrl: string): Promise<string> {
  const results: string[] = [];
  const meta = {
    pushedAt: new Date().toISOString(),
    pushedFrom: process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? "unknown",
  };

  for (const [service, path] of Object.entries(CREDENTIAL_PATHS) as [Service, string][]) {
    const data = readJson(path);
    if (!data) {
      results.push(`  ${service}: skipped (not found)`);
      continue;
    }
    try {
      const encrypted = encrypt(passphrase, JSON.stringify(data));
      await rememberOnServer(serverUrl, service, encrypted);
      results.push(`  ${service}: ✓ encrypted + stored`);
    } catch (err) {
      results.push(`  ${service}: ✗ failed — ${err}`);
    }
  }

  // Store metadata (unencrypted — no sensitive data)
  await rememberOnServer(serverUrl, "_meta", JSON.stringify(meta)).catch(() => {});

  return `Pushed to ${serverUrl}:\n${results.join("\n")}`;
}

async function pull(passphrase: string, serverUrl: string): Promise<string> {
  const results: string[] = [];

  // Show metadata
  const metaRaw = await recallFromServer(serverUrl, "_meta").catch(() => null);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw);
      results.push(`Store: pushed ${meta.pushedAt} from ${meta.pushedFrom}\n`);
    } catch {}
  }

  for (const [service, path] of Object.entries(CREDENTIAL_PATHS) as [Service, string][]) {
    try {
      const encrypted = await recallFromServer(serverUrl, service);
      if (!encrypted) {
        results.push(`  ${service}: skipped (not in store)`);
        continue;
      }
      const json = JSON.parse(decrypt(passphrase, encrypted)) as Record<string, unknown>;

      // Claude: merge to preserve other fields; others: full overwrite
      if (service === "claude") {
        const local = readJson(path) ?? {};
        writeJson(path, { ...local, ...json });
      } else {
        writeJson(path, json);
      }
      results.push(`  ${service}: ✓ decrypted → ${path}`);
    } catch (err) {
      results.push(`  ${service}: ✗ failed — ${err}`);
    }
  }

  return `Pulled from ${serverUrl}:\n${results.join("\n")}`;
}

async function status(serverUrl: string): Promise<string> {
  const lines: string[] = [];

  lines.push("=== Local credentials ===");
  for (const [service, path] of Object.entries(CREDENTIAL_PATHS) as [Service, string][]) {
    const data = readJson(path);
    lines.push(`  ${service}: ${data ? "✓ present" : "✗ not found"} (${path})`);
  }

  lines.push(`\n=== Remote store (${serverUrl}) ===`);
  try {
    const metaRaw = await recallFromServer(serverUrl, "_meta");
    if (metaRaw) {
      const meta = JSON.parse(metaRaw);
      lines.push(`  Last push: ${meta.pushedAt} from ${meta.pushedFrom}`);
    } else {
      lines.push("  No store found — run: sync_secrets { action: \"push\", passphrase: \"...\" }");
    }
    for (const service of Object.keys(CREDENTIAL_PATHS)) {
      const val = await recallFromServer(serverUrl, service);
      lines.push(`  ${service}: ${val ? "✓ in store" : "✗ missing"}`);
    }
  } catch (err) {
    lines.push(`  ✗ Cannot reach server: ${err}`);
    lines.push(`  → Set SYNC_SERVER_URL or update ~/.a2a-sync.json`);
  }

  lines.push(`\n=== Config ===`);
  lines.push(`  Server: ${serverUrl}`);
  lines.push(`  Config file: ${SYNC_CONFIG_FILE}`);

  return lines.join("\n");
}

async function configure(serverUrl?: string, passphrase?: string): Promise<string> {
  const existing = existsSync(SYNC_CONFIG_FILE)
    ? JSON.parse(readFileSync(SYNC_CONFIG_FILE, "utf-8"))
    : {};
  const updated = {
    ...existing,
    ...(serverUrl ? { serverUrl } : {}),
    ...(passphrase ? { passphrase } : {}),
  };
  writeFileSync(SYNC_CONFIG_FILE, JSON.stringify(updated, null, 2));
  return `Saved config to ${SYNC_CONFIG_FILE}\n${JSON.stringify({ serverUrl: updated.serverUrl, passphrase: updated.passphrase ? "***" : "(not set)" }, null, 2)}`;
}

// ── Skill export ─────────────────────────────────────────────────

export const skills: Skill[] = [
  {
    id: "sync_secrets",
    name: "Sync Secrets",
    description: "Cross-platform credential sync via a2a-server memory (AES-256-GCM encrypted). Actions: push, pull, status, configure.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["push", "pull", "status", "configure"],
          description: "push: encrypt + upload to server. pull: download + decrypt to local files. status: show sync state. configure: save serverUrl/passphrase.",
        },
        passphrase: {
          type: "string",
          description: "Encryption passphrase. Required for push/pull. Or set SYNC_PASSPHRASE env var.",
        },
        serverUrl: {
          type: "string",
          description: "a2a-server URL. Default: http://localhost:8080. Or set SYNC_SERVER_URL env var.",
        },
      },
      required: ["action"],
    },
    run: async (args) => {
      const action = args.action as string;
      const cfg = loadConfig();
      const serverUrl = (args.serverUrl as string) ?? cfg.serverUrl;
      const passphrase = (args.passphrase as string) ?? cfg.passphrase;

      if (action === "configure") {
        return configure(args.serverUrl as string | undefined, args.passphrase as string | undefined);
      }

      if (action === "status") return status(serverUrl);

      if (!passphrase) {
        return `Passphrase required for ${action}.\nSet it with:\n  sync_secrets { action: "configure", passphrase: "your-secret" }\nOr set env var: SYNC_PASSPHRASE=...`;
      }

      if (action === "push") return push(passphrase, serverUrl);
      if (action === "pull") return pull(passphrase, serverUrl);

      return `Unknown action: ${action}`;
    },
  },
];
