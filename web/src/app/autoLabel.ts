import type { GeoBounds } from "../engine/types.ts";

/**
 * Auto-label: pure rules behind the poster-label auto-fill. A resolved place
 * name (reverse geocode or curated place) may only land on the label when
 * the user hasn't claimed it.
 */

/**
 * True when an auto-resolved name may fill the label: the field is empty
 * (including whitespace) or still holds the previous auto-fill verbatim.
 * A user-typed label is never overwritten; clearing the field re-arms
 * auto-fill for the next generate.
 */
export function shouldAutoFill(currentLabel: string, lastAutoLabel: string | null): boolean {
  const trimmed = currentLabel.trim();
  if (trimmed === "") return true;
  return lastAutoLabel !== null && trimmed === lastAutoLabel;
}

/** Geographic center of a bounds box. */
export function boundsCenter(bounds: GeoBounds): { lat: number; lng: number } {
  return {
    lat: (bounds.north + bounds.south) / 2,
    lng: (bounds.east + bounds.west) / 2,
  };
}

/**
 * Cache key for a resolved center: 2-decimal (~1 km) buckets, so re-settling
 * on the same spot reuses the name instead of re-querying Nominatim.
 */
export function centerCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}
