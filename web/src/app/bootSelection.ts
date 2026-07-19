import type { AspectRatio, GeoBounds } from "../engine/types.ts";
import type { CuratedPlace } from "../data/places.ts";
import type { ParsedShareState } from "./urlState.ts";
import {
  deriveSelectionBounds,
  geoBoundsEquivalent,
  normalizeMapCenter,
  normalizeMapZoom,
  validateGeoBounds,
} from "./stateSafety.ts";

export const DEFAULT_CENTER: [number, number] = [-122.4194, 37.7749];
export const DEFAULT_ZOOM = 11;

export type BootSelection = {
  bounds: GeoBounds;
  center: [number, number];
  zoom: number;
};

/**
 * Resolves geography before MapLibre exists. Exact validated share bounds win;
 * otherwise center/zoom deterministically produce the first terrain selection.
 */
export function resolveBootSelection(
  url: Pick<ParsedShareState, "bounds" | "center" | "zoom">,
  place: Pick<CuratedPlace, "center" | "zoom"> | null,
  aspectRatio: AspectRatio = "square",
): BootSelection {
  const center = normalizeMapCenter(url.center ?? place?.center ?? DEFAULT_CENTER, DEFAULT_CENTER);
  const zoom = normalizeMapZoom(url.zoom ?? place?.zoom ?? DEFAULT_ZOOM, DEFAULT_ZOOM);
  return {
    bounds: url.bounds ?? deriveSelectionBounds(center, zoom, aspectRatio),
    center,
    zoom,
  };
}

export function claimInitialGeneration(started: { current: boolean }): boolean {
  if (started.current) return false;
  started.current = true;
  return true;
}

export type MapSelectionReconciliation = {
  bounds: GeoBounds;
  zoom: number;
  changed: boolean;
};

/** A fly-to is acknowledged only by a report at its requested center/zoom. */
export function mapSelectionAcknowledgesFlyTo(
  selection: Pick<MapSelectionReconciliation, "bounds" | "zoom">,
  request: { center: [number, number]; zoom: number; bounds?: GeoBounds },
  centerEpsilon = 0.001,
  zoomEpsilon = 0.05,
): boolean {
  // Composition restores fit exact geographic bounds. The resulting MapLibre
  // zoom is viewport-dependent and must not keep the restore request pending.
  if (request.bounds && geoBoundsEquivalent(selection.bounds, request.bounds)) {
    return true;
  }
  const centerLng = (selection.bounds.west + selection.bounds.east) / 2;
  const centerLat = (selection.bounds.south + selection.bounds.north) / 2;
  const longitudeDelta = Math.abs(
    ((centerLng - request.center[0] + 540) % 360) - 180,
  );
  return (
    longitudeDelta <= centerEpsilon &&
    Math.abs(centerLat - request.center[1]) <= centerEpsilon &&
    Math.abs(selection.zoom - request.zoom) <= zoomEpsilon
  );
}

/** Validates a map report and identifies equal boot-bound synchronization. */
export function reconcileMapSelection(
  activeBounds: GeoBounds,
  reportedBounds: unknown,
  reportedZoom: unknown,
  fallbackZoom: number,
): MapSelectionReconciliation | null {
  const bounds = validateGeoBounds(reportedBounds);
  if (!bounds) return null;
  return {
    bounds,
    zoom: normalizeMapZoom(reportedZoom, fallbackZoom),
    changed: !geoBoundsEquivalent(activeBounds, bounds),
  };
}
