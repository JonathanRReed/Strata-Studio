/**
 * Autopilot: the pure decision logic behind the zero-friction flows.
 *
 * - First-run: a fresh visit (no share params) starts on the daily curated
 *   place and auto-generates on the map's first bounds report.
 * - Influence bump: when OSM features first arrive and the user hasn't
 *   engaged any feature influence, nudge the style-supported influences to
 *   tasteful defaults so the app's signature trick is visible by default.
 *
 * Everything here is pure so App.tsx stays a thin wiring layer and the
 * decisions are unit-testable.
 */
import type { ControlKey, StyleParams } from "../engine/types.ts";
import { parseShareParams } from "./urlState.ts";
import { dailyPlace, type CuratedPlace } from "../data/places.ts";

/** Debounce between the last map-bounds change and the live auto-regenerate. */
export const AUTO_REGEN_DEBOUNCE_MS = 800;

/** Query keys that mark a URL as carrying share state (see urlState.ts). */
const SHARE_KEYS = ["lat", "lng", "z", "b", "style", "seed", "palette", "p", "preset"] as const;

export const INFLUENCE_KEYS = [
  "buildingInfluence",
  "roadInfluence",
  "waterInfluence",
  "oceanInfluence",
  "lakeInfluence",
  "riverInfluence",
] as const satisfies readonly ControlKey[];

const MODE_KEYS = [
  "buildingMode",
  "roadMode",
  "waterMode",
  "oceanMode",
  "lakeMode",
  "riverMode",
] as const;

/** True when the URL carries any share state (a returning/shared visit). */
export function hasShareState(search: string | URLSearchParams): boolean {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  return SHARE_KEYS.some((key) => sp.has(key));
}

/**
 * First-run decision: the daily curated place on a fresh visit, or null when
 * the URL carries share state (that visit restores exactly what it encodes).
 */
export function firstRunPlace(
  search: string | URLSearchParams,
  today: Date = new Date(),
): CuratedPlace | null {
  return hasShareState(search) ? null : dailyPlace(today);
}

/**
 * True when the URL's `p` diff encodes any feature-influence param (value or
 * mask mode). Those count as explicit user choices — including deliberate
 * zeros — so the influence bump must never fight them.
 *
 * Detection reuses parseShareParams: parse with and without `p` and compare
 * the influence-related keys, so sanitization rules stay in one place.
 */
export function urlLocksInfluence(search: string | URLSearchParams): boolean {
  const sp = new URLSearchParams(typeof search === "string" ? search : search.toString());
  if (!sp.has("p")) return false;
  const withDiff = parseShareParams(sp).params;
  const noDiffSp = new URLSearchParams(sp);
  noDiffSp.delete("p");
  const withoutDiff = parseShareParams(noDiffSp).params;
  return [...INFLUENCE_KEYS, ...MODE_KEYS].some((key) => withDiff[key] !== withoutDiff[key]);
}

/**
 * Influence-bump defaults, sized against the shipped presets (the
 * interference-map preset runs buildings 90 / roads 40; these sit at half
 * strength so the effect reads clearly without dominating the terrain).
 */
export const INFLUENCE_BUMP = {
  buildingInfluence: 45,
  roadInfluence: 25,
  waterInfluence: 35,
} as const;

/**
 * Computes the one-time influence bump applied when OSM features arrive.
 *
 * Returns a params patch, or null when no bump should happen:
 * - the style declares no influence controls, or
 * - any declared influence is already nonzero (a preset or the user has
 *   already engaged features — never fight that).
 *
 * Only influences whose ControlKey the style declares are set. Buildings get
 * interrupt mode (the signature line-break trick); road/water modes keep
 * their defaults. Per-type water (ocean/lake/river) is left at 0 — the
 * combined waterInfluence covers all water until the user opts into
 * per-type control.
 */
export function computeInfluenceBump(
  params: StyleParams,
  controls: readonly ControlKey[] | undefined,
): Partial<StyleParams> | null {
  // Mirrors the ControlsPanel fallback: styles without an explicit controls
  // list expose every control, influences included.
  const declared = controls ? new Set<ControlKey>(controls) : new Set<ControlKey>(INFLUENCE_KEYS);
  const relevant = INFLUENCE_KEYS.filter((key) => declared.has(key));
  if (relevant.length === 0) return null;
  if (relevant.some((key) => params[key] !== 0)) return null;

  const bump: Partial<StyleParams> = {};
  if (declared.has("buildingInfluence")) {
    bump.buildingInfluence = INFLUENCE_BUMP.buildingInfluence;
    bump.buildingMode = "interrupt";
  }
  if (declared.has("roadInfluence")) bump.roadInfluence = INFLUENCE_BUMP.roadInfluence;
  if (declared.has("waterInfluence")) bump.waterInfluence = INFLUENCE_BUMP.waterInfluence;
  return Object.keys(bump).length > 0 ? bump : null;
}
