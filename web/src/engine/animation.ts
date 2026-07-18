/**
 * Animation engine for Strata Studio.
 *
 * Supports three animation styles:
 * - drift: Re-renders frames with a time-varying noise phase, creating organic drift
 * - draw: Stroke-dash reveal animation (lines draw themselves in, then loop)
 * - parallax: Depth-based layer separation with different scroll speeds
 *
 * The drift mode works by modifying params.phase before each frame render,
 * which styles can use to offset their noise sampling.
 *
 * The draw and parallax modes work as post-processing on the canvas after
 * a normal render, using stroke-dash and transform techniques.
 */

import type { StyleParams, AnimationMode } from "./types.ts";
import type { Scene, Stroke, ScenePoint } from "./scene.ts";

/** Number of frames in a single animation loop. */
export const DEFAULT_FRAMES = 24;
export const DEFAULT_FPS = 24;

/** Returns the phase value (0–1) for a given frame in the loop. */
export function framePhase(frame: number, totalFrames: number): number {
  if (totalFrames <= 0) return 0;
  return (frame / totalFrames) % 1;
}

/**
 * For drift animation: returns params with the phase set for this frame.
 * Styles that use createAnimatedNoise will pick up the phase automatically.
 * Styles that don't will render identically each frame (no drift).
 */
export function paramsForFrame(params: StyleParams, frame: number, totalFrames: number): StyleParams {
  return { ...params, phase: framePhase(frame, totalFrames) };
}

/**
 * For draw-in animation: returns a scene with stroke-dash progress applied.
 * Each stroke is progressively revealed based on the current frame.
 * Strokes are ordered by their position in the scene (top to bottom, then order).
 */
export function sceneWithDrawProgress(scene: Scene, progress: number): Scene {
  const strokes = scene.strokes;
  if (strokes.length === 0) return scene;

  // Each stroke gets a start time based on its index, and takes a fraction
  // of the total animation to draw. We stagger them so they draw sequentially
  // with slight overlap.
  const stagger = 0.7; // 70% of the animation is staggered draw, 30% is hold/loop
  const perStroke = stagger / strokes.length;

  const visibleStrokes: Stroke[] = [];
  for (let i = 0; i < strokes.length; i++) {
    const strokeStart = (i / strokes.length) * stagger;
    const strokeProgress = (progress - strokeStart) / perStroke;
    if (strokeProgress <= 0) continue;
    const clamped = Math.min(1, strokeProgress);
    if (clamped >= 1) {
      visibleStrokes.push(strokes[i]);
    } else {
      // Reveal a fraction of the stroke's points from the start
      const points = strokes[i].points;
      const visibleCount = Math.max(2, Math.ceil(points.length * clamped));
      const revealed: ScenePoint[] = points.slice(0, visibleCount);
      visibleStrokes.push({ ...strokes[i], points: revealed });
    }
  }
  return { strokes: visibleStrokes };
}

/**
 * For parallax animation: returns a scene with strokes offset by depth.
 * Strokes are grouped into depth layers based on their vertical position
 * (higher = farther back = slower movement). Each layer gets a different
 * horizontal/vertical offset based on the phase.
 */
export function sceneWithParallax(scene: Scene, phase: number, width: number, height: number): Scene {
  if (scene.strokes.length === 0) return scene;
  if (height <= 0) return scene;

  // Compute the vertical center of each stroke to determine its depth layer
  const strokes = scene.strokes.map((stroke) => {
    if (stroke.points.length === 0) return stroke;
    let avgY = 0;
    for (const p of stroke.points) avgY += p.y;
    avgY /= stroke.points.length;
    // Normalize depth: 0 = top (far), 1 = bottom (near)
    const depth = avgY / height;
    // Parallax offset: far layers move less, near layers move more
    // Use a sinusoidal motion for smooth looping
    const wave = Math.sin(phase * Math.PI * 2);
    const offsetX = wave * depth * width * 0.015;
    const offsetY = Math.cos(phase * Math.PI * 2) * depth * height * 0.01;
    return {
      ...stroke,
      points: stroke.points.map((p) => ({ x: p.x + offsetX, y: p.y + offsetY })),
    };
  });

  return { strokes };
}

/**
 * Applies the appropriate animation transform to a scene based on the mode.
 * For drift, this is a no-op (the phase is injected into params before generation).
 * For draw and parallax, this post-processes the scene.
 */
export function animateScene(
  scene: Scene,
  params: StyleParams,
  frame: number,
  totalFrames: number,
  width: number,
  height: number,
): Scene {
  if (totalFrames <= 0) return scene;
  const progress = framePhase(frame, totalFrames);
  switch (params.animationMode) {
    case "draw":
      return sceneWithDrawProgress(scene, progress);
    case "parallax":
      return sceneWithParallax(scene, progress, width, height);
    case "drift":
    case "none":
    default:
      return scene;
  }
}

/** Whether a given animation mode requires per-frame scene regeneration. */
export function needsRegeneration(mode: AnimationMode): boolean {
  return mode === "drift";
}

/** Whether a given animation mode uses post-processing on a static scene. */
export function needsPostProcess(mode: AnimationMode): boolean {
  return mode === "draw" || mode === "parallax";
}
