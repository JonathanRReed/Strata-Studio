import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ChangeEvent,
  type FormEvent,
} from "react";
import maplibregl from "maplibre-gl";
import type { GeoBounds } from "../engine/types.ts";
import { normalizeBounds } from "../engine/projection.ts";
import { bboxAreaKm2, isBboxSmallEnough } from "../data/osmOverpass.ts";
import { CURATED_PLACES, surprisePlace, type CuratedPlace } from "../data/places.ts";

import "maplibre-gl/dist/maplibre-gl.css";

// OpenFreeMap vector basemap (free, keyless, commercial use allowed).
// Swappable: other styles include /styles/positron, /styles/bright,
// /styles/liberty, and /styles/fiord.
export const BASEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

function getSquareBounds(map: maplibregl.Map): GeoBounds {
  const center = map.project(map.getCenter());
  const container = map.getContainer();
  const size = Math.min(container.clientWidth, container.clientHeight) * 0.7;
  const half = size / 2;

  const topLeft = map.unproject([center.x - half, center.y - half]);
  const topRight = map.unproject([center.x + half, center.y - half]);
  const bottomRight = map.unproject([center.x + half, center.y + half]);

  return normalizeBounds({
    west: topLeft.lng,
    north: topLeft.lat,
    east: topRight.lng,
    south: bottomRight.lat,
  });
}

/** Instrument readout formatting: real minus sign, fixed decimals. */
function fmtDeg(value: number): string {
  return value.toFixed(4).replace(/-/g, "−");
}

/** Below-lg check (Tailwind lg = 64rem); read at event time, not reactively. */
function isCompactViewport(): boolean {
  return window.matchMedia("(max-width: 63.999rem)").matches;
}

/** One imperative fly-to request; `key` distinguishes repeat requests. */
export type FlyToRequest = {
  /** [lng, lat] — MapLibre order. */
  center: [number, number];
  zoom: number;
  key: number;
};

type Props = {
  initialCenter?: [number, number];
  initialZoom?: number;
  /** When provided, fit the selection square to these bounds on load (share-URL restore). */
  initialBounds?: GeoBounds | null;
  onChange: (bounds: GeoBounds, zoom: number) => void;
  /** Current selection, echoed back for the header readout. */
  bounds: GeoBounds;
  zoom: number;
  /** Whether the viewfinder is in its large-overlay state (chrome + map.resize). */
  expanded: boolean;
  onToggleExpand: () => void;
  /** Last curated place chosen; its chip renders active (border-signal). */
  activePlaceId?: string | null;
  /** Called when a curated place is chosen (chip or Surprise Me) — the map
   * flies there itself; the parent applies the place's preset. */
  onSelectPlace?: (place: CuratedPlace) => void;
  /** Fly-to requests from outside the map (mobile sheet place picks). */
  flyTo?: FlyToRequest | null;
};

export default function MapSelector({
  initialCenter = [-122.4194, 37.7749],
  initialZoom = 11,
  initialBounds = null,
  onChange,
  bounds,
  zoom,
  expanded,
  onToggleExpand,
  activePlaceId = null,
  onSelectPlace,
  flyTo = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Initial-only prop: read via ref so it doesn't retrigger the map effect.
  const initialBoundsRef = useRef(initialBounds);
  // Last selection reported from a real framing (load/moveend) — never from a
  // resize — so mobile expand/collapse can restore it (see handleResize).
  const lastSelectionRef = useRef<GeoBounds | null>(null);

  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showResultMarker, setShowResultMarker] = useState(false);

  const queryRef = useRef("");
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentControllerRef = useRef<AbortController | null>(null);
  const searchIdRef = useRef(0);

  const searchLocation = useCallback(async (rawQuery: string) => {
    const trimmed = rawQuery.trim();
    if (!trimmed) return;

    const id = ++searchIdRef.current;
    setLoading(true);
    setMessage(null);
    if (messageTimeoutRef.current !== null) {
      clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = null;
    }

    currentControllerRef.current?.abort();
    const controller = new AbortController();
    currentControllerRef.current = controller;

    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
        trimmed
      )}`;
      const response = await fetch(url, { signal: controller.signal });
      if (id !== searchIdRef.current) return;
      if (!response.ok) throw new Error("Search failed");

      const results = (await response.json()) as Array<{
        lat: string;
        lon: string;
        display_name?: string;
      }>;
      if (id !== searchIdRef.current) return;
      if (!results.length) {
        setMessage("No results");
        messageTimeoutRef.current = setTimeout(() => setMessage(null), 2000);
        return;
      }

      const lat = parseFloat(results[0].lat);
      const lon = parseFloat(results[0].lon);
      if (Number.isNaN(lat) || Number.isNaN(lon)) {
        throw new Error("Invalid coordinates");
      }

      const map = mapRef.current;
      if (!map) {
        setMessage("No results");
        messageTimeoutRef.current = setTimeout(() => setMessage(null), 2000);
        return;
      }

      map.flyTo({ center: [lon, lat], zoom: 16 });
      const name = results[0].display_name || trimmed;
      setMessage(name);
      setShowResultMarker(true);
      messageTimeoutRef.current = setTimeout(() => {
        setMessage(null);
        setShowResultMarker(false);
      }, 5000);
    } catch (err) {
      if (id !== searchIdRef.current) return;
      if (err instanceof Error && err.name === "AbortError") return;
      setMessage("No results");
      messageTimeoutRef.current = setTimeout(() => setMessage(null), 2000);
    } finally {
      if (id === searchIdRef.current) {
        setLoading(false);
      }
    }
  }, [setLoading, setMessage]);

  const cancelSearch = useCallback(() => {
    if (messageTimeoutRef.current !== null) {
      clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = null;
    }
    setMessage(null);
    setShowResultMarker(false);

    if (searchTimeoutRef.current !== null) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }

    currentControllerRef.current?.abort();
    currentControllerRef.current = null;
    searchIdRef.current += 1;
    setLoading(false);
  }, [setMessage, setLoading]);

  // Nominatim's usage policy forbids client-side autocomplete, so searches
  // only run on explicit submit (Enter).
  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      queryRef.current = value;
      setQuery(value);
    },
    [setQuery]
  );

  const handleSearch = useCallback(
    (rawQuery: string) => {
      const trimmed = rawQuery.trim();
      if (!trimmed) return;

      cancelSearch();
      searchLocation(trimmed);
    },
    [cancelSearch, searchLocation]
  );

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      handleSearch(queryRef.current);
    },
    [handleSearch]
  );

  /** Fly to a curated place; moveend then reports fresh bounds upstream,
   * which the live-regeneration flow turns into a new artwork. */
  const selectPlace = useCallback(
    (place: CuratedPlace) => {
      cancelSearch();
      mapRef.current?.flyTo({ center: place.center, zoom: place.zoom });
      onSelectPlace?.(place);
    },
    [cancelSearch, onSelectPlace]
  );

  const handleSurprise = useCallback(() => {
    selectPlace(surprisePlace(activePlaceId ?? undefined));
  }, [selectPlace, activePlaceId]);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current !== null) clearTimeout(searchTimeoutRef.current);
      if (messageTimeoutRef.current !== null) clearTimeout(messageTimeoutRef.current);
      currentControllerRef.current?.abort();
      searchIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE_URL,
      center: initialCenter,
      zoom: initialZoom,
      attributionControl: false,
    });

    map.on("load", () => {
      // Force a resize after the container has proper dimensions
      setTimeout(() => {
        map.resize();
        const restore = initialBoundsRef.current;
        if (restore) {
          // The selection square covers the central min(w,h)*0.7 of the
          // container; pad fitBounds so the restored bounds land exactly
          // under it (see getSquareBounds).
          const container = map.getContainer();
          const w = container.clientWidth;
          const h = container.clientHeight;
          const squareSize = Math.min(w, h) * 0.7;
          const padX = (w - squareSize) / 2;
          const padY = (h - squareSize) / 2;
          map.fitBounds(
            [
              [restore.west, restore.south],
              [restore.east, restore.north],
            ],
            { animate: false, padding: { top: padY, bottom: padY, left: padX, right: padX } },
          );
        }
        const first = getSquareBounds(map);
        lastSelectionRef.current = first;
        onChange(first, map.getZoom());
      }, 100);
    });

    const handleUpdate = () => {
      const next = getSquareBounds(map);
      lastSelectionRef.current = next;
      onChange(next, map.getZoom());
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const debouncedHandleUpdate = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(handleUpdate, 200);
    };

    // Desktop keeps the historical behavior: a resize reframes the selection
    // under the new square. On mobile the PiP (~120px) and the fullscreen
    // overlay differ so much that this would silently reselect a 9x smaller
    // or larger area on every expand/collapse — instead, refit the last real
    // framing under the new selection square so what the user framed is what
    // stays selected (the follow-up moveend re-reports it upstream).
    const handleResize = () => {
      const restore = lastSelectionRef.current;
      if (isCompactViewport() && restore) {
        const container = map.getContainer();
        const w = container.clientWidth;
        const h = container.clientHeight;
        const squareSize = Math.min(w, h) * 0.7;
        const padX = (w - squareSize) / 2;
        const padY = (h - squareSize) / 2;
        map.fitBounds(
          [
            [restore.west, restore.south],
            [restore.east, restore.north],
          ],
          { animate: false, padding: { top: padY, bottom: padY, left: padX, right: padX } },
        );
      } else {
        handleUpdate();
      }
    };

    map.on("moveend", debouncedHandleUpdate);
    map.on("resize", handleResize);

    mapRef.current = map;

    return () => {
      map.off("moveend", debouncedHandleUpdate);
      map.off("resize", handleResize);
      if (timeoutId !== null) clearTimeout(timeoutId);
      map.remove();
      mapRef.current = null;
    };
  }, [initialCenter, initialZoom, onChange]);

  // The expand toggle changes the container's size out from under MapLibre;
  // nudge it after the layout settles so tiles fill the new viewport (the
  // resize handler above owns any mobile selection compensation).
  useEffect(() => {
    const id = window.setTimeout(() => mapRef.current?.resize(), 50);
    return () => window.clearTimeout(id);
  }, [expanded]);

  // External fly-to requests (mobile sheet place picks / Surprise Me).
  useEffect(() => {
    if (!flyTo) return;
    mapRef.current?.flyTo({ center: flyTo.center, zoom: flyTo.zoom });
  }, [flyTo]);

  // Esc collapses the expanded viewfinder.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggleExpand();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, onToggleExpand]);

  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;
  const areaKm2 = bboxAreaKm2(bounds);
  const osmEligible = isBboxSmallEnough(bounds);

  return (
    <div className="flex h-full w-full flex-col bg-surface">
      {/* Viewfinder header: readout, expand toggle, search. Hidden below lg
          while collapsed — the mobile PiP is a pure locator (tap to expand). */}
      <div className={`shrink-0 border-b border-hairline ${expanded ? "" : "max-lg:hidden"}`}>
        <div className="flex items-center gap-2 pl-3">
          <p className="instrument-label min-w-0 flex-1 truncate text-ink-muted">
            {fmtDeg(centerLat)} {fmtDeg(centerLng)} · Z{Math.round(zoom)} ·{" "}
            <span className={osmEligible ? "text-ok" : "text-ink-faint"}>
              {areaKm2.toFixed(1)} KM²
            </span>
          </p>
          <button
            type="button"
            onClick={handleSurprise}
            aria-label="Surprise me"
            title="Surprise me"
            className="flex h-11 w-11 shrink-0 items-center justify-center text-[17px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <span aria-hidden="true">⚄</span>
          </button>
          <button
            type="button"
            onClick={onToggleExpand}
            aria-label={expanded ? "Collapse map" : "Expand map"}
            aria-expanded={expanded}
            className="flex h-11 w-11 shrink-0 items-center justify-center text-[15px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <span aria-hidden="true">{expanded ? "✕" : "⤢"}</span>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="border-t border-hairline">
          <input
            type="text"
            aria-label="Search for a location"
            value={query}
            onChange={onInputChange}
            placeholder="Search place…"
            enterKeyHint="search"
            className="h-10 w-full bg-transparent px-3 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:bg-surface-2"
          />
          {/* Default button: guarantees Enter-to-submit and gives assistive
              tech an explicit submit control. */}
          <button type="submit" className="sr-only">
            Search
          </button>
        </form>
        {/* Curated places strip — expanded viewfinder only. */}
        {expanded && (
          <div
            role="group"
            aria-label="Curated places"
            className="flex gap-1.5 overflow-x-auto border-t border-hairline px-3 py-2"
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
                  className={`flex h-11 shrink-0 flex-col items-start justify-center rounded-sm border bg-surface px-3 text-left transition-colors ${
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
      </div>

      {/* Map area — the selection square is min(w,h)*0.7 of THIS element,
          matching getSquareBounds exactly (container queries keep it square). */}
      <div className="relative min-h-0 flex-1 overflow-hidden [container-type:size]">
        <div
          ref={containerRef}
          style={{ position: "absolute", inset: 0, background: "var(--color-ground)" }}
          aria-label="Map for area selection"
        />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative aspect-square w-[min(70cqw,70cqh)] shadow-[0_0_0_9999px_rgba(0,0,0,0.3)]">
            {/* Corner brackets */}
            <span className="absolute -left-px -top-px h-3.5 w-3.5 border-l-2 border-t-2 border-ink/90" />
            <span className="absolute -right-px -top-px h-3.5 w-3.5 border-r-2 border-t-2 border-ink/90" />
            <span className="absolute -bottom-px -left-px h-3.5 w-3.5 border-b-2 border-l-2 border-ink/90" />
            <span className="absolute -bottom-px -right-px h-3.5 w-3.5 border-b-2 border-r-2 border-ink/90" />
            {/* Mid-edge ticks */}
            <span className="absolute left-1/2 top-0 h-2 w-0.5 -translate-x-1/2 bg-ink/90" />
            <span className="absolute bottom-0 left-1/2 h-2 w-0.5 -translate-x-1/2 bg-ink/90" />
            <span className="absolute left-0 top-1/2 h-0.5 w-2 -translate-y-1/2 bg-ink/90" />
            <span className="absolute right-0 top-1/2 h-0.5 w-2 -translate-y-1/2 bg-ink/90" />
            {/* Center crosshair dot */}
            <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink/90" />
          </div>
        </div>
        {(loading || message) && (
          <div
            className="pointer-events-none absolute left-1/2 top-2 z-10 max-w-[90%] -translate-x-1/2 truncate rounded-sm border border-hairline-2 bg-ground/90 px-3 py-1.5 text-center text-[12px] text-ink"
            aria-live="polite"
          >
            {loading ? "Searching…" : message}
          </div>
        )}
        {showResultMarker && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <div className="h-6 w-6 animate-ping rounded-full border-2 border-signal bg-signal/40" />
            <div className="absolute h-3 w-3 rounded-full border-2 border-ink bg-signal" />
          </div>
        )}
        <div
          className={`pointer-events-none absolute bottom-1 left-1.5 right-1.5 font-mono text-[9.5px] leading-tight text-ink-faint ${
            expanded ? "" : "max-lg:hidden"
          }`}
        >
          Map data &copy; OpenStreetMap contributors, OpenFreeMap &amp;
          OpenMapTiles | Terrain &copy; Mapzen / AWS Open Data
        </div>
        {/* Mobile PiP: the whole locator is one tap-to-expand target (the
            full overlay owns gestures, search and the places strip). */}
        {!expanded && (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-label="Expand map"
            aria-expanded={false}
            className="absolute inset-0 z-30 flex items-end justify-end p-1 lg:hidden"
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
