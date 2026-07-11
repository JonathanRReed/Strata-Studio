import { describe, expect, test } from "bun:test";
import { packElevations, unpackElevations } from "./cache.ts";

describe("cache elevation packing", () => {
  test("ordinary land packs at quarter-meter scale with 0.25 m precision", () => {
    const data = new Float32Array([0, 12.25, -3.5, 4211.75, 8191.75]);
    const { packed, scale } = packElevations(data);
    expect(scale).toBe(4);
    const out = unpackElevations(packed, scale);
    for (let i = 0; i < data.length; i++) {
      expect(Math.abs(out[i] - data[i])).toBeLessThanOrEqual(0.125);
    }
  });

  test("Everest-range tiles are not clamped (regression: v2 clamped at 8191.75 m)", () => {
    const everest = 8848.86;
    const data = new Float32Array([everest, 8500, 5000, -100]);
    const { packed, scale } = packElevations(data);
    expect(scale).toBe(2);
    const out = unpackElevations(packed, scale);
    expect(Math.abs(out[0] - everest)).toBeLessThanOrEqual(0.25);
    expect(out[0]).toBeGreaterThan(8191.75);
  });

  test("hadal bathymetry round-trips unclamped (half-meter scale suffices)", () => {
    const challengerDeep = -10935;
    const data = new Float32Array([challengerDeep, -9000, 0]);
    const { packed, scale } = packElevations(data);
    expect(scale).toBe(2);
    const out = unpackElevations(packed, scale);
    expect(Math.abs(out[0] - challengerDeep)).toBeLessThanOrEqual(0.25);
    expect(out[0]).toBeLessThan(-8191.75);
  });

  test("garbage beyond Earth's range clamps instead of overflowing Int16", () => {
    const data = new Float32Array([1e6, -1e6]);
    const { packed, scale } = packElevations(data);
    expect(scale).toBe(1);
    expect(packed[0]).toBe(32767);
    expect(packed[1]).toBe(-32767);
  });
});
