import { describe, it, expect } from "bun:test";
import {
  lngToPixelX,
  latToPixelY,
  pixelXToLng,
  pixelYToLat,
  normalizeBounds,
} from "./projection.ts";
import { hashSeed, createSeededNoise, createNoise } from "./noise.ts";
import {
  buildOverpassQuery,
  classifyFeature,
  overpassToGeoJSON,
  bboxAreaKm2,
  isBboxSmallEnough,
} from "../data/osmOverpass.ts";
import { sampleGrid, clamp, normalizeGrid, projectGeoPoint, cropGridToAspect } from "./grid.ts";
import {
  waveformTerrain,
  generateRows,
} from "../studios/experimental/waveformTerrain.ts";
import { allStyles, stylesByStudio, renderStyleSvg } from "../studios/registry.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import { marchingSquares } from "./contours.ts";

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
