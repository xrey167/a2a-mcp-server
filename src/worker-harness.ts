// src/worker-harness.ts
// Shared hardening for all worker responses: safe JSON, response cap, request size limit.
// Import and use in each worker's POST handler to enforce consistent limits.

import { safeStringify } from "./safe-json.js";
import { capResponse } from "./truncate.js";

/** Max response size before truncation (chars). */
const MAX_RESPONSE_SIZE = 25_000;

/** Max request body size (bytes). */
const MAX_REQUEST_BODY = 100_000; // 100KB

/**
 * Cap a skill result string to prevent oversized responses.
 * Uses safe JSON serialization if the input isn't already a string.
 */
export function hardenResponse(result: unknown): string {
  const text = typeof result === "string" ? result : safeStringify(result, 2);
  return capResponse(text, MAX_RESPONSE_SIZE);
}

/**
 * Validate request body size. Returns an error message if too large, null if OK.
 */
export function checkRequestSize(body: unknown): string | null {
  const size = typeof body === "string" ? body.length : safeStringify(body).length;
  if (size > MAX_REQUEST_BODY) {
    return `Request body too large: ${size} bytes (max ${MAX_REQUEST_BODY})`;
  }
  return null;
}

/**
 * Build a standard A2A JSON-RPC success response with hardened output.
 */
export function buildA2AResponse(
  requestId: unknown,
  taskId: unknown,
  result: string,
) {
  return {
    jsonrpc: "2.0" as const,
    id: requestId,
    result: {
      id: taskId,
      status: { state: "completed" as const },
      artifacts: [{ parts: [{ kind: "text" as const, text: hardenResponse(result) }] }],
    },
  };
}

/**
 * Build a standard A2A JSON-RPC error response.
 */
export function buildA2AError(requestId: unknown, error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    jsonrpc: "2.0" as const,
    id: requestId,
    error: { code: -32000, message: msg },
  };
}
