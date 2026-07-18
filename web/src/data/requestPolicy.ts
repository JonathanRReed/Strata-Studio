export type RequestFailureKind =
  | "caller-abort"
  | "operation-deadline"
  | "attempt-timeout"
  | "attempt-budget"
  | "offline"
  | "network"
  | "rate-limited"
  | "http-client"
  | "http-server"
  | "decode"
  | "unknown";

export type RequestPolicyErrorOptions = {
  retryable?: boolean;
  status?: number;
  retryAfterMs?: number;
  provider?: string;
  cause?: unknown;
};

const RETRYABLE_FAILURES = new Set<RequestFailureKind>([
  "attempt-timeout",
  "network",
  "rate-limited",
  "http-server",
]);

/** A normalized request failure that callers can branch on without message sniffing. */
export class RequestPolicyError extends Error {
  readonly kind: RequestFailureKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly provider?: string;

  constructor(kind: RequestFailureKind, message: string, options: RequestPolicyErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RequestPolicyError";
    this.kind = kind;
    this.retryable = options.retryable ?? RETRYABLE_FAILURES.has(kind);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.provider = options.provider;
  }
}

/** Explicit accounting shared by every provider participating in one operation. */
export class AttemptBudget {
  readonly limit: number;
  private consumed = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Attempt budget must be a positive integer; received ${limit}`);
    }
    this.limit = limit;
  }

  get used(): number {
    return this.consumed;
  }

  get remaining(): number {
    return this.limit - this.consumed;
  }

  consume(provider?: string): { number: number; remaining: number } {
    if (this.remaining <= 0) {
      throw new RequestPolicyError(
        "attempt-budget",
        `Network attempt budget exhausted after ${this.limit} attempts`,
        { provider },
      );
    }
    this.consumed++;
    return { number: this.consumed, remaining: this.remaining };
  }
}

export type RequestTimer = unknown;

/** Injectable wall clock, randomness, and timers make all policy behavior deterministic in tests. */
export type RequestPolicyRuntime = {
  now: () => number;
  random: () => number;
  schedule: (callback: () => void, delayMs: number) => RequestTimer;
  cancel: (timer: RequestTimer) => void;
};

export const systemRequestPolicyRuntime: RequestPolicyRuntime = {
  now: () => Date.now(),
  random: () => Math.random(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export type RequestOperation = {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly runtime: RequestPolicyRuntime;
  remainingMs: () => number;
  throwIfAborted: () => void;
  dispose: () => void;
};

export type CreateRequestOperationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  deadlineAt?: number;
  runtime?: RequestPolicyRuntime;
  label?: string;
};

function abortMessage(label: string | undefined, suffix: string): string {
  return label ? `${label} ${suffix}` : suffix[0].toUpperCase() + suffix.slice(1);
}

export function abortErrorFromSignal(
  signal: AbortSignal,
  fallbackKind: RequestFailureKind = "caller-abort",
): RequestPolicyError {
  if (signal.reason instanceof RequestPolicyError) return signal.reason;
  const cause = signal.reason;
  const message =
    fallbackKind === "operation-deadline"
      ? "Operation deadline exceeded"
      : fallbackKind === "attempt-timeout"
        ? "Request attempt timed out"
        : "Aborted";
  return new RequestPolicyError(fallbackKind, message, { cause });
}

/** Caller abort and an absolute deadline combined into one operation-scoped signal. */
export function createRequestOperation(
  options: CreateRequestOperationOptions,
): RequestOperation {
  const runtime = options.runtime ?? systemRequestPolicyRuntime;
  const startedAt = runtime.now();
  const timeoutDeadline =
    options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : startedAt + Math.max(0, options.timeoutMs);
  const explicitDeadline = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  const deadlineAt = Math.min(timeoutDeadline, explicitDeadline);
  if (!Number.isFinite(deadlineAt)) {
    throw new RangeError("Request operation requires timeoutMs or deadlineAt");
  }

  const controller = new AbortController();
  let deadlineTimer: RequestTimer | undefined;
  const onCallerAbort = () => {
    if (controller.signal.aborted) return;
    const reason = options.signal
      ? abortErrorFromSignal(options.signal)
      : new RequestPolicyError("caller-abort", "Aborted");
    controller.abort(reason);
  };

  if (options.signal?.aborted) {
    onCallerAbort();
  } else {
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  const deadlineDelay = Math.max(0, deadlineAt - runtime.now());
  const onDeadline = () => {
    if (controller.signal.aborted) return;
    controller.abort(
      new RequestPolicyError(
        "operation-deadline",
        abortMessage(options.label, "deadline exceeded"),
      ),
    );
  };
  if (!controller.signal.aborted) {
    if (deadlineDelay <= 0) onDeadline();
    else deadlineTimer = runtime.schedule(onDeadline, deadlineDelay);
  }

  return {
    signal: controller.signal,
    deadlineAt,
    runtime,
    remainingMs: () => Math.max(0, deadlineAt - runtime.now()),
    throwIfAborted: () => {
      if (controller.signal.aborted) throw abortErrorFromSignal(controller.signal);
      if (runtime.now() >= deadlineAt) {
        onDeadline();
        throw abortErrorFromSignal(controller.signal, "operation-deadline");
      }
    },
    dispose: () => {
      if (deadlineTimer !== undefined) runtime.cancel(deadlineTimer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function parseRetryAfter(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

/** Full-jitter exponential backoff in [0, min(cap, base * 2^retryIndex)). */
export function fullJitterBackoffMs(
  baseMs: number,
  capMs: number,
  retryIndex: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.max(0, Math.min(capMs, baseMs * Math.pow(2, Math.max(0, retryIndex))));
  const unit = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  return Math.floor(unit * ceiling);
}

export function normalizeRequestFailure(
  error: unknown,
  provider?: string,
): RequestPolicyError {
  if (error instanceof RequestPolicyError) return error;
  if (error instanceof TypeError) {
    return new RequestPolicyError("network", error.message || "Network request failed", {
      provider,
      cause: error,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new RequestPolicyError("network", error.message || "Network request aborted", {
      provider,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RequestPolicyError("unknown", message, { provider, cause: error });
}

export function requestFailureFromResponse(
  response: Response,
  url: string,
  options: { provider?: string; nowMs?: number } = {},
): RequestPolicyError {
  const status = response.status;
  const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"), options.nowMs);
  const detail = `Request failed (${status}): ${url}`;
  if (status === 429) {
    return new RequestPolicyError("rate-limited", detail, {
      status,
      retryAfterMs,
      provider: options.provider,
    });
  }
  if (status >= 500) {
    return new RequestPolicyError("http-server", detail, {
      status,
      retryAfterMs,
      provider: options.provider,
    });
  }
  if (status >= 400) {
    return new RequestPolicyError("http-client", detail, {
      status,
      retryAfterMs,
      provider: options.provider,
    });
  }
  return new RequestPolicyError("unknown", detail, {
    status,
    retryAfterMs,
    provider: options.provider,
  });
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortErrorFromSignal(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortErrorFromSignal(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export type RunRequestAttemptOptions<T> = {
  operation: RequestOperation;
  budget: AttemptBudget;
  timeoutMs: number;
  provider?: string;
  run: (context: {
    signal: AbortSignal;
    attempt: number;
    remainingAttempts: number;
  }) => Promise<T>;
};

/** Runs exactly one accounted attempt, bounded by both per-attempt and operation timers. */
export async function runRequestAttempt<T>(
  options: RunRequestAttemptOptions<T>,
): Promise<T> {
  const { operation, budget, provider } = options;
  operation.throwIfAborted();
  const remainingOperationMs = operation.remainingMs();
  if (remainingOperationMs <= 0) {
    throw new RequestPolicyError("operation-deadline", "Operation deadline exceeded", { provider });
  }

  const attempt = budget.consume(provider);
  const controller = new AbortController();
  const onOperationAbort = () => controller.abort(abortErrorFromSignal(operation.signal));
  operation.signal.addEventListener("abort", onOperationAbort, { once: true });

  const timeoutMs = Math.max(0, Math.min(options.timeoutMs, remainingOperationMs));
  const timeoutKind: RequestFailureKind =
    remainingOperationMs <= options.timeoutMs ? "operation-deadline" : "attempt-timeout";
  const timer = operation.runtime.schedule(() => {
    if (controller.signal.aborted) return;
    controller.abort(
      new RequestPolicyError(
        timeoutKind,
        timeoutKind === "operation-deadline"
          ? "Operation deadline exceeded"
          : `Request attempt timed out after ${options.timeoutMs}ms`,
        { provider },
      ),
    );
  }, timeoutMs);

  try {
    const pending = Promise.resolve().then(() =>
      options.run({
        signal: controller.signal,
        attempt: attempt.number,
        remainingAttempts: attempt.remaining,
      }),
    );
    return await raceWithSignal(pending, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw abortErrorFromSignal(controller.signal);
    throw normalizeRequestFailure(error, provider);
  } finally {
    operation.runtime.cancel(timer);
    operation.signal.removeEventListener("abort", onOperationAbort);
  }
}

function waitWithSignal(
  ms: number,
  operation: RequestOperation,
): Promise<void> {
  operation.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      operation.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = operation.runtime.schedule(() => finish(resolve), ms);
    const onAbort = () => {
      operation.runtime.cancel(timer);
      finish(() => reject(abortErrorFromSignal(operation.signal)));
    };
    operation.signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type RetryWaitOptions = {
  operation: RequestOperation;
  failure: RequestPolicyError;
  retryIndex: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
};

/** Honors Retry-After when present; otherwise waits a deterministic full-jitter delay. */
export async function waitForRetry(options: RetryWaitOptions): Promise<number> {
  const jitterMs = fullJitterBackoffMs(
    options.baseBackoffMs,
    options.maxBackoffMs,
    options.retryIndex,
    options.operation.runtime.random,
  );
  const delayMs = Math.max(jitterMs, options.failure.retryAfterMs ?? 0);
  if (delayMs <= 0) return 0;
  if (delayMs >= options.operation.remainingMs()) {
    throw new RequestPolicyError(
      "operation-deadline",
      "Retry delay would exceed the operation deadline",
      { provider: options.failure.provider, cause: options.failure },
    );
  }
  await waitWithSignal(delayMs, options.operation);
  return delayMs;
}

export function isAbortFailure(error: unknown): boolean {
  return (
    error instanceof RequestPolicyError &&
    (error.kind === "caller-abort" || error.kind === "operation-deadline")
  );
}
