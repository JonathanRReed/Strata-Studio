import type { MapSelectionCause } from "./mapSelectionTypes.ts";

/** Separate user gestures from MapLibre's programmatic and resize echoes. */
export function resolveMapMoveCause(
  pending: MapSelectionCause | null,
  originalEvent?: unknown,
): MapSelectionCause {
  if (originalEvent) return "manual";
  return pending ?? "restore";
}
