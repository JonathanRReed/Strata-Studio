import type { AspectRatio } from "../engine/types.ts";

/** Preview canvas long-side size in pixels. */
export const PREVIEW_SIZE = 512;

export type PixelDimensions = { width: number; height: number };
export type FrameRect = PixelDimensions & {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export const ASPECT_RATIOS: Record<AspectRatio, { w: number; h: number }> = {
  "square": { w: 1, h: 1 },
  "16:9": { w: 16, h: 9 },
  "9:16": { w: 9, h: 16 },
  "12:18": { w: 12, h: 18 },
};

/** Numeric width/height ratio used by the artboard, map frame, and exports. */
export function getAspectValue(aspect: AspectRatio): number {
  const ratio = ASPECT_RATIOS[aspect];
  return ratio.w / ratio.h;
}

/**
 * Floating-point dimensions contained inside a viewport. The map uses these
 * exact dimensions for both its visible frame and its geographic selection.
 */
export function getContainedFrameDimensions(
  containerWidth: number,
  containerHeight: number,
  aspect: AspectRatio,
  fill = 0.7,
): PixelDimensions {
  const ratio = getAspectValue(aspect);
  const maxWidth = Math.max(0, containerWidth * fill);
  const maxHeight = Math.max(0, containerHeight * fill);
  const width = Math.min(maxWidth, maxHeight * ratio);
  return { width, height: ratio > 0 ? width / ratio : 0 };
}

/** Pixel rectangle shared by the visible outline and MapLibre unprojection. */
export function getCenteredFrameRect(
  centerX: number,
  centerY: number,
  containerWidth: number,
  containerHeight: number,
  aspect: AspectRatio,
  fill = 0.7,
): FrameRect {
  const { width, height } = getContainedFrameDimensions(
    containerWidth,
    containerHeight,
    aspect,
    fill,
  );
  const left = centerX - width / 2;
  const top = centerY - height / 2;
  return {
    width,
    height,
    left,
    top,
    right: left + width,
    bottom: top + height,
  };
}

/** Dimensions for the given aspect with the longest side equal to `size`. */
export function getExportDimensions(
  aspect: AspectRatio,
  size: number,
): PixelDimensions {
  const ratio = ASPECT_RATIOS[aspect];
  if (ratio.w === ratio.h) return { width: size, height: size };
  if (ratio.w > ratio.h) {
    return { width: size, height: Math.round((size * ratio.h) / ratio.w) };
  }
  return { width: Math.round((size * ratio.w) / ratio.h), height: size };
}

/** Preview dimensions: the longest side is PREVIEW_SIZE. */
export function getPreviewDimensions(aspect: AspectRatio): PixelDimensions {
  return getExportDimensions(aspect, PREVIEW_SIZE);
}
