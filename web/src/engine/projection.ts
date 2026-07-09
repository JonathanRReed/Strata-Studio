const TILE_SIZE = 256;
const MAX_LAT = 85.0511;
const MIN_LAT = -85.0511;

function wrapLng(lng: number): number {
  let v = lng;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

function clampLat(lat: number): number {
  if (lat > MAX_LAT) return MAX_LAT;
  if (lat < MIN_LAT) return MIN_LAT;
  return lat;
}

export function lngToPixelX(lng: number, zoom: number): number {
  const w = wrapLng(lng);
  return ((w + 180) / 360) * TILE_SIZE * Math.pow(2, zoom);
}

export function latToPixelY(lat: number, zoom: number): number {
  const latRad = (clampLat(lat) * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    TILE_SIZE *
    Math.pow(2, zoom)
  );
}

export function pixelXToLng(x: number, zoom: number): number {
  return (x / (TILE_SIZE * Math.pow(2, zoom))) * 360 - 180;
}

export function pixelYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * Math.pow(2, zoom));
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function tileXForPixel(x: number, zoom: number): number {
  const max = Math.pow(2, zoom) - 1;
  const tx = Math.floor(x / TILE_SIZE);
  return Math.max(0, Math.min(tx, max));
}

export function tileYForPixel(y: number, zoom: number): number {
  const max = Math.pow(2, zoom) - 1;
  const ty = Math.floor(y / TILE_SIZE);
  return Math.max(0, Math.min(ty, max));
}

export function tileToBounds(tx: number, ty: number, zoom: number): GeoBounds {
  const west = pixelXToLng(tx * TILE_SIZE, zoom);
  const east = pixelXToLng((tx + 1) * TILE_SIZE, zoom);
  const north = pixelYToLat(ty * TILE_SIZE, zoom);
  const south = pixelYToLat((ty + 1) * TILE_SIZE, zoom);
  return { west, east, north, south };
}

export function normalizeBounds(bounds: GeoBounds): GeoBounds {
  let west = wrapLng(bounds.west);
  let east = wrapLng(bounds.east);
  // Antimeridian-crossing selections are clamped to the wider side of the
  // dateline so downstream pixel math never spans the whole world.
  if (east < west) {
    if (Math.abs(180 - west) >= Math.abs(east + 180)) {
      east = 180;
    } else {
      west = -180;
    }
  }
  return {
    west,
    east,
    north: clampLat(bounds.north),
    south: clampLat(bounds.south),
  };
}

type GeoBounds = import("./types.ts").GeoBounds;
