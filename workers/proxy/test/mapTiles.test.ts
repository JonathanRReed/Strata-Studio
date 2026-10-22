import { expect, test } from "bun:test";
import {
  mapTilesForBounds,
  parseMapTileSource,
  encodeMapTileBundle,
} from "../src/mapTiles";

test("map snapshots use detailed tiles and enforce a finite area request budget", () => {
  expect(
    mapTilesForBounds({
      south: 40.75,
      west: -73.99,
      north: 40.751,
      east: -73.989,
    }),
  ).toEqual([{ z: 14, x: 4824, y: 6157 }]);
  expect(() =>
    mapTilesForBounds({ south: 84.99, west: 0, north: 85, east: 1 }),
  ).toThrow(/tile/i);
});

test("upstream tile metadata cannot redirect the proxy to arbitrary hosts or paths", () => {
  const template =
    "https://tiles.openfreemap.org/planet/20261018_080001_pt/{z}/{x}/{y}.pbf";
  expect(parseMapTileSource({ tiles: [template], maxzoom: 14 })).toEqual({
    template,
    dataset: "20261018_080001_pt",
  });
  for (const bad of [
    template.replace("tiles.openfreemap.org", "evil.example"),
    template + "?token=secret",
    template.replace("https:", "http:"),
    template.replace("20261018_080001_pt", "../private"),
  ]) {
    expect(() => parseMapTileSource({ tiles: [bad], maxzoom: 14 })).toThrow();
  }
  expect(() =>
    parseMapTileSource({ tiles: [template], maxzoom: 12 }),
  ).toThrow();
});

test("binary area bundles retain explicit source metadata without base64 expansion", () => {
  const bytes = encodeMapTileBundle("20261018_080001_pt", [
    { z: 14, x: 4824, y: 6157, bytes: new Uint8Array([1, 2, 3]) },
  ]);
  expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("STRATAM1");
  const size = new DataView(bytes.buffer).getUint32(8, true);
  const manifest = JSON.parse(
    new TextDecoder().decode(bytes.subarray(12, 12 + size)),
  );
  expect(manifest.source).toBe("openfreemap");
  expect(manifest.tiles[0]).toEqual({ z: 14, x: 4824, y: 6157, byteLength: 3 });
  expect([...bytes.subarray(12 + size)]).toEqual([1, 2, 3]);
});

test("metadata zoom must be a finite integer", () => {
  const tiles = ["https://tiles.openfreemap.org/planet/20261018_080001_pt/{z}/{x}/{y}.pbf"];
  for (const maxzoom of [NaN, Infinity, 14.5]) {
    expect(() => parseMapTileSource({ tiles, maxzoom })).toThrow();
  }
});

test("snapshot encoding rejects repeated tiles and per-tile or aggregate byte overruns", () => {
  const item = { z: 14, x: 4824, y: 6157, bytes: new Uint8Array([1]) };
  expect(() => encodeMapTileBundle("20261018_080001_pt", [item, item])).toThrow();
  expect(() => encodeMapTileBundle("20261018_080001_pt", [{ ...item, bytes: new Uint8Array(2 * 1024 * 1024 + 1) }])).toThrow();
  expect(() => encodeMapTileBundle("20261018_080001_pt", Array.from({ length: 9 }, (_, index) => ({ ...item, x: item.x + index, bytes: new Uint8Array(1024 * 1024) })))).toThrow(/size budget/);
});
