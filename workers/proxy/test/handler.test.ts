import { describe, expect, test } from "bun:test";
import {
  createWorker,
  type Env,
  type ProxyLogRecord,
  type WorkerRuntime,
} from "../src/index";
import {
  CACHE_OVERPASS_OK,
  CACHE_TERRAIN_OK,
  OVERPASS_MIRROR,
  OVERPASS_PRIMARY,
} from "../src/logic";

const ALLOWED_ORIGIN = "https://studio.example";
const BBOX =
  "south=40.7500&west=-73.9900&north=40.7600&east=-73.9800";
const TERRAIN_PNG = await Bun.file(
  new URL("../../../tests/launch/terrain-fixture.png", import.meta.url),
).arrayBuffer();
const BASE_ENV: Env = {
  ALLOWED_ORIGINS: ALLOWED_ORIGIN,
  TERRAIN_ENABLED: "true",
  OVERPASS_ENABLED: "true",
  OVERPASS_PROTECTION_STAGED: "true",
  BUILD_ID: "test-build",
};

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

type FetchCall = { url: string; init?: RequestInit };

function harness(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
    new Response("unexpected", { status: 500 }),
  overrides: Partial<WorkerRuntime> = {},
) {
  const calls: FetchCall[] = [];
  const logs: ProxyLogRecord[] = [];
  const worker = createWorker({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      return responder(url, init);
    }) as typeof fetch,
    requestId: () => "req-123",
    log: (record) => logs.push(record),
    ...overrides,
  });
  return {
    calls,
    logs,
    run: (request: Request, env: Env = BASE_ENV) =>
      worker.fetch!(request as never, env, ctx as never) as Promise<Response>,
  };
}

function request(
  path: string,
  init: RequestInit = {},
  origin: string | null = ALLOWED_ORIGIN,
): Request {
  const headers = new Headers(init.headers);
  if (origin !== null) headers.set("Origin", origin);
  return new Request(`https://proxy.test${path}`, { ...init, headers });
}

async function errorBody(response: Response): Promise<{
  error: { code: string; message: string };
  requestId: string;
}> {
  return (await response.json()) as {
    error: { code: string; message: string };
    requestId: string;
  };
}

class FakeClock {
  currentTime = 0;
  private nextTimer = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.currentTime;
  schedule = (callback: () => void, delayMs: number) => {
    const id = this.nextTimer++;
    this.timers.set(id, { at: this.currentTime + Math.max(0, delayMs), callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  cancel = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number);
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

describe("origin and preflight policy", () => {
  test("reflects only the exact configured origin and varies on Origin", async () => {
    const { run } = harness();
    const response = await run(request("/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
      "Retry-After, X-Request-ID",
    );
    expect(response.headers.get("Vary")).toBe("Origin");

    const noOrigin = await run(request("/health", {}, null));
    expect(noOrigin.status).toBe(200);
    expect(noOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(noOrigin.headers.get("Access-Control-Expose-Headers")).toBeNull();
    expect(noOrigin.headers.get("Vary")).toBe("Origin");
  });

  test("preserves validated CORS headers on unexpected internal failures", async () => {
    const { run } = harness();
    const env = {
      ...BASE_ENV,
      get TERRAIN_ENABLED(): string {
        throw new Error("unexpected configuration failure");
      },
    };
    const response = await run(request("/terrain/1/0/0.png"), env);
    expect(response.status).toBe(502);
    expect((await errorBody(response)).error.code).toBe("internal_error");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN,
    );
    expect(response.headers.get("Vary")).toContain("Origin");
  });

  test("denies unlisted and prefix-confusable origins before routing", async () => {
    const { run, calls } = harness();
    for (const origin of [
      "https://evil.example",
      "https://studio.example.evil.test",
      "https://studio.example/",
      "null",
    ]) {
      const response = await run(request("/terrain/1/0/0.png", {}, origin));
      expect(response.status).toBe(403);
      expect((await errorBody(response)).error.code).toBe("origin_forbidden");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  test("returns a correct route-aware GET preflight", async () => {
    const { run } = harness();
    const response = await run(
      request(`/overpass?${BBOX}`, {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Content-Type",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type",
    );
    expect(response.headers.get("Vary")).toContain("Origin");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("rejects invalid preflight methods, headers, and targets", async () => {
    const { run } = harness();
    const badMethod = await run(
      request("/terrain/1/0/0.png", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "POST" },
      }),
    );
    expect(badMethod.status).toBe(405);

    const badHeaders = await run(
      request("/terrain/1/0/0.png", {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization",
        },
      }),
    );
    expect(badHeaders.status).toBe(400);

    const badTarget = await run(
      request("/terrain/1/0/0.png?x=1", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "GET" },
      }),
    );
    expect(badTarget.status).toBe(400);
  });
});

describe("health, methods, flags, and route abuse", () => {
  test("health reports build and safe route state without exposing origins", async () => {
    const { run } = harness();
    const response = await run(request("/health"), {
      ...BASE_ENV,
      OVERPASS_ENABLED: "false",
      OVERPASS_PROTECTION_STAGED: "false",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      service: "strata-proxy",
      build: "test-build",
      limits: { maxBboxKm2: 25, maxBboxSpanKm: 25 },
      routes: {
        terrain: { enabled: true },
        overpass: { enabled: false },
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(ALLOWED_ORIGIN);
    expect(serialized).not.toContain("requested");
    expect(serialized).not.toContain("protectionStaged");
  });

  test("unsafe enablement is unhealthy and the route remains disabled", async () => {
    const env = {
      ...BASE_ENV,
      OVERPASS_ENABLED: "true",
      OVERPASS_PROTECTION_STAGED: "false",
    };
    const { run, calls } = harness();
    const health = await run(request("/health"), env);
    expect(health.status).toBe(503);
    expect(health.headers.get("Retry-After")).toBe("300");
    expect(((await health.json()) as { ok: boolean }).ok).toBe(false);

    const overpass = await run(request(`/overpass?${BBOX}`), env);
    expect(overpass.status).toBe(503);
    expect((await errorBody(overpass)).error.code).toBe("overpass_disabled");
    expect(overpass.headers.get("Cache-Control")).toBe("no-store");
    expect(overpass.headers.get("Retry-After")).toBe("300");
    expect(calls).toHaveLength(0);
  });

  test("both emergency switches fail closed without upstream calls", async () => {
    const { run, calls } = harness();
    const terrain = await run(request("/terrain/1/0/0.png"), {
      ...BASE_ENV,
      TERRAIN_ENABLED: "false",
    });
    expect(terrain.status).toBe(503);
    expect((await errorBody(terrain)).error.code).toBe("terrain_disabled");
    expect(terrain.headers.get("Cache-Control")).toBe("no-store");
    expect(terrain.headers.get("Retry-After")).toBe("300");

    const overpass = await run(request(`/overpass?${BBOX}`), {
      ...BASE_ENV,
      OVERPASS_ENABLED: "false",
    });
    expect(overpass.status).toBe(503);
    expect((await errorBody(overpass)).error.code).toBe("overpass_disabled");
    expect(overpass.headers.get("Cache-Control")).toBe("no-store");
    expect(overpass.headers.get("Retry-After")).toBe("300");
    expect(calls).toHaveLength(0);
  });

  test("rejects methods, unknown paths, OG, and query/path abuse", async () => {
    const { run, calls } = harness();
    const post = await run(request(`/overpass?${BBOX}`, { method: "POST" }));
    expect(post.status).toBe(405);

    for (const path of [
      "/og",
      "/nope",
      "/terrain/1/0/0.png?x=1",
      "/terrain/01/0/0.png",
      "/terrain/1/00/0.png",
      "/health?debug=1",
      "/overpass?q=arbitrary",
      `/overpass?${BBOX}&extra=1`,
      "/terrain/1/0/0.png/extra",
    ]) {
      const response = await run(request(path));
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("terrain handler", () => {
  test("streams only PNG success with long cache headers", async () => {
    const { run, calls } = harness(
      () =>
        new Response(TERRAIN_PNG, {
          status: 200,
          headers: { "Content-Type": "image/png", "Cache-Control": "private" },
        }),
    );
    const response = await run(request("/terrain/10/163/395.png"));
    expect(calls[0]!.url).toBe(
      "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/163/395.png",
    );
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(CACHE_TERRAIN_OK);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect((await response.arrayBuffer()).byteLength).toBe(TERRAIN_PNG.byteLength);
  });

  test("rejects HTML 200 and maps rate limits to structured uncached JSON", async () => {
    const html = harness(
      () =>
        new Response("<html>error</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const htmlResponse = await html.run(request("/terrain/1/0/0.png"));
    expect(htmlResponse.status).toBe(502);
    expect(htmlResponse.headers.get("Cache-Control")).toBe("no-store");
    expect((await errorBody(htmlResponse)).error.code).toBe(
      "upstream_bad_response",
    );

    const malformed = harness(
      () =>
        new Response("not-a-png", {
          status: 200,
          headers: { "Content-Type": "IMAGE/PNG; charset=binary" },
        }),
    );
    const malformedResponse = await malformed.run(request("/terrain/1/0/0.png"));
    expect(malformedResponse.status).toBe(502);
    expect(malformedResponse.headers.get("Cache-Control")).toBe("no-store");
    expect((await errorBody(malformedResponse)).error.message).toContain(
      "malformed PNG",
    );

    const limited = harness(
      () =>
        new Response("busy", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
    );
    const limitedResponse = await limited.run(request("/terrain/1/0/0.png"));
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get("Retry-After")).toBe("120");
    expect(limitedResponse.headers.get("Content-Type")).toContain(
      "application/json",
    );
    expect((await errorBody(limitedResponse)).error.code).toBe(
      "upstream_rate_limited",
    );
  });

  test("propagates caller abort to the upstream signal", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const { run } = harness((_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const controller = new AbortController();
    const pending = run(
      request("/terrain/1/0/0.png", { signal: controller.signal }),
    );
    await flushMicrotasks();
    expect(upstreamSignal?.aborted).toBe(false);
    controller.abort();
    const response = await pending;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(504);
    expect((await errorBody(response)).error.code).toBe("request_aborted");
  });

  test("enforces upstream and whole-route deadlines", async () => {
    const clock = new FakeClock();
    const upstreamTimeout = harness(
      () => new Promise<Response>(() => {}),
      {
        now: clock.now,
        schedule: clock.schedule,
        cancel: clock.cancel,
        terrainUpstreamTimeoutMs: 100,
        terrainRouteTimeoutMs: 200,
      },
    );
    const pending = upstreamTimeout.run(request("/terrain/1/0/0.png"));
    await flushMicrotasks();
    clock.advance(100);
    const response = await pending;
    expect(response.status).toBe(504);
    expect((await errorBody(response)).error.code).toBe("upstream_timeout");
  });
});

describe("overpass handler", () => {
  test("constructs the fixed server query and caches only JSON success", async () => {
    const { run, calls } = harness(
      () =>
        new Response('{"elements":[]}', {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
    );
    const response = await run(request(`/overpass?${BBOX}`));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(OVERPASS_PRIMARY);
    expect(calls[0]!.init?.method).toBe("POST");
    const body = String(calls[0]!.init?.body);
    const query = new URLSearchParams(body).get("data")!;
    expect(query).toContain("[timeout:15][maxsize:16777216]");
    expect(query).toContain("(40.7500,-73.9900,40.7600,-73.9800)");
    expect(query).toContain('way["building"]');
    expect(query).not.toContain("arbitrary");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(CACHE_OVERPASS_OK);
  });

  test("accepts JSON suffix media types only after validating the payload", async () => {
    const { run, calls } = harness(
      () =>
        new Response('{"elements":[]}', {
          status: 200,
          headers: { "Content-Type": "Application/Vnd.Overpass+Json; Charset=UTF-8" },
        }),
    );
    const response = await run(request(`/overpass?${BBOX}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(CACHE_OVERPASS_OK);
    expect(calls).toHaveLength(1);
  });

  test("retries malformed JSON and never caches an exhausted bad 200", async () => {
    for (const body of [
      "{",
      '{"remark":"missing elements"}',
      '{"elements":[null]}',
    ]) {
      const { run, calls } = harness(
        () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const response = await run(request(`/overpass?${BBOX}`));
      expect(calls.map((call) => call.url)).toEqual([
        OVERPASS_PRIMARY,
        OVERPASS_MIRROR,
      ]);
      expect(response.status).toBe(502);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect((await errorBody(response)).error.code).toBe("upstream_bad_response");
    }
  });

  test("retries the mirror once for wrong content type and records retry count", async () => {
    const { run, calls, logs } = harness((url) =>
      url === OVERPASS_PRIMARY
        ? new Response("<html>busy</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })
        : new Response('{"elements":[]}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
    );
    const response = await run(request(`/overpass?${BBOX}`));
    expect(calls.map((call) => call.url)).toEqual([
      OVERPASS_PRIMARY,
      OVERPASS_MIRROR,
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(CACHE_OVERPASS_OK);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      requestId: "req-123",
      route: "overpass",
      upstream: "overpass-mirror",
      status: 200,
      retryCount: 1,
    });
  });

  test("maps exhausted 429/502/503/504 outcomes to deterministic JSON", async () => {
    for (const status of [429, 502, 503, 504] as const) {
      const { run, calls } = harness(
        () =>
          new Response("upstream body must not leak", {
            status,
            headers: { "Retry-After": status === 429 ? "90" : "invalid" },
          }),
      );
      const response = await run(request(`/overpass?${BBOX}`));
      expect(calls).toHaveLength(2);
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(response.headers.get("Retry-After")).toBe(
        status === 429 ? "90" : "30",
      );
      const body = await errorBody(response);
      expect(body.requestId).toBe("req-123");
      expect(JSON.stringify(body)).not.toContain("upstream body must not leak");
    }
  });

  test("keeps the upstream deadline active while reading a slow 200 body", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const { run } = harness(
      () => {
        calls++;
        if (calls === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                // Deliberately never produce body bytes or close.
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response('{"elements":[]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      {
        now: clock.now,
        schedule: clock.schedule,
        cancel: clock.cancel,
        overpassUpstreamTimeoutMs: 100,
        overpassRouteTimeoutMs: 500,
      },
    );

    const pending = run(request(`/overpass?${BBOX}`));
    await flushMicrotasks();
    expect(calls).toBe(1);
    clock.advance(100);
    await flushMicrotasks();
    expect(calls).toBe(2);
    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  test("whole-route deadline aborts retry work", async () => {
    const clock = new FakeClock();
    const signals: AbortSignal[] = [];
    const { run } = harness(
      (_url, init) => {
        signals.push(init!.signal!);
        return new Promise<Response>(() => {});
      },
      {
        now: clock.now,
        schedule: clock.schedule,
        cancel: clock.cancel,
        overpassUpstreamTimeoutMs: 100,
        overpassRouteTimeoutMs: 150,
      },
    );
    const pending = run(request(`/overpass?${BBOX}`));
    await flushMicrotasks();
    clock.advance(100);
    await flushMicrotasks();
    expect(signals).toHaveLength(2);
    clock.advance(50);
    const response = await pending;
    expect(response.status).toBe(504);
    expect((await errorBody(response)).error.code).toBe("route_deadline");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("logs only sanitized structured metadata", async () => {
    const { run, logs } = harness(
      () =>
        new Response('{"elements":[]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await run(request(`/overpass?${BBOX}`));
    const serialized = JSON.stringify(logs);
    expect(serialized).toContain('"event":"proxy_request"');
    expect(serialized).not.toContain("40.7500");
    expect(serialized).not.toContain("73.9900");
    expect(serialized).not.toContain(ALLOWED_ORIGIN);
    expect(serialized).not.toContain("building");
    expect(Object.keys(logs[0]!).sort()).toEqual(
      [
        "durationMs",
        "event",
        "requestId",
        "retryCount",
        "route",
        "status",
        "upstream",
      ].sort(),
    );
  });
});
