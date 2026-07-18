import type { GeoBounds, StyleParams } from "../engine/types.ts";
import type { CustomPaletteEntry } from "../presets/customPalettes.ts";
import { applyPreset, defaultStyleParams, presets } from "../presets/stylePresets.ts";
import {
  COMPOSITION_QUERY_KEY,
  createCompositionDocument,
  decodeCompositionFromUrl,
  encodeCompositionForUrl,
} from "./composition.ts";
import { DEFAULT_STYLE_ID, getStyle, stylesById } from "../studios/registry.ts";
import {
  MAX_SHARE_PAYLOAD_LENGTH,
  normalizeMapCenter,
  normalizeMapZoom,
  normalizeStyleParams,
  validateGeoBounds,
} from "./stateSafety.ts";

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
  selectedCustomPalette?: CustomPaletteEntry | null;
};

export type ParsedShareState = {
  styleId: string;
  params: StyleParams;
  /** Exact selection bounds from a versioned document or legacy `b`. */
  bounds: GeoBounds | null;
  /** Map camera center [lng, lat], from the document, lat/lng, or legacy `b`. */
  center: [number, number] | null;
  zoom: number | null;
  /** Embedded cross-profile palette, already canonicalized to its content id. */
  customPalette: { id: string; entry: CustomPaletteEntry } | null;
};

const PARAM_KEYS = Object.keys(defaultStyleParams) as (keyof StyleParams)[];

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseQueryNumber(value: string | null): number {
  if (value === null || value.trim() === "") return Number.NaN;
  return Number(value);
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

/** Keeps only known diff keys, then applies the central composition normalizer. */
function sanitizeDiff(raw: unknown, fallback: StyleParams): Partial<StyleParams> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const candidate: Partial<Record<keyof StyleParams, unknown>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "seed" || key === "palette") continue;
    if (!(key in defaultStyleParams)) continue;
    candidate[key as keyof StyleParams] = value;
  }
  const normalized = normalizeStyleParams({ ...fallback, ...candidate }, fallback);
  const out: Partial<StyleParams> = {};
  for (const key of Object.keys(candidate) as (keyof StyleParams)[]) {
    Object.assign(out, { [key]: normalized[key] });
  }
  return out;
}

export function serializeShareState(state: ShareState): string {
  const document = createCompositionDocument(state);
  const search = new URLSearchParams();
  search.set(COMPOSITION_QUERY_KEY, encodeCompositionForUrl(document));
  return search.toString();
}

export function parseShareParams(
  search: string | URLSearchParams,
  opts?: { isKnownPalette?: (id: string) => boolean },
): ParsedShareState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const isKnownPalette = opts?.isKnownPalette ?? (() => true);

  const encodedComposition = sp.get(COMPOSITION_QUERY_KEY);
  if (encodedComposition) {
    try {
      const document = decodeCompositionFromUrl(encodedComposition);
      const center: [number, number] = [
        (document.bounds.west + document.bounds.east) / 2,
        (document.bounds.south + document.bounds.north) / 2,
      ];
      return {
        styleId: document.style,
        params: document.params,
        bounds: document.bounds,
        center,
        zoom: document.zoom,
        customPalette: document.customPalette
          ? {
              id: document.customPalette.id,
              entry: {
                name: document.customPalette.name,
                palette: document.customPalette.definition,
              },
            }
          : null,
      };
    } catch {
      // Invalid versioned data falls through to the legacy parser so mixed old
      // links remain recoverable without ever partially applying the document.
    }
  }

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
  if (seed !== null) params = { ...params, seed };
  const palette = sp.get("palette");
  if (palette && isKnownPalette(palette)) params = { ...params, palette };

  // 4. The p diff wins last.
  const p = sp.get("p");
  if (p && p.length <= MAX_SHARE_PAYLOAD_LENGTH) {
    try {
      params = { ...params, ...sanitizeDiff(JSON.parse(decodeBase64Url(p)), params) };
    } catch {
      // Malformed p param — ignore it and keep the resolved params.
    }
  }
  params = normalizeStyleParams(params, resolveDefaultParams(styleId));

  let bounds: GeoBounds | null = null;
  const b = sp.get("b");
  if (b && b.length <= 256) {
    const rawParts = b.split(",");
    if (rawParts.length === 4 && rawParts.every((value) => value.trim() !== "")) {
      const [west, south, east, north] = rawParts.map(Number);
      bounds = validateGeoBounds({ west, south, east, north });
    }
  }

  const lat = parseQueryNumber(sp.get("lat"));
  const lng = parseQueryNumber(sp.get("lng"));
  const z = parseQueryNumber(sp.get("z"));
  const center: [number, number] | null =
    Number.isFinite(lat) && Number.isFinite(lng)
      ? normalizeMapCenter([lng, lat], [0, 0])
      : bounds
        ? [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2]
        : null;
  const zoom = Number.isFinite(z) ? normalizeMapZoom(z, 11) : null;

  return { styleId, params, bounds, center, zoom, customPalette: null };
}
