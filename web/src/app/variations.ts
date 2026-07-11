/**
 * Variations: pure seed-dealing logic behind the 2×2 variations overlay.
 * The overlay renders the CURRENT place/style/params under fresh random
 * seeds — zero network, reusing the loaded terrain grid — and adopting a
 * variant simply writes its seed into params.
 */

/** Number of variation slots dealt per hand. */
export const VARIATION_COUNT = 4;

/** Long-edge pixel size of a variation preview canvas. */
export const VARIATION_SIZE = 220;

/** One random 6-char base36 seed (same alphabet as the seed randomizer). */
export function randomSeed(rng: () => number = Math.random): string {
  let seed = "";
  while (seed.length < 6) {
    seed += Math.floor(rng() * 36).toString(36);
  }
  return seed;
}

/**
 * Deals `count` fresh, distinct seeds, none equal to `exclude` (the current
 * seed), so every variation genuinely differs from the artwork on stage.
 * The attempts cap only guards degenerate injected rngs; with Math.random
 * collisions are vanishingly rare.
 */
export function dealSeeds(
  count: number = VARIATION_COUNT,
  exclude?: string,
  rng: () => number = Math.random,
): string[] {
  const seen = new Set<string>(exclude == null ? [] : [exclude]);
  const seeds: string[] = [];
  let attempts = 0;
  while (seeds.length < count && attempts < count * 100) {
    attempts++;
    const seed = randomSeed(rng);
    if (seen.has(seed)) continue;
    seen.add(seed);
    seeds.push(seed);
  }
  return seeds;
}
