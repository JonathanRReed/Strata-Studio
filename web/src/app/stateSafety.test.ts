import { describe, expect, test } from "bun:test";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import { latToPixelY, lngToPixelX } from "../engine/projection.ts";
import {
  deriveSelectionBounds,
  MAX_LABEL_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEED_LENGTH,
  normalizeMapCenter,
  normalizeMapZoom,
  normalizeStyleParams,
  sanitizeSearchQuery,
  validateGeoBounds,
  WEB_MERCATOR_MAX_LAT,
  wrapLongitude,
} from "./stateSafety.ts";

describe("composition normalization", () => {
  test("clamps every numeric family to the shipped UI ranges", () => {
    const normalized = normalizeStyleParams({
      ...defaultStyleParams,
      amplitude: 1e9,
      spacing: -20,
      lineWidth: 0,
      noise: 5,
      detail: -1,
      compression: 99,
      buildingInfluence: -10,
      roadInfluence: 101,
      grain: Number.POSITIVE_INFINITY,
      rotation: 999,
      occlusion: -1,
      phase: 2,
      animationSpeed: 0,
    });
    expect(normalized).toMatchObject({
      amplitude: 120,
      spacing: 1,
      lineWidth: 0.5,
      noise: 1,
      detail: 0.1,
      compression: 2,
      buildingInfluence: 0,
      roadInfluence: 100,
      grain: defaultStyleParams.grain,
      rotation: 360,
      occlusion: 0,
      phase: 1 - Number.EPSILON,
      animationSpeed: 0.05,
    });
  });

  test("validates every enum family and caps text payloads", () => {
    const normalized = normalizeStyleParams({
      ...defaultStyleParams,
      seed: "s".repeat(MAX_SEED_LENGTH + 50),
      label: "l".repeat(MAX_LABEL_LENGTH + 50),
      aspectRatio: "100:1",
      labelStyle: "billboard",
      animationMode: "teleport",
      buildingMode: "erase",
      roadMode: "erase",
      waterMode: "erase",
      oceanMode: "erase",
      lakeMode: "erase",
      riverMode: "erase",
    });
    expect(normalized.seed).toHaveLength(MAX_SEED_LENGTH);
    expect(normalized.label).toHaveLength(MAX_LABEL_LENGTH);
    expect(normalized.aspectRatio).toBe(defaultStyleParams.aspectRatio);
    expect(normalized.labelStyle).toBe(defaultStyleParams.labelStyle);
    expect(normalized.animationMode).toBe(defaultStyleParams.animationMode);
    expect(normalized.buildingMode).toBe(defaultStyleParams.buildingMode);
    expect(normalized.roadMode).toBe(defaultStyleParams.roadMode);
    expect(normalized.waterMode).toBe(defaultStyleParams.waterMode);
    expect(normalized.oceanMode).toBe(defaultStyleParams.oceanMode);
    expect(normalized.lakeMode).toBe(defaultStyleParams.lakeMode);
    expect(normalized.riverMode).toBe(defaultStyleParams.riverMode);
  });

  test("caps and trims location search payloads", () => {
    expect(sanitizeSearchQuery(`  ${"x".repeat(500)}  `)).toHaveLength(
      MAX_SEARCH_QUERY_LENGTH,
    );
  });
});

describe("Web Mercator state safety", () => {
  test("wraps pathological longitudes in constant-time modulo", () => {
    expect(wrapLongitude(1_000_000_000)).toBe(-80);
    expect(wrapLongitude(-1_000_000_000)).toBe(80);
    expect(wrapLongitude(180)).toBe(180);
    expect(wrapLongitude(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("normalizes extreme centers and zooms", () => {
    expect(normalizeMapCenter([1_000_000_000, 999], [0, 0])).toEqual([
      -80,
      WEB_MERCATOR_MAX_LAT,
    ]);
    expect(normalizeMapZoom(-100, 11)).toBe(0);
    expect(normalizeMapZoom(100, 11)).toBe(22);
  });

  test("rejects bounds outside exact Web Mercator limits", () => {
    expect(
      validateGeoBounds({ west: -1, south: -90, east: 1, north: 1 }),
    ).toBeNull();
    expect(
      validateGeoBounds({ west: -181, south: -1, east: 1, north: 1 }),
    ).toBeNull();
    expect(
      validateGeoBounds({ west: 10, south: -1, east: -10, north: 1 }),
    ).toBeNull();
  });

  test("derives aspect-correct deterministic boot bounds", () => {
    const zoom = 11;
    const bounds = deriveSelectionBounds([-122.4194, 37.7749], zoom, "16:9");
    const width = Math.abs(
      lngToPixelX(bounds.east, zoom) - lngToPixelX(bounds.west, zoom),
    );
    const height = Math.abs(
      latToPixelY(bounds.south, zoom) - latToPixelY(bounds.north, zoom),
    );
    expect(width / height).toBeCloseTo(16 / 9, 10);
  });

  test("derives finite valid bounds at extreme center/zoom values", () => {
    for (const center of [
      [1e12, 1e12],
      [-1e12, -1e12],
      [180, WEB_MERCATOR_MAX_LAT],
    ] as [number, number][]) {
      const bounds = deriveSelectionBounds(center, 1e6);
      expect(validateGeoBounds(bounds)).toEqual(bounds);
      expect(Object.values(bounds).every(Number.isFinite)).toBe(true);
    }
  });
});
