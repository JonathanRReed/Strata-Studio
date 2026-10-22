import { expect, test } from "bun:test";
import Pbf from "pbf";
import {
  encodeMapTileBundle,
  mapTilesForBounds,
} from "../../../workers/proxy/src/mapTiles.ts";
import { decodeMapTileBundle } from "./mapTiles.ts";
import { createOsmFeatureFetcher, snapBoundsForQuery } from "./osmOverpass.ts";
import { summarizeFeatures } from "../app/useOsmFeatures.ts";
import { mapAttribution } from "../app/useExports.ts";

function tile() {
  const pbf = new Pbf();
  pbf.writeMessage(
    3,
    (_, layer: Pbf) => {
      layer.writeStringField(1, "building");
      layer.writeVarintField(15, 2);
      layer.writeVarintField(5, 4096);
      layer.writeMessage(
        2,
        (_, feature: Pbf) => {
          feature.writeVarintField(1, 123);
          feature.writeVarintField(3, 3);
          feature.writePackedVarint(
            4,
            [9, 2000, 2000, 26, 200, 0, 0, 200, 199, 0, 15],
          );
        },
        null,
      );
    },
    null,
  );
  return pbf.finish();
}
const bounds = { south: 40.75, west: -74.003, north: 40.763, east: -73.982 };
test("real protobuf geometry is decoded with tile provenance, not invented OSM identity", () => {
  const bytes = encodeMapTileBundle("20261018_080001_pt", [
    { z: 14, x: 4824, y: 6157, bytes: tile() },
  ]);
  const result = decodeMapTileBundle(bytes, bounds);
  expect(result.source).toEqual({
    kind: "openfreemap-tiles",
    dataset: "20261018_080001_pt",
    zoom: 14,
  });
  expect(result.features).toHaveLength(1);
  expect(result.features[0]!.properties.strataType).toBe("building");
  expect(result.features[0]!.geometry.type).toBe("Polygon");
  expect(result.features[0]!.properties.osmId).toBeUndefined();
  expect(summarizeFeatures(result)).toContain("Generalized map geometry");
  expect(summarizeFeatures(result)).toContain("2026-10-18");
  expect(mapAttribution(result)).toContain("© OpenMapTiles");
  expect(
    mapAttribution({ type: "FeatureCollection", features: [] }),
  ).not.toContain("OpenMapTiles");
});
test("truncated or trailing binary payloads are rejected rather than rendered as partial data", () => {
  const bytes = encodeMapTileBundle("20261018_080001_pt", [
    { z: 14, x: 4824, y: 6157, bytes: tile() },
  ]);
  expect(() =>
    decodeMapTileBundle(bytes.subarray(0, bytes.length - 1), bounds),
  ).toThrow();
  const extra = new Uint8Array(bytes.length + 1);
  extra.set(bytes);
  expect(() => decodeMapTileBundle(extra, bounds)).toThrow();
  expect(() =>
    decodeMapTileBundle(new Uint8Array([1, 2, 3]), bounds),
  ).toThrow();
});
test("a disabled Overpass route can use a validated tile snapshot and retain provenance in cache", async () => {
  const bundle = encodeMapTileBundle(
    "20261018_080001_pt",
    mapTilesForBounds(snapBoundsForQuery(bounds)).map((coords) => ({
      ...coords,
      bytes: tile(),
    })),
  );
  let cached: unknown;
  const fetcher = createOsmFeatureFetcher({
    endpoints: [
      { kind: "proxy", url: "https://proxy.example/overpass" },
      { kind: "tiles", url: "https://proxy.example/map-features" },
    ],
    getCached: async () => undefined,
    setCached: async (_, data) => {
      cached = data;
    },
    fetch: async (input) =>
      String(input).includes("/overpass?")
        ? new Response("disabled", { status: 503 })
        : new Response(bundle, {
            headers: { "Content-Type": "application/vnd.strata.map-tiles" },
          }),
  });
  const result = await fetcher(bounds);
  expect(result.source?.kind).toBe("openfreemap-tiles");
  expect(cached).toBe(result);
});
test("a disabled proxy's Retry-After is respected across later area requests", async () => {
  const bundle = encodeMapTileBundle(
    "20261018_080001_pt",
    mapTilesForBounds(snapBoundsForQuery(bounds)).map((coords) => ({
      ...coords,
      bytes: tile(),
    })),
  );
  let proxyCalls = 0;
  const fetcher = createOsmFeatureFetcher({
    endpoints: [
      { kind: "proxy", url: "https://proxy.example/overpass" },
      { kind: "tiles", url: "https://proxy.example/map-features" },
    ],
    getCached: async () => undefined,
    setCached: async () => {},
    fetch: async (input) => {
      if (String(input).includes("/overpass?")) {
        proxyCalls++;
        return new Response("disabled", {
          status: 503,
          headers: { "Retry-After": "60" },
        });
      }
      return new Response(bundle, {
        headers: { "Content-Type": "application/vnd.strata.map-tiles" },
      });
    },
  });
  await fetcher(bounds);
  await fetcher(bounds);
  expect(proxyCalls).toBe(1);
});

test("a tile bundle must cover the whole requested area with truthful metadata", () => {
  const payload = tile();
  const good = { version: 1, source: "openfreemap", dataset: "20261018_080001_pt", tiles: [{ z: 14, x: 4824, y: 6157, byteLength: payload.length }] };
  const forge = (metadata: object, body = payload) => {
    const json = new TextEncoder().encode(JSON.stringify(metadata));
    const bytes = new Uint8Array(12 + json.length + body.length);
    bytes.set(new TextEncoder().encode("STRATAM1"));
    new DataView(bytes.buffer).setUint32(8, json.length, true);
    bytes.set(json, 12); bytes.set(body, 12 + json.length);
    return bytes;
  };
  for (const altered of [
    { ...good, source: "raw-osm" },
    { ...good, dataset: "not-a-snapshot" },
    { ...good, tiles: [{ ...good.tiles[0], x: 4825 }] },
    { ...good, tiles: [{ ...good.tiles[0], byteLength: payload.length - 1 }] },
  ]) expect(() => decodeMapTileBundle(forge(altered), bounds)).toThrow();
  const wider = { ...bounds, north: 40.8 };
  expect(mapTilesForBounds(wider).length).toBeGreaterThan(1);
  expect(() => decodeMapTileBundle(forge(good), wider)).toThrow();
  const repeated = Array.from({ length: mapTilesForBounds(wider).length }, () => good.tiles[0]);
  const repeatedBytes = new Uint8Array(payload.length * repeated.length);
  repeated.forEach((_, index) => repeatedBytes.set(payload, index * payload.length));
  expect(() => decodeMapTileBundle(forge({ ...good, tiles: repeated }, repeatedBytes), wider)).toThrow();
});
