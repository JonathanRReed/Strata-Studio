import { createNoise2D } from "simplex-noise";

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
