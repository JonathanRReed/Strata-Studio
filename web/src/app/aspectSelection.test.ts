import { describe, expect, test } from "bun:test";
import type { AspectRatio, GeoBounds } from "../engine/types.ts";
import { latToPixelY, pixelYToLat } from "../engine/projection.ts";
import { deriveSelectionBounds, getMercatorBoundsCenter } from "./stateSafety.ts";

// Independent oracle: use the engine's established projection helpers instead
// of repeating the implementation's Mercator conversion formula.
function projectedCenter(bounds: GeoBounds): [number, number] {
  return [
    (bounds.west + bounds.east) / 2,
    pixelYToLat(
      (latToPixelY(bounds.south, 0) + latToPixelY(bounds.north, 0)) / 2,
      0,
    ),
  ];
}

const aspects: readonly AspectRatio[] = ["16:9", "9:16", "12:18", "square"];
const locations: { name: string; center: [number, number] }[] = [
  { name: "Denali", center: [-151, 63.07] },
  { name: "southern high latitude", center: [20, -63.07] },
  { name: "far northern latitude", center: [0, 80] },
  { name: "far southern latitude", center: [0, -80] },
];

describe("fallback aspect camera center", () => {
  for (const { name, center } of locations) {
    test(`${name} preserves projected center and square bounds through 100 cycles`, () => {
      const zoom = 9.5;
      const initial = deriveSelectionBounds(center, zoom, "square");
      const initialCenter = projectedCenter(initial);
      let bounds = initial;

      expect(getMercatorBoundsCenter(initial)[0]).toBeCloseTo(center[0], 12);
      expect(getMercatorBoundsCenter(initial)[1]).toBeCloseTo(center[1], 12);
      for (let cycle = 0; cycle < 100; cycle++) {
        for (const aspect of aspects) {
          bounds = deriveSelectionBounds(getMercatorBoundsCenter(bounds), zoom, aspect);
          const currentCenter = projectedCenter(bounds);
          expect(currentCenter[0]).toBeCloseTo(initialCenter[0], 10);
          expect(currentCenter[1]).toBeCloseTo(initialCenter[1], 10);
        }
        for (const key of ["west", "south", "east", "north"] as const) {
          expect(bounds[key]).toBeCloseTo(initial[key], 12);
        }
      }
    });
  }
});
