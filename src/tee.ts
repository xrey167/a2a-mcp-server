// src/tee.ts
// Raw output recovery — saves unfiltered output to temp files when
// filtering removes significant content, allowing full recovery.

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// ── Config ───────────────────────────────────────────────────────

function getTeeDir(): string {
  const dir = join(process.env.HOME ?? homedir(), ".a2a-mcp", "tee");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Save raw unfiltered output to a tee file.
 * Returns the file path for later retrieval.
 */
export function teeOutput(raw: string, skillId: string): string {
  const dir = getTeeDir();
  const ts = Date.now();
  const safeName = skillId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${ts}-${safeName}.txt`;
  const filePath = join(dir, filename);
  try {
    writeFileSync(filePath, raw, "utf-8");
  } catch (e) {
    process.stderr.write(`[tee] write error: ${e}\n`);
  }
  return filePath;
}

/**
 * Read a previously tee'd raw output file.
 * Validates path is within the tee directory.
 */
export function readTee(path: string): string {
  const dir = getTeeDir();
  const resolved = resolve(path);
  if (!resolved.startsWith(dir)) {
    return `Error: path must be within ${dir}`;
  }
  if (!existsSync(resolved)) {
    return `Error: file not found: ${path}`;
  }
  return readFileSync(resolved, "utf-8");
}

/**
 * Prune tee files older than maxAgeMs (default 24 hours).
 * Returns count of deleted files.
 */
export function pruneTeeFiles(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const dir = getTeeDir();
  let pruned = 0;
  const cutoff = Date.now() - maxAgeMs;

  try {
    for (const file of readdirSync(dir)) {
      const filePath = join(dir, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filePath);
          pruned++;
        }
      } catch { /* skip */ }
    }
  } catch { /* dir may not exist */ }

  return pruned;
}

/**
 * List available tee files with their timestamps and sizes.
 */
export function listTeeFiles(): Array<{ path: string; skill: string; timestamp: string; sizeKB: number }> {
  const dir = getTeeDir();
  if (!existsSync(dir)) return [];

  const files: Array<{ path: string; skill: string; timestamp: string; sizeKB: number }> = [];
  for (const file of readdirSync(dir)) {
    const filePath = join(dir, file);
    try {
      const stat = statSync(filePath);
      // Parse filename: {timestamp}-{skillId}.txt
      const match = file.match(/^(\d+)-(.+)\.txt$/);
      files.push({
        path: filePath,
        skill: match?.[2]?.replace(/_/g, ".") ?? file,
        timestamp: match ? new Date(parseInt(match[1])).toISOString() : stat.mtime.toISOString(),
        sizeKB: Math.round(stat.size / 1024),
      });
    } catch { /* skip */ }
  }

  return files.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
