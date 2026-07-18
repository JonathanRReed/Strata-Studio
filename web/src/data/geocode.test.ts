import { describe, expect, it } from "bun:test";
import {
  NominatimService,
  pickPlaceName,
  type GeocodeOutcome,
} from "./geocode.ts";
import type { RequestPolicyRuntime, RequestTimer } from "./requestPolicy.ts";

const SF_FIXTURE = {
  display_name: "San Francisco, California, United States",
  address: {
    city: "San Francisco",
    county: "San Francisco County",
    state: "California",
    country: "United States",
  },
};

class FakeRuntime implements RequestPolicyRuntime {
  time = 0;
  private id = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  random = () => 0;
  schedule = (callback: () => void, delayMs: number): RequestTimer => {
    const id = ++this.id;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  };
  cancel = (timer: RequestTimer) => {
    this.timers.delete(timer as number);
  };
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].callback();
    }
    this.time = target;
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

describe("pickPlaceName", () => {
  it("prefers locality fields and falls back to the first display-name segment", () => {
    expect(pickPlaceName({ address: { city: " San Francisco ", town: "Other" } })).toBe(
      "San Francisco",
    );
    expect(pickPlaceName({ address: { town: "Banff" } })).toBe("Banff");
    expect(pickPlaceName({ address: { village: "Zermatt" } })).toBe("Zermatt");
    expect(pickPlaceName({ address: { county: "Inyo County" } })).toBe("Inyo County");
    expect(pickPlaceName({ display_name: "Mount Fuji, Japan" })).toBe("Mount Fuji");
  });

  it("returns null for provider errors and malformed payloads", () => {
    expect(pickPlaceName({ error: "Unable to geocode" })).toBeNull();
    expect(pickPlaceName({})).toBeNull();
    expect(pickPlaceName(null)).toBeNull();
  });
});

describe("NominatimService policy", () => {
  it("sequences search and reverse starts at least one second apart", async () => {
    const runtime = new FakeRuntime();
    const starts: Array<{ at: number; path: string }> = [];
    const service = new NominatimService({
      runtime,
      fetch: (async (input) => {
        const url = new URL(String(input));
        starts.push({ at: runtime.now(), path: url.pathname });
        return url.pathname === "/search"
          ? Response.json([{ lat: "37.77", lon: "-122.42", display_name: "San Francisco" }])
          : Response.json(SF_FIXTURE);
      }),
    });

    const search = service.search("San Francisco");
    const reverse = service.reverse(37.77, -122.42);
    await flush();
    expect(starts).toEqual([{ at: 0, path: "/search" }]);

    runtime.advance(999);
    await flush();
    expect(starts).toHaveLength(1);
    runtime.advance(1);
    await flush();
    expect(starts).toEqual([
      { at: 0, path: "/search" },
      { at: 1000, path: "/reverse" },
    ]);
    expect((await search).status).toBe("success");
    expect((await reverse).status).toBe("success");
  });

  it("dedupes concurrent requests and session-caches positive and negative outcomes", async () => {
    let calls = 0;
    const service = new NominatimService({
      minIntervalMs: 0,
      fetch: (async (input) => {
        calls++;
        const url = new URL(String(input));
        return url.searchParams.get("q") === "missing"
          ? Response.json([])
          : Response.json([{ lat: "1", lon: "2", display_name: "Found" }]);
      }),
    });

    const [first, duplicate] = await Promise.all([
      service.search("found"),
      service.search("found"),
    ]);
    expect(first.status).toBe("success");
    expect(duplicate.status).toBe("success");
    expect(calls).toBe(1);
    const cached = await service.search("found");
    expect(cached).toMatchObject({ status: "success", cached: true });
    expect(calls).toBe(1);

    expect(await service.search("missing")).toMatchObject({ status: "no-results", cached: false });
    expect(await service.search("missing")).toMatchObject({ status: "no-results", cached: true });
    expect(calls).toBe(2);
  });

  it("starts a fresh same-key request after the previous subscriber aborts", async () => {
    let calls = 0;
    const service = new NominatimService({
      minIntervalMs: 0,
      fetch: ((_input, init) => {
        calls++;
        if (calls === 2) {
          return Promise.resolve(
            Response.json([{ lat: "1", lon: "2", display_name: "Recovered" }]),
          );
        }
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      }),
    });
    const controller = new AbortController();
    const first = service.search("same", controller.signal);
    await flush();
    expect(calls).toBe(1);

    controller.abort();
    const second = service.search("same");
    await expect(first).resolves.toEqual({ status: "cancelled" });
    await expect(second).resolves.toMatchObject({
      status: "success",
      value: { displayName: "Recovered" },
    });
    expect(calls).toBe(2);
  });

  it("returns explicit rate-limited, unavailable, and cancelled outcomes without retries", async () => {
    let calls = 0;
    const rateLimited = new NominatimService({
      minIntervalMs: 0,
      fetch: (async () => {
        calls++;
        return new Response("slow down", { status: 429 });
      }),
    });
    expect(await rateLimited.search("x")).toMatchObject({ status: "rate-limited" });
    expect(calls).toBe(1);

    const unavailable = new NominatimService({
      minIntervalMs: 0,
      fetch: (async () => {
        throw new TypeError("network down");
      }),
    });
    expect(await unavailable.reverse(0, 0)).toMatchObject({ status: "unavailable" });

    const controller = new AbortController();
    controller.abort();
    const cancelled: GeocodeOutcome<unknown> = await unavailable.search("cancel", controller.signal);
    expect(cancelled).toEqual({ status: "cancelled" });
  });

  it("enforces the ten-second operation deadline", async () => {
    const runtime = new FakeRuntime();
    let calls = 0;
    const service = new NominatimService({
      runtime,
      minIntervalMs: 0,
      fetch: ((_, init) => {
        calls++;
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }),
    });
    const pending = service.search("deadline");
    await flush();
    expect(calls).toBe(1);
    runtime.advance(10_000);
    await flush();
    expect(await pending).toMatchObject({ status: "unavailable" });
    expect(calls).toBe(1);
  });
});
