import { describe, it, expect, spyOn } from "bun:test";
import {
  lngToPixelX,
  latToPixelY,
  pixelXToLng,
  pixelYToLat,
  normalizeBounds,
} from "./projection.ts";
import { hashSeed, createSeededNoise, createNoise, createAnimatedNoise } from "./noise.ts";
import {
  buildOverpassQuery,
  classifyFeature,
  classifyWaterType,
  overpassToGeoJSON,
  bboxAreaKm2,
  isBboxSmallEnough,
  fetchOsmFeatures,
} from "../data/osmOverpass.ts";
import { sampleGrid, clamp, normalizeGrid, projectGeoPoint, cropGridToAspect } from "./grid.ts";
import {
  waveformTerrain,
  generateRows,
} from "../studios/experimental/waveformTerrain.ts";
import { allStyles, stylesByStudio, renderStyleSvg, validatePresetStyleIds } from "../studios/registry.ts";
import { defaultStyleParams, presets } from "../presets/stylePresets.ts";
import { marchingSquares } from "./contours.ts";
import { animateScene, sceneWithDrawProgress, sceneWithParallax, framePhase, needsRegeneration, needsPostProcess } from "./animation.ts";
import { applyFeatureInfluence, applyInfluenceToLine } from "../studios/common.ts";
import type { FeatureMasks, StyleParams } from "./types.ts";

function makeMasks(w: number, h: number, fill: Partial<Record<keyof FeatureMasks, number>>): FeatureMasks {
  const make = (v: number | undefined) => new Float32Array(w * h).fill(v ?? 0);
  return {
    width: w,
    height: h,
    building: make(fill.building),
    road: make(fill.road),
    water: make(fill.water),
    ocean: make(fill.ocean),
    lake: make(fill.lake),
    river: make(fill.river),
  };
}

function decodeElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

describe("projection", () => {
  it("round-trips longitude through pixel x", () => {
    const zoom = 11;
    const lng = -122.4194;
    const x = lngToPixelX(lng, zoom);
    expect(Math.abs(pixelXToLng(x, zoom) - lng)).toBeLessThan(1e-6);
  });

  it("round-trips latitude through pixel y", () => {
    const zoom = 11;
    const lat = 37.7749;
    const y = latToPixelY(lat, zoom);
    expect(Math.abs(pixelYToLat(y, zoom) - lat)).toBeLessThan(1e-6);
  });
});

describe("noise", () => {
  it("produces the same output for the same seed", () => {
    const noise = createSeededNoise("same");
    expect(noise(1, 2)).toBe(noise(1, 2));
  });

  it("produces different output for different seeds", () => {
    const a = createSeededNoise("a");
    const b = createSeededNoise("b");
    const samplesA = [a(1, 2), a(3, 4), a(5, 6)];
    const samplesB = [b(1, 2), b(3, 4), b(5, 6)];
    expect(samplesA).not.toEqual(samplesB);
  });

  it("hashes the same seed consistently", () => {
    expect(hashSeed("hello")).toBe(hashSeed("hello"));
  });

  it("creates fractal noise within [-1, 1]", () => {
    const n = createNoise("fractal", 4);
    const v = n(1, 2);
    expect(v).toBeGreaterThanOrEqual(-1);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("elevation decoding", () => {
  it("decodes (128, 0, 0) to 0 meters", () => {
    expect(decodeElevation(128, 0, 0)).toBe(0);
  });

  it("decodes (128, 60, 181) correctly", () => {
    expect(decodeElevation(128, 60, 181)).toBeCloseTo(60.707, 3);
  });
});

describe("buildOverpassQuery", () => {
  it("returns a query string containing required query parts", () => {
    const query = buildOverpassQuery({
      west: -122.43,
      east: -122.42,
      north: 37.78,
      south: 37.77,
    });
    expect(query).toContain("[out:json]");
    expect(query).toContain("building");
    expect(query).toContain("highway");
    expect(query).toContain("water");
    expect(query).toContain('way["natural"="coastline"]');
    expect(query).toContain('relation["natural"="water"]');
    expect(query).toContain('relation["waterway"]');
  });
});

describe("classifyWaterType", () => {
  it("classifies ocean, river, and lake water", () => {
    expect(classifyWaterType({ natural: "coastline" })).toBe("ocean");
    expect(classifyWaterType({ natural: "water", water: "river" })).toBe("river");
    expect(classifyWaterType({ waterway: "stream" })).toBe("river");
    expect(classifyWaterType({ waterway: "riverbank" })).toBe("river");
    expect(classifyWaterType({ natural: "water", water: "lake" })).toBe("lake");
    expect(classifyWaterType({ natural: "water" })).toBe("lake");
    expect(classifyWaterType({ building: "yes" })).toBeUndefined();
  });
});

describe("classifyFeature", () => {
  it("classifies tags as building, road, or water", () => {
    expect(classifyFeature({ building: "yes" })).toBe("building");
    expect(classifyFeature({ highway: "residential" })).toBe("road");
    expect(classifyFeature({ natural: "water" })).toBe("water");
  });
});

describe("overpassToGeoJSON", () => {
  it("converts a simple overpass response into a GeoJSON LineString feature", () => {
    const result = overpassToGeoJSON({
      elements: [
        { type: "node", id: 1, lat: 37.77, lon: -122.42 },
        { type: "node", id: 2, lat: 37.78, lon: -122.41 },
        {
          type: "way",
          id: 100,
          nodes: [1, 2],
          tags: { highway: "residential" },
        },
      ],
    });

    expect(result.features.length).toBe(1);
    expect(result.features[0].properties.strataType).toBe("road");
    expect(result.features[0].geometry.type).toBe("LineString");
  });

  it("assembles water multipolygon relations from open member ways", () => {
    const result = overpassToGeoJSON({
      elements: [
        { type: "node", id: 1, lat: 0, lon: 0 },
        { type: "node", id: 2, lat: 0, lon: 1 },
        { type: "node", id: 3, lat: 1, lon: 1 },
        { type: "node", id: 4, lat: 1, lon: 0 },
        { type: "way", id: 10, nodes: [1, 2, 3] },
        { type: "way", id: 11, nodes: [3, 4, 1] },
        {
          type: "relation",
          id: 100,
          members: [
            { type: "way", ref: 10, role: "outer" },
            { type: "way", ref: 11, role: "outer" },
          ],
          tags: { type: "multipolygon", natural: "water", water: "lake" },
        },
      ],
    });

    expect(result.features.length).toBe(1);
    const feature = result.features[0];
    expect(feature.geometry.type).toBe("Polygon");
    expect(feature.properties.strataType).toBe("water");
    expect(feature.properties.waterType).toBe("lake");
    if (feature.geometry.type === "Polygon") {
      expect(feature.geometry.coordinates[0].length).toBe(5);
    }
  });

  it("chains coastline ways into a single merged linestring tagged as ocean", () => {
    const result = overpassToGeoJSON({
      elements: [
        { type: "node", id: 1, lat: 0, lon: 0 },
        { type: "node", id: 2, lat: 0.5, lon: 0.5 },
        { type: "node", id: 3, lat: 1, lon: 1 },
        { type: "way", id: 20, nodes: [1, 2], tags: { natural: "coastline" } },
        { type: "way", id: 21, nodes: [2, 3], tags: { natural: "coastline" } },
      ],
    });

    expect(result.features.length).toBe(1);
    const feature = result.features[0];
    expect(feature.geometry.type).toBe("LineString");
    expect(feature.properties.waterType).toBe("ocean");
    if (feature.geometry.type === "LineString") {
      expect(feature.geometry.coordinates.length).toBe(3);
    }
  });

  it("assembles rings using head-extension when ways are not tail-ordered", () => {
    // Ways ordered so that the second way must be prepended to the head
    // of the first to close the ring: [2,3,4] + [4,1,2] → [2,3,4,1,2].
    // With the old tail-only assembler, [4,1,2] matches tail=4 so this
    // particular case works via tail. But [3,4,5] + [1,2,3] + [5,1] tests
    // head-extension: starting with [3,4,5], [1,2,3] matches head=3.
    const result = overpassToGeoJSON({
      elements: [
        { type: "node", id: 1, lat: 0, lon: 0 },
        { type: "node", id: 2, lat: 0, lon: 1 },
        { type: "node", id: 3, lat: 1, lon: 1 },
        { type: "node", id: 4, lat: 1, lon: 0 },
        { type: "node", id: 5, lat: 0.5, lon: 0.5 },
        { type: "way", id: 10, nodes: [3, 4, 5] },
        { type: "way", id: 11, nodes: [1, 2, 3] },
        { type: "way", id: 12, nodes: [5, 1] },
        {
          type: "relation",
          id: 100,
          members: [
            { type: "way", ref: 10, role: "outer" },
            { type: "way", ref: 11, role: "outer" },
            { type: "way", ref: 12, role: "outer" },
          ],
          tags: { type: "multipolygon", natural: "water", water: "lake" },
        },
      ],
    });

    expect(result.features.length).toBe(1);
    const feature = result.features[0];
    expect(feature.geometry.type).toBe("Polygon");
    if (feature.geometry.type === "Polygon") {
      expect(feature.geometry.coordinates[0].length).toBe(6);
    }
  });

  it("assigns inner rings to the correct outer in a multi-outer multipolygon", () => {
    // Two disjoint outer squares with one inner hole each. The inner rings
    // must be assigned to their containing outer, not duplicated across both.
    const result = overpassToGeoJSON({
      elements: [
        // Outer 1: square (0,0)-(2,2)
        { type: "node", id: 1, lat: 0, lon: 0 },
        { type: "node", id: 2, lat: 0, lon: 2 },
        { type: "node", id: 3, lat: 2, lon: 2 },
        { type: "node", id: 4, lat: 2, lon: 0 },
        { type: "way", id: 10, nodes: [1, 2, 3, 4, 1] },
        // Inner 1: hole inside outer 1 at (0.5,0.5)-(1,1)
        { type: "node", id: 5, lat: 0.5, lon: 0.5 },
        { type: "node", id: 6, lat: 0.5, lon: 1 },
        { type: "node", id: 7, lat: 1, lon: 1 },
        { type: "node", id: 8, lat: 1, lon: 0.5 },
        { type: "way", id: 11, nodes: [5, 6, 7, 8, 5] },
        // Outer 2: square (3,3)-(5,5)
        { type: "node", id: 9, lat: 3, lon: 3 },
        { type: "node", id: 10, lat: 3, lon: 5 },
        { type: "node", id: 11, lat: 5, lon: 5 },
        { type: "node", id: 12, lat: 5, lon: 3 },
        { type: "way", id: 12, nodes: [9, 10, 11, 12, 9] },
        // Inner 2: hole inside outer 2 at (3.5,3.5)-(4,4)
        { type: "node", id: 13, lat: 3.5, lon: 3.5 },
        { type: "node", id: 14, lat: 3.5, lon: 4 },
        { type: "node", id: 15, lat: 4, lon: 4 },
        { type: "node", id: 16, lat: 4, lon: 3.5 },
        { type: "way", id: 13, nodes: [13, 14, 15, 16, 13] },
        {
          type: "relation",
          id: 200,
          members: [
            { type: "way", ref: 10, role: "outer" },
            { type: "way", ref: 12, role: "outer" },
            { type: "way", ref: 11, role: "inner" },
            { type: "way", ref: 13, role: "inner" },
          ],
          tags: { type: "multipolygon", natural: "water", water: "lake" },
        },
      ],
    });

    expect(result.features.length).toBe(1);
    const feature = result.features[0];
    expect(feature.geometry.type).toBe("MultiPolygon");
    if (feature.geometry.type === "MultiPolygon") {
      // Each polygon should have exactly 2 rings: outer + its inner.
      expect(feature.geometry.coordinates[0].length).toBe(2);
      expect(feature.geometry.coordinates[1].length).toBe(2);
    }
  });

  it("classifies water=sea and water=lagoon as ocean", () => {
    expect(classifyWaterType({ natural: "water", water: "sea" })).toBe("ocean");
    expect(classifyWaterType({ natural: "water", water: "lagoon" })).toBe("ocean");
    expect(classifyWaterType({ natural: "water", water: "reservoir" })).toBe("lake");
  });
});

describe("bboxAreaKm2 and isBboxSmallEnough", () => {
  it("returns a small area for a 0.01 degree bbox and is small enough", () => {
    const small = {
      west: -122.43,
      east: -122.42,
      north: 37.78,
      south: 37.77,
    };
    expect(bboxAreaKm2(small)).toBeLessThan(2);
    expect(isBboxSmallEnough(small)).toBe(true);
  });

  it("returns false for a large 10 degree bbox", () => {
    const large = { west: 0, east: 10, north: 10, south: 0 };
    expect(isBboxSmallEnough(large)).toBe(false);
  });
});

describe("sampleGrid and clamp", () => {
  it("clamps values to the given range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("samples a 2x2 grid", () => {
    const grid = new Float32Array([0, 1, 1, 2]);
    expect(sampleGrid(grid, 2, 0, 0)).toBe(0);
    expect(sampleGrid(grid, 2, 1, 1)).toBe(2);
    expect(sampleGrid(grid, 2, 0.5, 0.5)).toBe(1);
  });
});

describe("normalizeGrid", () => {
  it("returns min, max, and range for a grid", () => {
    const grid = new Float32Array([0, 5, 10]);
    expect(normalizeGrid(grid)).toEqual({ min: 0, max: 10, range: 10 });
  });
});

describe("projectGeoPoint", () => {
  it("projects geographic coordinates to canvas coordinates", () => {
    const bounds = { west: 0, east: 10, north: 10, south: 0 };
    expect(projectGeoPoint(0, 0, bounds, 100, 100)).toEqual({ x: 0, y: 100 });
    expect(projectGeoPoint(10, 10, bounds, 100, 100)).toEqual({
      x: 100,
      y: 0,
    });
  });
});

describe("normalizeBounds", () => {
  it("clamps latitude to the mercator max and wraps longitude", () => {
    expect(
      normalizeBounds({ west: 0, east: 1, north: 90, south: -90 }),
    ).toEqual({
      west: 0,
      east: 1,
      north: 85.0511,
      south: -85.0511,
    });

    expect(
      normalizeBounds({ west: 185, east: 190, north: 10, south: 5 }),
    ).toEqual({
      west: -175,
      east: -170,
      north: 10,
      south: 5,
    });
  });
});

describe("waveformTerrain", () => {
  it("generateRows and renderSvg work with a fake elevation grid", () => {
    const grid = {
      width: 4,
      height: 4,
      bounds: { west: 0, east: 1, north: 1, south: 0 },
      data: new Float32Array([
        0, 0.25, 0.5, 0.75, 0.25, 0.5, 0.75, 1, 0, 0.25, 0.5, 0.75, 0.25, 0.5,
        0.75, 1,
      ]),
    };

    const input = {
      bounds: { west: 0, east: 1, north: 1, south: 0 },
      elevationGrid: grid,
      width: 100,
      height: 100,
      seed: "test",
    };

    const params = { ...defaultStyleParams, ...waveformTerrain.defaultParams };
    const rows = generateRows(input, params);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Array.isArray(row.segments)).toBe(true);
    }

    const svg = renderStyleSvg(waveformTerrain.id, input, params);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
  });

  it("amplify influence increases displacement magnitude", () => {
    const grid = {
      width: 4,
      height: 4,
      bounds: { west: 0, east: 1, north: 1, south: 0 },
      data: new Float32Array([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    };
    const masks = {
      width: 4,
      height: 4,
      building: new Float32Array(16),
      road: new Float32Array(16).fill(1),
      water: new Float32Array(16),
      ocean: new Float32Array(16),
      lake: new Float32Array(16),
      river: new Float32Array(16),
    };
    const base = {
      ...defaultStyleParams,
      ...waveformTerrain.defaultParams,
      noise: 0,
      occlusion: 0,
    };
    const input = (m?: typeof masks) => ({
      bounds: grid.bounds,
      elevationGrid: grid,
      masks: m,
      width: 100,
      height: 100,
      seed: "test",
    });
    const plain = generateRows(input(undefined), base);
    const amplified = generateRows(input(masks), {
      ...base,
      roadInfluence: 100,
      roadMode: "amplify" as const,
    });
    const plainY = plain[0].segments[0][0].y;
    const ampY = amplified[0].segments[0][0].y;
    const baseY = plain[0].baseY;
    expect(Math.abs(ampY - baseY)).toBeGreaterThan(Math.abs(plainY - baseY));
  });
});

describe("style registry", () => {
  const grid = {
    width: 8,
    height: 8,
    bounds: { west: 0, east: 1, north: 1, south: 0 },
    data: new Float32Array(64).map((_, i) => Math.sin(i * 0.3) * 0.5 + 0.5),
  };
  const input = {
    bounds: grid.bounds,
    elevationGrid: grid,
    width: 120,
    height: 120,
    seed: "registry-test",
  };

  it("contains all 16 styles across both studios", () => {
    expect(stylesByStudio.classic.length).toBe(7);
    expect(stylesByStudio.experimental.length).toBe(9);
    expect(allStyles.length).toBe(16);
  });

  it("every style generates a non-empty scene and valid SVG", () => {
    for (const style of allStyles) {
      const params = { ...defaultStyleParams, ...style.defaultParams };
      const scene = style.generate(input, params);
      expect(scene.strokes.length).toBeGreaterThan(0);
      const svg = renderStyleSvg(style.id, input, params);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("</svg>");
    }
  });

  it("escapes labels in SVG output", () => {
    const params = {
      ...defaultStyleParams,
      ...waveformTerrain.defaultParams,
      label: 'A & B <"C">',
    };
    const svg = renderStyleSvg(waveformTerrain.id, input, params);
    expect(svg).toContain("A &amp; B &lt;&quot;C&quot;&gt;");
    expect(svg).not.toContain('<"C">');
  });

  it("is deterministic for the same seed", () => {
    const params = { ...defaultStyleParams, ...waveformTerrain.defaultParams };
    const a = renderStyleSvg(waveformTerrain.id, input, params);
    const b = renderStyleSvg(waveformTerrain.id, input, params);
    expect(a).toBe(b);
  });

  it("classic styles apply feature influence (interrupt mode breaks strokes)", () => {
    // Build a mask with a building footprint covering the center
    const maskW = 120, maskH = 120;
    const building = new Float32Array(maskW * maskH);
    const road = new Float32Array(maskW * maskH);
    const water = new Float32Array(maskW * maskH);
    const ocean = new Float32Array(maskW * maskH);
    const lake = new Float32Array(maskW * maskH);
    const river = new Float32Array(maskW * maskH);
    // Fill center region with building mask
    for (let y = 40; y < 80; y++) {
      for (let x = 40; x < 80; x++) {
        building[y * maskW + x] = 1.0;
      }
    }
    const masks: FeatureMasks = {
      width: maskW, height: maskH,
      building, road, water, ocean, lake, river,
    };
    const inputWithMasks = { ...input, masks };

    const classicStyleIds = ["contour", "flow", "blueprint", "woodcut", "drift", "signal"];
    for (const styleId of classicStyleIds) {
      const style = allStyles.find((s) => s.id === styleId)!;
      const baseParams = { ...defaultStyleParams, ...style.defaultParams };
      // Without influence: normal generation
      const sceneNoInfluence = style.generate(inputWithMasks, baseParams);
      // With building influence + interrupt mode: should break strokes
      const sceneWithInfluence = style.generate(inputWithMasks, {
        ...baseParams,
        buildingInfluence: 100,
        buildingMode: "interrupt" as const,
      });
      // The number of strokes should differ (interrupt mode splits lines)
      // or the total point count should differ
      const noInfStrokes = sceneNoInfluence.strokes.length;
      const withInfStrokes = sceneWithInfluence.strokes.length;
      // At least one of these should be true:
      // 1. More strokes (lines were broken)
      // 2. Fewer total points (segments were removed)
      const noInfPoints = sceneNoInfluence.strokes.reduce((s, st) => s + st.points.length, 0);
      const withInfPoints = sceneWithInfluence.strokes.reduce((s, st) => s + st.points.length, 0);
      const strokesChanged = withInfStrokes !== noInfStrokes;
      const pointsChanged = withInfPoints !== noInfPoints;
      expect(strokesChanged || pointsChanged).toBe(true);
    }
  });

  it("type-aware feature influence: water influence does not affect road lines", () => {
    // Build a mask with water covering the center
    const maskW = 120, maskH = 120;
    const building = new Float32Array(maskW * maskH);
    const road = new Float32Array(maskW * maskH);
    const ocean = new Float32Array(maskW * maskH);
    const lake = new Float32Array(maskW * maskH);
    const river = new Float32Array(maskW * maskH);
    const water = new Float32Array(maskW * maskH);
    // Fill center with water mask
    for (let y = 40; y < 80; y++) {
      for (let x = 40; x < 80; x++) {
        ocean[y * maskW + x] = 1.0;
        water[y * maskW + x] = 1.0;
      }
    }
    const masks: FeatureMasks = {
      width: maskW, height: maskH,
      building, road, water, ocean, lake, river,
    };

    // A horizontal road line crossing through the water area
    // (conceptually — we test the influence function directly below)

    // Without strataType (terrain): water influence SHOULD affect the line
    const terrainResult = applyFeatureInfluence(1, 0.5, 0.5, masks, {
      ...defaultStyleParams,
      oceanInfluence: 100,
      oceanMode: "interrupt" as const,
    });
    expect(terrainResult.break_).toBe(true);

    // With strataType="road": water influence should NOT affect the line
    const roadResult = applyFeatureInfluence(1, 0.5, 0.5, masks, {
      ...defaultStyleParams,
      oceanInfluence: 100,
      oceanMode: "interrupt" as const,
    }, "road");
    expect(roadResult.break_).toBe(false);

    // With strataType="water": water influence SHOULD affect the line
    const waterResult = applyFeatureInfluence(1, 0.5, 0.5, masks, {
      ...defaultStyleParams,
      oceanInfluence: 100,
      oceanMode: "interrupt" as const,
    }, "water");
    expect(waterResult.break_).toBe(true);
  });

  it("gravity-well honors the occlusion parameter", () => {
    const style = allStyles.find((s) => s.id === "gravity-well")!;
    const params = { ...defaultStyleParams, ...style.defaultParams };
    const without = style.generate(input, { ...params, occlusion: 0 });
    const withOcclusion = style.generate(input, { ...params, occlusion: 1 });
    expect(without.strokes.some((s) => s.fill)).toBe(false);
    expect(withOcclusion.strokes.some((s) => s.fill && s.role === "background")).toBe(true);
  });

  it("magnetic-field responds to flatten influence (streamlines stall)", () => {
    const style = allStyles.find((s) => s.id === "magnetic-field")!;
    const masks = makeMasks(120, 120, { road: 1 });
    const params = { ...defaultStyleParams, ...style.defaultParams };
    const inputWithMasks = { ...input, masks };
    const totalLength = (scene: ReturnType<typeof style.generate>) =>
      scene.strokes.reduce((sum, s) => {
        let len = 0;
        for (let i = 1; i < s.points.length; i++) {
          len += Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y);
        }
        return sum + len;
      }, 0);
    const plain = totalLength(style.generate(inputWithMasks, params));
    const flattened = totalLength(style.generate(inputWithMasks, {
      ...params,
      roadInfluence: 100,
      roadMode: "flatten" as const,
    }));
    expect(plain).toBeGreaterThan(0);
    // Full-strength flatten zeroes the step length: streamlines cannot move
    // (up to Float32 mask-sampling dust).
    expect(flattened).toBeLessThan(1e-9);
  });

  it("terrain-sonogram responds to amplify and flatten influence", () => {
    const style = allStyles.find((s) => s.id === "terrain-sonogram")!;
    const masks = makeMasks(120, 120, { road: 1 });
    const params = { ...defaultStyleParams, ...style.defaultParams };
    const inputWithMasks = { ...input, masks };
    const countPoints = (scene: ReturnType<typeof style.generate>) =>
      scene.strokes.reduce((sum, s) => sum + s.points.length, 0);
    const plain = countPoints(style.generate(inputWithMasks, params));
    const amplified = countPoints(style.generate(inputWithMasks, {
      ...params,
      roadInfluence: 100,
      roadMode: "amplify" as const,
    }));
    const flattened = style.generate(inputWithMasks, {
      ...params,
      roadInfluence: 100,
      roadMode: "flatten" as const,
    });
    // Amplify boosts bar intensity above the cutoff → more visible bars.
    expect(amplified).toBeGreaterThan(plain);
    // Full-strength flatten damps every bar below the cutoff.
    expect(flattened.strokes.length).toBe(0);
  });
});

describe("marching squares", () => {
  it("extracts a contour ring around a peak", () => {
    const n = 8;
    const field = (x: number, y: number) => {
      const dx = x - 3.5;
      const dy = y - 3.5;
      return 1 - Math.hypot(dx, dy) / 5;
    };
    const lines = marchingSquares(field, n, 0.5);
    expect(lines.length).toBeGreaterThan(0);
    const totalPoints = lines.reduce((s, l) => s + l.length, 0);
    expect(totalPoints).toBeGreaterThan(4);
  });
});

describe("cropGridToAspect", () => {
  it("center-crops a square grid for a wide aspect", () => {
    const grid = {
      width: 8,
      height: 8,
      bounds: { west: 0, east: 8, north: 8, south: 0 },
      data: new Float32Array(64).map((_, i) => i),
    };
    const cropped = cropGridToAspect(grid, 16, 9);
    expect(cropped.width).toBe(8);
    expect(cropped.height).toBeLessThan(8);
    expect(cropped.data.length).toBe(cropped.width * cropped.height);
  });

  it("returns the grid unchanged for square targets", () => {
    const grid = {
      width: 4,
      height: 4,
      bounds: { west: 0, east: 1, north: 1, south: 0 },
      data: new Float32Array(16),
    };
    expect(cropGridToAspect(grid, 100, 100)).toBe(grid);
  });
});

describe("antimeridian bounds", () => {
  it("clamps antimeridian-crossing selections instead of spanning the world", () => {
    const b = normalizeBounds({ west: 179, east: -179, north: 10, south: 9 });
    expect(b.east).toBeGreaterThan(b.west);
    expect(b.east - b.west).toBeLessThan(5);
  });
});

describe("animated noise", () => {
  it("produces different output for different phases", () => {
    const noise = createAnimatedNoise("anim-test", 4, 0.5);
    const a = noise(0.5, 0.5, 0);
    const b = noise(0.5, 0.5, 0.5);
    expect(a).not.toBe(b);
  });

  it("phase 0 matches default (no phase argument)", () => {
    const noise = createAnimatedNoise("loop-test", 4, 0.5);
    const a = noise(0.5, 0.5, 0);
    const b = noise(0.5, 0.5);
    expect(a).toBe(b);
  });

  it("loops exactly: phase 1 equals phase 0 bit-for-bit", () => {
    const noise = createAnimatedNoise("loop-exact", 4, 0.5);
    for (const [x, y] of [[0.5, 0.5], [0.1, 0.9], [3.2, -1.7]]) {
      expect(noise(x, y, 1)).toBe(noise(x, y, 0));
      expect(noise(x, y, 2)).toBe(noise(x, y, 0));
    }
  });

  it("wraps fractional phases: 1.25 equals 0.25 (continuous preview phase previews the loop)", () => {
    const noise = createAnimatedNoise("loop-wrap", 4, 0.5);
    expect(noise(0.5, 0.5, 1.25)).toBe(noise(0.5, 0.5, 0.25));
    expect(noise(0.5, 0.5, 3.75)).toBe(noise(0.5, 0.5, 0.75));
  });

  it("stays within [-1, 1] and is deterministic per seed", () => {
    const a = createAnimatedNoise("det-test", 4, 0.5);
    const b = createAnimatedNoise("det-test", 4, 0.5);
    for (const phase of [0, 0.3, 0.6, 0.9]) {
      const v = a(0.4, 0.8, phase);
      expect(v).toBe(b(0.4, 0.8, phase));
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("animation engine", () => {
  it("framePhase returns 0 at start and approaches 1 at end", () => {
    expect(framePhase(0, 48)).toBe(0);
    expect(framePhase(24, 48)).toBe(0.5);
    expect(framePhase(47, 48)).toBeCloseTo(47/48, 10);
  });

  it("needsRegeneration is true only for drift", () => {
    expect(needsRegeneration("drift")).toBe(true);
    expect(needsRegeneration("draw")).toBe(false);
    expect(needsRegeneration("parallax")).toBe(false);
    expect(needsRegeneration("none")).toBe(false);
  });

  it("needsPostProcess is true for draw and parallax", () => {
    expect(needsPostProcess("draw")).toBe(true);
    expect(needsPostProcess("parallax")).toBe(true);
    expect(needsPostProcess("drift")).toBe(false);
    expect(needsPostProcess("none")).toBe(false);
  });

  it("sceneWithDrawProgress reveals strokes progressively", () => {
    const scene = {
      strokes: [
        { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] },
        { points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] },
      ],
    };
    // At progress 0, no strokes should be visible
    const atStart = sceneWithDrawProgress(scene, 0);
    expect(atStart.strokes.length).toBe(0);
    // At progress 1, all strokes should be fully visible
    const atEnd = sceneWithDrawProgress(scene, 1);
    expect(atEnd.strokes.length).toBe(2);
  });

  it("sceneWithParallax offsets stroke points", () => {
    const scene = {
      strokes: [
        { points: [{ x: 50, y: 0 }, { x: 50, y: 100 }] },
      ],
    };
    const result = sceneWithParallax(scene, 0.25, 100, 100);
    // At phase 0.25, the offset should be non-zero
    const origX = scene.strokes[0].points[0].x;
    const newX = result.strokes[0].points[0].x;
    expect(newX).not.toBe(origX);
  });

  it("animateScene returns scene unchanged for none mode", () => {
    const scene = { strokes: [{ points: [{ x: 1, y: 2 }] }] };
    const result = animateScene(scene, { ...defaultStyleParams, animationMode: "none" }, 0, 48, 100, 100);
    expect(result).toBe(scene);
  });
});

describe("per-type water influence", () => {
  it("ocean influence with flatten mode damps displacement", () => {
    const masks = makeMasks(4, 4, { ocean: 0.8 });
    const params: StyleParams = {
      ...defaultStyleParams,
      oceanInfluence: 100,
      oceanMode: "flatten",
      waterInfluence: 0,
      lakeInfluence: 0,
      riverInfluence: 0,
    };
    const result = applyFeatureInfluence(10, 0.5, 0.5, masks, params);
    expect(Math.abs(result.displacement)).toBeLessThan(10);
  });

  it("lake influence with amplify mode increases displacement", () => {
    const masks = makeMasks(4, 4, { lake: 0.8 });
    const params: StyleParams = {
      ...defaultStyleParams,
      lakeInfluence: 100,
      lakeMode: "amplify",
      waterInfluence: 0,
      oceanInfluence: 0,
      riverInfluence: 0,
    };
    const result = applyFeatureInfluence(10, 0.5, 0.5, masks, params);
    expect(Math.abs(result.displacement)).toBeGreaterThan(10);
  });

  it("river influence with interrupt mode sets break_", () => {
    const masks = makeMasks(4, 4, { river: 0.8 });
    const params: StyleParams = {
      ...defaultStyleParams,
      riverInfluence: 100,
      riverMode: "interrupt",
      waterInfluence: 0,
      oceanInfluence: 0,
      lakeInfluence: 0,
    };
    const result = applyFeatureInfluence(10, 0.5, 0.5, masks, params);
    expect(result.break_).toBe(true);
  });

  it("combined water influence still works alongside per-type", () => {
    const masks = makeMasks(4, 4, { water: 0.8, ocean: 0 });
    const params: StyleParams = {
      ...defaultStyleParams,
      waterInfluence: 100,
      waterMode: "flatten",
      oceanInfluence: 0,
      lakeInfluence: 0,
      riverInfluence: 0,
    };
    const result = applyFeatureInfluence(10, 0.5, 0.5, masks, params);
    expect(Math.abs(result.displacement)).toBeLessThan(10);
  });

  it("ocean pixels with both ocean and water influence apply only the ocean influence", () => {
    // water = max(ocean, lake, river), so an ocean pixel is also a water pixel.
    const masks = makeMasks(4, 4, { ocean: 1, water: 1 });
    const params: StyleParams = {
      ...defaultStyleParams,
      oceanInfluence: 100,
      oceanMode: "amplify",
      waterInfluence: 100,
      waterMode: "amplify",
      lakeInfluence: 0,
      riverInfluence: 0,
    };
    const result = applyFeatureInfluence(10, 0.5, 0.5, masks, params);
    // One amplify at strength 1: 10 + 10 * 0.75 = 17.5.
    // Double application would compound to 30.625.
    expect(result.displacement).toBeCloseTo(17.5, 10);
  });

  it("water influence alone covers ocean pixels", () => {
    const masks = makeMasks(4, 4, { ocean: 1, water: 1 });
    const params: StyleParams = {
      ...defaultStyleParams,
      waterInfluence: 100,
      waterMode: "amplify",
      oceanInfluence: 0,
      lakeInfluence: 0,
      riverInfluence: 0,
    };
    const result = applyFeatureInfluence(10, 0.5, 0.5, masks, params);
    expect(result.displacement).toBeCloseTo(17.5, 10);
  });

  it("water influence still applies where the active per-type mask is absent", () => {
    // Ocean influence is set, but this pixel is lake-only: the combined
    // water influence must still cover it.
    const masks = makeMasks(4, 4, { lake: 1, water: 1 });
    const params: StyleParams = {
      ...defaultStyleParams,
      oceanInfluence: 100,
      oceanMode: "flatten",
      waterInfluence: 100,
      waterMode: "amplify",
      lakeInfluence: 0,
      riverInfluence: 0,
    };
    const result = applyFeatureInfluence(10, 0.5, 0.5, masks, params);
    expect(result.displacement).toBeCloseTo(17.5, 10);
  });

  it("zero influence on all types does not modify displacement", () => {
    const masks = makeMasks(4, 4, { ocean: 0.8, lake: 0.8, river: 0.8, water: 0.8 });
    const params: StyleParams = {
      ...defaultStyleParams,
      waterInfluence: 0,
      oceanInfluence: 0,
      lakeInfluence: 0,
      riverInfluence: 0,
    };
    const result = applyFeatureInfluence(10, 0.5, 0.5, masks, params);
    expect(result.displacement).toBe(10);
    expect(result.break_).toBe(false);
    expect(result.glow).toBe(false);
  });
});

describe("glow proportionality", () => {
  it("glow strength scales with influence", () => {
    const masks = makeMasks(4, 4, { road: 1 });
    const half = applyFeatureInfluence(10, 0.5, 0.5, masks, {
      ...defaultStyleParams,
      roadInfluence: 50,
      roadMode: "glow",
    });
    expect(half.glow).toBe(true);
    expect(half.glowStrength).toBeCloseTo(0.5, 10);
    const full = applyFeatureInfluence(10, 0.5, 0.5, masks, {
      ...defaultStyleParams,
      roadInfluence: 100,
      roadMode: "glow",
    });
    expect(full.glowStrength).toBeCloseTo(1, 10);
  });

  it("glow strength scales with mask coverage", () => {
    const masks = makeMasks(4, 4, { road: 0.4 });
    const result = applyFeatureInfluence(10, 0.5, 0.5, masks, {
      ...defaultStyleParams,
      roadInfluence: 100,
      roadMode: "glow",
    });
    expect(result.glowStrength).toBeCloseTo(0.4, 6);
  });

  it("applyInfluenceToLine emits accent runs only over glowing sub-segments", () => {
    // Building mask covering the right half of a 100x100 canvas.
    const maskW = 100, maskH = 100;
    const building = new Float32Array(maskW * maskH);
    for (let y = 0; y < maskH; y++) {
      for (let x = 50; x < maskW; x++) {
        building[y * maskW + x] = 1;
      }
    }
    const masks: FeatureMasks = {
      ...makeMasks(maskW, maskH, {}),
      building,
    };
    const points = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 50 }));
    const strokes = applyInfluenceToLine(points, 100, 100, masks, {
      ...defaultStyleParams,
      buildingInfluence: 60,
      buildingMode: "glow",
    }, 1, 1, "foreground");

    const base = strokes.filter((s) => !s.glow);
    const glows = strokes.filter((s) => s.glow);
    // The base stroke keeps its role and spans the full line.
    expect(base.length).toBe(1);
    expect(base[0].role).toBe("foreground");
    expect(base[0].points.length).toBe(100);
    // Exactly one accent run over the masked half, alpha scaled by strength.
    expect(glows.length).toBe(1);
    expect(glows[0].role).toBe("accent");
    expect(glows[0].points.every((p) => p.x >= 49)).toBe(true);
    expect(glows[0].points.length).toBeLessThan(60);
    expect(glows[0].opacity).toBeCloseTo(0.6, 10);
  });
});

describe("outline and invert modes", () => {
  it("outline glows at the mask boundary and leaves interior and displacement alone", () => {
    // Building mask filling the left half of a 20x20 mask.
    const maskW = 20, maskH = 20;
    const building = new Float32Array(maskW * maskH);
    for (let y = 0; y < maskH; y++) {
      for (let x = 0; x < 10; x++) {
        building[y * maskW + x] = 1;
      }
    }
    const masks: FeatureMasks = { ...makeMasks(maskW, maskH, {}), building };
    const params: StyleParams = {
      ...defaultStyleParams,
      buildingInfluence: 100,
      buildingMode: "outline",
    };

    const boundary = applyFeatureInfluence(10, 0.5, 0.5, masks, params);
    expect(boundary.glow).toBe(true);
    expect(boundary.glowStrength).toBeGreaterThan(0.5);
    expect(boundary.displacement).toBe(10);

    const interior = applyFeatureInfluence(10, 0.25, 0.5, masks, params);
    expect(interior.glow).toBe(false);
    expect(interior.displacement).toBe(10);

    const outside = applyFeatureInfluence(10, 0.9, 0.5, masks, params);
    expect(outside.glow).toBe(false);
    expect(outside.displacement).toBe(10);
  });

  it("invert negates displacement at full influence and interpolates below", () => {
    const masks = makeMasks(4, 4, { building: 1 });
    const full = applyFeatureInfluence(10, 0.5, 0.5, masks, {
      ...defaultStyleParams,
      buildingInfluence: 100,
      buildingMode: "invert",
    });
    expect(full.displacement).toBeCloseTo(-10, 10);
    const half = applyFeatureInfluence(10, 0.5, 0.5, masks, {
      ...defaultStyleParams,
      buildingInfluence: 50,
      buildingMode: "invert",
    });
    expect(half.displacement).toBeCloseTo(0, 10);
  });
});

describe("shared row loop", () => {
  it("waveform-terrain rows match the direct displacement formula", () => {
    // 2x2 grid with identical rows [0, 1]: normalized elevation(u, v) = u,
    // so with noise 0 each row is y = baseY - amplitude * (x / (width - 1)).
    const grid = {
      width: 2,
      height: 2,
      bounds: { west: 0, east: 1, north: 1, south: 0 },
      data: new Float32Array([0, 1, 0, 1]),
    };
    const input = {
      bounds: grid.bounds,
      elevationGrid: grid,
      width: 100,
      height: 100,
      seed: "rowloop",
    };
    const params = { ...defaultStyleParams, ...waveformTerrain.defaultParams, noise: 0 };
    const rows = generateRows(input, params);

    // rowStep = spacing / compression = 6 → baseY 0, 6, ..., 96 → 17 rows.
    expect(rows.length).toBe(17);
    for (const row of rows) {
      // No masks → a single unbroken segment sampled at every x (detail 1).
      expect(row.segments.length).toBe(1);
      expect(row.segments[0].length).toBe(100);
      for (const p of row.segments[0]) {
        expect(p.y).toBeCloseTo(row.baseY - params.amplitude * (p.x / 99), 6);
        expect(p.glow).toBe(false);
      }
    }
  });
});

describe("preset validation", () => {
  it("every preset references a registered style", () => {
    expect(() => validatePresetStyleIds()).not.toThrow();
  });

  it("throws for a preset with an unknown style id", () => {
    expect(() =>
      validatePresetStyleIds([
        { id: "bogus", name: "Bogus", styleId: "not-a-style", params: {} },
      ]),
    ).toThrow(/not-a-style/);
  });

  it("includes the Topo Signal preset on waveform-terrain", () => {
    const topo = presets.find((p) => p.id === "topo-signal");
    expect(topo).toBeDefined();
    expect(topo!.name).toBe("Topo Signal");
    expect(topo!.styleId).toBe("waveform-terrain");
  });
});

describe("transparent rendering", () => {
  const testInput = {
    bounds: { west: 0, east: 1, north: 1, south: 0 },
    elevationGrid: {
      width: 8,
      height: 8,
      bounds: { west: 0, east: 1, north: 1, south: 0 },
      data: new Float32Array(64).map((_, i) => (i % 8) / 7),
    },
    width: 100,
    height: 100,
    seed: "transparent-test",
  };

  it("SVG with transparent=true omits the background rect", () => {
    const svg = renderStyleSvg(waveformTerrain.id, testInput, { ...defaultStyleParams, ...waveformTerrain.defaultParams }, undefined, true);
    // Should NOT contain a standalone background <rect> (stroke fills are ok)
    expect(svg).not.toMatch(/<rect[^>]*fill="[^"]*"[^>]*\/>/);
    // Should still have paths
    expect(svg).toContain("<path");
  });

  it("SVG with transparent=false includes the background rect", () => {
    const svg = renderStyleSvg(waveformTerrain.id, testInput, { ...defaultStyleParams, ...waveformTerrain.defaultParams }, undefined, false);
    expect(svg).toMatch(/<rect[^>]*fill="[^"]*"[^>]*\/>/);
  });
});

describe("OSM retry", () => {
  it("fetchOsmFeatures retries on 504 and succeeds", async () => {
    let callCount = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response("Gateway Timeout", { status: 504 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ elements: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch);

    const cacheModule = await import("../data/cache.ts");
    const getOsmSpy = spyOn(cacheModule, "getOsm").mockResolvedValue(undefined);
    const setOsmSpy = spyOn(cacheModule, "setOsm").mockResolvedValue(undefined);

    try {
      const bounds = { west: 0, east: 0.001, north: 0.001, south: 0 };
      const result = await fetchOsmFeatures(bounds);
      expect(result.features.length).toBe(0);
      expect(callCount).toBe(2); // First failed, second succeeded
    } finally {
      fetchSpy.mockRestore();
      getOsmSpy.mockRestore();
      setOsmSpy.mockRestore();
    }
  });

  it("fetchOsmFeatures does not retry on non-retryable errors (400)", async () => {
    let callCount = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      callCount++;
      return Promise.resolve(new Response("Bad Request", { status: 400 }));
    }) as unknown as typeof fetch);

    const cacheModule = await import("../data/cache.ts");
    const getOsmSpy = spyOn(cacheModule, "getOsm").mockResolvedValue(undefined);
    const setOsmSpy = spyOn(cacheModule, "setOsm").mockResolvedValue(undefined);

    try {
      const bounds = { west: 0, east: 0.001, north: 0.001, south: 0 };
      await expect(fetchOsmFeatures(bounds)).rejects.toThrow();
      expect(callCount).toBe(1); // No retry
    } finally {
      fetchSpy.mockRestore();
      getOsmSpy.mockRestore();
      setOsmSpy.mockRestore();
    }
  });
});
