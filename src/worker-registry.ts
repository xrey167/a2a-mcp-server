// src/worker-registry.ts
// Community worker registry — a curated index of installable workers.
// The registry can be a local JSON file or fetched from a remote URL.
// Workers are installed into ~/.a2a-mcp/workers/ and auto-discovered on startup.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface RegistryEntry {
  name: string;
  description: string;
  author: string;
  version: string;
  repo: string;           // GitHub repo URL
  skills: string[];       // skill IDs provided
  tags: string[];         // searchable tags
  port?: number;          // suggested port
}

export interface Registry {
  version: number;
  updated: string;
  workers: RegistryEntry[];
}

function getConfigDir(): string {
  return join(process.env.HOME ?? homedir(), ".a2a-mcp");
}

function getLocalRegistryPath(): string {
  return join(getConfigDir(), "registry.json");
}

/**
 * Built-in registry with example community workers.
 * In production this would be fetched from a remote URL.
 */
const BUILTIN_REGISTRY: Registry = {
  version: 1,
  updated: "2026-03-09",
  workers: [
    {
      name: "github-agent",
      description: "GitHub API integration — PRs, issues, code search, repo management",
      author: "a2a-community",
      version: "1.0.0",
      repo: "https://github.com/a2a-community/worker-github",
      skills: ["github_search", "github_create_issue", "github_list_prs", "github_review_pr"],
      tags: ["github", "git", "code-review", "issues"],
    },
    {
      name: "slack-agent",
      description: "Slack integration — send messages, search channels, manage threads",
      author: "a2a-community",
      version: "1.0.0",
      repo: "https://github.com/a2a-community/worker-slack",
      skills: ["slack_send", "slack_search", "slack_list_channels"],
      tags: ["slack", "messaging", "notifications"],
    },
    {
      name: "postgres-agent",
      description: "PostgreSQL query agent — run queries, inspect schema, explain plans",
      author: "a2a-community",
      version: "1.0.0",
      repo: "https://github.com/a2a-community/worker-postgres",
      skills: ["pg_query", "pg_schema", "pg_explain"],
      tags: ["postgres", "database", "sql"],
    },
    {
      name: "redis-agent",
      description: "Redis operations — get/set, pub/sub, key scanning",
      author: "a2a-community",
      version: "1.0.0",
      repo: "https://github.com/a2a-community/worker-redis",
      skills: ["redis_get", "redis_set", "redis_scan", "redis_pubsub"],
      tags: ["redis", "cache", "pubsub"],
    },
    {
      name: "docker-agent",
      description: "Docker management — list containers, logs, exec, compose operations",
      author: "a2a-community",
      version: "1.0.0",
      repo: "https://github.com/a2a-community/worker-docker",
      skills: ["docker_ps", "docker_logs", "docker_exec", "docker_compose"],
      tags: ["docker", "containers", "devops"],
    },
    {
      name: "s3-agent",
      description: "AWS S3 operations — list, get, put objects, generate presigned URLs",
      author: "a2a-community",
      version: "1.0.0",
      repo: "https://github.com/a2a-community/worker-s3",
      skills: ["s3_list", "s3_get", "s3_put", "s3_presign"],
      tags: ["aws", "s3", "storage", "cloud"],
    },
    {
      name: "playwright-agent",
      description: "Browser automation — navigate, screenshot, extract data from web pages",
      author: "a2a-community",
      version: "1.0.0",
      repo: "https://github.com/a2a-community/worker-playwright",
      skills: ["browser_navigate", "browser_screenshot", "browser_extract"],
      tags: ["browser", "scraping", "automation", "testing"],
    },
    {
      name: "email-agent",
      description: "Email operations via SMTP/IMAP — send, search, read emails",
      author: "a2a-community",
      version: "1.0.0",
      repo: "https://github.com/a2a-community/worker-email",
      skills: ["email_send", "email_search", "email_read"],
      tags: ["email", "smtp", "imap", "notifications"],
    },
  ],
};

/**
 * Load the registry — merges built-in with any locally cached entries.
 */
export function loadRegistry(): Registry {
  const localPath = getLocalRegistryPath();
  if (existsSync(localPath)) {
    try {
      const local = JSON.parse(readFileSync(localPath, "utf-8")) as Registry;
      // Merge: local entries override built-in by name
      const nameSet = new Set(local.workers.map(w => w.name));
      const merged = [
        ...local.workers,
        ...BUILTIN_REGISTRY.workers.filter(w => !nameSet.has(w.name)),
      ];
      return { ...local, workers: merged };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") process.stderr.write(`[worker-registry] failed to load registry: ${e}\n`);
      return BUILTIN_REGISTRY;
    }
  }
  return BUILTIN_REGISTRY;
}

/**
 * Search the registry by query string (matches name, description, tags, skills).
 */
export function searchRegistry(query: string): RegistryEntry[] {
  const registry = loadRegistry();
  const q = query.toLowerCase();
  return registry.workers.filter(w =>
    w.name.toLowerCase().includes(q) ||
    w.description.toLowerCase().includes(q) ||
    w.tags.some(t => t.toLowerCase().includes(q)) ||
    w.skills.some(s => s.toLowerCase().includes(q))
  );
}

/**
 * Get a specific registry entry by name.
 */
export function getRegistryEntry(name: string): RegistryEntry | undefined {
  const registry = loadRegistry();
  return registry.workers.find(w => w.name === name);
}

/**
 * Save updated registry to local cache.
 */
export function saveRegistry(registry: Registry): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getLocalRegistryPath(), JSON.stringify(registry, null, 2));
}
