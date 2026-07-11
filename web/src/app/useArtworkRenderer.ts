import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { renderStyleCanvas } from "../studios/registry.ts";
import type {
  ArtworkInput,
  ElevationGrid,
  GeoFeatureCollection,
  Palette,
  StyleParams,
} from "../engine/types.ts";
import { getPreviewDimensions } from "./aspect.ts";
import { buildArtworkInput } from "./renderPipeline.ts";

const DEBOUNCE_MS = 150;

/**
 * Owns the preview canvas rendering: a memoized render input (so param
 * tweaks don't re-rasterize feature masks), an immediate render function for
 * the Generate flow, and the debounced live re-render on param changes.
 */
export function useArtworkRenderer({
  canvasRef,
  grid,
  features,
  params,
  styleId,
  allPalettes,
  suspended,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  grid: ElevationGrid | null;
  features?: GeoFeatureCollection;
  params: StyleParams;
  styleId: string;
  allPalettes: Record<string, Palette>;
  /** Pause the debounced preview (animation loop renders, or bounds are stale). */
  suspended: boolean;
}) {
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width, height } = getPreviewDimensions(params.aspectRatio);

  const previewInput = useMemo<ArtworkInput | null>(
    () => (grid ? buildArtworkInput({ grid, features, params, width, height }) : null),
    // params is only read for seed (masks depend on features + cropped bounds).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid, features, params.seed, width, height],
  );

  // Latest render state for the canvas-resize repaint, which must not retrigger
  // effects or change identity when params tweak.
  const latestRef = useRef({ previewInput, params, styleId, allPalettes });
  latestRef.current = { previewInput, params, styleId, allPalettes };

  /**
   * Repaints the current artwork after the canvas backing store was resized
   * (resizing clears the bitmap). Debouncing lives in the Artboard's resize
   * observer. Deliberately ignores `suspended`: while the animation loop runs
   * the next frame overwrites this paint anyway, and while bounds are stale
   * the preserved artwork must be restored rather than left blank.
   */
  const notifyCanvasResized = useCallback(() => {
    const latest = latestRef.current;
    if (!latest.previewInput) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    renderStyleCanvas(latest.styleId, ctx, latest.previewInput, latest.params, latest.allPalettes);
  }, [canvasRef]);

  /** Renders a given grid immediately (placeholder + fresh grid on Generate). */
  const renderArtwork = useCallback(
    (g: ElevationGrid, opts?: { skipMasks?: boolean }) => {
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      const input = buildArtworkInput({
        grid: g,
        features,
        params,
        width,
        height,
        skipMasks: opts?.skipMasks,
      });
      renderStyleCanvas(styleId, ctx, input, params, allPalettes);
    },
    [canvasRef, features, params, styleId, allPalettes, width, height],
  );

  // Debounced live preview when params/style/features change.
  useEffect(() => {
    if (!previewInput) return;
    if (suspended) return;
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = setTimeout(() => {
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      renderStyleCanvas(styleId, ctx, previewInput, params, allPalettes);
    }, DEBOUNCE_MS);
    return () => {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    };
  }, [previewInput, params, styleId, allPalettes, suspended, canvasRef]);

  return { previewInput, renderArtwork, notifyCanvasResized };
}
