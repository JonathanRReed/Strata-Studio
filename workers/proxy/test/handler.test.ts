/**
 * Handler-level tests: exercise the exported fetch handler with a stubbed
 * global fetch. The /og route is NOT exercised here — it dynamically imports
 * workers-og (WASM), which only exists inside the Workers runtime bundle.
 */
import { afterEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import {
  CACHE_OVERPASS_OK,
  CACHE_TERRAIN_OK,
  OVERPASS_MIRROR,
  OVERPASS_PRIMARY,
  base64UrlEncode,
} from "../src/logic";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return calls;
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

const run = (req: Request) => worker.fetch(req as any, {} as any, ctx as any);

describe("cross-cutting behavior", () => {
  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const res = await run(
      new Request("https://proxy.test/terrain/1/0/0.png", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });

  test("non-GET methods get 405", async () => {
    const res = await run(new Request("https://proxy.test/overpass", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, OPTIONS");
  });

  test("/health returns ok json, uncached", async () => {
    const res = await run(new Request("https://proxy.test/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("unknown paths get 404 json with CORS", async () => {
    const res = await run(new Request("https://proxy.test/nope"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("not found");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("/terrain", () => {
  test("streams a 200 tile with long cache and preserved content-type", async () => {
    const calls = stubFetch(
      () =>
        new Response("png-bytes", {
          status: 200,
          headers: { "Content-Type": "image/png", "Cache-Control": "private" },
        }),
    );
    const res = await run(new Request("https://proxy.test/terrain/10/163/395.png"));
    expect(calls[0]!.url).toBe(
      "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/163/395.png",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE_TERRAIN_OK);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(await res.text()).toBe("png-bytes");
  });

  test("passes 404 through with short cache", async () => {
    stubFetch(() => new Response("missing", { status: 404 }));
    const res = await run(new Request("https://proxy.test/terrain/1/0/0.png"));
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=3600");
  });

  test("passes 5xx through uncached", async () => {
    stubFetch(() => new Response("boom", { status: 503 }));
    const res = await run(new Request("https://proxy.test/terrain/1/0/0.png"));
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("rejects invalid coordinates without touching upstream", async () => {
    const calls = stubFetch(() => new Response("should not happen"));
    const res = await run(new Request("https://proxy.test/terrain/16/0/0.png"));
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });
});

describe("/overpass", () => {
  const query = '[out:json];way["highway"](1,2,3,4);out geom;';
  const q = base64UrlEncode(query);

  test("POSTs the decoded query form-encoded and caches 200s", async () => {
    const calls = stubFetch(
      () => new Response('{"elements":[]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await run(new Request(`https://proxy.test/overpass?q=${q}`));
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(OVERPASS_PRIMARY);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(String(calls[0]!.init?.body)).toBe(
      new URLSearchParams({ data: query }).toString(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE_OVERPASS_OK);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  test("retries the mirror once on 429, succeeds", async () => {
    const calls = stubFetch((url) =>
      url === OVERPASS_PRIMARY
        ? new Response("busy", { status: 429 })
        : new Response("{}", { status: 200 }),
    );
    const res = await run(new Request(`https://proxy.test/overpass?q=${q}`));
    expect(calls.map((c) => c.url)).toEqual([OVERPASS_PRIMARY, OVERPASS_MIRROR]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(CACHE_OVERPASS_OK);
  });

  test("gives up after one retry: error passes through uncached with Retry-After", async () => {
    const calls = stubFetch(() => new Response("busy", { status: 429 }));
    const res = await run(new Request(`https://proxy.test/overpass?q=${q}`));
    expect(calls.length).toBe(2); // never more than one retry
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  test("preserves an upstream Retry-After", async () => {
    stubFetch(
      () => new Response("busy", { status: 504, headers: { "Retry-After": "120" } }),
    );
    const res = await run(new Request(`https://proxy.test/overpass?q=${q}`));
    expect(res.headers.get("Retry-After")).toBe("120");
  });

  test("does NOT retry non-429/504 errors", async () => {
    const calls = stubFetch(() => new Response("bad query", { status: 400 }));
    const res = await run(new Request(`https://proxy.test/overpass?q=${q}`));
    expect(calls.length).toBe(1);
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("rejects a malformed q without touching upstream", async () => {
    const calls = stubFetch(() => new Response("nope"));
    const res = await run(new Request("https://proxy.test/overpass?q=%25%25"));
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  test("returns 502 when both upstreams are unreachable", async () => {
    const calls = stubFetch(() => {
      throw new Error("network down");
    });
    const res = await run(new Request(`https://proxy.test/overpass?q=${q}`));
    expect(calls.length).toBe(2);
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});
