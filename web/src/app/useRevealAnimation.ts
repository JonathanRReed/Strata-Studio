import { useCallback, useEffect, useRef, type RefObject } from "react";
import { getStyle } from "../studios/registry.ts";
import { renderSceneCanvas } from "../engine/scene.ts";
import { sceneWithDrawProgress } from "../engine/animation.ts";
import { defaultPalette } from "../presets/palettes.ts";
import type {
  ArtworkInput,
  ElevationGrid,
  GeoFeatureCollection,
  Palette,
  StyleParams,
} from "../engine/types.ts";

/** Total duration of the one-shot draw-in reveal. */
export const REVEAL_DURATION_MS = 1400;

/**
 * Per-frame cap on how much reveal time one frame may consume. A generate
 * settle queues heavy synchronous work (feature-mask rasterization, thumbnail
 * refresh) that can stall the main thread mid-reveal; clamping the frame
 * delta makes the stall pause the reveal instead of swallowing it. At 30fps+
 * the clamp never engages, so the duration stays ~REVEAL_DURATION_MS.
 */
export const MAX_FRAME_STEP_MS = 50;

/**
 * sceneWithDrawProgress finishes every stroke at progress 0.7 (the remaining
 * 0.3 of a looping draw animation is the hold), so the one-shot reveal maps
 * its eased time onto [0, 0.7] and the drawing completes exactly at the end.
 */
export const DRAW_COMPLETE_PROGRESS = 0.7;

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Eased draw progress for an elapsed reveal time, clamped to the draw window. */
export function revealProgress(elapsedMs: number, durationMs = REVEAL_DURATION_MS): number {
  if (durationMs <= 0) return DRAW_COMPLETE_PROGRESS;
  const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
  return easeOutCubic(t) * DRAW_COMPLETE_PROGRESS;
}

/**
 * Whether a fresh-terrain render should play the reveal at all: never under
 * prefers-reduced-motion (instant paint, as before) and never while the
 * looping animation owns the canvas.
 */
export function shouldReveal(opts: {
  prefersReducedMotion: boolean;
  isAnimating: boolean;
}): boolean {
  return !opts.prefersReducedMotion && !opts.isAnimating;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Params equality ignoring the given keys. */
export function paramsEqualExcept(
  a: StyleParams,
  b: StyleParams,
  ignore: ReadonlySet<keyof StyleParams>,
): boolean {
  if (a === b) return true;
  for (const key of Object.keys(a) as (keyof StyleParams)[]) {
    if (ignore.has(key)) continue;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

const LABEL_ONLY: ReadonlySet<keyof StyleParams> = new Set(["label"]);

/**
 * Params equality ignoring `label`. The auto-label flow may resolve a place
 * name while a reveal is playing; a label is painted by renderSceneCanvas
 * from params (never baked into the scene), so a label-only change must not
 * cancel the reveal — the closing frame renders it instead.
 */
export function paramsEqualExceptLabel(a: StyleParams, b: StyleParams): boolean {
  return paramsEqualExcept(a, b, LABEL_ONLY);
}

/**
 * Param keys the one-time influence bump writes when OSM features first
 * arrive (see autopilot.ts). A features arrival plus its bump is the SAME
 * generate still settling — it enhances the artwork rather than replacing
 * it, so it defers to the reveal instead of cancelling it.
 */
const ENHANCE_TOLERATED: ReadonlySet<keyof StyleParams> = new Set([
  "label",
  "buildingInfluence",
  "roadInfluence",
  "waterInfluence",
  "oceanInfluence",
  "lakeInfluence",
  "riverInfluence",
  "buildingMode",
  "roadMode",
  "waterMode",
  "oceanMode",
  "lakeMode",
  "riverMode",
]);

/** Everything a reveal was started from, for echo detection (see below). */
export type RevealSource = {
  grid: ElevationGrid;
  features: GeoFeatureCollection | undefined;
  params: StyleParams;
  styleId: string;
  allPalettes: Record<string, Palette>;
};

type RevealState = {
  raf: number;
  source: RevealSource;
  /** Replaces the default closing frame (features arrived mid-reveal). */
  followUp: (() => void) | null;
};

/** What the debounced preview should do while a reveal may be running. */
export type RevealArbitration = "skip" | "paint";

/**
 * One-shot stroke-by-stroke reveal for fresh terrain renders, built on the
 * existing draw-mode machinery (sceneWithDrawProgress + renderSceneCanvas).
 *
 * - Skips entirely under prefers-reduced-motion or while the looping
 *   animation runs (playReveal returns false → caller paints instantly).
 * - A new playReveal / cancelReveal call cancels the running reveal cleanly.
 * - The closing frame re-renders the full scene with the latest label (via
 *   latestParamsRef) so an auto-filled place name lands without a restart.
 */
export function useRevealAnimation({
  canvasRef,
  isAnimating,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  isAnimating: boolean;
}) {
  const stateRef = useRef<RevealState | null>(null);
  /** Kept current by the consumer each render; read on the closing frame. */
  const latestParamsRef = useRef<StyleParams | null>(null);

  const cancelReveal = useCallback(() => {
    if (!stateRef.current) return;
    cancelAnimationFrame(stateRef.current.raf);
    stateRef.current = null;
  }, []);

  // The looping animation owns the canvas — stop any reveal when it starts.
  useEffect(() => {
    if (isAnimating) cancelReveal();
  }, [isAnimating, cancelReveal]);
  useEffect(() => cancelReveal, [cancelReveal]);

  const isRevealing = useCallback(() => stateRef.current !== null, []);

  /**
   * Decides what the debounced preview repaint should do while a reveal may
   * be running:
   *
   * - No reveal → "paint" (normal instant behavior).
   * - Echo: the generate flow renders the fresh grid immediately AND commits
   *   it to state, so the debounce re-fires ~150ms later with identical
   *   inputs (label aside) → "skip"; the reveal finishes with the same pixels.
   * - Enhance: the same generate's OSM features arrive mid-reveal (with their
   *   one-time influence bump) → "skip", but register `paintLatest` as the
   *   reveal's closing frame so the enhanced artwork lands when it ends.
   * - Anything else (slider tweak, style/palette/aspect switch, new grid) is
   *   a real user change → cancel the reveal and "paint" instantly, as now.
   */
  const arbitrateRepaint = useCallback(
    (s: RevealSource, paintLatest: () => void): RevealArbitration => {
      const current = stateRef.current;
      if (!current) return "paint";
      const src = current.source;
      const sameComposition =
        src.grid === s.grid && src.styleId === s.styleId && src.allPalettes === s.allPalettes;
      if (sameComposition && src.features === s.features && paramsEqualExceptLabel(src.params, s.params)) {
        return "skip";
      }
      if (
        sameComposition &&
        src.features !== s.features &&
        paramsEqualExcept(src.params, s.params, ENHANCE_TOLERATED)
      ) {
        current.followUp = paintLatest;
        return "skip";
      }
      cancelReveal();
      return "paint";
    },
    [cancelReveal],
  );

  /**
   * Starts the reveal for a fresh render input. Returns false (after
   * cancelling any running reveal) when the reveal should not play — the
   * caller then paints instantly, exactly as before this feature.
   */
  const playReveal = useCallback(
    (input: ArtworkInput, source: RevealSource): boolean => {
      cancelReveal();
      if (!shouldReveal({ prefersReducedMotion: prefersReducedMotion(), isAnimating })) {
        return false;
      }
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return false;
      const { params, styleId, allPalettes } = source;
      const scene = getStyle(styleId).generate(input, { ...params, phase: 0 });
      if (scene.strokes.length === 0) return false;
      const palette = allPalettes[params.palette] ?? allPalettes[defaultPalette];

      const state: RevealState = { raf: 0, source, followUp: null };
      stateRef.current = state;
      // Reveal time accumulates in clamped frame deltas (see MAX_FRAME_STEP_MS)
      // rather than wall-clock, so main-thread stalls pause the reveal instead
      // of ending it; the clock also starts at the FIRST frame, not play time.
      let elapsed = 0;
      let lastFrameAt = 0;

      const frame = (now: number) => {
        if (stateRef.current !== state) return; // cancelled or superseded
        if (lastFrameAt !== 0) {
          elapsed += Math.min(now - lastFrameAt, MAX_FRAME_STEP_MS);
        }
        lastFrameAt = now;
        if (elapsed >= REVEAL_DURATION_MS) {
          stateRef.current = null;
          if (state.followUp) {
            // Features arrived while revealing: close on the enhanced render.
            state.followUp();
            return;
          }
          const latest = latestParamsRef.current;
          const finalParams =
            latest && paramsEqualExceptLabel(latest, params) ? latest : params;
          renderSceneCanvas(
            ctx,
            scene,
            finalParams,
            palette,
            input.width,
            input.height,
            false,
            input.masks,
          );
          return;
        }
        const partial = sceneWithDrawProgress(scene, revealProgress(elapsed));
        renderSceneCanvas(
          ctx,
          partial,
          params,
          palette,
          input.width,
          input.height,
          false,
          input.masks,
        );
        state.raf = requestAnimationFrame(frame);
      };
      state.raf = requestAnimationFrame(frame);
      return true;
    },
    [canvasRef, cancelReveal, isAnimating],
  );

  return { playReveal, cancelReveal, isRevealing, arbitrateRepaint, latestParamsRef };
}
