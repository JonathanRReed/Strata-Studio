/**
 * Pure, runtime-agnostic logic for the strata-proxy Worker.
 *
 * Everything in this file is unit-testable under `bun test` — no Workers
 * runtime APIs, no I/O. The fetch handler in index.ts is a thin shell
 * around these functions.
 */

// ---------------------------------------------------------------------------
// Upstreams
// ---------------------------------------------------------------------------

export const TERRAIN_UPSTREAM =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
export const OVERPASS_PRIMARY = "https://overpass-api.de/api/interpreter";
export const OVERPASS_MIRROR =
  "https://overpass.private.coffee/api/interpreter";

// ---------------------------------------------------------------------------
// Cache-Control policies (Workers Cache keys off these headers)
// ---------------------------------------------------------------------------

/** Terrain tiles are frozen upstream: cache hard at the edge, a day in browsers. */
export const CACHE_TERRAIN_OK =
  "public, s-maxage=2592000, max-age=86400, immutable";
/** Missing tiles (ocean gaps etc.): cache briefly so we don't hammer S3. */
export const CACHE_TERRAIN_404 = "public, s-maxage=3600";
/** Overpass results: a day at the edge, serve stale while revalidating. */
export const CACHE_OVERPASS_OK =
  "public, s-maxage=86400, stale-while-revalidate=86400";
/** OG cards: a week at the edge. */
export const CACHE_OG_OK = "public, s-maxage=604800";
/** Anything transient or erroneous must never enter the cache. */
export const CACHE_NONE = "no-store";

/** Pick the Cache-Control header for a terrain upstream response status. */
export function terrainCacheControl(status: number): string {
  if (status === 200) return CACHE_TERRAIN_OK;
  if (status === 404) return CACHE_TERRAIN_404;
  return CACHE_NONE; // 5xx and anything unexpected: pass through uncached
}

/** Pick the Cache-Control header for an Overpass upstream response status. */
export function overpassCacheControl(status: number): string {
  return status === 200 ? CACHE_OVERPASS_OK : CACHE_NONE;
}

/** Overpass statuses that warrant one (and only one) mirror retry. */
export function shouldRetryOverpass(status: number): boolean {
  return status === 429 || status === 504;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------------------
// Terrain tile route
// ---------------------------------------------------------------------------

export interface TileCoords {
  z: number;
  x: number;
  y: number;
}

const TERRAIN_PATH_RE = /^\/terrain\/(\d{1,2})\/(\d{1,10})\/(\d{1,10})\.png$/;

/**
 * Parse and validate `/terrain/{z}/{x}/{y}.png`.
 * Returns null unless z is 0-15 and x, y are integers within [0, 2^z).
 */
export function parseTerrainPath(pathname: string): TileCoords | null {
  const m = TERRAIN_PATH_RE.exec(pathname);
  if (!m) return null;
  const z = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (!isValidTile(z, x, y)) return null;
  return { z, x, y };
}

export function isValidTile(z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return false;
  }
  if (z < 0 || z > 15) return false;
  const max = 2 ** z;
  return x >= 0 && x < max && y >= 0 && y < max;
}

export function terrainUpstreamUrl({ z, x, y }: TileCoords): string {
  return `${TERRAIN_UPSTREAM}/${z}/${x}/${y}.png`;
}

// ---------------------------------------------------------------------------
// Overpass route
// ---------------------------------------------------------------------------

export const OVERPASS_MAX_QUERY_BYTES = 8 * 1024;

export type OverpassDecodeResult =
  | { ok: true; query: string }
  | { ok: false; error: string };

/**
 * Decode a base64url-encoded Overpass QL query (from `?q=`) and validate it.
 * The query travels GET-normalized so the edge cache can key on the URL;
 * the Worker re-POSTs it upstream (HTTP caches don't cache POSTs).
 */
export function decodeOverpassQuery(
  encoded: string | null,
): OverpassDecodeResult {
  if (!encoded) {
    return { ok: false, error: "missing q parameter" };
  }
  // Hard cap on the encoded form too (base64 is 4/3 the decoded size).
  if (encoded.length > Math.ceil((OVERPASS_MAX_QUERY_BYTES * 4) / 3) + 4) {
    return { ok: false, error: "query too large" };
  }

  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(encoded);
  } catch {
    return { ok: false, error: "q is not valid base64url" };
  }

  if (bytes.length === 0) {
    return { ok: false, error: "query is empty" };
  }
  if (bytes.length >= OVERPASS_MAX_QUERY_BYTES) {
    return { ok: false, error: "query too large" };
  }

  let query: string;
  try {
    query = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return { ok: false, error: "query is not valid UTF-8" };
  }

  if (query.trim().length === 0) {
    return { ok: false, error: "query is empty" };
  }
  return { ok: true, query };
}

/** Decode base64url (RFC 4648 §5, padding optional) to bytes. */
export function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded) || padded.length % 4 !== 0) {
    throw new Error("invalid base64url");
  }
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encode a string to base64url — handy for tests and for the web app contract. */
export function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// OG card route
// ---------------------------------------------------------------------------

export interface OgParams {
  place: string;
  style: string;
  palette: [string, string, string];
  coords: string;
}

export const OG_DEFAULT_PALETTE: [string, string, string] = [
  "#1a1a2e",
  "#e94560",
  "#f5f5f5",
];

const HEX_COLOR_RE = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const COORDS_RE = /^(-?\d{1,3}(?:\.\d{1,8})?),\s*(-?\d{1,3}(?:\.\d{1,8})?)$/;
const STYLE_RE = /^[a-zA-Z0-9 _-]{1,40}$/;

/** Sanitize and bound all /og query params. Never throws; always renders something. */
export function parseOgParams(searchParams: URLSearchParams): OgParams {
  // Place: strip control chars, collapse whitespace, cap at 80 chars.
  const rawPlace = searchParams.get("place") ?? "";
  const place =
    rawPlace
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Strata Studio";

  // Style id: strict allowlist, else a neutral label.
  const rawStyle = (searchParams.get("style") ?? "").trim();
  const style = STYLE_RE.test(rawStyle) ? rawStyle : "custom";

  // Palette: comma-separated hex; take the first 3 valid entries.
  const palette: string[] = [];
  for (const part of (searchParams.get("palette") ?? "").split(",")) {
    const m = HEX_COLOR_RE.exec(part.trim());
    if (m) {
      const hex =
        m[1]!.length === 3
          ? m[1]!.split("").map((c) => c + c).join("")
          : m[1]!;
      palette.push(`#${hex.toLowerCase()}`);
      if (palette.length === 3) break;
    }
  }
  while (palette.length < 3) {
    palette.push(OG_DEFAULT_PALETTE[palette.length]!);
  }

  // Coords: pattern-checked lat,lng within valid ranges.
  const rawCoords = (searchParams.get("coords") ?? "").trim();
  let coords = "";
  const cm = COORDS_RE.exec(rawCoords);
  if (cm) {
    const lat = Number(cm[1]);
    const lng = Number(cm[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      coords = `${formatCoord(lat, "N", "S")}  ${formatCoord(lng, "E", "W")}`;
    }
  }

  return {
    place,
    style,
    palette: palette as [string, string, string],
    coords,
  };
}

function formatCoord(value: number, pos: string, neg: string): string {
  const hemi = value >= 0 ? pos : neg;
  return `${Math.abs(value).toFixed(4)}°${hemi}`;
}

/** Escape a string for safe interpolation into the OG card's HTML template. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
