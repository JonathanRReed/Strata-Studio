/** Pure, runtime-agnostic policy for the Strata Studio proxy Worker. */

export const TERRAIN_UPSTREAM =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
export const OVERPASS_PRIMARY = "https://overpass-api.de/api/interpreter";
export const OVERPASS_MIRROR =
  "https://overpass.private.coffee/api/interpreter";

export const CACHE_TERRAIN_OK =
  "public, s-maxage=2592000, max-age=86400, immutable";
export const CACHE_TERRAIN_404 = "public, s-maxage=3600";
export const CACHE_OVERPASS_OK =
  "public, s-maxage=86400, stale-while-revalidate=86400";
export const CACHE_NONE = "no-store";

export function terrainCacheControl(status: number): string {
  if (status === 200) return CACHE_TERRAIN_OK;
  if (status === 404) return CACHE_TERRAIN_404;
  return CACHE_NONE;
}

export interface TileCoords {
  z: number;
  x: number;
  y: number;
}

const TERRAIN_PATH_RE = /^\/terrain\/(\d{1,2})\/(\d{1,10})\/(\d{1,10})\.png$/;

export function parseTerrainPath(pathname: string): TileCoords | null {
  const match = TERRAIN_PATH_RE.exec(pathname);
  if (!match) return null;
  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!isValidTile(z, x, y)) return null;
  // One path per tile keeps the edge cache key canonical and prevents
  // leading-zero aliases from multiplying cache entries.
  if (pathname !== `/terrain/${z}/${x}/${y}.png`) return null;
  return { z, x, y };
}

export function isValidTile(z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return false;
  }
  if (z < 0 || z > 15) return false;
  const limit = 2 ** z;
  return x >= 0 && x < limit && y >= 0 && y < limit;
}

export function terrainUpstreamUrl({ z, x, y }: TileCoords): string {
  return `${TERRAIN_UPSTREAM}/${z}/${x}/${y}.png`;
}

export const MAX_BBOX_KM2 = 25;
export const MAX_BBOX_SPAN_KM = 25;
export const WEB_MERCATOR_MAX_LAT = 85.05112878;
export const BBOX_DECIMAL_PLACES = 4;
export const OVERPASS_TIMEOUT_SECONDS = 15;
export const OVERPASS_MAXSIZE_BYTES = 16 * 1024 * 1024;

export interface CanonicalBbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export type CanonicalBboxResult =
  | { ok: true; bounds: CanonicalBbox; search: string }
  | { ok: false; error: string };

const DECIMAL = "-?(?:0|[1-9]\\d{0,2})\\.\\d{4}";
const CANONICAL_BBOX_RE = new RegExp(
  `^south=(${DECIMAL})&west=(${DECIMAL})&north=(${DECIMAL})&east=(${DECIMAL})$`,
);

export function formatCanonicalCoordinate(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("coordinate must be finite");
  const formatted = value.toFixed(BBOX_DECIMAL_PLACES);
  return formatted === "-0.0000" ? "0.0000" : formatted;
}

export function canonicalBboxSearch(bounds: CanonicalBbox): string {
  return [
    `south=${formatCanonicalCoordinate(bounds.south)}`,
    `west=${formatCanonicalCoordinate(bounds.west)}`,
    `north=${formatCanonicalCoordinate(bounds.north)}`,
    `east=${formatCanonicalCoordinate(bounds.east)}`,
  ].join("&");
}

export function bboxDimensionsKm(bounds: CanonicalBbox): {
  width: number;
  height: number;
} {
  const deltaLng = bounds.east - bounds.west;
  const deltaLat = bounds.north - bounds.south;
  const meanLat = (bounds.north + bounds.south) / 2;
  const radians = (meanLat * Math.PI) / 180;
  return {
    width: Math.abs(Math.cos(radians) * deltaLng * 111.32),
    height: Math.abs(deltaLat * 110.57),
  };
}

export function bboxAreaKm2(bounds: CanonicalBbox): number {
  const { width, height } = bboxDimensionsKm(bounds);
  return width * height;
}

/**
 * Accept exactly one canonical representation so edge-cache keys cannot vary by
 * parameter aliases, order, duplicates, exponent notation, padding, or encoding.
 */
export function parseCanonicalBbox(search: string): CanonicalBboxResult {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const match = CANONICAL_BBOX_RE.exec(raw);
  if (!match) {
    return {
      ok: false,
      error:
        "expected canonical south,west,north,east parameters with four decimal places",
    };
  }
  if (match.slice(1).some((value) => value === "-0.0000")) {
    return { ok: false, error: "negative zero is not canonical" };
  }

  const bounds: CanonicalBbox = {
    south: Number(match[1]),
    west: Number(match[2]),
    north: Number(match[3]),
    east: Number(match[4]),
  };
  if (
    bounds.south < -WEB_MERCATOR_MAX_LAT ||
    bounds.north > WEB_MERCATOR_MAX_LAT ||
    bounds.west < -180 ||
    bounds.east > 180
  ) {
    return { ok: false, error: "bbox is outside Web Mercator-safe bounds" };
  }
  if (bounds.south >= bounds.north || bounds.west >= bounds.east) {
    return { ok: false, error: "bbox coordinates are not strictly ordered" };
  }
  const dimensions = bboxDimensionsKm(bounds);
  if (
    dimensions.width > MAX_BBOX_SPAN_KM ||
    dimensions.height > MAX_BBOX_SPAN_KM
  ) {
    return {
      ok: false,
      error: `bbox span exceeds ${MAX_BBOX_SPAN_KM} km`,
    };
  }
  if (dimensions.width * dimensions.height > MAX_BBOX_KM2) {
    return { ok: false, error: `bbox exceeds ${MAX_BBOX_KM2} km²` };
  }

  const canonical = canonicalBboxSearch(bounds);
  if (raw !== canonical) {
    return { ok: false, error: "bbox parameters are not canonical" };
  }
  return { ok: true, bounds, search: canonical };
}

/** The only Overpass program the public Worker is permitted to execute. */
export function buildOverpassQuery(bounds: CanonicalBbox): string {
  const bbox = `(${formatCanonicalCoordinate(bounds.south)},${formatCanonicalCoordinate(bounds.west)},${formatCanonicalCoordinate(bounds.north)},${formatCanonicalCoordinate(bounds.east)})`;
  return `[out:json][timeout:${OVERPASS_TIMEOUT_SECONDS}][maxsize:${OVERPASS_MAXSIZE_BYTES}];
(
  way["building"]${bbox};
  way["highway"]${bbox};
  way["natural"="water"]${bbox};
  way["waterway"]${bbox};
  way["natural"="coastline"]${bbox};
  relation["natural"="water"]${bbox};
  relation["waterway"]${bbox};
);
out body;
>;
out skel qt;`;
}

export function shouldRetryOverpass(status: number): boolean {
  return status === 429 || status >= 500;
}

export function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export function isPngContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(";", 1)[0]!.trim().toLowerCase() === "image/png";
}

export function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const candidate of value?.split(",") ?? []) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed === "*") continue;
    try {
      const url = new URL(trimmed);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === "" &&
        trimmed === url.origin
      ) {
        origins.add(trimmed);
      }
    } catch {
      // Invalid entries fail closed.
    }
  }
  return origins;
}

export function isAllowedOrigin(
  origin: string | null,
  allowed: ReadonlySet<string>,
): boolean {
  if (origin === null) return true;
  try {
    return new URL(origin).origin === origin && allowed.has(origin);
  } catch {
    return false;
  }
}

export function sanitizeRetryAfter(
  value: string | null,
  fallbackSeconds = 30,
): string {
  const parsed = value?.trim();
  if (parsed && /^\d{1,3}$/.test(parsed)) {
    const seconds = Number(parsed);
    if (seconds >= 1 && seconds <= 300) return String(seconds);
  }
  return String(fallbackSeconds);
}

export function sanitizeBuildId(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return /^[A-Za-z0-9._-]{1,64}$/.test(trimmed) ? trimmed : "unversioned";
}

export function enabledFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}
