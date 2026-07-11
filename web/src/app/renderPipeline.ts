import { buildFeatureMasks } from "../engine/maskRasterizer.ts";
import { cropGridToAspect } from "../engine/grid.ts";
import { createNoise } from "../engine/noise.ts";
import type {
  ArtworkInput,
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
  let masks: FeatureMasks | undefined;
  if (features && !skipMasks) {
    const { maskW, maskH } = getMaskDimensions(width, height);
    masks = buildFeatureMasks(features, croppedGrid.bounds, maskW, maskH);
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
  size: number,
  seed: string,
  bounds: GeoBounds,
): ElevationGrid {
  const noise = createNoise(seed, 4, 0.5);
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      const v = y / (size - 1);
      data[y * size + x] = noise(u * 4, v * 4) * 0.5 + 0.5;
    }
  }
  return { width: size, height: size, bounds, data };
}
