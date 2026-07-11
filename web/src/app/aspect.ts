import type { AspectRatio } from "../engine/types.ts";

/** Preview canvas long-side size in pixels. */
export const PREVIEW_SIZE = 512;

export const ASPECT_RATIOS: Record<AspectRatio, { w: number; h: number }> = {
  "square": { w: 1, h: 1 },
  "16:9": { w: 16, h: 9 },
  "9:16": { w: 9, h: 16 },
  "12:18": { w: 12, h: 18 },
};

/** Dimensions for the given aspect with the longest side equal to `size`. */
export function getExportDimensions(
  aspect: AspectRatio,
  size: number,
): { width: number; height: number } {
  const ratio = ASPECT_RATIOS[aspect];
  if (ratio.w === ratio.h) return { width: size, height: size };
  if (ratio.w > ratio.h) {
    return { width: size, height: Math.round((size * ratio.h) / ratio.w) };
  }
  return { width: Math.round((size * ratio.w) / ratio.h), height: size };
}

/** Preview dimensions: the longest side is PREVIEW_SIZE. */
export function getPreviewDimensions(aspect: AspectRatio): { width: number; height: number } {
  return getExportDimensions(aspect, PREVIEW_SIZE);
}
