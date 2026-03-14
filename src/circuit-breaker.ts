/**
 * Circuit Breaker — resilient worker communication with automatic failure detection.
 *
 * States:
 *   CLOSED  → normal operation, requests flow through
 *   OPEN    → too many failures, requests fail fast without calling the worker
 *   HALF_OPEN → after cooldown, allow one probe request to test recovery
 *
 * Usage:
 *   const breaker = getBreaker("http://localhost:8081");
 *   const result = await breaker.call(() => sendTask(url, params));
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold: number;
  /** How long to keep the circuit open before allowing a probe (ms, default: 30000) */
  cooldownMs: number;
  /** Timeout for individual calls (ms, default: 30000) */
  callTimeoutMs: number;
  /** Number of successful probes needed to close the circuit (default: 2) */
  successThreshold: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  callTimeoutMs: 30_000,
  successThreshold: 2,
};

export class CircuitBreaker {
  readonly name: string;
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private lastStateChange = Date.now();
  private readonly options: CircuitBreakerOptions;

  // Metrics
  private totalCalls = 0;
  private totalSuccess = 0;
  private totalFailure = 0;
  private totalRejected = 0;

  constructor(name: string, options?: Partial<CircuitBreakerOptions>) {
    this.name = name;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get currentState(): CircuitState { return this.state; }

  get stats() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      totalCalls: this.totalCalls,
      totalSuccess: this.totalSuccess,
      totalFailure: this.totalFailure,
      totalRejected: this.totalRejected,
      lastFailureTime: this.lastFailureTime,
      lastStateChange: this.lastStateChange,
      uptimeMs: Date.now() - this.lastStateChange,
    };
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws CircuitOpenError if the circuit is open.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    if (this.state === "open") {
      // Check if cooldown has elapsed
      if (Date.now() - this.lastFailureTime >= this.options.cooldownMs) {
        this.transitionTo("half_open");
      } else {
        this.totalRejected++;
        throw new CircuitOpenError(this.name, Math.max(0, this.options.cooldownMs - (Date.now() - this.lastFailureTime)));
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Circuit breaker timeout (${this.options.callTimeoutMs}ms)`)), this.options.callTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      this.onSuccess();
      return result;
    } catch (err) {
      clearTimeout(timer);
      this.onFailure();
      throw err;
    }
  }

  /** Manually reset the circuit to closed state. */
  reset(): void {
    this.failureCount = 0;
    this.successCount = 0;
    this.transitionTo("closed");
  }

  /** Manually record a failure (e.g. from external process crash). */
  recordFailure(): void {
    this.onFailure();
  }

  private onSuccess(): void {
    this.totalSuccess++;
    this.failureCount = 0;

    if (this.state === "half_open") {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        this.transitionTo("closed");
      }
    }
  }

  private onFailure(): void {
    this.totalFailure++;
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.successCount = 0;

    if (this.state === "half_open") {
      this.transitionTo("open");
    } else if (this.state === "closed" && this.failureCount >= this.options.failureThreshold) {
      this.transitionTo("open");
    }
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    process.stderr.write(`[circuit-breaker] ${this.name}: ${this.state} → ${newState}\n`);
    this.state = newState;
    this.lastStateChange = Date.now();
    if (newState === "closed") {
      this.failureCount = 0;
      this.successCount = 0;
    }
  }
}

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;

  constructor(name: string, retryAfterMs: number) {
    super(`Circuit breaker ${name} is OPEN — retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "CircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

// ── Singleton Registry ────────────────────────────────────────────

const breakers = new Map<string, CircuitBreaker>();

/**
 * Get or create a circuit breaker for a worker URL.
 * Circuit breakers are per-worker singletons.
 */
export function getBreaker(name: string, options?: Partial<CircuitBreakerOptions>): CircuitBreaker {
  let breaker = breakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker(name, options);
    breakers.set(name, breaker);
  }
  return breaker;
}

/** Get stats for all circuit breakers. */
export function getAllBreakerStats(): Record<string, ReturnType<CircuitBreaker["stats"]>> {
  const result: Record<string, ReturnType<CircuitBreaker["stats"]>> = {};
  for (const [name, breaker] of breakers) {
    result[name] = breaker.stats;
  }
  return result;
}

/** Reset all circuit breakers (useful after worker restart). */
export function resetAllBreakers(): void {
  for (const breaker of breakers.values()) {
    breaker.reset();
  }
}
