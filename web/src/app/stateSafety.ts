import type {
  AnimationMode,
  AspectRatio,
  GeoBounds,
  LabelStyle,
  MaskMode,
  StyleParams,
} from "../engine/types.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import { getContainedFrameDimensions } from "./aspect.ts";

export const WEB_MERCATOR_MAX_LAT = 85.05112878;
export const MIN_MAP_ZOOM = 0;
export const MAX_MAP_ZOOM = 22;
export const MAX_SEED_LENGTH = 128;
export const MAX_LABEL_LENGTH = 256;
export const MAX_PALETTE_ID_LENGTH = 128;
export const MAX_SEARCH_QUERY_LENGTH = 200;
export const MAX_SHARE_PAYLOAD_LENGTH = 16_384;

/**
 * MapLibre defines zoom against a 512 px world tile. The viewfinder selection
 * is 70% of the historical 240 px desktop locator, so this fixed span keeps
 * center/zoom boot URLs deterministic instead of depending on viewport size.
 */
export const BOOT_SELECTION_SIZE_PX = 168;
const MAPLIBRE_WORLD_TILE_SIZE = 512;

type SelectionFrame = number | AspectRatio | { width: number; height: number };

function selectionFrameDimensions(frame: SelectionFrame): { width: number; height: number } {
  if (typeof frame === "number") {
    const size = Number.isFinite(frame)
      ? clamp(frame, 1, MAPLIBRE_WORLD_TILE_SIZE)
      : BOOT_SELECTION_SIZE_PX;
    return { width: size, height: size };
  }
  if (typeof frame === "string") {
    return getContainedFrameDimensions(
      BOOT_SELECTION_SIZE_PX,
      BOOT_SELECTION_SIZE_PX,
      frame,
      1,
    );
  }
  const width = Number.isFinite(frame.width)
    ? clamp(frame.width, 1, MAPLIBRE_WORLD_TILE_SIZE)
    : BOOT_SELECTION_SIZE_PX;
  const height = Number.isFinite(frame.height)
    ? clamp(frame.height, 1, MAPLIBRE_WORLD_TILE_SIZE)
    : BOOT_SELECTION_SIZE_PX;
  return { width, height };
}

const MASK_MODES = new Set<MaskMode>([
  "interrupt",
  "amplify",
  "flatten",
  "glow",
  "outline",
  "invert",
]);
const ASPECT_RATIOS = new Set<AspectRatio>(["square", "16:9", "9:16", "12:18"]);
const LABEL_STYLES = new Set<LabelStyle>(["plain", "poster"]);
const ANIMATION_MODES = new Set<AnimationMode>(["none", "drift", "draw", "parallax"]);

const NUMBER_RANGES = {
  amplitude: [0, 120],
  spacing: [1, 30],
  lineWidth: [0.5, 5],
  noise: [0, 1],
  detail: [0.1, 1],
  compression: [0.5, 2],
  buildingInfluence: [0, 100],
  roadInfluence: [0, 100],
  waterInfluence: [0, 100],
  oceanInfluence: [0, 100],
  lakeInfluence: [0, 100],
  riverInfluence: [0, 100],
  grain: [0, 1],
  rotation: [0, 360],
  occlusion: [0, 1],
  phase: [0, 1 - Number.EPSILON],
  animationSpeed: [0.05, 1],
} as const satisfies Record<
  | "amplitude"
  | "spacing"
  | "lineWidth"
  | "noise"
  | "detail"
  | "compression"
  | "buildingInfluence"
  | "roadInfluence"
  | "waterInfluence"
  | "oceanInfluence"
  | "lakeInfluence"
  | "riverInfluence"
  | "grain"
  | "rotation"
  | "occlusion"
  | "phase"
  | "animationSpeed",
  readonly [number, number]
>;

type NumericParam = keyof typeof NUMBER_RANGES;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeNumber(value: unknown, fallback: number, range: readonly [number, number]): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, range[0], range[1])
    : fallback;
}

function normalizeString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : fallback;
}

function normalizeEnum<T extends string>(value: unknown, fallback: T, allowed: ReadonlySet<T>): T {
  return typeof value === "string" && allowed.has(value as T) ? (value as T) : fallback;
}

/**
 * Normalizes every composition field at a state boundary. Unknown keys are
 * ignored, numeric controls use their real UI ranges, and invalid enum/type
 * values fall back to the previous trusted composition.
 */
export function normalizeStyleParams(
  value: unknown,
  fallback: StyleParams = defaultStyleParams,
): StyleParams {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<Record<keyof StyleParams, unknown>>)
    : {};
  const out = { ...fallback };

  for (const key of Object.keys(NUMBER_RANGES) as NumericParam[]) {
    out[key] = normalizeNumber(raw[key], fallback[key], NUMBER_RANGES[key]);
  }

  out.seed = normalizeString(raw.seed, fallback.seed, MAX_SEED_LENGTH);
  out.palette = normalizeString(raw.palette, fallback.palette, MAX_PALETTE_ID_LENGTH);
  out.label = normalizeString(raw.label, fallback.label, MAX_LABEL_LENGTH);
  out.buildingMode = normalizeEnum(raw.buildingMode, fallback.buildingMode, MASK_MODES);
  out.roadMode = normalizeEnum(raw.roadMode, fallback.roadMode, MASK_MODES);
  out.waterMode = normalizeEnum(raw.waterMode, fallback.waterMode, MASK_MODES);
  out.oceanMode = normalizeEnum(raw.oceanMode, fallback.oceanMode, MASK_MODES);
  out.lakeMode = normalizeEnum(raw.lakeMode, fallback.lakeMode, MASK_MODES);
  out.riverMode = normalizeEnum(raw.riverMode, fallback.riverMode, MASK_MODES);
  out.aspectRatio = normalizeEnum(raw.aspectRatio, fallback.aspectRatio, ASPECT_RATIOS);
  out.labelStyle = normalizeEnum(raw.labelStyle, fallback.labelStyle, LABEL_STYLES);
  out.animationMode = normalizeEnum(
    raw.animationMode,
    fallback.animationMode,
    ANIMATION_MODES,
  );
  out.transparent = typeof raw.transparent === "boolean" ? raw.transparent : fallback.transparent;

  return out;
}

/** Constant-time longitude wrapping; positive 180 stays on the positive edge. */
export function wrapLongitude(lng: number): number {
  if (!Number.isFinite(lng)) return 0;
  if (lng >= -180 && lng <= 180) return lng;
  const wrapped = ((lng + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 && lng > 0 ? 180 : wrapped;
}

export function clampMercatorLatitude(lat: number): number {
  if (!Number.isFinite(lat)) return 0;
  return clamp(lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
}

export function normalizeMapZoom(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, MIN_MAP_ZOOM, MAX_MAP_ZOOM)
    : fallback;
}

export function normalizeMapCenter(
  value: unknown,
  fallback: [number, number],
): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  const [lng, lat] = value;
  if (typeof lng !== "number" || typeof lat !== "number") return fallback;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return fallback;
  return [wrapLongitude(lng), clampMercatorLatitude(lat)];
}

/**
 * Validates exact share bounds without changing them. This is deliberately
 * stricter than normalizeMapCenter so a valid `b` remains byte-for-byte exact
 * while malformed/out-of-Mercator selections are ignored.
 */
export function validateGeoBounds(value: unknown): GeoBounds | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<Record<keyof GeoBounds, unknown>>;
  const west = raw.west;
  const south = raw.south;
  const east = raw.east;
  const north = raw.north;
  if (
    typeof west !== "number" ||
    typeof south !== "number" ||
    typeof east !== "number" ||
    typeof north !== "number" ||
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north)
  ) {
    return null;
  }
  if (west < -180 || east > 180 || west >= east) return null;
  if (
    south < -WEB_MERCATOR_MAX_LAT ||
    north > WEB_MERCATOR_MAX_LAT ||
    south >= north
  ) {
    return null;
  }
  return { west, south, east, north };
}

function mercatorY(lat: number): number {
  const radians = (clampMercatorLatitude(lat) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}

function latitudeFromMercatorY(y: number): number {
  const n = Math.PI - 2 * Math.PI * clamp(y, 0, 1);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/**
 * Pure deterministic selection for fresh and legacy center/zoom boots. Exact
 * validated share bounds bypass this helper and remain the source of truth.
 */
export function deriveSelectionBounds(
  center: [number, number],
  zoom: number,
  frame: SelectionFrame = BOOT_SELECTION_SIZE_PX,
): GeoBounds {
  const [lng, lat] = normalizeMapCenter(center, [0, 0]);
  const safeZoom = normalizeMapZoom(zoom, 11);
  const { width, height } = selectionFrameDimensions(frame);
  const worldSize = MAPLIBRE_WORLD_TILE_SIZE * 2 ** safeZoom;
  const halfWorldX = width / 2 / worldSize;
  const halfWorldY = height / 2 / worldSize;
  const halfLongitude = halfWorldX * 360;
  const centerY = mercatorY(lat);

  return {
    west: Math.max(-180, lng - halfLongitude),
    east: Math.min(180, lng + halfLongitude),
    north: latitudeFromMercatorY(centerY - halfWorldY),
    south: latitudeFromMercatorY(centerY + halfWorldY),
  };
}

export function geoBoundsEquivalent(a: GeoBounds, b: GeoBounds, epsilon = 0.00002): boolean {
  return (
    Math.abs(a.west - b.west) <= epsilon &&
    Math.abs(a.south - b.south) <= epsilon &&
    Math.abs(a.east - b.east) <= epsilon &&
    Math.abs(a.north - b.north) <= epsilon
  );
}

export function sanitizeSearchQuery(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_SEARCH_QUERY_LENGTH) : "";
}
