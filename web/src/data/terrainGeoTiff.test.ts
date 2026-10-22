import { test, expect } from "bun:test";
import {
  decodeTerrainGeoTiff,
  normalizeTerrainSamples,
} from "./terrainGeoTiff.ts";
test("the real NYC scalar TIFF does not contain the Terrarium kilometre-scale spikes", async () => {
  const bytes = await Bun.file(
    new URL("../../../tests/launch/terrain-fixture.tif", import.meta.url),
  ).arrayBuffer();
  const data = await decodeTerrainGeoTiff(bytes);
  expect(data.length).toBe(512 * 512);
  expect(data.reduce((a, b) => Math.min(a, b), Infinity)).toBe(-29);
  expect(data.reduce((a, b) => Math.max(a, b), -Infinity)).toBe(97);
  expect(data[423 * 512 + 131]).toBeGreaterThan(-10);
});
test("floating-point Deflate predictor preserves heights and all native 512 pixel-center samples", async () => {
  const bytes = await Bun.file(
    new URL("./fixtures/float-terrain.tif", import.meta.url),
  ).arrayBuffer();
  const data = await decodeTerrainGeoTiff(bytes);
  for (const [x, y] of [
    [0, 0],
    [100, 200],
    [511, 511],
  ])
    expect(data[y * 512 + x]).toBe(1 + x * 0.125 + y * 0.25);
});
test("missing scalar samples fail explicitly rather than becoming fake terrain", () => {
  const values = new Float32Array(256 * 256).fill(-12);
  expect(normalizeTerrainSamples(values, 256, 256, -32768)[0]).toBe(-12);
  for (const missing of [-32768, Math.fround(-3.4028234663852886e38), NaN]) {
    values[25] = missing;
    expect(() => normalizeTerrainSamples(values, 256, 256, missing)).toThrow(
      "missing elevation",
    );
  }
});
test("cancelled GeoTIFF decode stops before loading the decoder", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    decodeTerrainGeoTiff(new ArrayBuffer(8), controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});
test("normalization never turns finite input into Float32 infinity", () => {
  expect(() =>
    normalizeTerrainSamples(
      new Float64Array(256 * 256).fill(1e300),
      256,
      256,
      null,
    ),
  ).toThrow("represented safely");
});
