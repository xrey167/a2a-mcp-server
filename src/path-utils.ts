/**
 * Path sanitization utilities for security.
 *
 * Prevents path traversal attacks and command injection by validating
 * file paths before use in file system operations.
 */

import { resolve, normalize, isAbsolute } from "node:path";
import { homedir } from "node:os";

/**
 * Sanitize a path for safe use in file system operations.
 *
 * Validates that the path:
 * - Does not contain path traversal sequences (..)
 * - Does not contain shell metacharacters or control characters
 * - Uses only safe characters (alphanumeric, hyphens, underscores, dots, slashes, tildes)
 *
 * @param path - The path to sanitize
 * @param baseDir - Optional base directory to constrain the path within
 * @returns The sanitized path
 * @throws Error if the path is unsafe or escapes the base directory
 */
export function sanitizePath(path: string, baseDir?: string): string {
  if (!path || typeof path !== "string") {
    throw new Error("Path must be a non-empty string");
  }

  // Only allow alphanumeric, hyphens, underscores, dots, slashes, and tildes
  // This prevents shell metacharacters and control characters
  if (!/^[a-zA-Z0-9_.\/~-]+$/.test(path)) {
    throw new Error(`Unsafe path rejected: "${path}" — path contains disallowed characters`);
  }

  // Reject explicit path traversal attempts
  if (path.includes("..")) {
    throw new Error(`Unsafe path rejected: "${path}" — path contains '..'`);
  }

  // If a base directory is provided, ensure the resolved path is within it
  if (baseDir) {
    const resolvedBase = resolve(expandTilde(baseDir));
    const resolvedPath = resolve(resolvedBase, expandTilde(path));

    // Normalize both paths to handle any remaining edge cases
    const normalizedBase = normalize(resolvedBase);
    const normalizedPath = normalize(resolvedPath);

    // Check if the resolved path starts with the base directory
    if (!normalizedPath.startsWith(normalizedBase + "/") && normalizedPath !== normalizedBase) {
      throw new Error(
        `Unsafe path rejected: "${path}" — resolved path "${normalizedPath}" escapes base directory "${normalizedBase}"`
      );
    }

    return resolvedPath;
  }

  return path;
}

/**
 * Expand tilde (~) in paths to the user's home directory.
 * @param path - Path that may contain ~
 * @returns Path with ~ expanded
 */
function expandTilde(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return path.replace(/^~/, homedir());
  }
  return path;
}

/**
 * Sanitize a relative path extracted from LLM output for use in file operations.
 *
 * This is specifically designed for paths that come from AI model responses,
 * which may be adversarially crafted to escape project directories.
 *
 * @param relPath - Relative path from LLM output
 * @param projectDir - Project directory to constrain writes within
 * @returns The full sanitized absolute path
 * @throws Error if the path is unsafe or attempts to escape the project directory
 */
export function sanitizeRelativePath(relPath: string, projectDir: string): string {
  // First sanitize the relative path itself
  const safePath = sanitizePath(relPath);

  // Reject absolute paths (LLM should only return relative paths)
  if (isAbsolute(safePath)) {
    throw new Error(`Unsafe path rejected: "${relPath}" — LLM returned absolute path`);
  }

  // Construct full path and validate it's within the project directory
  return sanitizePath(safePath, projectDir);
}
