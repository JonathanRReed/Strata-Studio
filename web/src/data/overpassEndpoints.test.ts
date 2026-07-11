import { describe, expect, test } from "bun:test";
import {
  encodeOverpassQuery,
  OVERPASS_MIRRORS,
  overpassEndpoints,
} from "./osmOverpass.ts";

describe("overpassEndpoints", () => {
  test("without a proxy, all endpoints are direct public mirrors", () => {
    const endpoints = overpassEndpoints(undefined);
    expect(endpoints.map((e) => e.url)).toEqual(OVERPASS_MIRRORS);
    expect(endpoints.every((e) => e.kind === "direct")).toBe(true);
  });

  test("a configured proxy is tried first, mirrors kept as fallback", () => {
    const endpoints = overpassEndpoints("https://strata-proxy.example.workers.dev/overpass");
    expect(endpoints[0]).toEqual({
      url: "https://strata-proxy.example.workers.dev/overpass",
      kind: "proxy",
    });
    expect(endpoints.slice(1).map((e) => e.url)).toEqual(OVERPASS_MIRRORS);
  });

  test("trailing slashes on the proxy URL are stripped", () => {
    expect(overpassEndpoints("https://p.dev/overpass/")[0].url).toBe("https://p.dev/overpass");
  });
});

describe("encodeOverpassQuery", () => {
  test("emits unpadded base64url that decodes back to the query", () => {
    const query = '[out:json][timeout:25];(way["building"](52.36,4.88,52.38,4.92););out body;>;out skel qt;';
    const encoded = encodeOverpassQuery(query);
    expect(encoded).not.toMatch(/[+/=]/);
    // Decode the way the proxy Worker does: base64url -> base64 -> bytes.
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(query);
  });
});
