import type { GeoBounds, StyleParams } from "../engine/types.ts";
import { applyPreset, defaultStyleParams, presets } from "../presets/stylePresets.ts";
import { DEFAULT_STYLE_ID, getStyle, stylesById } from "../studios/registry.ts";
import { ASPECT_RATIOS } from "./aspect.ts";

/**
 * Share-URL scheme (full fidelity).
 *
 *   lat, lng, z   — human-readable map center (4 dp) + zoom; restores the
 *                   map camera and keeps URLs hackable.
 *   b             — selection bounds "west,south,east,north" at 5 decimal
 *                   places. Source of truth for the selection on restore.
 *                   (Replaces the old center+zoom approximation, which
 *                   derived bounds from viewport pixels — so the same URL
 *                   selected different geography on different screens — and
 *                   whose restore path multiplied by cos(lat) where it
 *                   should have divided.)
 *   style         — style id.
 *   seed, palette — kept explicit and human-readable.
 *   p             — base64url(JSON) of the params diff vs the resolved
 *                   defaults (defaultStyleParams + style.defaultParams),
 *                   excluding seed/palette which are explicit above.
 *   preset        — input nicety only: applied first on parse and never
 *                   written back. The `p` diff always captures the full
 *                   state, so serialized URLs need no preset/divergence
 *                   tracking and always round-trip exactly.
 *
 * Parse order: preset → style → explicit seed/palette → p diff (wins last).
 */

export type ShareState = {
  styleId: string;
  params: StyleParams;
  bounds: GeoBounds;
  mapZoom: number;
};

export type ParsedShareState = {
  styleId: string;
  params: StyleParams;
  /** Exact selection bounds from `b`, when present and valid. */
  bounds: GeoBounds | null;
  /** Map camera center [lng, lat], from lat/lng or derived from `b`. */
  center: [number, number] | null;
  zoom: number | null;
};

const PARAM_KEYS = Object.keys(defaultStyleParams) as (keyof StyleParams)[];

const MASK_MODE_KEYS = new Set([
  "buildingMode",
  "roadMode",
  "waterMode",
  "oceanMode",
  "lakeMode",
  "riverMode",
]);
const MASK_MODES = new Set(["interrupt", "amplify", "flatten", "glow", "outline", "invert"]);
const ANIMATION_MODES = new Set(["none", "drift", "draw", "parallax"]);

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Baseline params a URL's diff is computed against for the given style. */
export function resolveDefaultParams(styleId: string): StyleParams {
  return { ...defaultStyleParams, ...getStyle(styleId).defaultParams };
}

/** Params that differ from `defaults`, excluding seed/palette (explicit in the URL). */
export function paramsDiff(params: StyleParams, defaults: StyleParams): Partial<StyleParams> {
  const diff: Record<string, unknown> = {};
  for (const key of PARAM_KEYS) {
    if (key === "seed" || key === "palette") continue;
    if (params[key] !== defaults[key]) diff[key] = params[key];
  }
  return diff as Partial<StyleParams>;
}

/** Keeps only known param keys whose values have the right type and range. */
function sanitizeDiff(raw: unknown): Partial<StyleParams> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "seed" || key === "palette") continue;
    if (!(key in defaultStyleParams)) continue;
    const defaultValue = defaultStyleParams[key as keyof StyleParams];
    if (typeof value !== typeof defaultValue) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (key === "aspectRatio" && !(String(value) in ASPECT_RATIOS)) continue;
    if (MASK_MODE_KEYS.has(key) && !MASK_MODES.has(String(value))) continue;
    if (key === "animationMode" && !ANIMATION_MODES.has(String(value))) continue;
    out[key] = value;
  }
  return out as Partial<StyleParams>;
}

export function serializeShareState(state: ShareState): string {
  const { params, styleId, bounds, mapZoom } = state;
  const lat = (bounds.north + bounds.south) / 2;
  const lng = (bounds.east + bounds.west) / 2;
  const search = new URLSearchParams();
  search.set("lat", lat.toFixed(4));
  search.set("lng", lng.toFixed(4));
  // z is a camera nicety (b is the source of truth); 2 dp keeps URLs tidy.
  search.set("z", String(Math.round(mapZoom * 100) / 100));
  search.set("style", styleId);
  search.set("seed", params.seed);
  search.set("palette", params.palette);
  search.set(
    "b",
    [bounds.west, bounds.south, bounds.east, bounds.north].map((v) => v.toFixed(5)).join(","),
  );
  const diff = paramsDiff(params, resolveDefaultParams(styleId));
  if (Object.keys(diff).length > 0) {
    search.set("p", encodeBase64Url(JSON.stringify(diff)));
  }
  return search.toString();
}

export function parseShareParams(
  search: string | URLSearchParams,
  opts?: { isKnownPalette?: (id: string) => boolean },
): ParsedShareState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const isKnownPalette = opts?.isKnownPalette ?? (() => true);

  let styleId = DEFAULT_STYLE_ID;
  let params: StyleParams | null = null;

  // 1. Preset: establishes style + base params (input nicety, never written back).
  const presetId = sp.get("preset");
  if (presetId) {
    const preset = presets.find((p) => p.id === presetId);
    if (preset) {
      styleId = preset.styleId;
      params = applyPreset(preset, getStyle(preset.styleId).defaultParams);
    }
  }

  // 2. Explicit style wins over the preset's style.
  const style = sp.get("style");
  if (style && stylesById[style]) styleId = style;

  if (!params) params = resolveDefaultParams(styleId);

  // 3. Explicit seed/palette.
  const seed = sp.get("seed");
  if (seed) params = { ...params, seed };
  const palette = sp.get("palette");
  if (palette && isKnownPalette(palette)) params = { ...params, palette };

  // 4. The p diff wins last.
  const p = sp.get("p");
  if (p) {
    try {
      params = { ...params, ...sanitizeDiff(JSON.parse(decodeBase64Url(p))) };
    } catch {
      // Malformed p param — ignore it and keep the resolved params.
    }
  }

  let bounds: GeoBounds | null = null;
  const b = sp.get("b");
  if (b) {
    const parts = b.split(",").map((v) => parseFloat(v));
    if (parts.length === 4 && parts.every((v) => Number.isFinite(v))) {
      const [west, south, east, north] = parts;
      if (west < east && south < north && Math.abs(north) <= 90 && Math.abs(south) <= 90) {
        bounds = { west, south, east, north };
      }
    }
  }

  const lat = parseFloat(sp.get("lat") ?? "");
  const lng = parseFloat(sp.get("lng") ?? "");
  const z = parseFloat(sp.get("z") ?? "");
  const center: [number, number] | null =
    Number.isFinite(lat) && Number.isFinite(lng)
      ? [lng, lat]
      : bounds
        ? [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2]
        : null;

  return { styleId, params, bounds, center, zoom: Number.isFinite(z) ? z : null };
}
