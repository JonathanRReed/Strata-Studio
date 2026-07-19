import { describe, it, expect } from "bun:test";
import { buildArtworkInput, createPlaceholderGrid, getMaskDimensions, MASK_SIZE } from "./renderPipeline.ts";
import {
  ASPECT_RATIOS,
  getCenteredFrameRect,
  getContainedFrameDimensions,
  getExportDimensions,
  getPreviewDimensions,
  PREVIEW_SIZE,
} from "./aspect.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import type { ElevationGrid, GeoBounds } from "../engine/types.ts";

const BOUNDS: GeoBounds = { west: -122.5, south: 37.7, east: -122.35, north: 37.85 };

function makeGrid(size: number): ElevationGrid {
  const data = new Float32Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = i % 97;
  return { width: size, height: size, bounds: BOUNDS, data };
}

describe("aspect dimensions", () => {
  it("keeps square at full size", () => {
    expect(getPreviewDimensions("square")).toEqual({ width: PREVIEW_SIZE, height: PREVIEW_SIZE });
    expect(getExportDimensions("square", 2048)).toEqual({ width: 2048, height: 2048 });
  });

  it("scales landscape and portrait against the long side", () => {
    expect(getPreviewDimensions("16:9")).toEqual({ width: 512, height: 288 });
    expect(getPreviewDimensions("9:16")).toEqual({ width: 288, height: 512 });
    expect(getExportDimensions("12:18", 3000)).toEqual({ width: 2000, height: 3000 });
  });

  it("covers every aspect ratio", () => {
    for (const aspect of Object.keys(ASPECT_RATIOS) as (keyof typeof ASPECT_RATIOS)[]) {
      const { width, height } = getPreviewDimensions(aspect);
      expect(Math.max(width, height)).toBe(PREVIEW_SIZE);
    }
  });

  it("uses the same centered rectangle for the visible frame and bounds sampling", () => {
    const dimensions = getContainedFrameDimensions(240, 240, "16:9");
    const rect = getCenteredFrameRect(120, 120, 240, 240, "16:9");
    expect(dimensions).toEqual({ width: 168, height: 94.5 });
    expect(rect).toEqual({
      width: 168,
      height: 94.5,
      left: 36,
      right: 204,
      top: 72.75,
      bottom: 167.25,
    });
  });
});

describe("getMaskDimensions", () => {
  it("matches the target aspect with MASK_SIZE on the long side", () => {
    expect(getMaskDimensions(512, 512)).toEqual({ maskW: MASK_SIZE, maskH: MASK_SIZE });
    expect(getMaskDimensions(512, 288)).toEqual({ maskW: 512, maskH: 288 });
    expect(getMaskDimensions(288, 512)).toEqual({ maskW: 288, maskH: 512 });
    expect(getMaskDimensions(2000, 3000)).toEqual({ maskW: 341, maskH: 512 });
  });
});

describe("buildArtworkInput", () => {
  const params = { ...defaultStyleParams, seed: "test-seed" };

  it("passes a square grid through uncropped", () => {
    const grid = makeGrid(64);
    const input = buildArtworkInput({ grid, params, width: 512, height: 512 });
    expect(input.elevationGrid).toBe(grid);
    expect(input.bounds).toEqual(BOUNDS);
    expect(input.width).toBe(512);
    expect(input.height).toBe(512);
    expect(input.seed).toBe("test-seed");
    // No features: a 1×1 zero-mask carrier exists purely to deliver meta.
    expect(input.masks).toBeDefined();
    expect(input.masks!.width).toBe(1);
    expect(input.masks!.height).toBe(1);
    expect(Array.from(input.masks!.building)).toEqual([0]);
    expect(Array.from(input.masks!.water)).toEqual([0]);
  });

  it("attaches ArtworkMeta (bounds + elevation range) for the poster title block", () => {
    const grid = makeGrid(64); // data = i % 97 → elevation range [0, 96]
    const input = buildArtworkInput({ grid, params, width: 512, height: 512 });
    expect(input.masks!.meta).toEqual({
      bounds: BOUNDS,
      elevation: { min: 0, max: 96 },
    });
  });

  it("computes meta from the CROPPED grid so coordinates match the artwork", () => {
    const grid = makeGrid(64);
    const input = buildArtworkInput({ grid, params, width: 512, height: 288 });
    expect(input.masks!.meta!.bounds).toEqual(input.bounds);
    expect(input.masks!.meta!.bounds.north).toBeLessThan(BOUNDS.north);
  });


  it("crops the grid and bounds to the target aspect", () => {
    const grid = makeGrid(64);
    const input = buildArtworkInput({ grid, params, width: 512, height: 288 });
    expect(input.elevationGrid.width).toBe(64);
    expect(input.elevationGrid.height).toBe(36);
    // Cropped vertically: full lng range, reduced lat range
    expect(input.bounds.west).toBe(BOUNDS.west);
    expect(input.bounds.east).toBe(BOUNDS.east);
    expect(input.bounds.north).toBeLessThan(BOUNDS.north);
    expect(input.bounds.south).toBeGreaterThan(BOUNDS.south);
    expect(input.bounds).toEqual(input.elevationGrid.bounds);
  });

  it("does not center-crop new rectangular terrain inputs a second time", () => {
    const grid: ElevationGrid = {
      width: 64,
      height: 36,
      bounds: BOUNDS,
      data: new Float32Array(64 * 36),
    };
    const input = buildArtworkInput({ grid, params, width: 512, height: 288 });
    expect(input.elevationGrid).toBe(grid);
    expect(input.bounds).toBe(BOUNDS);
    expect(input.masks!.meta!.bounds).toBe(BOUNDS);
  });

  it("skips mask rasterization when skipMasks is set (meta-only carrier)", () => {
    const grid = makeGrid(16);
    const features = { type: "FeatureCollection" as const, features: [] };
    const input = buildArtworkInput({ grid, features, params, width: 512, height: 512, skipMasks: true });
    expect(input.masks!.width).toBe(1);
    expect(input.masks!.height).toBe(1);
    expect(input.masks!.meta).toBeDefined();
    expect(input.features).toBe(features);
  });
});

describe("createPlaceholderGrid", () => {
  it("supports rectangular preview dimensions", () => {
    const grid = createPlaceholderGrid({ width: 32, height: 18 }, "wide", BOUNDS);
    expect(grid.width).toBe(32);
    expect(grid.height).toBe(18);
    expect(grid.data).toHaveLength(32 * 18);
    expect(grid.bounds).toBe(BOUNDS);
  });

  it("is deterministic for a given seed and stays in [0, 1]", () => {
    const a = createPlaceholderGrid(32, "seed-a", BOUNDS);
    const b = createPlaceholderGrid(32, "seed-a", BOUNDS);
    const c = createPlaceholderGrid(32, "seed-b", BOUNDS);
    expect(a.data).toEqual(b.data);
    expect(a.data).not.toEqual(c.data);
    expect(a.width).toBe(32);
    expect(a.height).toBe(32);
    expect(a.bounds).toEqual(BOUNDS);
    for (const v of a.data) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
