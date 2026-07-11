import { useEffect, useMemo, useRef, type RefObject } from "react";
import { getStyle, renderStyleCanvas } from "../studios/registry.ts";
import { renderSceneCanvas } from "../engine/scene.ts";
import { animateScene, DEFAULT_FRAMES, needsRegeneration } from "../engine/animation.ts";
import { defaultPalette } from "../presets/palettes.ts";
import type { ArtworkInput, Palette, StyleParams } from "../engine/types.ts";

/**
 * Params that restart the animation loop when they change. animationSpeed is
 * read live from a ref (no restart) and phase is driven by the loop itself.
 * The exhaustive Record type forces a decision here whenever a field is
 * added to StyleParams.
 */
const ANIM_RESTART_KEY_MAP: Record<Exclude<keyof StyleParams, "animationSpeed" | "phase">, true> = {
  amplitude: true,
  spacing: true,
  lineWidth: true,
  noise: true,
  detail: true,
  compression: true,
  seed: true,
  palette: true,
  buildingInfluence: true,
  roadInfluence: true,
  waterInfluence: true,
  oceanInfluence: true,
  lakeInfluence: true,
  riverInfluence: true,
  buildingMode: true,
  roadMode: true,
  waterMode: true,
  oceanMode: true,
  lakeMode: true,
  riverMode: true,
  grain: true,
  rotation: true,
  label: true,
  labelStyle: true,
  aspectRatio: true,
  occlusion: true,
  animationMode: true,
  transparent: true,
};
const ANIM_RESTART_KEYS = Object.keys(ANIM_RESTART_KEY_MAP) as (keyof StyleParams)[];

/** requestAnimationFrame preview loop for animated styles. */
export function useAnimationLoop({
  canvasRef,
  isAnimating,
  input,
  params,
  styleId,
  allPalettes,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  isAnimating: boolean;
  input: ArtworkInput | null;
  params: StyleParams;
  styleId: string;
  allPalettes: Record<string, Palette>;
}) {
  const animFrameRef = useRef<number>(0);
  const animStartRef = useRef<number>(0);
  const animSceneRef = useRef<import("../engine/scene.ts").Scene | null>(null);
  // Latest params so the loop reads animationSpeed without restarting.
  const animParamsRef = useRef(params);
  animParamsRef.current = params;

  // Restart signature over exactly the params that should restart the loop,
  // memoized per field — the old code JSON.stringified the whole params
  // object on every render, so animationSpeed tweaks rebuilt the key too.
  const animRestartKey = useMemo(
    () => ANIM_RESTART_KEYS.map((key) => `${key}=${String(params[key])}`).join("|"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ANIM_RESTART_KEYS.map((key) => params[key]),
  );

  useEffect(() => {
    if (!isAnimating || !input) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = input;
    const style = getStyle(styleId);
    const palette = allPalettes[params.palette] ?? allPalettes[defaultPalette];

    // For non-regeneration modes, generate the scene once.
    if (!needsRegeneration(params.animationMode)) {
      animSceneRef.current = style.generate(input, { ...params, phase: 0 });
    } else {
      animSceneRef.current = null;
    }

    animStartRef.current = performance.now();
    const totalFrames = DEFAULT_FRAMES;

    const loop = (now: number) => {
      const currentParams = animParamsRef.current;
      const elapsed = now - animStartRef.current;
      const loopDurationMs = (1 / currentParams.animationSpeed) * 1000;
      // Use continuous phase (not wrapping) for drift to avoid noise discontinuity.
      // For draw/parallax, wrap to [0,1) for frame indexing.
      const rawPhase = elapsed / loopDurationMs;
      const phase = needsRegeneration(currentParams.animationMode)
        ? rawPhase // continuous — noise field scrolls seamlessly
        : rawPhase % 1;
      const frame = Math.floor((rawPhase % 1) * totalFrames);

      if (needsRegeneration(currentParams.animationMode)) {
        // Drift: regenerate with continuous phase
        const animParams = { ...currentParams, phase };
        renderStyleCanvas(styleId, ctx, input, animParams, allPalettes);
      } else {
        // Draw-in / parallax: post-process the static scene
        const scene = animateScene(animSceneRef.current!, currentParams, frame, totalFrames, width, height);
        renderSceneCanvas(ctx, scene, currentParams, palette, width, height, false, input.masks);
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };
    animFrameRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnimating, input, styleId, allPalettes, animRestartKey, canvasRef]);
}
