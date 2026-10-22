import { expect, test } from "bun:test";
import { fetchTerrain, tileCountForFetch } from "./terrainTiles.ts";
import {
  pixelXToLng,
  pixelYToLat,
  lngToPixelX,
  latToPixelY,
} from "../engine/projection.ts";
const boundsFor = (x0: number, x1: number, y0: number, y1: number) => ({
  west: pixelXToLng(x0, 1),
  east: pixelXToLng(x1, 1),
  north: pixelYToLat(y0, 1),
  south: pixelYToLat(y1, 1),
});
async function plane(
  bounds: ReturnType<typeof boundsFor>,
  dimensions: { width: number; height: number },
) {
  const calls: { z: number; x: number; y: number }[] = [];
  const grid = await fetchTerrain(bounds, dimensions, undefined, {
    tileLoader: {
      getTileData: async (z, x, y) => {
        calls.push({ z, x, y });
        return Float32Array.from(
          { length: 65536 },
          (_, i) =>
            2 * (x * 256 + (i % 256) + 0.5) +
            3 * (y * 256 + Math.floor(i / 256) + 0.5) +
            7,
        );
      },
    },
  });
  return { grid, calls };
}
test("registered bilinear samples preserve affine terrain across four-tile seams", async () => {
  const bounds = boundsFor(255.5, 384.5, 255.5, 256.5),
    dimensions = { width: 128, height: 3 };
  const { grid, calls } = await plane(bounds, dimensions);
  expect(new Set(calls.map((c) => c.z))).toEqual(new Set([1]));
  expect(calls.length).toBe(tileCountForFetch(bounds, dimensions));
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 128; col++) {
      const x = 255.5 + (col / 127) * 129,
        y = 255.5 + row / 2;
      expect(grid.data[row * 128 + col]!).toBeCloseTo(2 * x + 3 * y + 7, 3);
    }
});
test("interpolation fetches east and west halo samples outside the selected tile footprint", async () => {
  for (const [left, right] of [
    [100.5, 255.75],
    [256.25, 400.5],
  ]) {
    const bounds = boundsFor(left!, right!, 100.5, 101.5);
    const { grid, calls } = await plane(bounds, { width: 128, height: 2 });
    expect(new Set(calls.map((c) => c.x))).toEqual(new Set([0, 1]));
    for (const col of [0, 127])
      expect(grid.data[col]!).toBeCloseTo(
        2 * (col === 0 ? left! : right!) + 3 * 100.5 + 7,
        3,
      );
  }
});
test("world edges clamp to actual sample centers without invalid tiles or latitude wrapping", async () => {
  const bounds = { west: -180, east: 180, north: 85, south: -85 };
  const { grid, calls } = await plane(bounds, { width: 129, height: 3 });
  expect(calls).toEqual([{ z: 0, x: 0, y: 0 }]);
  for (let row = 0; row < 3; row++)
    for (const col of [0, 128]) {
      const y0 = latToPixelY(grid.bounds.north, 0),
        y1 = latToPixelY(grid.bounds.south, 0);
      const y = Math.max(0.5, Math.min(255.5, y0 + ((y1 - y0) * row) / 2));
      const x = Math.max(
        0.5,
        Math.min(255.5, lngToPixelX(col === 0 ? -180 : 180, 0)),
      );
      expect(grid.data[row * 129 + col]!).toBeCloseTo(2 * x + 3 * y + 7, 3);
    }
});
