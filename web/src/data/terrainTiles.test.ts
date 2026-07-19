import { describe, expect, test } from "bun:test";
import {
  createTerrainTileLoader,
  fetchTerrain,
  ProxyCircuitBreaker,
  TerrainLoadError,
  tileCountForFetch,
  type TerrainFetch,
} from "./terrainTiles.ts";
import {
  RequestPolicyError,
  type RequestPolicyRuntime,
  type RequestTimer,
} from "./requestPolicy.ts";
import type { GeoBounds } from "../engine/types.ts";

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

async function flushMicrotasks(rounds = 10): Promise<void> {
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

function tile(value = 123): Float32Array {
  const data = new Float32Array(256 * 256);
  data.fill(value);
  return data;
}

function testLoader(options: {
  runtime?: FakeRuntime;
  fetch: TerrainFetch;
  getCachedTile?: () => Promise<Float32Array | undefined>;
  setCachedTile?: () => Promise<void>;
  isOnline?: () => boolean;
  circuit?: ProxyCircuitBreaker;
}) {
  return createTerrainTileLoader({
    proxyUrl: "https://proxy.example/terrain",
    directUrl: "https://aws.example/terrarium/{z}/{x}/{y}.png",
    runtime: options.runtime,
    fetch: options.fetch,
    getCachedTile: options.getCachedTile ?? (async () => undefined),
    setCachedTile: options.setCachedTile ?? (async () => {}),
    decodeResponse: async () => tile(),
    isOnline: options.isOnline ?? (() => true),
    circuit: options.circuit,
  });
}

describe("terrain provider request policy", () => {
  test("prefers the proxy, then deliberately falls back within three total attempts", async () => {
    const runtime = new FakeRuntime();
    const urls: string[] = [];
    const fetchMock: TerrainFetch = async (input) => {
      urls.push(String(input));
      return new Response(null, { status: urls.length < 3 ? 503 : 200 });
    };
    const loader = testLoader({ runtime, fetch: fetchMock });

    await expect(loader.getTileData(8, 40, 90)).resolves.toHaveLength(256 * 256);
    expect(urls).toEqual([
      "https://proxy.example/terrain/8/40/90.png",
      "https://proxy.example/terrain/8/40/90.png",
      "https://aws.example/terrarium/8/40/90.png",
    ]);
  });

  test("never exceeds three total network attempts when every provider fails", async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    const fetchMock: TerrainFetch = async () => {
      calls++;
      return new Response(null, { status: 503 });
    };
    const loader = testLoader({ runtime, fetch: fetchMock });

    await expect(loader.getTileData(8, 41, 90)).rejects.toMatchObject({
      kind: "http-server",
    });
    expect(calls).toBe(3);
  });

  test("falls back once on a permanent proxy 4xx without retrying either provider", async () => {
    const runtime = new FakeRuntime();
    const hosts: string[] = [];
    let cancelledBodies = 0;
    const circuit = new ProxyCircuitBreaker({ runtime, failureThreshold: 1 });
    const loader = testLoader({
      runtime,
      circuit,
      fetch: async (input) => {
        const host = new URL(String(input)).host;
        hosts.push(host);
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelledBodies++;
            },
          }),
          { status: host === "proxy.example" ? 404 : 403 },
        );
      },
    });

    await expect(loader.getTileData(8, 41, 91)).rejects.toMatchObject({
      kind: "http-client",
      status: 403,
    });
    expect(hosts).toEqual(["proxy.example", "aws.example"]);
    expect(cancelledBodies).toBe(2);
    expect(circuit.snapshot()).toMatchObject({ failures: 0, open: false });
  });

  test("opens after repeated proxy failures, bypasses proxy, then recovers after cooldown", async () => {
    const runtime = new FakeRuntime();
    const hosts: string[] = [];
    let proxyCalls = 0;
    const fetchMock: TerrainFetch = async (input) => {
      const url = new URL(String(input));
      hosts.push(url.host);
      if (url.host === "proxy.example" && proxyCalls++ < 2) {
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 200 });
    };
    const circuit = new ProxyCircuitBreaker({ runtime, failureThreshold: 2, cooldownMs: 15000 });
    const loader = testLoader({ runtime, fetch: fetchMock, circuit });

    await loader.getTileData(8, 1, 1);
    expect(circuit.snapshot().open).toBe(true);
    await loader.getTileData(8, 1, 2);
    expect(hosts).toEqual(["proxy.example", "proxy.example", "aws.example", "aws.example"]);

    runtime.advance(15000);
    await loader.getTileData(8, 1, 3);
    expect(hosts.at(-1)).toBe("proxy.example");
    expect(circuit.snapshot()).toMatchObject({ failures: 0, open: false });
  });

  test("counts network, rate-limit, and server failures toward the proxy circuit", () => {
    for (const kind of ["network", "rate-limited", "http-server"] as const) {
      const circuit = new ProxyCircuitBreaker({ failureThreshold: 2 });
      const failure = new RequestPolicyError(kind, kind);
      circuit.recordFailure(failure);
      expect(circuit.snapshot()).toMatchObject({ failures: 1, open: false });
      circuit.recordFailure(failure);
      expect(circuit.snapshot()).toMatchObject({ failures: 2, open: true });
    }

    for (const kind of [
      "caller-abort",
      "operation-deadline",
      "http-client",
      "decode",
    ] as const) {
      const circuit = new ProxyCircuitBreaker({ failureThreshold: 1 });
      circuit.recordFailure(new RequestPolicyError(kind, kind));
      expect(circuit.snapshot()).toMatchObject({ failures: 0, open: false });
    }
  });

  test("honors proxy Retry-After before the next attempt", async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    const fetchMock: TerrainFetch = async () => {
      calls++;
      if (calls === 1) {
        return new Response(null, { status: 429, headers: { "Retry-After": "2" } });
      }
      return new Response(null, { status: 200 });
    };
    const loader = testLoader({ runtime, fetch: fetchMock });
    const pending = loader.getTileData(8, 2, 1);

    await flushMicrotasks();
    expect(calls).toBe(1);
    runtime.advance(1999);
    await flushMicrotasks();
    expect(calls).toBe(1);
    runtime.advance(1);
    await expect(pending).resolves.toHaveLength(256 * 256);
    expect(calls).toBe(2);
  });

  test("falls back directly when proxy Retry-After exceeds the operation budget", async () => {
    const runtime = new FakeRuntime();
    const hosts: string[] = [];
    const loader = testLoader({
      runtime,
      fetch: async (input) => {
        const host = new URL(String(input)).host;
        hosts.push(host);
        if (host === "proxy.example") {
          return new Response(null, {
            status: 429,
            headers: { "Retry-After": "60" },
          });
        }
        return new Response(null, { status: 200 });
      },
    });

    await expect(loader.getTileData(8, 2, 2)).resolves.toHaveLength(256 * 256);
    expect(hosts).toEqual(["proxy.example", "aws.example"]);
    expect(runtime.currentTime).toBe(0);
  });

  test("bounds black-holed fetches with per-attempt timeouts and the total budget", async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    const fetchMock: TerrainFetch = () => {
      calls++;
      return new Promise<Response>(() => {});
    };
    const loader = testLoader({ runtime, fetch: fetchMock });
    const pending = loader.getTileData(8, 3, 1);
    const rejection = captureRejection(pending);

    await flushMicrotasks();
    expect(calls).toBe(1);
    runtime.advance(8000);
    await flushMicrotasks();
    expect(calls).toBe(2);
    runtime.advance(8000);
    await flushMicrotasks();
    expect(calls).toBe(3);
    runtime.advance(8000);
    expect(await rejection).toMatchObject({ kind: "attempt-timeout" });
    expect(calls).toBe(3);
  });

  test("does not count caller aborts as circuit failures", async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    const fetchMock: TerrainFetch = () => {
      calls++;
      return new Promise<Response>(() => {});
    };
    const circuit = new ProxyCircuitBreaker({ runtime });
    const loader = testLoader({ runtime, fetch: fetchMock, circuit });
    const caller = new AbortController();
    const pending = loader.getTileData(8, 4, 1, caller.signal);
    const rejection = captureRejection(pending);

    await flushMicrotasks();
    expect(calls).toBe(1);
    caller.abort();
    expect(await rejection).toMatchObject({ kind: "caller-abort" });
    expect(circuit.snapshot()).toMatchObject({ failures: 0, open: false });
  });

  test("does not start or poison a shared load for an already-aborted caller", async () => {
    let calls = 0;
    const loader = testLoader({
      fetch: async () => {
        calls++;
        return new Response(null, { status: 200 });
      },
    });
    const caller = new AbortController();
    caller.abort();

    await expect(loader.getTileData(8, 4, 2, caller.signal)).rejects.toMatchObject({
      kind: "caller-abort",
    });
    expect(calls).toBe(0);
    await expect(loader.getTileData(8, 4, 2)).resolves.toHaveLength(256 * 256);
    expect(calls).toBe(1);
  });

  test("keeps a shared tile alive when one caller aborts", async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    let resolveFetch!: (response: Response) => void;
    const fetchMock: TerrainFetch = () => {
      calls++;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    };
    const loader = testLoader({ runtime, fetch: fetchMock });
    const first = new AbortController();
    const second = new AbortController();
    const firstLoad = loader.getTileData(8, 5, 1, first.signal);
    const secondLoad = loader.getTileData(8, 5, 1, second.signal);
    const firstRejection = captureRejection(firstLoad);

    await flushMicrotasks();
    expect(calls).toBe(1);
    first.abort();
    expect(await firstRejection).toMatchObject({ kind: "caller-abort" });
    resolveFetch(new Response(null, { status: 200 }));
    await expect(secondLoad).resolves.toHaveLength(256 * 256);
    expect(calls).toBe(1);
  });

  test("replaces an aborted shared load without letting old cleanup delete the replacement", async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    let resolveReplacement!: (response: Response) => void;
    const loader = testLoader({
      runtime,
      fetch: () => {
        calls++;
        if (calls === 1) return new Promise<Response>(() => {});
        return new Promise<Response>((resolve) => {
          resolveReplacement = resolve;
        });
      },
    });
    const first = new AbortController();
    const firstLoad = loader.getTileData(8, 5, 2, first.signal);
    const firstRejection = captureRejection(firstLoad);

    await flushMicrotasks();
    expect(calls).toBe(1);
    first.abort();
    const replacement = loader.getTileData(8, 5, 2);
    const replacementSubscriber = loader.getTileData(8, 5, 2);
    await flushMicrotasks();

    expect(await firstRejection).toMatchObject({ kind: "caller-abort" });
    expect(calls).toBe(2);
    resolveReplacement(new Response(null, { status: 200 }));
    await expect(replacement).resolves.toHaveLength(256 * 256);
    await expect(replacementSubscriber).resolves.toHaveLength(256 * 256);
    expect(calls).toBe(2);
  });

  test("lets a longer export survive a preview deadline on shared tiles", async () => {
    const runtime = new FakeRuntime();
    const bounds: GeoBounds = {
      west: -122.5,
      north: 37.85,
      east: -122.35,
      south: 37.7,
    };
    const resolveFetches: ((response: Response) => void)[] = [];
    let calls = 0;
    const loader = testLoader({
      runtime,
      fetch: () => {
        calls++;
        return new Promise<Response>((resolve) => {
          resolveFetches.push(resolve);
        });
      },
    });

    const preview = fetchTerrain(bounds, 64, undefined, {
      operationTimeoutMs: 100,
      runtime,
      tileLoader: loader,
    });
    const previewRejection = captureRejection(preview);
    const exportLoad = fetchTerrain(bounds, 64, undefined, {
      operationTimeoutMs: 1000,
      runtime,
      tileLoader: loader,
    });

    await flushMicrotasks();
    expect(calls).toBe(2);
    runtime.advance(100);
    expect(await previewRejection).toMatchObject({ kind: "operation-deadline" });

    for (const resolve of resolveFetches) {
      resolve(new Response(null, { status: 200 }));
    }
    await expect(exportLoad).resolves.toMatchObject({ width: 64, height: 64 });
    expect(calls).toBe(2);
  });

  test("serves cache hits offline and fails cache misses without network calls", async () => {
    let hitFetches = 0;
    const cached = tile(77);
    const hitLoader = testLoader({
      fetch: async () => {
        hitFetches++;
        return new Response(null, { status: 200 });
      },
      getCachedTile: async () => cached,
      isOnline: () => false,
    });
    await expect(hitLoader.getTileData(8, 6, 1)).resolves.toBe(cached);
    expect(hitFetches).toBe(0);

    let missFetches = 0;
    const missLoader = testLoader({
      fetch: async () => {
        missFetches++;
        return new Response(null, { status: 200 });
      },
      getCachedTile: async () => undefined,
      isOnline: () => false,
    });
    await expect(missLoader.getTileData(8, 6, 2)).rejects.toMatchObject({ kind: "offline" });
    expect(missFetches).toBe(0);
  });
});

describe("terrain grid failure aggregation", () => {
  const bounds: GeoBounds = {
    west: -122.5,
    north: 37.85,
    east: -122.35,
    south: 37.7,
  };

  test("rejects a pre-aborted grid operation before invoking any tile loader", async () => {
    const caller = new AbortController();
    caller.abort();
    let calls = 0;

    await expect(
      fetchTerrain(bounds, 64, caller.signal, {
        tileLoader: {
          getTileData: async () => {
            calls++;
            return tile();
          },
        },
      }),
    ).rejects.toMatchObject({ kind: "caller-abort" });
    expect(calls).toBe(0);
  });

  test("samples rectangular grids while preserving exact bounds", async () => {
    const grid = await fetchTerrain(bounds, { width: 96, height: 54 }, undefined, {
      tileLoader: {
        getTileData: async () => tile(456),
      },
    });

    expect(grid).toMatchObject({ width: 96, height: 54, bounds });
    expect(grid.data).toHaveLength(96 * 54);
    expect(grid.data.every((value) => value === 456)).toBe(true);
    expect(tileCountForFetch(bounds, { width: 96, height: 54 })).toBe(
      tileCountForFetch(bounds, 96),
    );
  });

  test("returns partial terrain with diagnostics when only some tiles fail", async () => {
    expect(tileCountForFetch(bounds, 64)).toBe(2);
    let calls = 0;
    let diagnostics: { totalTiles: number; failedTiles: number } | undefined;
    const grid = await fetchTerrain(bounds, 64, undefined, {
      tileLoader: {
        getTileData: async () => {
          calls++;
          if (calls === 1) throw new RequestPolicyError("network", "connection reset");
          return tile(321);
        },
      },
      onDiagnostics: (value) => {
        diagnostics = value;
      },
    });

    expect(diagnostics).toEqual({ totalTiles: 2, failedTiles: 1 });
    expect(grid.data.some((value) => value === 0)).toBe(true);
    expect(grid.data.some((value) => value === 321)).toBe(true);
  });

  test("treats a tile-local deadline as a partial failure, not an outer abort", async () => {
    let calls = 0;
    let diagnostics: { totalTiles: number; failedTiles: number } | undefined;
    const grid = await fetchTerrain(bounds, 64, undefined, {
      tileLoader: {
        getTileData: async () => {
          calls++;
          if (calls === 1) {
            throw new RequestPolicyError(
              "operation-deadline",
              "Terrain tile deadline exceeded",
            );
          }
          return tile(222);
        },
      },
      onDiagnostics: (value) => {
        diagnostics = value;
      },
    });

    expect(diagnostics).toEqual({ totalTiles: 2, failedTiles: 1 });
    expect(grid.data.some((value) => value === 0)).toBe(true);
    expect(grid.data.some((value) => value === 222)).toBe(true);
  });

  test("reports diagnostics and fails when all tiles fail", async () => {
    let diagnostics: { totalTiles: number; failedTiles: number } | undefined;
    const pending = fetchTerrain(bounds, 64, undefined, {
      tileLoader: {
        getTileData: async () => {
          throw new RequestPolicyError("network", "connection reset");
        },
      },
      onDiagnostics: (value) => {
        diagnostics = value;
      },
    });

    await expect(pending).rejects.toBeInstanceOf(TerrainLoadError);
    expect(diagnostics).toEqual({ totalTiles: 2, failedTiles: 2 });
  });
});
