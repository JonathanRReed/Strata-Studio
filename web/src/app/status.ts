/**
 * Typed errors and per-operation status unions.
 *
 * The data layer (data/terrainTiles.ts, data/osmOverpass.ts) reports failures
 * as Error objects with human-readable message strings. classifyError is the
 * single place that knows that string contract — everything else branches on
 * AppError.kind instead of re-sniffing messages with regexes.
 */

export type AppErrorKind =
  | "network"
  | "rate-limited"
  | "area-too-large"
  | "all-tiles-failed"
  | "aborted"
  | "unknown";

export type AppError = { kind: AppErrorKind; message: string };

export function classifyError(err: unknown): AppError {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
  if (
    (err instanceof Error && err.name === "AbortError") ||
    /^aborted$/i.test(message) ||
    /was cancelled/i.test(message)
  ) {
    return { kind: "aborted", message };
  }
  if (/all terrain tiles failed/i.test(message)) {
    return { kind: "all-tiles-failed", message };
  }
  if (/too large/i.test(message)) {
    return { kind: "area-too-large", message };
  }
  if (/too busy|rate limit/i.test(message)) {
    return { kind: "rate-limited", message };
  }
  if (/tile load (error|timeout)|timeout|fetch|network/i.test(message)) {
    return { kind: "network", message };
  }
  return { kind: "unknown", message };
}

/** Transient failures worth retrying (manually or with backoff). */
export function isRetryableError(error: AppError): boolean {
  return (
    error.kind === "network" ||
    error.kind === "rate-limited" ||
    error.kind === "all-tiles-failed"
  );
}

export type GenerateStatus =
  | { phase: "idle" }
  | { phase: "fetching"; note: string }
  | { phase: "rendering" }
  | { phase: "done" }
  | { phase: "error"; error: AppError };

export type OsmStatus =
  | { phase: "idle" }
  | { phase: "fetching" }
  | { phase: "done" }
  | { phase: "error"; error: AppError };

export type ExportStatus =
  | { phase: "idle" }
  | { phase: "fetching"; note: string }
  | { phase: "rendering" }
  | { phase: "error"; error: AppError };

export type AnimationExportStatus =
  | { phase: "idle" }
  | { phase: "exporting"; progress: number; note: string }
  | { phase: "error"; error: AppError };

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

export type RetryOptions = {
  maxRetries: number;
  baseBackoffMs: number;
  signal?: AbortSignal;
  /** Called when a retryable failure schedules a backoff wait. */
  onWait?: (backoffMs: number, attempt: number, maxRetries: number) => void;
  /** Injectable for tests; defaults to sleepWithAbort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * Runs `run` with exponential-backoff retries for retryable errors.
 *
 * The caller owns all loading/status state: set it once before calling and
 * resolve it exactly once from the returned promise. (The old in-component
 * retry loop had a `finally` inside the `for` loop, which reset the loading
 * state on every `continue` and re-enabled the Generate button mid-backoff.)
 *
 * Throws the last underlying error on a non-retryable failure, on abort, or
 * when maxRetries is exhausted.
 */
export async function retryWithBackoff<T>(
  run: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const sleep = opts.sleep ?? sleepWithAbort;
  for (let attempt = 0; ; attempt++) {
    try {
      if (opts.signal?.aborted) throw new Error("Aborted");
      return await run(attempt);
    } catch (err) {
      const error = classifyError(err);
      if (error.kind === "aborted" || opts.signal?.aborted) throw err;
      if (attempt >= opts.maxRetries || !isRetryableError(error)) throw err;
      const backoffMs = opts.baseBackoffMs * Math.pow(2, attempt);
      opts.onWait?.(backoffMs, attempt, opts.maxRetries);
      await sleep(backoffMs, opts.signal);
    }
  }
}
