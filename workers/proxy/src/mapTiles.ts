import type { CanonicalBbox, TileCoords } from "./logic";

// A small offline area snapshot, within OpenFreeMap's published download policy.
// Keep geometry decoding on the client, not on the free-plan Worker CPU budget.
export const MAP_TILE_METADATA = "https://tiles.openfreemap.org/planet";
export const MAP_TILE_ZOOM = 14;
export const MAX_MAP_TILES = 16;
export const MAX_MAP_TILE_BYTES = 2 * 1024 * 1024;
export const MAX_MAP_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAP_BUNDLE_TYPE = "application/vnd.strata.map-tiles";

/** Cheap top-level protobuf framing check; full geometry validation is client-side. */
export function isVectorTilePayload(bytes: Uint8Array): boolean {
  let offset = 0,
    layers = 0;
  const varint = (): number => {
    let value = 0,
      multiplier = 1;
    for (let count = 0; count < 5 && offset < bytes.length; count++) {
      const byte = bytes[offset++]!;
      value += (byte & 127) * multiplier;
      if (byte < 128) return value;
      multiplier *= 128;
    }
    return -1;
  };
  while (offset < bytes.length) {
    if (varint() !== 26) return false;
    const length = varint();
    if (length < 1 || offset + length > bytes.length) return false;
    offset += length;
    layers++;
  }
  return layers > 0;
}

export function mapTilesForBounds(bounds: CanonicalBbox): TileCoords[] {
  const { south, west, north, east } = bounds;
  if (
    ![south, west, north, east].every(Number.isFinite) ||
    south >= north ||
    west >= east ||
    south < -85.05112878 ||
    north > 85.05112878 ||
    west < -180 ||
    east > 180
  ) {
    throw new Error("invalid map tile bounds");
  }
  const n = 2 ** MAP_TILE_ZOOM;
  const x = (lon: number) => ((lon + 180) / 360) * n;
  const y = (lat: number) =>
    ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  const minX = Math.max(0, Math.floor(x(west)));
  const maxX = Math.min(n - 1, Math.ceil(x(east)) - 1);
  const minY = Math.max(0, Math.floor(y(north)));
  const maxY = Math.min(n - 1, Math.ceil(y(south)) - 1);
  const count = (maxX - minX + 1) * (maxY - minY + 1);
  if (count < 1 || count > MAX_MAP_TILES)
    throw new Error("map tile budget exceeded; zoom in");
  const tiles: TileCoords[] = [];
  for (let ty = minY; ty <= maxY; ty++)
    for (let tx = minX; tx <= maxX; tx++)
      tiles.push({ z: MAP_TILE_ZOOM, x: tx, y: ty });
  return tiles;
}

export function parseMapTileSource(value: unknown): {
  template: string;
  dataset: string;
} {
  if (!value || typeof value !== "object")
    throw new Error("invalid map source");
  const source = value as { tiles?: unknown; maxzoom?: unknown };
  if (
    !Array.isArray(source.tiles) ||
    source.tiles.length !== 1 ||
    typeof source.tiles[0] !== "string" ||
    typeof source.maxzoom !== "number" ||
    !Number.isInteger(source.maxzoom) ||
    source.maxzoom < MAP_TILE_ZOOM
  )
    throw new Error("unsupported map source");
  const template = source.tiles[0];
  const match =
    /^https:\/\/tiles\.openfreemap\.org\/planet\/(\d{8}_\d{6}_pt)\/\{z\}\/\{x\}\/\{y\}\.pbf$/.exec(
      template,
    );
  if (!match) throw new Error("untrusted map source URL");
  return { template, dataset: match[1]! };
}

export function encodeMapTileBundle(
  dataset: string,
  tiles: (TileCoords & { bytes: Uint8Array })[],
): Uint8Array<ArrayBuffer> {
  if (
    !/^\d{8}_\d{6}_pt$/.test(dataset) ||
    tiles.length < 1 ||
    tiles.length > MAX_MAP_TILES
  )
    throw new Error("invalid map bundle");
  let total = 0;
  const seen = new Set<string>();
  for (const tile of tiles) {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    if (
      tile.z !== MAP_TILE_ZOOM ||
      !Number.isInteger(tile.x) ||
      !Number.isInteger(tile.y) ||
      tile.x < 0 ||
      tile.y < 0 ||
      tile.x >= 2 ** MAP_TILE_ZOOM ||
      tile.y >= 2 ** MAP_TILE_ZOOM ||
      seen.has(key) ||
      !tile.bytes.byteLength ||
      tile.bytes.byteLength > MAX_MAP_TILE_BYTES
    )
      throw new Error("invalid map tile");
    seen.add(key);
    total += tile.bytes.byteLength;
  }
  if (total > MAX_MAP_SNAPSHOT_BYTES)
    throw new Error("map snapshot exceeds size budget");
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      source: "openfreemap",
      dataset,
      tiles: tiles.map(({ z, x, y, bytes }) => ({
        z,
        x,
        y,
        byteLength: bytes.byteLength,
      })),
    }),
  );
  const output = new Uint8Array(12 + metadata.byteLength + total);
  output.set(new TextEncoder().encode("STRATAM1"));
  new DataView(output.buffer).setUint32(8, metadata.byteLength, true);
  output.set(metadata, 12);
  let offset = 12 + metadata.byteLength;
  for (const tile of tiles) {
    output.set(tile.bytes, offset);
    offset += tile.bytes.byteLength;
  }
  return output;
}
