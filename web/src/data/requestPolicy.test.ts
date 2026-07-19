import { describe, expect, test } from "bun:test";
import {
  AttemptBudget,
  createRequestOperation,
  fullJitterBackoffMs,
  parseRetryAfter,
  RequestPolicyError,
  runRequestAttempt,
  waitForRetry,
  type RequestPolicyRuntime,
  type RequestTimer,
} from "./requestPolicy.ts";

class FakeRuntime implements RequestPolicyRuntime {
  currentTime = 0;
  randomValue = 0;
  private nextTimer = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.currentTime;
  random = () => this.randomValue;
  schedule = (callback: () => void, delayMs: number): RequestTimer => {
    const id = this.nextTimer++;
    this.timers.set(id, { at: this.currentTime + Math.max(0, delayMs), callback });
    return id;
  };
  cancel = (timer: RequestTimer) => {
    this.timers.delete(timer as number);
  };

  advance(ms: number): void {
    const target = this.currentTime + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.currentTime = timer.at;
      timer.callback();
    }
    this.currentTime = target;
  }
}

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected promise to reject");
    },
    (error) => error,
  );
}

describe("request policy primitives", () => {
  test("accounts for a fixed attempt budget across providers", () => {
    const budget = new AttemptBudget(3);
    expect(budget.consume("proxy")).toEqual({ number: 1, remaining: 2 });
    expect(budget.consume("proxy")).toEqual({ number: 2, remaining: 1 });
    expect(budget.consume("direct")).toEqual({ number: 3, remaining: 0 });
    expect(budget.used).toBe(3);
    expect(() => budget.consume("direct")).toThrow("budget exhausted");
  });

  test("parses Retry-After delta seconds and HTTP dates", () => {
    const now = Date.parse("2026-07-17T12:00:00Z");
    expect(parseRetryAfter("2.5", now)).toBe(2500);
    expect(parseRetryAfter("Fri, 17 Jul 2026 12:00:04 GMT", now)).toBe(4000);
    expect(parseRetryAfter("Fri, 17 Jul 2026 11:59:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("not-a-date", now)).toBeUndefined();
  });

  test("uses deterministic full-jitter exponential backoff", () => {
    expect(fullJitterBackoffMs(300, 2500, 0, () => 0)).toBe(0);
    expect(fullJitterBackoffMs(300, 2500, 1, () => 0.5)).toBe(300);
    expect(fullJitterBackoffMs(300, 2500, 8, () => 0.5)).toBe(1250);
  });

  test("honors Retry-After before retrying", async () => {
    const runtime = new FakeRuntime();
    const operation = createRequestOperation({ timeoutMs: 10000, runtime });
    const failure = new RequestPolicyError("rate-limited", "Too many requests", {
      retryAfterMs: 2000,
      provider: "proxy",
    });
    let settled = false;
    const pending = waitForRetry({
      operation,
      failure,
      retryIndex: 0,
      baseBackoffMs: 300,
      maxBackoffMs: 2500,
    }).then((delay) => {
      settled = true;
      return delay;
    });

    runtime.advance(1999);
    await flushMicrotasks();
    expect(settled).toBe(false);
    runtime.advance(1);
    await expect(pending).resolves.toBe(2000);
    operation.dispose();
  });

  test("refuses a Retry-After wait that would overrun the operation deadline", async () => {
    const runtime = new FakeRuntime();
    const operation = createRequestOperation({ timeoutMs: 1000, runtime });
    const failure = new RequestPolicyError("rate-limited", "Too many requests", {
      retryAfterMs: 1000,
    });
    await expect(
      waitForRetry({
        operation,
        failure,
        retryIndex: 0,
        baseBackoffMs: 300,
        maxBackoffMs: 2500,
      }),
    ).rejects.toMatchObject({ kind: "operation-deadline" });
    expect(runtime.currentTime).toBe(0);
    operation.dispose();
  });

  test("times out a black-holed attempt without exceeding its budget", async () => {
    const runtime = new FakeRuntime();
    const operation = createRequestOperation({ timeoutMs: 1000, runtime });
    const budget = new AttemptBudget(1);
    const pending = runRequestAttempt({
      operation,
      budget,
      timeoutMs: 100,
      provider: "proxy",
      run: () => new Promise<string>(() => {}),
    });
    const rejection = captureRejection(pending);

    runtime.advance(99);
    await flushMicrotasks();
    expect(budget.used).toBe(1);
    runtime.advance(1);
    expect(await rejection).toMatchObject({
      kind: "attempt-timeout",
      provider: "proxy",
    });
    expect(budget.remaining).toBe(0);
    operation.dispose();
  });

  test("distinguishes caller abort from an absolute operation deadline", async () => {
    const callerRuntime = new FakeRuntime();
    const caller = new AbortController();
    const callerOperation = createRequestOperation({
      signal: caller.signal,
      timeoutMs: 1000,
      runtime: callerRuntime,
    });
    caller.abort();
    expect(() => callerOperation.throwIfAborted()).toThrow("Aborted");
    try {
      callerOperation.throwIfAborted();
    } catch (error) {
      expect(error).toMatchObject({ kind: "caller-abort" });
    }
    callerOperation.dispose();

    const deadlineRuntime = new FakeRuntime();
    const deadlineOperation = createRequestOperation({
      timeoutMs: 250,
      runtime: deadlineRuntime,
      label: "Preview",
    });
    deadlineRuntime.advance(250);
    try {
      deadlineOperation.throwIfAborted();
    } catch (error) {
      expect(error).toMatchObject({ kind: "operation-deadline" });
      expect((error as Error).message).toBe("Preview deadline exceeded");
    }
    deadlineOperation.dispose();
  });
});
