import { describe, expect, test } from "bun:test";
import type { GeoBounds, GeoFeatureCollection } from "../engine/types.ts";
import {
  OVERPASS_MIRRORS,
  canonicalProxyBboxParams,
  createOsmFeatureFetcher,
  isBboxSmallEnough,
  overpassEndpoints,
  proxyOverpassUrl,
  snapBoundsForQuery,
  type OverpassEndpoint,
} from "./osmOverpass.ts";
import type {
  RequestPolicyRuntime,
  RequestTimer,
} from "./requestPolicy.ts";

const BOUNDS: GeoBounds = {
  south: 40.75,
  west: -73.99,
  north: 40.76,
  east: -73.98,
};
const EMPTY_FEATURES: GeoFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

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

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve();
}

function successResponse(): Response {
  return new Response('{"elements":[]}', {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("overpass endpoint contract", () => {
  test("without a proxy, all endpoints are direct public mirrors", () => {
    const endpoints = overpassEndpoints(undefined);
    expect(endpoints.map((endpoint) => endpoint.url)).toEqual(OVERPASS_MIRRORS);
    expect(endpoints.every((endpoint) => endpoint.kind === "direct")).toBe(true);
  });

  test("a configured proxy is followed by one distinct direct provider", () => {
    const endpoints = overpassEndpoints(
      "https://strata-proxy.example.workers.dev/overpass/",
    );
    expect(endpoints).toEqual([
      {
        url: "https://strata-proxy.example.workers.dev/overpass",
        kind: "proxy",
      },
      { url: OVERPASS_MIRRORS[OVERPASS_MIRRORS.length - 1]!, kind: "direct" },
    ]);
  });

  test("builds one canonical, ordered bbox-only proxy URL", () => {
    const snapped = snapBoundsForQuery(BOUNDS);
    expect(canonicalProxyBboxParams(snapped)).toBe(
      "south=40.7500&west=-73.9900&north=40.7600&east=-73.9800",
    );
    expect(proxyOverpassUrl("https://proxy.test/overpass/", snapped)).toBe(
      "https://proxy.test/overpass?south=40.7500&west=-73.9900&north=40.7600&east=-73.9800",
    );
  });

  test("rejects non-finite, unordered, polar, and long-thin bounds before networking", () => {
    for (const bounds of [
      { ...BOUNDS, south: Number.NaN },
      { ...BOUNDS, east: Number.POSITIVE_INFINITY },
      { ...BOUNDS, south: BOUNDS.north, north: BOUNDS.south },
      { south: 0, west: 179.9, north: 0.01, east: -179.9 },
      { south: 0, west: -999, north: 0.01, east: 0.01 },
      { south: 85.051, west: -100, north: 85.0511, east: 100 },
      { south: 85.0511, west: 0, north: 85.0512, east: 0.001 },
    ]) {
      expect(isBboxSmallEnough(bounds)).toBe(false);
    }
  });
});

describe("browser Overpass fallback policy", () => {
  test("rejects invalid bounds without cache or network access", async () => {
    let calls = 0;
    const fetcher = createOsmFeatureFetcher({
      endpoints: [{ url: "https://proxy.test/overpass", kind: "proxy" }],
      fetch: async () => {
        calls++;
        return successResponse();
      },
      getCached: async () => {
        calls++;
        return undefined;
      },
      setCached: async () => {
        calls++;
      },
    });

    await expect(
      fetcher({ south: 85.051, west: -100, north: 85.0511, east: 100 }),
    ).rejects.toThrow("Bounding box is too large");
    expect(calls).toBe(0);
  });

  test("uses the proxy GET then one form-encoded direct fallback attempt", async () => {
    const endpoints: OverpassEndpoint[] = [
      { url: "https://proxy.test/overpass", kind: "proxy" },
      { url: "https://direct.test/interpreter", kind: "direct" },
    ];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let cacheWrites = 0;
    const fetcher = createOsmFeatureFetcher({
      endpoints,
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        return calls.length === 1
          ? new Response('{"error":"disabled"}', {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "0",
              },
            })
          : successResponse();
      },
      getCached: async () => undefined,
      setCached: async (_key, value) => {
        expect(value).toEqual(EMPTY_FEATURES);
        cacheWrites++;
      },
    });

    await expect(fetcher(BOUNDS)).resolves.toEqual(EMPTY_FEATURES);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain(
      "/overpass?south=40.7500&west=-73.9900&north=40.7600&east=-73.9800",
    );
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[1]!.url).toBe("https://direct.test/interpreter");
    expect(calls[1]!.init?.method).toBe("POST");
    expect(String(calls[1]!.init?.body)).toContain("data=%5Bout%3Ajson%5D");
    expect(new URLSearchParams(String(calls[1]!.init?.body)).get("data")).toContain(
      "[timeout:15][maxsize:16777216]",
    );
    expect(cacheWrites).toBe(1);
  });

  test("keeps the proxy alive beyond the Worker's upstream timeout", async () => {
    const runtime = new FakeRuntime();
    const calls: string[] = [];
    const fetcher = createOsmFeatureFetcher({
      runtime,
      endpoints: [
        { url: "https://proxy.test/overpass", kind: "proxy" },
        { url: "https://direct.test/interpreter", kind: "direct" },
      ],
      fetch: async (input) => {
        calls.push(String(input));
        if (calls.length === 1) return new Promise<Response>(() => {});
        return successResponse();
      },
      getCached: async () => undefined,
      setCached: async () => {},
    });

    const pending = fetcher(BOUNDS);
    await flushMicrotasks();
    runtime.advance(9_000);
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    runtime.advance(14_999);
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    runtime.advance(1);
    await expect(pending).resolves.toEqual(EMPTY_FEATURES);
    expect(calls).toHaveLength(2);
  });

  test("falls back after permanent proxy 400/404 responses and discards their bodies", async () => {
    for (const status of [400, 404]) {
      const calls: string[] = [];
      let cancelledBodies = 0;
      const fetcher = createOsmFeatureFetcher({
        endpoints: [
          { url: "https://proxy.test/overpass", kind: "proxy" },
          { url: "https://direct.test/interpreter", kind: "direct" },
        ],
        fetch: async (input) => {
          calls.push(String(input));
          if (calls.length === 1) {
            return new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancelledBodies++;
                },
              }),
              { status },
            );
          }
          return successResponse();
        },
        getCached: async () => undefined,
        setCached: async () => {},
      });

      await expect(fetcher(BOUNDS)).resolves.toEqual(EMPTY_FEATURES);
      expect(calls).toHaveLength(2);
      expect(cancelledBodies).toBe(1);
    }
  });

  test("caps Retry-After within the operation deadline before failover", async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    let settled = false;
    const fetcher = createOsmFeatureFetcher({
      runtime,
      endpoints: [
        { url: "https://proxy.test/overpass", kind: "proxy" },
        { url: "https://direct.test/interpreter", kind: "direct" },
      ],
      fetch: async () => {
        calls++;
        return calls === 1
          ? new Response("busy", {
              status: 429,
              headers: { "Retry-After": "120" },
            })
          : successResponse();
      },
      getCached: async () => undefined,
      setCached: async () => {},
    });

    const pending = fetcher(BOUNDS).then((value) => {
      settled = true;
      return value;
    });
    await flushMicrotasks();
    expect(calls).toBe(1);
    runtime.advance(1_999);
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(calls).toBe(1);
    runtime.advance(1);
    await expect(pending).resolves.toEqual(EMPTY_FEATURES);
    expect(calls).toBe(2);
  });

  test("rejects HTML, malformed JSON, missing elements, and never caches them", async () => {
    const endpoints: OverpassEndpoint[] = [
      { url: "https://proxy.test/overpass", kind: "proxy" },
      ...OVERPASS_MIRRORS.map((url) => ({ url, kind: "direct" as const })),
    ];
    let cacheWrites = 0;
    const calls: string[] = [];
    const responses = [
      new Response("<html>ok</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
      new Response("{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      new Response('{"remark":"no elements"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      new Response('{"error":"busy"}', {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    ];
    const fetcher = createOsmFeatureFetcher({
      endpoints,
      fetch: async (input) => {
        calls.push(String(input));
        return responses.shift()!;
      },
      getCached: async () => undefined,
      setCached: async () => {
        cacheWrites++;
      },
      runtime: new FakeRuntime(),
    });

    await expect(fetcher(BOUNDS)).rejects.toThrow(
      "OSM features are temporarily unavailable",
    );
    expect(calls).toHaveLength(4);
    expect(new Set(calls).size).toBe(4);
    expect(cacheWrites).toBe(0);
  });

  test("the total deadline aborts in-flight fallback work", async () => {
    const runtime = new FakeRuntime();
    const signals: AbortSignal[] = [];
    const fetcher = createOsmFeatureFetcher({
      runtime,
      operationTimeoutMs: 250,
      attemptTimeoutMs: 100,
      endpoints: [
        { url: "https://proxy.test/overpass", kind: "proxy" },
        { url: "https://one.test/interpreter", kind: "direct" },
        { url: "https://two.test/interpreter", kind: "direct" },
      ],
      fetch: async (_input, init) => {
        signals.push(init!.signal!);
        return new Promise<Response>(() => {});
      },
      getCached: async () => undefined,
      setCached: async () => {},
    });

    const pending = fetcher(BOUNDS);
    await flushMicrotasks();
    runtime.advance(100);
    await flushMicrotasks();
    runtime.advance(100);
    await flushMicrotasks();
    runtime.advance(50);
    await expect(pending).rejects.toThrow("OSM fetch deadline exceeded");
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
