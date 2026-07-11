import { describe, it, expect } from "bun:test";
import { classifyError, isRetryableError, retryWithBackoff, type AppErrorKind } from "./status.ts";

describe("classifyError", () => {
  const cases: [string, AppErrorKind][] = [
    ["All terrain tiles failed to load", "all-tiles-failed"],
    ["Tile load timeout: https://example.com/1/2/3.png", "network"],
    ["Tile fetch failed (500): https://example.com/1/2/3.png", "network"],
    ["Network error while fetching OSM features: connection refused", "network"],
    ["OSM fetch failed after retries.", "network"],
    ["Overpass API rate limit reached. Please wait a minute before trying again.", "rate-limited"],
    [
      "Overpass API is too busy right now. This is a public server with rate limits. Please wait a few seconds and try again.",
      "rate-limited",
    ],
    ["Bounding box is too large (> 25 km²). Please zoom in.", "area-too-large"],
    ["Selected area is too large for OSM queries. Please zoom in (max ~25 km²).", "area-too-large"],
    ["Aborted", "aborted"],
    ["OSM fetch was cancelled.", "aborted"],
    ["Something exploded", "unknown"],
    ["Overpass API returned 400: parse error", "unknown"],
  ];

  for (const [message, kind] of cases) {
    it(`classifies "${message.slice(0, 48)}" as ${kind}`, () => {
      expect(classifyError(new Error(message))).toEqual({ kind, message });
    });
  }

  it("classifies DOMException-style AbortError by name", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(classifyError(err).kind).toBe("aborted");
  });

  it("handles non-Error values", () => {
    expect(classifyError("rate limit hit")).toEqual({ kind: "rate-limited", message: "rate limit hit" });
    expect(classifyError(42)).toEqual({ kind: "unknown", message: "Unknown error" });
  });

  it("marks network, rate-limited, and all-tiles-failed as retryable", () => {
    const retryable: AppErrorKind[] = ["network", "rate-limited", "all-tiles-failed"];
    const notRetryable: AppErrorKind[] = ["area-too-large", "aborted", "unknown"];
    for (const kind of retryable) expect(isRetryableError({ kind, message: "" })).toBe(true);
    for (const kind of notRetryable) expect(isRetryableError({ kind, message: "" })).toBe(false);
  });
});

describe("retryWithBackoff", () => {
  const instantSleep = () => Promise.resolve();

  it("returns the first successful result without waiting", async () => {
    const waits: number[] = [];
    const result = await retryWithBackoff(() => Promise.resolve("ok"), {
      maxRetries: 2,
      baseBackoffMs: 800,
      onWait: (ms) => waits.push(ms),
      sleep: instantSleep,
    });
    expect(result).toBe("ok");
    expect(waits).toEqual([]);
  });

  it("retries retryable errors with exponential backoff, then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retryWithBackoff(
      () => {
        calls++;
        if (calls < 3) return Promise.reject(new Error("Tile load timeout: x"));
        return Promise.resolve("done");
      },
      { maxRetries: 2, baseBackoffMs: 800, onWait: (ms) => waits.push(ms), sleep: instantSleep },
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
    expect(waits).toEqual([800, 1600]);
  });

  it("throws immediately on non-retryable errors", async () => {
    let calls = 0;
    const waits: number[] = [];
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          return Promise.reject(new Error("Bounding box is too large (> 25 km²). Please zoom in."));
        },
        { maxRetries: 2, baseBackoffMs: 800, onWait: (ms) => waits.push(ms), sleep: instantSleep },
      ),
    ).rejects.toThrow(/too large/);
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("throws the last error after exhausting maxRetries", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          return Promise.reject(new Error(`attempt ${calls}: network down`));
        },
        { maxRetries: 2, baseBackoffMs: 1, sleep: instantSleep },
      ),
    ).rejects.toThrow("attempt 3: network down");
    expect(calls).toBe(3);
  });

  it("does not call run when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          return Promise.resolve("never");
        },
        { maxRetries: 2, baseBackoffMs: 1, signal: controller.signal },
      ),
    ).rejects.toThrow("Aborted");
    expect(calls).toBe(0);
  });

  it("stops retrying when aborted during the backoff wait", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          return Promise.reject(new Error("network flake"));
        },
        {
          maxRetries: 5,
          baseBackoffMs: 1,
          signal: controller.signal,
          sleep: () => {
            controller.abort();
            return Promise.reject(new Error("Aborted"));
          },
        },
      ),
    ).rejects.toThrow("Aborted");
    expect(calls).toBe(1);
  });

  it("does not rethrow an abort as a retryable failure", async () => {
    await expect(
      retryWithBackoff(() => Promise.reject(new Error("Aborted")), {
        maxRetries: 5,
        baseBackoffMs: 1,
        sleep: instantSleep,
      }),
    ).rejects.toThrow("Aborted");
  });

  // Regression test for the generate-flow bug: the old retry loop had a
  // try/catch/finally INSIDE the for loop, so `finally` ran on every retry
  // `continue` and cleared isLoading/statusText during the backoff wait —
  // re-enabling the Generate button mid-retry. The contract now is that the
  // caller sets loading once before retryWithBackoff and resolves it once
  // after; this asserts loading stays set across every wait.
  it("keeps caller loading state set across backoff waits (finally-bug regression)", async () => {
    let loading = false;
    const loadingDuringWaits: boolean[] = [];
    let calls = 0;

    loading = true; // set once before the retry loop
    const result = await retryWithBackoff(
      () => {
        calls++;
        if (calls < 3) return Promise.reject(new Error("Tile load timeout: y"));
        return Promise.resolve("grid");
      },
      {
        maxRetries: 2,
        baseBackoffMs: 1,
        onWait: () => loadingDuringWaits.push(loading),
        sleep: () => {
          loadingDuringWaits.push(loading);
          return Promise.resolve();
        },
      },
    );
    loading = false; // cleared once after the loop resolves

    expect(result).toBe("grid");
    expect(loadingDuringWaits).toEqual([true, true, true, true]);
  });
});
