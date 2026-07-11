/**
 * Draw-in reveal (pure parts): the reduced-motion / animation-loop skip
 * decision, the eased progress mapping onto sceneWithDrawProgress's draw
 * window, and the label-agnostic params comparison that lets an auto-filled
 * place name land mid-reveal without cancelling it.
 */

import { describe, expect, it } from "bun:test";
import {
  DRAW_COMPLETE_PROGRESS,
  easeOutCubic,
  paramsEqualExcept,
  paramsEqualExceptLabel,
  REVEAL_DURATION_MS,
  revealProgress,
  shouldReveal,
} from "./useRevealAnimation.ts";
import { sceneWithDrawProgress } from "../engine/animation.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import type { Scene } from "../engine/scene.ts";

describe("shouldReveal", () => {
  it("skips entirely under prefers-reduced-motion", () => {
    expect(shouldReveal({ prefersReducedMotion: true, isAnimating: false })).toBe(false);
  });

  it("never fights the looping animation", () => {
    expect(shouldReveal({ prefersReducedMotion: false, isAnimating: true })).toBe(false);
    expect(shouldReveal({ prefersReducedMotion: true, isAnimating: true })).toBe(false);
  });

  it("plays for a plain fresh render", () => {
    expect(shouldReveal({ prefersReducedMotion: false, isAnimating: false })).toBe(true);
  });
});

describe("revealProgress", () => {
  it("starts at 0 and clamps negative elapsed", () => {
    expect(revealProgress(0)).toBe(0);
    expect(revealProgress(-100)).toBe(0);
  });

  it("reaches the full draw window exactly at the duration (and clamps past it)", () => {
    expect(revealProgress(REVEAL_DURATION_MS)).toBeCloseTo(DRAW_COMPLETE_PROGRESS, 10);
    expect(revealProgress(REVEAL_DURATION_MS * 3)).toBeCloseTo(DRAW_COMPLETE_PROGRESS, 10);
  });

  it("is monotonically non-decreasing", () => {
    let prev = -1;
    for (let t = 0; t <= REVEAL_DURATION_MS; t += 50) {
      const p = revealProgress(t);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("eases out: front-loaded relative to linear", () => {
    const halfway = revealProgress(REVEAL_DURATION_MS / 2);
    expect(halfway).toBeGreaterThan(DRAW_COMPLETE_PROGRESS / 2);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 10);
  });

  it("completes every stroke at the end of the reveal", () => {
    const scene: Scene = {
      strokes: [
        { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] },
        { points: [{ x: 4, y: 4 }, { x: 5, y: 5 }, { x: 6, y: 6 }, { x: 7, y: 7 }] },
      ] as Scene["strokes"],
    };
    const final = sceneWithDrawProgress(scene, revealProgress(REVEAL_DURATION_MS));
    expect(final.strokes.length).toBe(scene.strokes.length);
    for (let i = 0; i < scene.strokes.length; i++) {
      expect(final.strokes[i].points.length).toBe(scene.strokes[i].points.length);
    }
    // …and starts with almost nothing.
    const opening = sceneWithDrawProgress(scene, revealProgress(1));
    const openingPoints = opening.strokes.reduce((sum, s) => sum + s.points.length, 0);
    const finalPoints = final.strokes.reduce((sum, s) => sum + s.points.length, 0);
    expect(openingPoints).toBeLessThan(finalPoints);
  });
});

describe("paramsEqualExceptLabel", () => {
  it("matches identical params and label-only differences", () => {
    const a = { ...defaultStyleParams };
    expect(paramsEqualExceptLabel(a, a)).toBe(true);
    expect(paramsEqualExceptLabel(a, { ...a })).toBe(true);
    expect(paramsEqualExceptLabel(a, { ...a, label: "Amsterdam" })).toBe(true);
  });

  it("rejects any non-label difference (a slider tweak must cancel the reveal)", () => {
    const a = { ...defaultStyleParams };
    expect(paramsEqualExceptLabel(a, { ...a, amplitude: a.amplitude + 1 })).toBe(false);
    expect(paramsEqualExceptLabel(a, { ...a, seed: "other" })).toBe(false);
    expect(paramsEqualExceptLabel(a, { ...a, palette: "neon" })).toBe(false);
    expect(paramsEqualExceptLabel(a, { ...a, label: "x", spacing: a.spacing + 1 })).toBe(false);
  });
});

describe("paramsEqualExcept", () => {
  it("tolerates exactly the ignored keys (influence-bump defers, sliders cancel)", () => {
    const a = { ...defaultStyleParams };
    const bumpKeys = new Set<keyof typeof a>(["label", "buildingInfluence", "buildingMode"]);
    const bumped = { ...a, buildingInfluence: 45, buildingMode: "interrupt" as const };
    expect(paramsEqualExcept(a, bumped, bumpKeys)).toBe(true);
    expect(paramsEqualExcept(a, { ...bumped, amplitude: a.amplitude + 5 }, bumpKeys)).toBe(false);
    expect(paramsEqualExcept(a, a, new Set())).toBe(true);
  });
});
