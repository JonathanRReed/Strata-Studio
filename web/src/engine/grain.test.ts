import { expect, test } from "bun:test";
import fc from "fast-check";
import { applyAlphaPreservingGrain } from "./grain.ts";
test("grain never adds coverage or changes black/white endpoints", () => {
  const pixels = new Uint8ClampedArray([
    0, 0, 0, 0, 0, 0, 0, 128, 255, 255, 255, 255,
  ]);
  applyAlphaPreservingGrain(
    pixels,
    3,
    new Uint8ClampedArray([255, 255, 255, 100]),
    1,
  );
  expect(Array.from(pixels)).toEqual([
    0, 0, 0, 0, 0, 0, 0, 128, 255, 255, 255, 255,
  ]);
});
test("soft-light color follows the analytic blend while keeping alpha", () => {
  const pixels = new Uint8ClampedArray([128, 128, 128, 64]);
  applyAlphaPreservingGrain(
    pixels,
    1,
    new Uint8ClampedArray([255, 255, 255, 255]),
    1,
  );
  expect(pixels[0]).toBe(Math.round(Math.sqrt(128 / 255) * 255));
  expect(pixels[3]).toBe(64);
});
test("random grain leaves every original alpha byte unchanged", () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 64, maxLength: 64 }),
      fc.integer({ min: 0, max: 255 }),
      (input, noise) => {
        const pixels = new Uint8ClampedArray(input);
        applyAlphaPreservingGrain(
          pixels,
          4,
          new Uint8ClampedArray([noise, noise, noise, 100]),
          1,
        );
        for (let i = 3; i < 64; i += 4) expect(pixels[i]).toBe(input[i]);
      },
    ),
    { seed: 20261022, numRuns: 100 },
  );
});
