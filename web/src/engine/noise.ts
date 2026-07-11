import { createNoise2D, createNoise3D } from "simplex-noise";

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createSeededNoise(seed: string) {
  const rng = mulberry32(hashSeed(seed));
  return createNoise2D(rng);
}

export function createSeededNoise3D(seed: string) {
  const rng = mulberry32(hashSeed(seed));
  return createNoise3D(rng);
}

export function createNoise(seed: string, octaves: number, persistence = 0.5) {
  const base = createSeededNoise(seed);
  return function (x: number, y: number): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let max = 0;
    for (let i = 0; i < octaves; i++) {
      value += base(x * frequency, y * frequency) * amplitude;
      max += amplitude;
      amplitude *= persistence;
      frequency *= 2;
    }
    return value / max;
  };
}

/**
 * Distance (in base noise-space units) the sample point travels over one full
 * phase loop. The old implementation scrolled linearly by `phase * 10`, so the
 * loop circumference is kept at 10 to preserve the same visual drift speed.
 */
const DRIFT_LOOP_DISTANCE = 10;
const DRIFT_RADIUS = DRIFT_LOOP_DISTANCE / (2 * Math.PI);

/**
 * Creates a noise function that drifts over time by sampling 3D simplex noise
 * along a closed circle: offsets (R·cos(2πp), R·sin(2πp)) in the (y, z)
 * plane. Because the path is a closed loop, phase 1 is EXACTLY phase 0 — so
 * exported animations that wrap phase 0→1 loop without a seam, and the live
 * preview (which passes a continuous, non-wrapping phase) previews the exact
 * same loop, retracing the circle once per whole phase unit.
 * Phase defaults to 0, making this compatible with createNoise's 2-arg signature.
 */
export function createAnimatedNoise(seed: string, octaves: number, persistence = 0.5) {
  const base = createSeededNoise3D(seed);
  return function (x: number, y: number, phase = 0): number {
    // Wrap into [0, 1) so integer phases map to bit-identical sample points.
    const p = phase - Math.floor(phase);
    const angle = p * Math.PI * 2;
    const yOff = DRIFT_RADIUS * Math.cos(angle);
    const zOff = DRIFT_RADIUS * Math.sin(angle);
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let max = 0;
    for (let i = 0; i < octaves; i++) {
      value += base(x * frequency, (y + yOff) * frequency, zOff * frequency) * amplitude;
      max += amplitude;
      amplitude *= persistence;
      frequency *= 2;
    }
    return value / max;
  };
}
