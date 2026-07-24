import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { bboxAreaKm2, isBboxSmallEnough } from "../data/osmOverpass.ts";
import { CURATED_PLACES, surprisePlace, type CuratedPlace } from "../data/places.ts";
import {
  deriveSelectionBounds,
  MAX_SEARCH_QUERY_LENGTH,
  normalizeMapCenter,
  normalizeMapZoom,
  sanitizeSearchQuery,
} from "../app/stateSafety.ts";
import type { MapSelectionCause, MapSelectionProps } from "./mapSelectionTypes.ts";
import { useNominatimSearch } from "../app/useNominatimSearch.ts";

function fmtDeg(value: number): string {
  return value.toFixed(4).replace(/-/g, "−");
}

type Props = MapSelectionProps & {
  reason?: string;
  onRetry?: () => void;
};

/**
 * Functional location picker used when WebGL, OpenFreeMap, MapLibre startup,
 * or the lazy map chunk is unavailable. Artwork generation never depends on
 * this surface; it can still choose deterministic curated/search selections.
 */
export function NoMapFallback({
  aspectRatio,
  onChange,
  bounds,
  zoom,
  expanded,
  onToggleExpand,
  activePlaceId = null,
  onSelectPlace,
  flyTo = null,
  reason = "Interactive map unavailable",
  onRetry,
}: Props) {
  const [query, setQuery] = useState("");
  const handledFlyToKeyRef = useRef<number | null>(null);
  const previousAspectRef = useRef(aspectRatio);

  const selectCenter = useCallback(
    (
      center: [number, number],
      requestedZoom: number,
      cause: MapSelectionCause,
    ) => {
      const safeZoom = normalizeMapZoom(requestedZoom, zoom);
      const safeCenter = normalizeMapCenter(center, [
        (bounds.west + bounds.east) / 2,
        (bounds.south + bounds.north) / 2,
      ]);
      onChange(
        deriveSelectionBounds(safeCenter, safeZoom, aspectRatio),
        safeZoom,
        cause,
      );
    },
    [aspectRatio, bounds, onChange, zoom],
  );

  const handleSearchResult = useCallback(
    (result: { lat: number; lng: number }) => {
      selectCenter([result.lng, result.lat], 16, "search");
    },
    [selectCenter],
  );
  const locationSearch = useNominatimSearch({ onResult: handleSearchResult });

  const selectPlace = useCallback(
    (place: CuratedPlace) => {
      locationSearch.dismiss();
      onSelectPlace?.(place);
      selectCenter(place.center, place.zoom, "curated");
    },
    [locationSearch, onSelectPlace, selectCenter],
  );

  const handleSearch = useCallback(
    (rawQuery: string) => {
      const trimmed = sanitizeSearchQuery(rawQuery);
      if (trimmed) void locationSearch.search(trimmed);
    },
    [locationSearch],
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void handleSearch(query);
    },
    [handleSearch, query],
  );

  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      locationSearch.edited();
      setQuery(event.target.value.slice(0, MAX_SEARCH_QUERY_LENGTH));
    },
    [locationSearch],
  );

  useEffect(() => {
    if (!flyTo || handledFlyToKeyRef.current === flyTo.key) return;
    handledFlyToKeyRef.current = flyTo.key;
    if (flyTo.bounds) {
      onChange(flyTo.bounds, flyTo.zoom, "restore");
    } else {
      selectCenter(flyTo.center, flyTo.zoom, "curated");
    }
  }, [flyTo, onChange, selectCenter]);

  useEffect(() => {
    if (previousAspectRef.current === aspectRatio) return;
    previousAspectRef.current = aspectRatio;
    selectCenter(
      [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2],
      zoom,
      "aspect",
    );
  }, [aspectRatio, bounds, selectCenter, zoom]);

  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;
  const areaKm2 = bboxAreaKm2(bounds);
  const osmEligible = isBboxSmallEnough(bounds);

  return (
    <div className="flex h-full w-full flex-col bg-surface" aria-label="Map unavailable">
      <div className={`shrink-0 border-b border-hairline ${expanded ? "" : "max-lg:hidden"}`}>
        <div className="flex min-h-11 items-center gap-2 px-3">
          <p className="instrument-label min-w-0 flex-1 truncate text-ink-muted">
            {fmtDeg(centerLat)} {fmtDeg(centerLng)} · Z{Math.round(zoom)} ·{" "}
            <span className={osmEligible ? "text-ok" : "text-ink-faint"}>
              {areaKm2.toFixed(1)} KM²
            </span>
          </p>
          <button
            type="button"
            onClick={() => selectPlace(surprisePlace(activePlaceId ?? undefined))}
            aria-label="Surprise me"
            title="Surprise me"
            className="flex h-11 w-11 shrink-0 items-center justify-center text-[17px] text-ink-muted press hover:bg-surface-2 hover:text-ink"
          >
            <span aria-hidden="true">⚄</span>
          </button>
          <button
            type="button"
            onClick={(event) => onToggleExpand(event.currentTarget)}
            aria-label={expanded ? "Collapse map" : "Expand map"}
            aria-expanded={expanded}
            className="flex h-11 w-11 shrink-0 items-center justify-center text-[15px] text-ink-muted press hover:bg-surface-2 hover:text-ink"
          >
            <span aria-hidden="true">{expanded ? "✕" : "⤢"}</span>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex items-center border-t border-hairline">
          <input
            type="text"
            data-map-initial-focus
            aria-label="Search for a location"
            value={query}
            onChange={handleQueryChange}
            maxLength={MAX_SEARCH_QUERY_LENGTH}
            placeholder="Search place…"
            enterKeyHint="search"
            className="h-10 min-w-0 flex-1 bg-transparent px-3 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:bg-surface-2"
          />
          <button
            type="submit"
            aria-label="Search"
            className="instrument-label press flex h-10 shrink-0 items-center px-3 text-ink-muted hover:text-ink"
          >
            <span aria-hidden="true" className="text-[14px]">⏎</span>
          </button>
        </form>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden bg-ground p-3 text-center">
        <div role="status" className="flex max-w-md flex-col items-center gap-2">
          <p className="instrument-label text-amber">Map unavailable</p>
          <p className={`text-[12px] leading-snug text-ink-muted ${expanded ? "" : "max-lg:hidden"}`}>
            {reason}. Artwork generation and location choices still work.
          </p>
          {locationSearch.state.phase !== "idle" && (
            <div className="flex flex-wrap items-center justify-center gap-2 text-[12px] text-ink" aria-live="polite">
              <span>
                {locationSearch.state.phase === "loading"
                  ? "Searching…"
                  : locationSearch.state.message}
              </span>
              {locationSearch.state.phase === "loading" && (
                <button type="button" onClick={locationSearch.cancel} className="text-ink-muted hover:text-ink">
                  Cancel
                </button>
              )}
              {locationSearch.state.phase === "error" && (
                <>
                  <button type="button" onClick={locationSearch.retry} className="text-signal hover:underline">
                    Retry
                  </button>
                  <button type="button" onClick={locationSearch.dismiss} className="text-ink-muted hover:text-ink">
                    Dismiss
                  </button>
                </>
              )}
            </div>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="instrument-label flex min-h-9 items-center rounded-sm border border-hairline-2 px-3 text-ink press hover:bg-surface-2"
            >
              Retry map
            </button>
          )}
        </div>

        {expanded && (
          <div
            role="group"
            aria-label="Curated places"
            className="mt-4 grid max-h-[55%] w-full max-w-3xl grid-cols-2 gap-1.5 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4"
          >
            {CURATED_PLACES.map((place) => {
              const active = place.id === activePlaceId;
              return (
                <button
                  key={place.id}
                  type="button"
                  onClick={() => selectPlace(place)}
                  aria-pressed={active}
                  title={place.blurb}
                  className={`flex min-h-11 flex-col items-start justify-center rounded-sm border bg-surface px-3 py-1.5 text-left press ${
                    active
                      ? "border-signal"
                      : "border-hairline hover:border-hairline-2 hover:bg-surface-2"
                  }`}
                >
                  <span className="instrument-label text-ink">{place.name}</span>
                  <span className="instrument-label text-ink-faint">{place.region}</span>
                </button>
              );
            })}
          </div>
        )}

        {!expanded && (
          <button
            type="button"
            onClick={(event) => onToggleExpand(event.currentTarget)}
            aria-label="Expand map"
            aria-expanded={false}
            className="absolute inset-0 z-10 flex items-end justify-end p-1 lg:hidden"
          >
            <span
              aria-hidden="true"
              className="flex h-6 w-6 items-center justify-center rounded-sm border border-hairline-2 bg-ground/80 text-[12px] text-ink-muted"
            >
              ⤢
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
