import { expect, test } from "bun:test";
import { createWorker, type Env, type WorkerRuntime } from "../src/index";
const bbox = "south=40.7500&west=-73.9900&north=40.7510&east=-73.9890";
const env: Env = {
  ALLOWED_ORIGINS: "https://studio.example",
  MAP_TILES_ENABLED: "true",
  OVERPASS_PROTECTION_STAGED: "true",
  OVERPASS_CLIENT_LIMITER: { limit: async () => ({ success: true }) },
  OVERPASS_ROUTE_LIMITER: { limit: async () => ({ success: true }) },
};
function harness(
  template = "https://tiles.openfreemap.org/planet/20261018_080001_pt/{z}/{x}/{y}.pbf",
  options: {
    tile?: () => Response | Promise<Response>;
    runtime?: Partial<WorkerRuntime>;
    bbox?: string;
  } = {},
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const worker = createWorker({
    log() {},
    fetch: (async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/planet"))
        return Response.json({ tiles: [template], maxzoom: 14 });
      return (
        options.tile?.() ??
        new Response(
          new Uint8Array([26, 8, 10, 4, 116, 101, 115, 116, 120, 2]),
          { headers: { "Content-Type": "application/x-protobuf" } },
        )
      );
    }) as typeof fetch,
    ...options.runtime,
  });
  return {
    calls,
    run: (settings = env) =>
      worker.fetch!(
        new Request(`https://proxy.test/map-features?${options.bbox ?? bbox}`, {
          headers: {
            Origin: "https://studio.example",
            "CF-Connecting-IP": "192.0.2.1",
          },
        }) as never,
        settings,
        {} as never,
      ) as Promise<Response>,
  };
}
test("tile fallback is independently disabled and shares fail-closed managed protection", async () => {
  for (const settings of [
    { ...env, MAP_TILES_ENABLED: "false" },
    { ...env, OVERPASS_CLIENT_LIMITER: undefined },
  ]) {
    const h = harness();
    expect((await h.run(settings)).status).toBe(503);
    expect(h.calls).toHaveLength(0);
  }
  const h = harness();
  expect(
    (
      await h.run({
        ...env,
        OVERPASS_CLIENT_LIMITER: { limit: async () => ({ success: false }) },
      })
    ).status,
  ).toBe(429);
  expect(h.calls).toHaveLength(0);
});
test("tile fallback fetches only a bounded identified snapshot and serves exact CORS", async () => {
  const h = harness();
  const response = await h.run();
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe(
    "application/vnd.strata.map-tiles",
  );
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
    "https://studio.example",
  );
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]!.url).toBe(
    "https://tiles.openfreemap.org/planet/20261018_080001_pt/14/4824/6157.pbf",
  );
  for (const call of h.calls) {
    expect(new Headers(call.init?.headers).get("User-Agent")).toContain(
      "Strata-Studio",
    );
    expect(call.init?.redirect).toBe("manual");
  }
});
test("untrusted tile templates never trigger a second outbound request", async () => {
  const h = harness("https://evil.example/{z}/{x}/{y}.pbf");
  const response = await h.run();
  expect(response.status).toBe(502);
  expect(h.calls).toHaveLength(1);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
test("bad binary, oversized bodies, redirects and HTML cannot become cached snapshots", async () => {
  const failures = [
    () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "application/x-protobuf" },
      }),
    () =>
      new Response("oversized", {
        headers: {
          "Content-Type": "application/x-protobuf",
          "Content-Length": "2097153",
        },
      }),
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/" },
      }),
    () =>
      new Response("<html>error</html>", {
        headers: { "Content-Type": "text/html" },
      }),
  ];
  for (const tile of failures) {
    const h = harness(undefined, { tile });
    const response = await h.run();
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(h.calls).toHaveLength(2);
  }
});
test("a stalled tile body is cancelled within the existing deadline", async () => {
  let cancelled = false;
  const h = harness(undefined, {
    tile: () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/x-protobuf" } },
      ),
    runtime: { overpassUpstreamTimeoutMs: 5, overpassRouteTimeoutMs: 20 },
  });
  const response = await h.run();
  expect(response.status).toBe(504);
  expect(cancelled).toBe(true);
});
const wider = "south=40.7400&west=-74.0100&north=40.7700&east=-73.9700";
test("larger snapshots never exceed two parallel tile requests", async () => {
  let active = 0,
    peak = 0;
  const h = harness(undefined, {
    bbox: wider,
    tile: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return new Response(
        new Uint8Array([26, 8, 10, 4, 116, 101, 115, 116, 120, 2]),
        { headers: { "Content-Type": "application/x-protobuf" } },
      );
    },
  });
  expect((await h.run()).status).toBe(200);
  expect(peak).toBe(2);
  expect(h.calls.length).toBeGreaterThan(3);
  expect(h.calls.length).toBeLessThanOrEqual(17);
});
test("one failed tile cancels its peer instead of serving partial geometry", async () => {
  let count = 0,
    cancelled = false;
  const h = harness(undefined, {
    bbox: wider,
    tile: async () => {
      if (++count === 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response("unavailable", { status: 503 });
      }
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/x-protobuf" } },
      );
    },
  });
  expect((await h.run()).status).toBe(503);
  expect(cancelled).toBe(true);
  expect(h.calls).toHaveLength(3);
});
test("detail budgets reject oversized high-latitude coverage before any fetch", async () => {
  const h = harness(undefined, {
    bbox: "south=84.9900&west=0.0000&north=85.0000&east=1.0000",
  });
  expect((await h.run()).status).toBe(400);
  expect(h.calls).toHaveLength(0);
});
