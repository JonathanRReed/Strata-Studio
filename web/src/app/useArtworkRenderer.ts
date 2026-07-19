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
import { useRevealAnimation } from "./useRevealAnimation.ts";

const DEBOUNCE_MS = 150;

/**
 * Owns the preview canvas rendering: a memoized render input (so param
 * tweaks don't re-rasterize feature masks), an immediate render function for
 * the Generate flow (optionally with the draw-in reveal for fresh terrain),
 * and the debounced live re-render on param changes.
 */
export function useArtworkRenderer({
  canvasRef,
  grid,
  features,
  params,
  styleId,
  allPalettes,
  suspended,
  isAnimating,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  grid: ElevationGrid | null;
  features?: GeoFeatureCollection;
  params: StyleParams;
  styleId: string;
  allPalettes: Record<string, Palette>;
  /** Pause the debounced preview (animation loop renders, or bounds are stale). */
  suspended: boolean;
  /** The looping animation owns the canvas; the reveal must never fight it. */
  isAnimating: boolean;
}) {
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width, height } = getPreviewDimensions(params.aspectRatio);

  const { playReveal, cancelReveal, isRevealing, arbitrateRepaint, latestParamsRef } =
    useRevealAnimation({ canvasRef, isAnimating });
  // Keep the reveal's closing frame current (label auto-fill mid-reveal).
  latestParamsRef.current = params;
  const immediateInputRef = useRef<{
    grid: ElevationGrid;
    features: GeoFeatureCollection | undefined;
    seed: string;
    width: number;
    height: number;
    input: ArtworkInput;
  } | null>(null);

  const previewInput = useMemo<ArtworkInput | null>(() => {
    if (!grid) return null;
    const immediate = immediateInputRef.current;
    if (
      immediate &&
      immediate.grid === grid &&
      immediate.features === features &&
      immediate.seed === params.seed &&
      immediate.width === width &&
      immediate.height === height
    ) {
      return immediate.input;
    }
    return buildArtworkInput({ grid, features, params, width, height });
    // params is only read for seed (masks depend on features + cropped bounds).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, features, params.seed, width, height]);

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
    // A running reveal repaints the (resized) canvas on its next frame.
    if (isRevealing()) return;
    const latest = latestRef.current;
    if (!latest.previewInput) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    renderStyleCanvas(latest.styleId, ctx, latest.previewInput, latest.params, latest.allPalettes);
  }, [canvasRef, isRevealing]);

  /**
   * Renders a given grid immediately (placeholder + fresh grid on Generate).
   * With `reveal`, fresh terrain plays the one-shot draw-in reveal instead of
   * an instant paint; when the reveal declines (reduced motion, animation
   * loop running) the paint is instant as before. Any instant render cancels
   * a running reveal, so a second generate's placeholder wipes it cleanly.
   */
  const renderArtwork = useCallback(
    async (g: ElevationGrid, opts?: { skipMasks?: boolean; reveal?: boolean }) => {
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
      if (!opts?.skipMasks) {
        immediateInputRef.current = {
          grid: g,
          features,
          seed: params.seed,
          width,
          height,
          input,
        };
      }
      if (
        opts?.reveal &&
        (await playReveal(input, { grid: g, features, params, styleId, allPalettes }))
      ) {
        return;
      }
      cancelReveal();
      renderStyleCanvas(styleId, ctx, input, params, allPalettes);
    },
    [canvasRef, features, params, styleId, allPalettes, width, height, playReveal, cancelReveal],
  );

  // Debounced live preview when params/style/features change.
  useEffect(() => {
    if (!previewInput) return;
    if (suspended) return;
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = setTimeout(() => {
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      const paintLatest = () => {
        const latest = latestRef.current;
        const latestCtx = canvasRef.current?.getContext("2d");
        if (!latest.previewInput || !latestCtx) return;
        renderStyleCanvas(
          latest.styleId,
          latestCtx,
          latest.previewInput,
          latest.params,
          latest.allPalettes,
        );
      };
      // Reveal arbitration (see useRevealAnimation): the generate's own state
      // echo skips this repaint, the same generate's features arrival defers
      // it to the reveal's closing frame, and any real user change cancels
      // the reveal so this paints instantly, as before.
      if (grid) {
        const verdict = arbitrateRepaint({ grid, features, params, styleId, allPalettes }, paintLatest);
        if (verdict === "skip") return;
      }
      renderStyleCanvas(styleId, ctx, previewInput, params, allPalettes);
    }, DEBOUNCE_MS);
    return () => {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    };
  }, [
    previewInput,
    grid,
    features,
    params,
    styleId,
    allPalettes,
    suspended,
    canvasRef,
    arbitrateRepaint,
  ]);

  return { previewInput, renderArtwork, notifyCanvasResized };
}
