/**
 * Reverse geocoding via Nominatim, for suggesting a poster title from the
 * selected map area. Deliberately NOT wired into any flow yet — App-side
 * integration happens separately. Usage-policy compliant: one request per
 * call, no retries, zoom=10 (city scale), errors resolve to null.
 */

const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

/** Locality-level address fields, in preference order. */
const PLACE_FIELDS = ["city", "town", "village", "county"] as const;

type NominatimReverseResponse = {
  display_name?: string;
  address?: Record<string, string>;
  error?: string;
};

/**
 * Short display name from a Nominatim reverse-geocode payload: the first
 * locality-level address field (city > town > village > county), falling
 * back to the first display_name segment. Null when the payload has neither
 * (including Nominatim's `{ error }` responses).
 */
export function pickPlaceName(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as NominatimReverseResponse;
  if (typeof data.error === "string") return null;
  const address = data.address;
  if (address && typeof address === "object") {
    for (const field of PLACE_FIELDS) {
      const value = address[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  if (typeof data.display_name === "string") {
    const first = data.display_name.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

/**
 * Reverse-geocodes a coordinate to a short place name (city/locality level).
 * Resolves to null on any failure — network errors, non-2xx responses,
 * malformed payloads, or aborts — so callers can treat the name as a pure
 * nice-to-have. Never retries (Nominatim usage policy).
 */
export async function reverseGeocodeName(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("zoom", "10");
  url.searchParams.set("lat", lat.toFixed(5));
  url.searchParams.set("lon", lng.toFixed(5));
  try {
    const res = await fetch(url, {
      signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return pickPlaceName(await res.json());
  } catch {
    return null;
  }
}
