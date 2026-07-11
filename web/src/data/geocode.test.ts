/**
 * Reverse-geocode name picking: address-field preference order over Nominatim
 * fixture payloads, and the single-request / errors-to-null contract of
 * reverseGeocodeName.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { pickPlaceName, reverseGeocodeName } from "./geocode.ts";

/** Trimmed real-shape Nominatim /reverse (zoom=10) response. */
const SF_FIXTURE = {
  place_id: 258934581,
  lat: "37.7792588",
  lon: "-122.4193286",
  display_name: "San Francisco, California, United States",
  address: {
    city: "San Francisco",
    county: "San Francisco County",
    state: "California",
    country: "United States",
    country_code: "us",
  },
};

describe("pickPlaceName address-field preference", () => {
  it("prefers city over town/village/county", () => {
    expect(
      pickPlaceName({
        display_name: "x",
        address: { city: "San Francisco", town: "T", village: "V", county: "C" },
      }),
    ).toBe("San Francisco");
  });

  it("falls back city → town → village → county in order", () => {
    expect(pickPlaceName({ address: { town: "Banff", village: "V", county: "C" } })).toBe("Banff");
    expect(pickPlaceName({ address: { village: "Zermatt", county: "C" } })).toBe("Zermatt");
    expect(pickPlaceName({ address: { county: "Inyo County", state: "California" } })).toBe(
      "Inyo County",
    );
  });

  it("skips empty/whitespace fields and trims the winner", () => {
    expect(pickPlaceName({ address: { city: "  ", town: " Reykjavík " } })).toBe("Reykjavík");
  });

  it("falls back to the first display_name segment when no locality field matches", () => {
    expect(
      pickPlaceName({
        display_name: "Mount Fuji, Shizuoka Prefecture, Japan",
        address: { state: "Shizuoka Prefecture", country: "Japan" },
      }),
    ).toBe("Mount Fuji");
    expect(pickPlaceName({ display_name: "Atlantic Ocean" })).toBe("Atlantic Ocean");
  });

  it("returns null for error payloads and malformed input", () => {
    expect(pickPlaceName({ error: "Unable to geocode" })).toBeNull();
    expect(pickPlaceName({})).toBeNull();
    expect(pickPlaceName(null)).toBeNull();
    expect(pickPlaceName("nope")).toBeNull();
    expect(pickPlaceName({ display_name: "", address: {} })).toBeNull();
  });

  it("parses a real-shape fixture at city level", () => {
    expect(pickPlaceName(SF_FIXTURE)).toBe("San Francisco");
  });
});

describe("reverseGeocodeName", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(impl: (url: URL) => Promise<Response>): () => number {
    let calls = 0;
    globalThis.fetch = ((input: URL | RequestInfo) => {
      calls++;
      return impl(new URL(String(input)));
    }) as typeof fetch;
    return () => calls;
  }

  it("issues a single policy-compliant request and returns the short name", async () => {
    let requested: URL | null = null;
    const calls = stubFetch((url) => {
      requested = url;
      return Promise.resolve(Response.json(SF_FIXTURE));
    });

    const name = await reverseGeocodeName(37.7793, -122.4193);
    expect(name).toBe("San Francisco");
    expect(calls()).toBe(1);
    expect(requested!.origin + requested!.pathname).toBe(
      "https://nominatim.openstreetmap.org/reverse",
    );
    expect(requested!.searchParams.get("format")).toBe("json");
    expect(requested!.searchParams.get("zoom")).toBe("10");
    expect(requested!.searchParams.get("lat")).toBe("37.77930");
    expect(requested!.searchParams.get("lon")).toBe("-122.41930");
  });

  it("returns null on a non-2xx response without retrying", async () => {
    const calls = stubFetch(() =>
      Promise.resolve(new Response("Bandwidth limit exceeded", { status: 509 })),
    );
    expect(await reverseGeocodeName(0, 0)).toBeNull();
    expect(calls()).toBe(1);
  });

  it("returns null on network errors and aborts without retrying", async () => {
    const calls = stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await reverseGeocodeName(51.5, -0.12)).toBeNull();
    expect(calls()).toBe(1);

    const aborts = stubFetch(() =>
      Promise.reject(new DOMException("The operation was aborted.", "AbortError")),
    );
    const controller = new AbortController();
    controller.abort();
    expect(await reverseGeocodeName(51.5, -0.12, controller.signal)).toBeNull();
    expect(aborts()).toBe(1);
  });

  it("returns null for unparseable or error payloads", async () => {
    stubFetch(() => Promise.resolve(new Response("<html>rate limited</html>")));
    expect(await reverseGeocodeName(1, 1)).toBeNull();

    stubFetch(() => Promise.resolve(Response.json({ error: "Unable to geocode" })));
    expect(await reverseGeocodeName(1, 1)).toBeNull();
  });
});
