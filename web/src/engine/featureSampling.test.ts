import { expect, test } from "bun:test";
import { sampleMask, sampleRasterMask } from "./grid.ts";
import type { ArtworkInput, FeatureMasks, StyleParams } from "./types.ts";
import { generateRows } from "../studios/experimental/waveformTerrain.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";

test("raster mask centers stay exact without changing endpoint terrain sampling", () => {
  const values = new Float32Array([0, 1, 0, 0]);
  expect(sampleRasterMask(values, 4, 1, 1.5 / 4, 0)).toBe(1);
  expect(sampleRasterMask(values, 4, 1, 0.5 / 4, 0)).toBe(0);
  expect(sampleRasterMask(values, 4, 1, 0, 0)).toBe(0);
  expect(sampleMask(values, 4, 1, 1 / 3, 0)).toBe(1);
});

for (const layer of ["road", "building", "water"] as const) {
  test(`low-detail rows cannot step over a thin ${layer} mask`, () => {
    const n = 512,
      zero = new Float32Array(n * n),
      occupied = zero.slice();
    for (let y = 0; y < n; y++) for (const x of [4, 5]) occupied[y * n + x] = 1;
    const masks: FeatureMasks = {
      width: n,
      height: n,
      building: zero,
      road: zero,
      water: zero,
      ocean: zero,
      lake: zero,
      river: zero,
      [layer]: occupied,
    };
    const bounds = { west: 0, east: 1, south: 0, north: 1 };
    const input: ArtworkInput = {
      width: n,
      height: n,
      bounds,
      masks,
      seed: "thin-feature",
      elevationGrid: {
        width: 2,
        height: 2,
        bounds,
        data: new Float32Array([0, 0, 1, 1]),
      },
    };
    const base: StyleParams = {
      ...defaultStyleParams,
      noise: 0,
      detail: 0.2,
      buildingInfluence: 0,
      roadInfluence: 0,
      waterInfluence: 0,
      oceanInfluence: 0,
      lakeInfluence: 0,
      riverInfluence: 0,
    };
    const baseline = generateRows(input, base);
    const changed = generateRows(input, {
      ...base,
      [`${layer}Influence`]: 100,
      [`${layer}Mode`]: "interrupt",
    });
    expect(baseline[0]!.segments).toHaveLength(1);
    expect(changed[0]!.segments).toHaveLength(2);
    expect(changed).not.toEqual(baseline);
    // Outside the feature halo, the user's coarse terrain detail is retained.
    for (const segment of changed[0]!.segments)
      for (const { x } of segment) if (x >= 8 && x < 510) expect(x % 9).toBe(0);
    expect(generateRows(input, base)).toEqual(baseline);
  });
}
