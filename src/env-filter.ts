// src/env-filter.ts
// Filter dangerous environment variables from sandbox subprocesses.
// Prevents sandbox code from inheriting security-sensitive env vars.

/**
 * Environment variables that must NEVER be passed to sandbox subprocesses.
 * These could be used for code injection, privilege escalation, or credential theft.
 */
const DANGEROUS_ENV_KEYS = new Set([
  // Process injection
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",

  // Shell/system
  "PATH",
  "SHELL",
  "BASH_ENV",
  "ENV",
  "CDPATH",
  "IFS",
  "PROMPT_COMMAND",

  // Credentials that shouldn't leak to sandbox
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "HOMEBREW_GITHUB_API_TOKEN",

  // SSH
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",

  // Debug (could leak info)
  "NODE_DEBUG",
  "DEBUG",
]);

/**
 * Patterns that match additional dangerous keys (case-insensitive).
 */
const DANGEROUS_PATTERNS = [
  /^.*_SECRET$/i,
  /^.*_PASSWORD$/i,
  /^.*_TOKEN$/i,
  /^.*_PRIVATE_KEY$/i,
  /^.*_API_KEY$/i,
];

/**
 * Returns a filtered copy of process.env safe for sandbox subprocesses.
 * Keeps a minimal PATH for basic command execution.
 */
export function filterEnvForSandbox(): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (DANGEROUS_ENV_KEYS.has(key)) continue;
    if (DANGEROUS_PATTERNS.some(p => p.test(key))) continue;
    filtered[key] = value;
  }

  // Provide a minimal safe PATH so basic commands work
  filtered["PATH"] = "/usr/local/bin:/usr/bin:/bin";

  return filtered;
}

/**
 * Check if a specific env key is considered dangerous.
 */
export function isDangerousEnvKey(key: string): boolean {
  if (DANGEROUS_ENV_KEYS.has(key)) return true;
  return DANGEROUS_PATTERNS.some(p => p.test(key));
}
