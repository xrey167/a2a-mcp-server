// NDJSON stdio transport for the Agent Client Protocol (ACP).
// Reads newline-delimited JSON from stdin, writes to stdout.
// All debug/log output MUST go to stderr (stdout is protocol-only).

import type { JsonRpcRequest, JsonRpcNotification, JsonRpcResponse } from "./acp-types.js";

export type IncomingMessage = JsonRpcRequest | JsonRpcNotification;

type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;

/**
 * NDJSON reader: reads stdin line-by-line, parses JSON, and calls the handler.
 * Returns a cleanup function.
 */
export function startReading(handler: MessageHandler): () => void {
  let buffer = "";
  let closed = false;

  const decoder = new TextDecoder();

  async function readLoop() {
    const reader = Bun.stdin.stream().getReader();
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          let msg: unknown;
          try {
            msg = JSON.parse(line);
          } catch {
            process.stderr.write(`[acp-transport] invalid JSON: ${line.slice(0, 200)}\n`);
            continue;
          }
          try {
            await handler(msg as IncomingMessage);
          } catch (err) {
            process.stderr.write(`[acp-transport] handler error: ${err}\n`);
          }
        }
      }
    } catch (err) {
      if (!closed) {
        process.stderr.write(`[acp-transport] stdin read error: ${err}\n`);
      }
    } finally {
      reader.releaseLock();
    }
  }

  readLoop();

  return () => {
    closed = true;
  };
}

/** Send a JSON-RPC response (reply to a request). */
export function sendResponse(response: JsonRpcResponse): void {
  const line = JSON.stringify(response) + "\n";
  process.stdout.write(line);
}

/** Send a JSON-RPC notification (no id, no reply expected). */
export function sendNotification(method: string, params?: Record<string, unknown>): void {
  const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
  const line = JSON.stringify(msg) + "\n";
  process.stdout.write(line);
}

/** Send a JSON-RPC request from agent to client (e.g. request_permission, fs/read_text_file). */
let nextRequestId = 1;
const pendingRequests = new Map<string | number, {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/** Default per-request timeout in milliseconds (30 seconds). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function sendRequest(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const timeout = timeoutMs != null && timeoutMs > 0 ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingRequests.delete(id)) {
        reject(new Error(`Request "${method}" (id=${id}) timed out after ${timeout}ms`));
      }
    }, timeout);
    pendingRequests.set(id, { resolve, reject, timer });
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const line = JSON.stringify(msg) + "\n";
    process.stdout.write(line);
  });
}

/**
 * Reject all pending requests and cancel their timers.
 * Call this when shutting down to avoid memory leaks from unresolved promises.
 */
export function closeTransport(): void {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`Transport closed with pending request id=${id}`));
  }
  pendingRequests.clear();
}

/**
 * Handle an incoming message that might be a response to a pending agent→client request.
 * Returns true if it was a response (consumed), false otherwise.
 */
export function handlePossibleResponse(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  if (!("id" in obj) || obj.method !== undefined) return false; // It's a request/notification, not a response
  const id = obj.id as string | number;
  const pending = pendingRequests.get(id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRequests.delete(id);
  if ("error" in obj && obj.error) {
    const err = obj.error as { message?: string };
    pending.reject(new Error(err.message ?? "Unknown error"));
  } else {
    pending.resolve(obj.result);
  }
  return true;
}
