import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import type {
  GeoBounds,
  GeoFeature,
  GeoFeatureCollection,
  GeoGeometry,
} from "../engine/types.ts";

export const MAP_BUNDLE_TYPE = "application/vnd.strata.map-tiles";
export const MAX_MAP_BUNDLE_BYTES = 8 * 1024 * 1024 + 4096 + 12;
const ROAD_CLASSES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "minor",
  "service",
  "track",
  "path",
]);

/** Decode an all-or-nothing, bounded snapshot. Tile IDs are not OSM object IDs. */
export function decodeMapTileBundle(
  bytes: Uint8Array,
  bounds: GeoBounds,
): GeoFeatureCollection {
  const invalid = () => new Error("Incomplete or invalid map tile snapshot");
  if (
    bytes.byteLength < 12 ||
    bytes.byteLength > MAX_MAP_BUNDLE_BYTES ||
    new TextDecoder().decode(bytes.subarray(0, 8)) !== "STRATAM1"
  )
    throw invalid();
  const metadataLength = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(8, true);
  if (
    metadataLength < 1 ||
    metadataLength > 4096 ||
    12 + metadataLength > bytes.byteLength
  )
    throw invalid();
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(12, 12 + metadataLength),
    ),
  );
  if (!value || typeof value !== "object") throw invalid();
  const manifest = value as {
    version?: unknown;
    source?: unknown;
    dataset?: unknown;
    tiles?: unknown;
  };
  if (
    manifest.version !== 1 ||
    manifest.source !== "openfreemap" ||
    typeof manifest.dataset !== "string" ||
    !/^\d{8}_\d{6}_pt$/.test(manifest.dataset) ||
    !Array.isArray(manifest.tiles) ||
    manifest.tiles.length < 1 ||
    manifest.tiles.length > 16
  )
    throw invalid();
  const n = 2 ** 14;
  const tx = (lon: number) => ((lon + 180) / 360) * n;
  const ty = (lat: number) =>
    ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  if (
    ![bounds.south, bounds.west, bounds.north, bounds.east].every(
      Number.isFinite,
    ) ||
    bounds.south >= bounds.north ||
    bounds.west >= bounds.east ||
    bounds.south < -85.05112878 ||
    bounds.north > 85.05112878 ||
    bounds.west < -180 ||
    bounds.east > 180
  )
    throw invalid();
  const minX = Math.max(0, Math.floor(tx(bounds.west))),
    maxX = Math.min(n - 1, Math.ceil(tx(bounds.east)) - 1);
  const minY = Math.max(0, Math.floor(ty(bounds.north))),
    maxY = Math.min(n - 1, Math.ceil(ty(bounds.south)) - 1);
  if ((maxX - minX + 1) * (maxY - minY + 1) !== manifest.tiles.length)
    throw invalid();
  const seenTiles = new Set<string>();
  const seenGeometry = new Set<string>();
  const features: GeoFeature[] = [];
  let offset = 12 + metadataLength,
    vertices = 0,
    featureCount = 0;
  for (const entry of manifest.tiles) {
    if (!entry || typeof entry !== "object") throw invalid();
    const { z, x, y, byteLength } = entry as Record<string, unknown>;
    if (
      z !== 14 ||
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof byteLength !== "number" ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      !Number.isInteger(byteLength) ||
      x < minX ||
      x > maxX ||
      y < minY ||
      y > maxY ||
      byteLength < 1 ||
      byteLength > 2 * 1024 * 1024 ||
      offset + byteLength > bytes.byteLength
    )
      throw invalid();
    const key = `${x}/${y}`;
    if (seenTiles.has(key)) throw invalid();
    seenTiles.add(key);
    const tile = new VectorTile(
      new Pbf(bytes.subarray(offset, offset + byteLength)),
    );
    if (Object.keys(tile.layers).length === 0) throw invalid();
    offset += byteLength;
    for (const name of ["building", "transportation", "water", "waterway"]) {
      const layer = tile.layers[name];
      if (!layer) continue;
      featureCount += layer.length;
      if (featureCount > 50_000) throw invalid();
      for (let index = 0; index < layer.length; index++) {
        const feature = layer.feature(index);
        const classification = feature.properties.class;
        if (
          name === "transportation" &&
          (!ROAD_CLASSES.has(String(classification)) || feature.type !== 2)
        )
          continue;
        if ((name === "building" || name === "water") && feature.type !== 3)
          continue;
        if (name === "waterway" && feature.type !== 2) continue;
        if (name === "water" && classification === "swimming_pool") continue;
        const geometry = feature.toGeoJSON(x, y, z).geometry;
        if (
          ![
            "Polygon",
            "MultiPolygon",
            "LineString",
            "MultiLineString",
          ].includes(geometry.type)
        )
          throw invalid();
        const decoded = geometry as GeoGeometry;
        const candidates: GeoGeometry[] =
          decoded.type === "MultiPolygon"
            ? decoded.coordinates.map((coordinates) => ({
                type: "Polygon",
                coordinates,
              }))
            : decoded.type === "MultiLineString"
              ? decoded.coordinates.map((coordinates) => ({
                  type: "LineString",
                  coordinates,
                }))
              : [decoded];
        for (const candidate of candidates) {
          let west = Infinity,
            east = -Infinity,
            south = Infinity,
            north = -Infinity;
          const visit = (coordinates: unknown, depth = 0): void => {
            if (
              !Array.isArray(coordinates) ||
              coordinates.length === 0 ||
              depth > 4
            )
              throw invalid();
            if (typeof coordinates[0] === "number") {
              if (
                coordinates.length !== 2 ||
                !coordinates.every(Number.isFinite) ||
                Math.abs(coordinates[0]) > 181 ||
                Math.abs(coordinates[1]) > 90 ||
                ++vertices > 500_000
              )
                throw invalid();
              west = Math.min(west, coordinates[0]);
              east = Math.max(east, coordinates[0]);
              south = Math.min(south, coordinates[1]);
              north = Math.max(north, coordinates[1]);
            } else for (const child of coordinates) visit(child, depth + 1);
          };
          visit(candidate.coordinates);
          if (
            east < bounds.west ||
            west > bounds.east ||
            north < bounds.south ||
            south > bounds.north
          )
            continue;
          const strataType =
            name === "building"
              ? "building"
              : name === "transportation"
                ? "road"
                : "water";
          // Keep clipped fragments separate: filling each shape preserves union
          // coverage without inventing edges or XOR holes at tile seams.
          const identity = `${strataType}:${JSON.stringify(candidate)}`;
          if (seenGeometry.has(identity)) continue;
          seenGeometry.add(identity);
          features.push({
            type: "Feature",
            geometry: candidate,
            properties: {
              strataType,
              sourceLayer: name,
              ...(strataType === "water"
                ? {
                    waterType:
                      classification === "ocean"
                        ? ("ocean" as const)
                        : name === "waterway" || classification === "river"
                          ? ("river" as const)
                          : ("lake" as const),
                  }
                : {}),
            },
          });
          if (features.length > 50_000) throw invalid();
        }
      }
    }
  }
  if (offset !== bytes.byteLength) throw invalid();
  return {
    type: "FeatureCollection",
    features,
    source: { kind: "openfreemap-tiles", dataset: manifest.dataset, zoom: 14 },
  };
}
