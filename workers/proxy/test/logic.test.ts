import { describe, expect, test } from "bun:test";
import {
  BBOX_DECIMAL_PLACES,
  CACHE_NONE,
  CACHE_TERRAIN_404,
  CACHE_TERRAIN_OK,
  MAX_BBOX_KM2,
  MAX_BBOX_SPAN_KM,
  OVERPASS_MAXSIZE_BYTES,
  OVERPASS_TIMEOUT_SECONDS,
  WEB_MERCATOR_MAX_LAT,
  bboxAreaKm2,
  buildOverpassQuery,
  canonicalBboxSearch,
  enabledFlag,
  formatCanonicalCoordinate,
  isAllowedOrigin,
  isJsonContentType,
  isPngContentType,
  isValidTile,
  parseAllowedOrigins,
  parseCanonicalBbox,
  parseTerrainPath,
  sanitizeBuildId,
  sanitizeRetryAfter,
  terrainCacheControl,
  terrainUpstreamUrl,
} from "../src/logic";

describe("terrain path parsing", () => {
  test("parses valid tile coordinates and builds the fixed upstream URL", () => {
    expect(parseTerrainPath("/terrain/10/163/395.png")).toEqual({
      z: 10,
      x: 163,
      y: 395,
    });
    expect(terrainUpstreamUrl({ z: 10, x: 163, y: 395 })).toBe(
      "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/163/395.png",
    );
  });

  test("accepts zoom bounds and rejects malformed or out-of-range paths", () => {
    expect(parseTerrainPath("/terrain/0/0/0.png")).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTerrainPath("/terrain/15/32767/32767.png")).toEqual({
      z: 15,
      x: 32767,
      y: 32767,
    });
    for (const path of [
      "/terrain/16/0/0.png",
      "/terrain/2/4/0.png",
      "/terrain/2/0/4.png",
      "/terrain/-1/0/0.png",
      "/terrain/1/0.5/0.png",
      "/terrain/01/0/0.png",
      "/terrain/1/00/0.png",
      "/terrain/1/0/00.png",
      "/terrain/1/0/0.jpg",
      "/terrain/1/0/0.png/extra",
      "/terrain/../secret.png",
    ]) {
      expect(parseTerrainPath(path)).toBeNull();
    }
    expect(isValidTile(1.5, 0, 0)).toBe(false);
  });

  test("uses long cache only for valid terrain outcomes", () => {
    expect(terrainCacheControl(200)).toBe(CACHE_TERRAIN_OK);
    expect(terrainCacheControl(404)).toBe(CACHE_TERRAIN_404);
    expect(terrainCacheControl(429)).toBe(CACHE_NONE);
    expect(terrainCacheControl(503)).toBe(CACHE_NONE);
  });
});

describe("canonical bbox validation", () => {
  const canonical =
    "?south=40.7500&west=-73.9900&north=40.7600&east=-73.9800";

  test("accepts exactly one ordered four-decimal representation", () => {
    expect(parseCanonicalBbox(canonical)).toEqual({
      ok: true,
      bounds: {
        south: 40.75,
        west: -73.99,
        north: 40.76,
        east: -73.98,
      },
      search: canonical.slice(1),
    });
    expect(BBOX_DECIMAL_PLACES).toBe(4);
    expect(formatCanonicalCoordinate(-0)).toBe("0.0000");
    expect(
      canonicalBboxSearch({ south: 1, west: 2, north: 3, east: 4 }),
    ).toBe("south=1.0000&west=2.0000&north=3.0000&east=4.0000");
  });

  test("rejects aliases, reordering, duplicates, unknowns, and noncanonical decimals", () => {
    for (const search of [
      "?s=40.7500&w=-73.9900&n=40.7600&e=-73.9800",
      "?west=-73.9900&south=40.7500&north=40.7600&east=-73.9800",
      `${canonical}&east=-73.9800`,
      `${canonical}&q=payload`,
      "?south=40.75&west=-73.9900&north=40.7600&east=-73.9800",
      "?south=040.7500&west=-73.9900&north=40.7600&east=-73.9800",
      "?south=4.075e1&west=-73.9900&north=40.7600&east=-73.9800",
      "?south=NaN&west=-73.9900&north=40.7600&east=-73.9800",
      "?south=-Infinity&west=-73.9900&north=40.7600&east=-73.9800",
      "?south=+40.7500&west=-73.9900&north=40.7600&east=-73.9800",
      "?south=-0.0000&west=0.0000&north=0.0100&east=0.0100",
      "?south=40%2E7500&west=-73.9900&north=40.7600&east=-73.9800",
      "?south=40.7500%26west=-73.9900&north=40.7600&east=-73.9800",
      "?south=40.7500;west=-73.9900&north=40.7600&east=-73.9800",
      "?south=40.7500%2526west=-73.9900&north=40.7600&east=-73.9800",
    ]) {
      expect(parseCanonicalBbox(search).ok).toBe(false);
    }
  });

  test("enforces Web Mercator-safe ranges and strict ordering", () => {
    expect(WEB_MERCATOR_MAX_LAT).toBeLessThan(90);
    for (const search of [
      "?south=-85.0512&west=0.0000&north=0.0100&east=0.0100",
      "?south=0.0000&west=0.0000&north=85.0512&east=0.0100",
      "?south=0.0000&west=-180.0001&north=0.0100&east=0.0100",
      "?south=0.0000&west=0.0000&north=0.0100&east=180.0001",
      "?south=1.0000&west=0.0000&north=1.0000&east=0.0100",
      "?south=0.0000&west=1.0000&north=0.0100&east=1.0000",
      "?south=0.0000&west=179.9000&north=0.0100&east=-179.9000",
      "?south=0.0000&west=-999.0000&north=0.0100&east=0.0100",
    ]) {
      expect(parseCanonicalBbox(search).ok).toBe(false);
    }
  });

  test("keeps the existing 25 km² maximum", () => {
    expect(MAX_BBOX_KM2).toBe(25);
    expect(
      bboxAreaKm2({ south: 0, west: 0, north: 0.01, east: 0.01 }),
    ).toBeLessThan(25);
    expect(
      parseCanonicalBbox(
        "?south=0.0000&west=0.0000&north=0.1000&east=0.1000",
      ),
    ).toEqual({ ok: false, error: "bbox exceeds 25 km²" });
  });

  test("rejects long thin polar strips that evade an area-only limit", () => {
    expect(MAX_BBOX_SPAN_KM).toBe(25);
    expect(
      bboxAreaKm2({
        south: 85.051,
        west: -100,
        north: 85.0511,
        east: 100,
      }),
    ).toBeLessThan(MAX_BBOX_KM2);
    expect(
      parseCanonicalBbox(
        "?south=85.0510&west=-100.0000&north=85.0511&east=100.0000",
      ),
    ).toEqual({ ok: false, error: "bbox span exceeds 25 km" });
  });
});

describe("fixed Overpass query", () => {
  test("uses bounded settings and only Strata Studio feature classes", () => {
    const query = buildOverpassQuery({
      south: 40.75,
      west: -73.99,
      north: 40.76,
      east: -73.98,
    });
    expect(query).toContain(`[timeout:${OVERPASS_TIMEOUT_SECONDS}]`);
    expect(query).toContain(`[maxsize:${OVERPASS_MAXSIZE_BYTES}]`);
    expect(query).toContain("(40.7500,-73.9900,40.7600,-73.9800)");
    expect(query.match(/way\[/g)).toHaveLength(5);
    expect(query.match(/relation\[/g)).toHaveLength(2);
    expect(query).toContain('way["building"]');
    expect(query).toContain('way["highway"]');
    expect(query).toContain('way["natural"="water"]');
    expect(query).toContain('way["waterway"]');
    expect(query).toContain('way["natural"="coastline"]');
    expect(query).toContain('relation["natural"="water"]');
    expect(query).toContain('relation["waterway"]');
    expect(query).not.toContain("node[");
    expect(query).not.toContain("nwr");
  });
});

describe("origin, content-type, flag, and metadata helpers", () => {
  test("parses only exact configured HTTP(S) origins and never wildcard", () => {
    const allowed = parseAllowedOrigins(
      "https://studio.example,http://localhost:5173,*,https://bad.example/path,notaurl",
    );
    expect([...allowed]).toEqual([
      "https://studio.example",
      "http://localhost:5173",
    ]);
    expect(isAllowedOrigin(null, allowed)).toBe(true);
    expect(isAllowedOrigin("https://studio.example", allowed)).toBe(true);
    expect(isAllowedOrigin("https://studio.example/", allowed)).toBe(false);
    expect(isAllowedOrigin("https://evil.example", allowed)).toBe(false);
  });

  test("recognizes only JSON and PNG media types needed for cacheable success", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/problem+json")).toBe(true);
    expect(isJsonContentType("text/html")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
    expect(isPngContentType("image/png")).toBe(true);
    expect(isPngContentType("image/jpeg")).toBe(false);
  });

  test("sanitizes retry and build metadata and treats flags fail-closed", () => {
    expect(sanitizeRetryAfter("120")).toBe("120");
    expect(sanitizeRetryAfter("0")).toBe("30");
    expect(sanitizeRetryAfter("999")).toBe("30");
    expect(sanitizeRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT")).toBe("30");
    expect(sanitizeBuildId("abc-123_test.4")).toBe("abc-123_test.4");
    expect(sanitizeBuildId("secret/value")).toBe("unversioned");
    expect(enabledFlag("true")).toBe(true);
    expect(enabledFlag(" TRUE ")).toBe(true);
    expect(enabledFlag("1")).toBe(false);
    expect(enabledFlag(undefined)).toBe(false);
  });
});
