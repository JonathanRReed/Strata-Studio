import {
  AttemptBudget,
  RequestPolicyError,
  abortErrorFromSignal,
  createRequestOperation,
  normalizeRequestFailure,
  requestFailureFromResponse,
  runRequestAttempt,
  type RequestPolicyRuntime,
  systemRequestPolicyRuntime,
} from "./requestPolicy.ts";
import { sanitizeSearchQuery } from "../app/stateSafety.ts";

const NOMINATIM_ORIGIN = "https://nominatim.openstreetmap.org";
export const NOMINATIM_MIN_INTERVAL_MS = 1_000;
export const NOMINATIM_DEADLINE_MS = 10_000;
const PLACE_FIELDS = ["city", "town", "village", "county"] as const;

type NominatimReverseResponse = {
  display_name?: string;
  address?: Record<string, string>;
  error?: string;
};

export type NominatimSearchResult = {
  lat: number;
  lng: number;
  displayName: string;
};

export type GeocodeOutcome<T> =
  | { status: "success"; value: T; cached: boolean }
  | { status: "no-results"; cached: boolean }
  | { status: "unavailable"; message: string }
  | { status: "rate-limited"; message: string }
  | { status: "cancelled" };

type CacheableOutcome<T> =
  | { status: "success"; value: T; cached: boolean }
  | { status: "no-results"; cached: boolean };

type SharedRequest<T> = {
  promise: Promise<GeocodeOutcome<T>>;
  controller: AbortController;
  subscribers: number;
};

export type NominatimFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type NominatimDependencies = {
  fetch?: NominatimFetch;
  runtime?: RequestPolicyRuntime;
  minIntervalMs?: number;
  deadlineMs?: number;
};

export function pickPlaceName(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as NominatimReverseResponse;
  if (typeof data.error === "string") return null;
  const address = data.address;
  if (address && typeof address === "object") {
    for (const field of PLACE_FIELDS) {
      const value = address[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  if (typeof data.display_name === "string") {
    const first = data.display_name.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

function pickSearchResult(payload: unknown): NominatimSearchResult | null {
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const first = payload[0];
  if (!first || typeof first !== "object") return null;
  const item = first as Record<string, unknown>;
  const lat = Number(item.lat);
  const lng = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const displayName =
    typeof item.display_name === "string" && item.display_name.trim()
      ? item.display_name.trim()
      : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  return { lat, lng, displayName };
}

function waitForTurn(
  ms: number,
  signal: AbortSignal,
  runtime: RequestPolicyRuntime,
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortErrorFromSignal(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = runtime.schedule(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      runtime.cancel(timer);
      reject(abortErrorFromSignal(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function attachSubscriber<T>(
  shared: SharedRequest<T>,
  signal?: AbortSignal,
): Promise<GeocodeOutcome<T>> {
  shared.subscribers++;
  let active = true;
  const release = (abortUnderlying: boolean) => {
    if (!active) return;
    active = false;
    shared.subscribers--;
    if (abortUnderlying && shared.subscribers <= 0 && !shared.controller.signal.aborted) {
      shared.controller.abort(new RequestPolicyError("caller-abort", "Aborted"));
    }
  };

  if (!signal) {
    return shared.promise.finally(() => release(false));
  }
  if (signal.aborted) {
    release(true);
    return Promise.resolve({ status: "cancelled" });
  }

  return new Promise((resolve) => {
    const onAbort = () => {
      release(true);
      resolve({ status: "cancelled" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    shared.promise.then((outcome) => {
      signal.removeEventListener("abort", onAbort);
      if (!active) return;
      release(false);
      resolve(outcome);
    });
  });
}

function outcomeFromError(error: unknown): Exclude<GeocodeOutcome<never>, CacheableOutcome<never>> {
  const failure = normalizeRequestFailure(error, "nominatim");
  if (failure.kind === "caller-abort") return { status: "cancelled" };
  if (failure.kind === "rate-limited" || failure.status === 429) {
    return {
      status: "rate-limited",
      message: "Nominatim is rate limiting requests. Wait a moment and retry.",
    };
  }
  if (failure.kind === "operation-deadline" || failure.kind === "attempt-timeout") {
    return {
      status: "unavailable",
      message: "Geocoding timed out after 10 seconds.",
    };
  }
  return {
    status: "unavailable",
    message: "Geocoding is currently unavailable. Check your connection and retry.",
  };
}

export class NominatimService {
  private readonly fetchImpl: NominatimFetch;
  private readonly runtime: RequestPolicyRuntime;
  private readonly minIntervalMs: number;
  private readonly deadlineMs: number;
  private readonly cache = new Map<string, CacheableOutcome<unknown>>();
  private readonly inFlight = new Map<string, SharedRequest<unknown>>();
  private gate: Promise<void> = Promise.resolve();
  private nextStartAt = 0;

  constructor(dependencies: NominatimDependencies = {}) {
    this.fetchImpl = dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.runtime = dependencies.runtime ?? systemRequestPolicyRuntime;
    this.minIntervalMs = dependencies.minIntervalMs ?? NOMINATIM_MIN_INTERVAL_MS;
    this.deadlineMs = dependencies.deadlineMs ?? NOMINATIM_DEADLINE_MS;
  }

  clearSession(): void {
    this.cache.clear();
  }

  private async reserveStart(signal: AbortSignal): Promise<void> {
    const turn = this.gate.then(async () => {
      const waitMs = Math.max(0, this.nextStartAt - this.runtime.now());
      await waitForTurn(waitMs, signal, this.runtime);
      if (signal.aborted) throw abortErrorFromSignal(signal);
      this.nextStartAt = this.runtime.now() + this.minIntervalMs;
    });
    this.gate = turn.catch(() => undefined);
    await turn;
  }

  private async perform<T>(
    url: URL,
    pick: (payload: unknown) => T | null,
    signal: AbortSignal,
  ): Promise<GeocodeOutcome<T>> {
    const operation = createRequestOperation({
      signal,
      timeoutMs: this.deadlineMs,
      runtime: this.runtime,
      label: "Geocoding",
    });
    try {
      await this.reserveStart(operation.signal);
      operation.throwIfAborted();
      const payload = await runRequestAttempt({
        operation,
        budget: new AttemptBudget(1),
        timeoutMs: operation.remainingMs(),
        provider: "nominatim",
        run: async ({ signal: attemptSignal }) => {
          const response = await this.fetchImpl(url, {
            signal: attemptSignal,
            headers: { Accept: "application/json" },
          });
          if (!response.ok) throw requestFailureFromResponse(response, url.toString(), {
            provider: "nominatim",
            nowMs: this.runtime.now(),
          });
          try {
            return await response.json();
          } catch (error) {
            throw new RequestPolicyError("decode", "Nominatim returned invalid JSON", {
              provider: "nominatim",
              cause: error,
            });
          }
        },
      });
      const value = pick(payload);
      return value === null
        ? { status: "no-results", cached: false }
        : { status: "success", value, cached: false };
    } catch (error) {
      return outcomeFromError(error) as GeocodeOutcome<T>;
    } finally {
      operation.dispose();
    }
  }

  private request<T>(
    key: string,
    url: URL,
    pick: (payload: unknown) => T | null,
    signal?: AbortSignal,
  ): Promise<GeocodeOutcome<T>> {
    if (signal?.aborted) return Promise.resolve({ status: "cancelled" });
    const cached = this.cache.get(key) as CacheableOutcome<T> | undefined;
    if (cached) return Promise.resolve({ ...cached, cached: true });

    let shared = this.inFlight.get(key) as SharedRequest<T> | undefined;
    if (shared?.controller.signal.aborted) {
      if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
      shared = undefined;
    }
    if (!shared) {
      const controller = new AbortController();
      const created: SharedRequest<T> = {
        controller,
        subscribers: 0,
        promise: Promise.resolve({ status: "cancelled" }),
      };
      created.promise = this.perform(url, pick, controller.signal).then((outcome) => {
        if (outcome.status === "success" || outcome.status === "no-results") {
          this.cache.set(key, outcome as CacheableOutcome<unknown>);
        }
        return outcome;
      }).finally(() => {
        if (this.inFlight.get(key) === created) this.inFlight.delete(key);
      });
      this.inFlight.set(key, created as SharedRequest<unknown>);
      shared = created;
    }
    return attachSubscriber(shared, signal);
  }

  search(query: string, signal?: AbortSignal): Promise<GeocodeOutcome<NominatimSearchResult>> {
    const normalized = sanitizeSearchQuery(query);
    if (!normalized) return Promise.resolve({ status: "no-results", cached: false });
    const url = new URL("/search", NOMINATIM_ORIGIN);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    url.searchParams.set("q", normalized);
    return this.request(`search:${normalized.toLocaleLowerCase()}`, url, pickSearchResult, signal);
  }

  reverse(lat: number, lng: number, signal?: AbortSignal): Promise<GeocodeOutcome<string>> {
    const safeLat = Number.isFinite(lat) ? lat : 0;
    const safeLng = Number.isFinite(lng) ? lng : 0;
    const url = new URL("/reverse", NOMINATIM_ORIGIN);
    url.searchParams.set("format", "json");
    url.searchParams.set("zoom", "10");
    url.searchParams.set("lat", safeLat.toFixed(5));
    url.searchParams.set("lon", safeLng.toFixed(5));
    return this.request(
      `reverse:${safeLat.toFixed(5)},${safeLng.toFixed(5)}`,
      url,
      pickPlaceName,
      signal,
    );
  }
}

export const nominatim = new NominatimService();

export function searchGeocode(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeOutcome<NominatimSearchResult>> {
  return nominatim.search(query, signal);
}

export function reverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<GeocodeOutcome<string>> {
  return nominatim.reverse(lat, lng, signal);
}

/** Compatibility helper for auto-label callers that only need the optional name. */
export async function reverseGeocodeName(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const outcome = await reverseGeocode(lat, lng, signal);
  if (outcome.status === "success") return outcome.value;
  if (outcome.status === "no-results") return null;
  if (outcome.status === "cancelled") {
    throw new DOMException("Reverse geocoding was cancelled", "AbortError");
  }
  throw new Error(outcome.message);
}
