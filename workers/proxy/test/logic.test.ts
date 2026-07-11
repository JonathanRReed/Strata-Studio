import { describe, expect, test } from "bun:test";
import {
  CACHE_NONE,
  CACHE_OVERPASS_OK,
  CACHE_TERRAIN_404,
  CACHE_TERRAIN_OK,
  OVERPASS_MAX_QUERY_BYTES,
  base64UrlDecode,
  base64UrlEncode,
  decodeOverpassQuery,
  escapeHtml,
  isValidTile,
  overpassCacheControl,
  parseOgParams,
  parseTerrainPath,
  shouldRetryOverpass,
  terrainCacheControl,
  terrainUpstreamUrl,
} from "../src/logic";

describe("terrain path parsing", () => {
  test("parses a valid tile path", () => {
    expect(parseTerrainPath("/terrain/10/163/395.png")).toEqual({
      z: 10,
      x: 163,
      y: 395,
    });
  });

  test("accepts zoom bounds 0 and 15", () => {
    expect(parseTerrainPath("/terrain/0/0/0.png")).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTerrainPath("/terrain/15/32767/32767.png")).toEqual({
      z: 15,
      x: 32767,
      y: 32767,
    });
  });

  test("rejects zoom > 15", () => {
    expect(parseTerrainPath("/terrain/16/0/0.png")).toBeNull();
  });

  test("rejects x/y outside 2^z", () => {
    expect(parseTerrainPath("/terrain/2/4/0.png")).toBeNull();
    expect(parseTerrainPath("/terrain/2/0/4.png")).toBeNull();
    expect(parseTerrainPath("/terrain/0/1/0.png")).toBeNull();
  });

  test("rejects non-integer, negative, and malformed paths", () => {
    expect(parseTerrainPath("/terrain/1/0.5/0.png")).toBeNull();
    expect(parseTerrainPath("/terrain/-1/0/0.png")).toBeNull();
    expect(parseTerrainPath("/terrain/1/0/0.jpg")).toBeNull();
    expect(parseTerrainPath("/terrain/1/0/0.png/extra")).toBeNull();
    expect(parseTerrainPath("/terrain/1/0/0.png%00")).toBeNull();
    expect(parseTerrainPath("/terrain/../secret.png")).toBeNull();
  });

  test("isValidTile handles non-integers directly", () => {
    expect(isValidTile(1.5, 0, 0)).toBe(false);
    expect(isValidTile(3, 7, 7)).toBe(true);
    expect(isValidTile(3, 8, 0)).toBe(false);
  });

  test("builds the terrarium upstream URL", () => {
    expect(terrainUpstreamUrl({ z: 10, x: 163, y: 395 })).toBe(
      "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/163/395.png",
    );
  });
});

describe("terrain cache header selection", () => {
  test("200 gets long immutable caching", () => {
    expect(terrainCacheControl(200)).toBe(CACHE_TERRAIN_OK);
    expect(CACHE_TERRAIN_OK).toContain("s-maxage=2592000");
    expect(CACHE_TERRAIN_OK).toContain("immutable");
  });
  test("404 gets short caching", () => {
    expect(terrainCacheControl(404)).toBe(CACHE_TERRAIN_404);
    expect(CACHE_TERRAIN_404).toBe("public, s-maxage=3600");
  });
  test("5xx is never cached", () => {
    expect(terrainCacheControl(500)).toBe(CACHE_NONE);
    expect(terrainCacheControl(503)).toBe(CACHE_NONE);
  });
});

describe("overpass query decode/validate", () => {
  const query = '[out:json];way["building"](50.7,7.1,50.8,7.2);out geom;';

  test("round-trips through base64url", () => {
    const encoded = base64UrlEncode(query);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    const result = decodeOverpassQuery(encoded);
    expect(result).toEqual({ ok: true, query });
  });

  test("handles unicode queries", () => {
    const q = '[out:json];node["name"="Zürich — Bäckerei"];out;';
    expect(decodeOverpassQuery(base64UrlEncode(q))).toEqual({ ok: true, query: q });
  });

  test("rejects missing/empty/whitespace queries", () => {
    expect(decodeOverpassQuery(null).ok).toBe(false);
    expect(decodeOverpassQuery("").ok).toBe(false);
    expect(decodeOverpassQuery(base64UrlEncode("   \n\t ")).ok).toBe(false);
  });

  test("rejects queries at or over 8 KB", () => {
    const big = base64UrlEncode("x".repeat(OVERPASS_MAX_QUERY_BYTES));
    expect(decodeOverpassQuery(big)).toEqual({ ok: false, error: "query too large" });
    const okSize = base64UrlEncode("x".repeat(OVERPASS_MAX_QUERY_BYTES - 1));
    expect(decodeOverpassQuery(okSize).ok).toBe(true);
  });

  test("rejects invalid base64url", () => {
    expect(decodeOverpassQuery("not!!valid##").ok).toBe(false);
    expect(decodeOverpassQuery("a+b/c=").ok).toBe(false); // plain base64 chars not allowed
  });

  test("base64UrlDecode accepts unpadded input", () => {
    expect(new TextDecoder().decode(base64UrlDecode("aGk"))).toBe("hi");
  });
});

describe("overpass retry + cache policy", () => {
  test("retries only on 429 and 504", () => {
    expect(shouldRetryOverpass(429)).toBe(true);
    expect(shouldRetryOverpass(504)).toBe(true);
    expect(shouldRetryOverpass(200)).toBe(false);
    expect(shouldRetryOverpass(400)).toBe(false);
    expect(shouldRetryOverpass(500)).toBe(false);
  });

  test("only 200s are cacheable", () => {
    expect(overpassCacheControl(200)).toBe(CACHE_OVERPASS_OK);
    expect(overpassCacheControl(429)).toBe(CACHE_NONE);
    expect(overpassCacheControl(504)).toBe(CACHE_NONE);
    expect(overpassCacheControl(400)).toBe(CACHE_NONE);
  });
});

describe("og param sanitization", () => {
  const params = (q: Record<string, string>) => new URLSearchParams(q);

  test("passes through clean params", () => {
    const p = parseOgParams(
      params({
        place: "Kyoto",
        style: "contour-noir",
        palette: "1a1a2e,e94560,f5f5f5",
        coords: "35.0116,135.7681",
      }),
    );
    expect(p.place).toBe("Kyoto");
    expect(p.style).toBe("contour-noir");
    expect(p.palette).toEqual(["#1a1a2e", "#e94560", "#f5f5f5"]);
    expect(p.coords).toBe("35.0116°N  135.7681°E");
  });

  test("caps place at 80 chars and strips control characters", () => {
    const p = parseOgParams(params({ place: "A\u0000B\u001fC " + "x".repeat(200) }));
    expect(p.place.length).toBeLessThanOrEqual(80);
    expect(p.place.startsWith("A B C")).toBe(true);
  });

  test("falls back on empty or invalid inputs", () => {
    const p = parseOgParams(params({ style: "<script>", palette: "zzz,red", coords: "99,99" }));
    expect(p.place).toBe("Strata Studio");
    expect(p.style).toBe("custom");
    expect(p.palette).toHaveLength(3);
    expect(p.palette.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
  });

  test("rejects out-of-range coords but accepts negatives", () => {
    expect(parseOgParams(params({ coords: "91,0" })).coords).toBe("");
    expect(parseOgParams(params({ coords: "0,181" })).coords).toBe("");
    expect(parseOgParams(params({ coords: "abc" })).coords).toBe("");
    expect(parseOgParams(params({ coords: "-33.8688,151.2093" })).coords).toBe(
      "33.8688°S  151.2093°E",
    );
  });

  test("expands 3-digit hex and accepts leading #", () => {
    const p = parseOgParams(params({ palette: "#fff,000,#e94560" }));
    expect(p.palette).toEqual(["#ffffff", "#000000", "#e94560"]);
  });

  test("escapeHtml neutralizes markup", () => {
    expect(escapeHtml(`<img src="x" onerror='y'> & co`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt; &amp; co",
    );
  });
});
