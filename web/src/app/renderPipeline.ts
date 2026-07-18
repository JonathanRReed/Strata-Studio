import { buildFeatureMasks } from "../engine/maskRasterizer.ts";
import { cropGridToAspect, normalizeGrid } from "../engine/grid.ts";
import { createNoise } from "../engine/noise.ts";
import type {
  ArtworkInput,
  ArtworkMeta,
  ElevationGrid,
  FeatureMasks,
  GeoBounds,
  GeoFeatureCollection,
  StyleParams,
} from "../engine/types.ts";

/** Feature masks are rasterized with this long-side size at any output resolution. */
export const MASK_SIZE = 512;

/** Mask raster dimensions matching the target aspect: the longest side is MASK_SIZE. */
export function getMaskDimensions(
  width: number,
  height: number,
): { maskW: number; maskH: number } {
  const maskW = width >= height ? MASK_SIZE : Math.round((MASK_SIZE * width) / height);
  const maskH = width >= height ? Math.round((MASK_SIZE * height) / width) : MASK_SIZE;
  return { maskW, maskH };
}

/** Coordinates + elevation range of the cropped grid, for the poster title block. */
export function buildArtworkMeta(grid: ElevationGrid): ArtworkMeta {
  const { min, max } = normalizeGrid(grid.data);
  return { bounds: grid.bounds, elevation: { min, max } };
}

/**
 * A zero-coverage 1×1 masks object that only carries ArtworkMeta. Used when
 * no OSM features are loaded so the renderer (which receives masks, not the
 * full ArtworkInput) still gets coordinates/elevation for the poster title
 * block. All-zero masks are influence no-ops, so rendering is unchanged.
 */
function metaOnlyMasks(meta: ArtworkMeta): FeatureMasks {
  const zero = new Float32Array(1);
  return {
    width: 1,
    height: 1,
    building: zero,
    road: zero,
    water: zero,
    ocean: zero,
    lake: zero,
    river: zero,
    meta,
  };
}

export type BuildArtworkInputOptions = {
  grid: ElevationGrid;
  features?: GeoFeatureCollection;
  params: StyleParams;
  width: number;
  height: number;
  /** Skip mask rasterization (the placeholder render passes features but no masks). */
  skipMasks?: boolean;
};

/**
 * The single place that turns raw state into a render input: crops the grid
 * to the target aspect and rasterizes feature masks aligned to the cropped
 * bounds. Preview, generate, and export all build their inputs here.
 */
export function buildArtworkInput({
  grid,
  features,
  params,
  width,
  height,
  skipMasks,
}: BuildArtworkInputOptions): ArtworkInput {
  const croppedGrid = cropGridToAspect(grid, width, height);
  const meta = buildArtworkMeta(croppedGrid);
  let masks: FeatureMasks;
  if (features && !skipMasks) {
    const { maskW, maskH } = getMaskDimensions(width, height);
    masks = { ...buildFeatureMasks(features, croppedGrid.bounds, maskW, maskH), meta };
  } else {
    masks = metaOnlyMasks(meta);
  }
  return {
    bounds: croppedGrid.bounds,
    elevationGrid: croppedGrid,
    features,
    masks,
    width,
    height,
    seed: params.seed,
  };
}

/** Seeded noise grid rendered as instant feedback while real terrain loads. */
export function createPlaceholderGrid(
  dimensions: number | { width: number; height: number },
  seed: string,
  bounds: GeoBounds,
): ElevationGrid {
  const width = typeof dimensions === "number" ? dimensions : dimensions.width;
  const height = typeof dimensions === "number" ? dimensions : dimensions.height;
  const noise = createNoise(seed, 4, 0.5);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1 || 1);
      const v = y / (height - 1 || 1);
      data[y * width + x] = noise(u * 4, v * 4) * 0.5 + 0.5;
    }
  }
  return { width, height, bounds, data };
}
