/**
 * Variations seed dealing: distinctness, exclusion of the current seed, and
 * the seed alphabet — the pure logic behind the 2×2 variations overlay.
 */

import { describe, expect, it } from "bun:test";
import { dealSeeds, randomSeed, VARIATION_COUNT } from "./variations.ts";

/** Deterministic LCG so dealing is reproducible in tests. */
function makeRng(seed = 42): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("randomSeed", () => {
  it("produces 6-char lowercase base36 seeds", () => {
    const rng = makeRng();
    for (let i = 0; i < 50; i++) {
      expect(randomSeed(rng)).toMatch(/^[0-9a-z]{6}$/);
    }
  });

  it("is deterministic for a deterministic rng", () => {
    expect(randomSeed(makeRng(7))).toBe(randomSeed(makeRng(7)));
  });
});

describe("dealSeeds", () => {
  it("deals the default hand of four distinct seeds", () => {
    const seeds = dealSeeds(undefined, undefined, makeRng());
    expect(seeds.length).toBe(VARIATION_COUNT);
    expect(new Set(seeds).size).toBe(VARIATION_COUNT);
    for (const seed of seeds) expect(seed).toMatch(/^[0-9a-z]{6}$/);
  });

  it("never deals the excluded (current) seed", () => {
    const rng = makeRng(1);
    const current = randomSeed(makeRng(1)); // the seed the rng would deal first
    const seeds = dealSeeds(VARIATION_COUNT, current, rng);
    expect(seeds).not.toContain(current);
    expect(seeds.length).toBe(VARIATION_COUNT);
    expect(new Set(seeds).size).toBe(VARIATION_COUNT);
  });

  it("re-dealing produces a fresh hand (reshuffle)", () => {
    const rng = makeRng(9);
    const first = dealSeeds(VARIATION_COUNT, "abcdef", rng);
    const second = dealSeeds(VARIATION_COUNT, "abcdef", rng);
    expect(second).not.toEqual(first);
  });

  it("terminates even for a degenerate constant rng", () => {
    const constant = () => 0.5;
    const seeds = dealSeeds(VARIATION_COUNT, undefined, constant);
    // A constant rng can only ever mint one distinct seed; the attempts cap
    // stops the deal instead of hanging.
    expect(seeds.length).toBeLessThanOrEqual(VARIATION_COUNT);
    expect(seeds.length).toBeGreaterThan(0);
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});
