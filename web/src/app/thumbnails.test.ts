import { describe, expect, it } from "bun:test";
import {
  createLruCache,
  renderThumbnail,
  THUMBNAIL_CACHE_CAP,
  THUMBNAIL_PARAM_OVERRIDES,
  THUMBNAIL_SIZE,
  thumbnailKey,
} from "./thumbnails.ts";
import {
  createSampleHeightmap,
  SAMPLE_BOUNDS,
  SAMPLE_GRID_SIZE,
  SAMPLE_MAX_ELEVATION,
  sampleFeatures,
  sampleHeightmap,
} from "../data/sampleHeightmap.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import { allStyles } from "../studios/registry.ts";
import type { StyleParams } from "../engine/types.ts";

describe("sampleHeightmap", () => {
  it("is deterministic across instantiations", () => {
    const a = createSampleHeightmap();
    const b = createSampleHeightmap();
    expect(a.data).toEqual(b.data);
    expect(sampleHeightmap.data).toEqual(a.data);
    expect(sampleHeightmap.bounds).toEqual(a.bounds);
  });

  it("has the expected dimensions and bounds", () => {
    expect(sampleHeightmap.width).toBe(SAMPLE_GRID_SIZE);
    expect(sampleHeightmap.height).toBe(SAMPLE_GRID_SIZE);
    expect(sampleHeightmap.data.length).toBe(SAMPLE_GRID_SIZE * SAMPLE_GRID_SIZE);
    expect(sampleHeightmap.bounds).toEqual(SAMPLE_BOUNDS);
    expect(SAMPLE_BOUNDS.east).toBeGreaterThan(SAMPLE_BOUNDS.west);
    expect(SAMPLE_BOUNDS.north).toBeGreaterThan(SAMPLE_BOUNDS.south);
  });

  it("spans the full 0..1200 m elevation range with real relief", () => {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const v of sampleHeightmap.data) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(min).toBeLessThan(1);
    expect(max).toBeLessThanOrEqual(SAMPLE_MAX_ELEVATION + 0.001);
    expect(max).toBeGreaterThan(SAMPLE_MAX_ELEVATION - 1);
    // Mean well inside the range: neither a flat floor nor a plateau.
    const mean = sum / sampleHeightmap.data.length;
    expect(mean).toBeGreaterThan(100);
    expect(mean).toBeLessThan(900);
  });

  it("ships synthetic features of every strata type inside the bounds", () => {
    const byType = { building: 0, road: 0, water: 0 };
    for (const feature of sampleFeatures.features) {
      byType[feature.properties.strataType]++;
    }
    expect(byType.building).toBeGreaterThanOrEqual(3);
    expect(byType.road).toBe(2);
    expect(byType.water).toBe(1);

    const water = sampleFeatures.features.find(
      (f) => f.properties.strataType === "water",
    );
    expect(water?.properties.waterType).toBe("lake");
    expect(water?.geometry.type).toBe("Polygon");

    for (const feature of sampleFeatures.features) {
      for (const [lng, lat] of flattenCoordinates(feature.geometry)) {
        expect(lng).toBeGreaterThanOrEqual(SAMPLE_BOUNDS.west);
        expect(lng).toBeLessThanOrEqual(SAMPLE_BOUNDS.east);
        expect(lat).toBeGreaterThanOrEqual(SAMPLE_BOUNDS.south);
        expect(lat).toBeLessThanOrEqual(SAMPLE_BOUNDS.north);
      }
    }
  });
});

function flattenCoordinates(
  geometry: (typeof sampleFeatures.features)[number]["geometry"],
): [number, number][] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "LineString":
      return geometry.coordinates;
    case "Polygon":
    case "MultiLineString":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
  }
}

describe("thumbnailKey", () => {
  it("is stable for identical inputs", () => {
    expect(thumbnailKey("ridge", defaultStyleParams)).toBe(
      thumbnailKey("ridge", defaultStyleParams),
    );
  });

  it("ignores param object key order", () => {
    const reordered = Object.fromEntries(
      Object.entries(defaultStyleParams).reverse(),
    ) as StyleParams;
    expect(thumbnailKey("ridge", reordered)).toBe(
      thumbnailKey("ridge", defaultStyleParams),
    );
  });

  it("changes when a rendered param or the style changes", () => {
    const base = thumbnailKey("ridge", defaultStyleParams);
    expect(
      thumbnailKey("ridge", { ...defaultStyleParams, amplitude: 99 }),
    ).not.toBe(base);
    expect(
      thumbnailKey("ridge", { ...defaultStyleParams, seed: "other" }),
    ).not.toBe(base);
    expect(
      thumbnailKey("ridge", { ...defaultStyleParams, palette: "neon" }),
    ).not.toBe(base);
    expect(thumbnailKey("contour", defaultStyleParams)).not.toBe(base);
  });

  it("collapses params that the overrides neutralize", () => {
    const base = thumbnailKey("ridge", defaultStyleParams);
    const noisyParams: StyleParams = {
      ...defaultStyleParams,
      grain: 0.8,
      label: "CHAMONIX",
      aspectRatio: "16:9",
      animationMode: "drift",
      phase: 0.5,
      transparent: true,
    };
    expect(thumbnailKey("ridge", noisyParams)).toBe(base);
  });
});

describe("THUMBNAIL_PARAM_OVERRIDES", () => {
  it("forces the documented cheap-render settings", () => {
    expect(THUMBNAIL_PARAM_OVERRIDES).toEqual({
      grain: 0,
      label: "",
      aspectRatio: "square",
      animationMode: "none",
      phase: 0,
      transparent: false,
    });
  });

  it("only contains valid StyleParams fields", () => {
    for (const key of Object.keys(THUMBNAIL_PARAM_OVERRIDES)) {
      expect(defaultStyleParams).toHaveProperty(key);
    }
  });
});

describe("renderThumbnail without a DOM", () => {
  it("returns null instead of throwing", () => {
    expect(typeof document).toBe("undefined");
    for (const style of allStyles) {
      expect(renderThumbnail(style.id, defaultStyleParams)).toBeNull();
    }
    expect(
      renderThumbnail("ridge", defaultStyleParams, THUMBNAIL_SIZE, sampleHeightmap),
    ).toBeNull();
  });
});

describe("createLruCache", () => {
  it("evicts the oldest entry past the cap", () => {
    const cache = createLruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("d")).toBe(4);
  });

  it("refreshes recency on get", () => {
    const cache = createLruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1); // a is now most recent
    cache.set("d", 4); // evicts b, not a
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("overwrites in place without growing and misses cleanly", () => {
    const cache = createLruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("a", 10);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(10);
    expect(cache.get("missing")).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("matches the documented thumbnail cap", () => {
    expect(THUMBNAIL_CACHE_CAP).toBe(64);
    const cache = createLruCache<number, number>(THUMBNAIL_CACHE_CAP);
    for (let i = 0; i < THUMBNAIL_CACHE_CAP + 5; i++) cache.set(i, i);
    expect(cache.size).toBe(THUMBNAIL_CACHE_CAP);
    expect(cache.has(0)).toBe(false);
    expect(cache.has(THUMBNAIL_CACHE_CAP + 4)).toBe(true);
  });
});
