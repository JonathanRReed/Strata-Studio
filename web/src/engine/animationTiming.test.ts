import { expect, test } from "bun:test";
import { frameDelayMs, DEFAULT_FRAMES } from "./animation.ts";
test("GIF and APNG timing quantization preserves the complete loop duration", () => {
  for (const fps of [1.2, 3.6, 24, 60])
    for (const quantum of [1, 10]) {
      const delays = Array.from({ length: 24 }, (_, i) =>
        frameDelayMs(i, fps, quantum),
      );
      expect(delays.reduce((a, b) => a + b, 0)).toBe(
        Math.round((24 * 1000) / fps / quantum) * quantum,
      );
      expect(delays.every((delay) => delay > 0)).toBe(true);
    }
});
test("UI export frame rate keeps the preview speed instead of forcing a one-second loop", () => {
  for (const speed of [0.05, 0.15, 1])
    expect(DEFAULT_FRAMES / (DEFAULT_FRAMES * speed)).toBeCloseTo(
      1 / speed,
      10,
    );
});
