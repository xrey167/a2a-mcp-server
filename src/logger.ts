// src/logger.ts
// Structured JSON logging to stderr. stdout is reserved for MCP JSON-RPC.

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = (process.env.A2A_LOG_LEVEL ?? "info") as LogLevel;

interface LogEntry {
  ts: string;
  level: LogLevel;
  worker: string;
  msg: string;
  [key: string]: unknown;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= (LEVEL_PRIORITY[MIN_LEVEL] ?? 1);
}

function emit(entry: LogEntry) {
  process.stderr.write(JSON.stringify(entry) + "\n");
}

/**
 * Create a logger scoped to a worker/module name.
 *
 * Usage:
 *   const log = createLogger("shell-agent");
 *   log.info("listening", { port: 8081 });
 *   log.error("command failed", { cmd, exitCode });
 */
export function createLogger(worker: string) {
  function log(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    if (!shouldLog(level)) return;
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      worker,
      msg,
      ...meta,
    };
    emit(entry);
  }

  return {
    debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
    info:  (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
    warn:  (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
  };
}
