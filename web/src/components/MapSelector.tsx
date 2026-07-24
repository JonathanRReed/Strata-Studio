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
import {
  getAspectValue,
  getCenteredFrameRect,
  getContainedFrameDimensions,
} from "../app/aspect.ts";
import { bboxAreaKm2, isBboxSmallEnough } from "../data/osmOverpass.ts";
import { CURATED_PLACES, surprisePlace, type CuratedPlace } from "../data/places.ts";
import {
  MAX_SEARCH_QUERY_LENGTH,
  normalizeMapCenter,
  normalizeMapZoom,
  sanitizeSearchQuery,
} from "../app/stateSafety.ts";
import { NoMapFallback } from "./NoMapFallback.tsx";
import { detectCapabilities } from "../app/capabilities.ts";
import { useNominatimSearch } from "../app/useNominatimSearch.ts";
import type { MapSelectionCause, MapSelectionProps } from "./mapSelectionTypes.ts";

import "maplibre-gl/dist/maplibre-gl.css";

// OpenFreeMap vector basemap (free, keyless, commercial use allowed).
// Swappable: other styles include /styles/positron, /styles/bright,
// /styles/liberty, and /styles/fiord.
export const BASEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

function getFramedBounds(
  map: maplibregl.Map,
  aspectRatio: MapSelectionProps["aspectRatio"],
): GeoBounds {
  const center = map.project(map.getCenter());
  const container = map.getContainer();
  const frame = getCenteredFrameRect(
    center.x,
    center.y,
    container.clientWidth,
    container.clientHeight,
    aspectRatio,
  );

  const topLeft = map.unproject([frame.left, frame.top]);
  const topRight = map.unproject([frame.right, frame.top]);
  const bottomRight = map.unproject([frame.right, frame.bottom]);

  return normalizeBounds({
    west: topLeft.lng,
    north: topLeft.lat,
    east: topRight.lng,
    south: bottomRight.lat,
  });
}

function getFramePadding(
  map: maplibregl.Map,
  aspectRatio: MapSelectionProps["aspectRatio"],
): { top: number; bottom: number; left: number; right: number } {
  const container = map.getContainer();
  const frame = getContainedFrameDimensions(
    container.clientWidth,
    container.clientHeight,
    aspectRatio,
  );
  const horizontal = Math.max(0, (container.clientWidth - frame.width) / 2);
  const vertical = Math.max(0, (container.clientHeight - frame.height) / 2);
  return { top: vertical, bottom: vertical, left: horizontal, right: horizontal };
}

/** Instrument readout formatting: real minus sign, fixed decimals. */
function fmtDeg(value: number): string {
  return value.toFixed(4).replace(/-/g, "−");
}

export const MAP_LOAD_TIMEOUT_MS = 12_000;

type MapFailure = {
  message: string;
};

function webGlAvailable(): boolean {
  return detectCapabilities().webgl;
}

function mapErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "The basemap could not start";
}

export default function MapSelector({
  initialCenter = [-122.4194, 37.7749],
  initialZoom = 11,
  initialBounds = null,
  aspectRatio,
  onChange,
  bounds,
  zoom,
  expanded,
  onToggleExpand,
  activePlaceId = null,
  onSelectPlace,
  flyTo = null,
}: MapSelectionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const pendingFlyToRef = useRef<{
    center: [number, number];
    zoom: number;
    bounds?: GeoBounds;
    cause: "curated" | "search" | "restore";
  } | null>(null);
  const pendingMoveCauseRef = useRef<MapSelectionCause | null>(null);
  const reportSelectionRef = useRef<(cause: MapSelectionCause) => void>(() => {});
  const frameSettledRef = useRef(false);
  const activeAspectRef = useRef(aspectRatio);
  const previousAspectRef = useRef(aspectRatio);
  activeAspectRef.current = aspectRatio;
  // The active artwork selection is read through a ref so map retries restore
  // current user state without recreating the map on every bounds update.
  const activeBoundsRef = useRef(bounds);
  activeBoundsRef.current = bounds;
  // Last selection reported from a real framing (load/moveend) — never from a
  // resize — so mobile expand/collapse can restore it (see handleResize).
  const lastSelectionRef = useRef<GeoBounds | null>(null);

  const [query, setQuery] = useState("");
  const [showResultMarker, setShowResultMarker] = useState(false);
  const [mapFailure, setMapFailure] = useState<MapFailure | null>(null);
  const [mapAttempt, setMapAttempt] = useState(0);

  const queryRef = useRef("");
  const markerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const failCurrentMap = useCallback((error: unknown) => {
    setMapFailure({ message: mapErrorMessage(error) });
    // Changing the attempt guarantees the active map effect cleans itself up
    // even though the component switches to its no-map fallback render.
    setMapAttempt((attempt) => attempt + 1);
  }, []);

  const flushPendingFlyTo = useCallback(() => {
    const map = mapRef.current;
    const pending = pendingFlyToRef.current;
    if (!map || !pending || !frameSettledRef.current) return;
    pendingFlyToRef.current = null;
    pendingMoveCauseRef.current = pending.cause;
    try {
      if (pending.bounds) {
        map.fitBounds(
          [
            [pending.bounds.west, pending.bounds.south],
            [pending.bounds.east, pending.bounds.north],
          ],
          {
            padding: getFramePadding(map, activeAspectRef.current),
            duration: 0,
          },
        );
      } else {
        // jumpTo is safe before style load and emits the target bounds immediately.
        map.jumpTo(pending);
      }
      // Camera mutations are synchronous, but WebKit can delay or omit the
      // matching moveend event under load. Commit the landed selection now so
      // curated places and searches cannot update their label while leaving
      // terrain and OSM requests on the previous bounds. The later debounced
      // moveend report is harmless because the parent ignores equal bounds.
      const landedBounds = getFramedBounds(map, activeAspectRef.current);
      lastSelectionRef.current = landedBounds;
      onChange(landedBounds, map.getZoom(), pending.cause);
    } catch (error) {
      failCurrentMap(error);
    }
  }, [failCurrentMap, onChange]);

  const requestFlyTo = useCallback(
    (
      center: [number, number],
      requestedZoom: number,
      cause: "curated" | "search" | "restore",
      exactBounds?: GeoBounds,
    ) => {
      const request = {
        center: normalizeMapCenter(center, initialCenter),
        zoom: normalizeMapZoom(requestedZoom, initialZoom),
        bounds: exactBounds,
        cause,
      };
      // Keep the latest request until a MapLibre instance exists; flush uses a
      // synchronous camera jump that is safe before style load.
      pendingFlyToRef.current = request;
      flushPendingFlyTo();
    },
    [flushPendingFlyTo, initialCenter, initialZoom],
  );

  const handleSearchResult = useCallback(
    (result: { lat: number; lng: number }) => {
      requestFlyTo([result.lng, result.lat], 16, "search");
      setShowResultMarker(true);
      if (markerTimeoutRef.current) clearTimeout(markerTimeoutRef.current);
      markerTimeoutRef.current = setTimeout(() => {
        setShowResultMarker(false);
        markerTimeoutRef.current = null;
      }, 5_000);
    },
    [requestFlyTo],
  );
  const locationSearch = useNominatimSearch({ onResult: handleSearchResult });

  const cancelSearch = useCallback(() => {
    locationSearch.dismiss();
    if (markerTimeoutRef.current) clearTimeout(markerTimeoutRef.current);
    markerTimeoutRef.current = null;
    setShowResultMarker(false);
  }, [locationSearch]);

  // Nominatim's usage policy forbids client-side autocomplete, so searches
  // only run on explicit submit (Enter).
  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value.slice(0, MAX_SEARCH_QUERY_LENGTH);
      locationSearch.edited();
      queryRef.current = value;
      setQuery(value);
    },
    [locationSearch]
  );

  const handleSearch = useCallback(
    (rawQuery: string) => {
      const trimmed = sanitizeSearchQuery(rawQuery);
      if (!trimmed) return;

      void locationSearch.search(trimmed);
    },
    [locationSearch]
  );

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      handleSearch(queryRef.current);
    },
    [handleSearch]
  );

  /** Curated navigation is parent-owned so a keyed request survives map load,
   * failure, fallback, and retry transitions until a valid bounds report lands. */
  const selectPlace = useCallback(
    (place: CuratedPlace) => {
      cancelSearch();
      onSelectPlace?.(place);
    },
    [cancelSearch, onSelectPlace]
  );

  const handleSurprise = useCallback(() => {
    selectPlace(surprisePlace(activePlaceId ?? undefined));
  }, [selectPlace, activePlaceId]);

  useEffect(
    () => () => {
      if (markerTimeoutRef.current) clearTimeout(markerTimeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    if (!webGlAvailable()) {
      setMapFailure({ message: "WebGL is unavailable in this browser or device" });
      return;
    }

    setMapFailure(null);
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: BASEMAP_STYLE_URL,
        center: normalizeMapCenter(initialCenter, [-122.4194, 37.7749]),
        zoom: normalizeMapZoom(initialZoom, 11),
        attributionControl: false,
      });
    } catch (error) {
      setMapFailure({ message: mapErrorMessage(error) });
      return;
    }

    let mapCanvas: HTMLCanvasElement;
    try {
      mapCanvas = map.getCanvas();
    } catch (error) {
      setMapFailure({ message: mapErrorMessage(error) });
      try {
        map.remove();
      } catch {
        // The partially-created map may already be torn down.
      }
      return;
    }

    mapCanvas.tabIndex = 0;
    mapCanvas.setAttribute("aria-label", "Interactive area selection map");
    mapCanvas.setAttribute("aria-describedby", "map-keyboard-instructions");

    let disposed = false;
    let loaded = false;
    let removed = false;
    // map.resize() may synchronously emit "resize" before the active bounds
    // have been fitted. Suppress that provisional report so boot cannot be
    // invalidated and generated a second time.
    frameSettledRef.current = false;
    let queuedCause: MapSelectionCause = "manual";
    let updateTimeout: ReturnType<typeof setTimeout> | null = null;
    let settleTimeout: ReturnType<typeof setTimeout> | null = null;
    let loadTimeout: ReturnType<typeof setTimeout> | null = null;

    const handleUpdate = (cause: MapSelectionCause) => {
      if (disposed || removed || !frameSettledRef.current) return;
      try {
        const next = getFramedBounds(map, activeAspectRef.current);
        lastSelectionRef.current = next;
        onChange(next, map.getZoom(), cause);
      } catch (error) {
        failMap(mapErrorMessage(error));
      }
    };
    reportSelectionRef.current = handleUpdate;

    const debouncedHandleUpdate = () => {
      if (!frameSettledRef.current) return;
      queuedCause = pendingMoveCauseRef.current ?? "manual";
      pendingMoveCauseRef.current = null;
      if (updateTimeout !== null) clearTimeout(updateTimeout);
      updateTimeout = setTimeout(() => handleUpdate(queuedCause), 200);
    };

    // Container changes (including expanded/collapsed mode) preserve the exact
    // active geography by refitting it into the aspect-aware frame.
    const handleResize = () => {
      if (!frameSettledRef.current) return;
      try {
        const restore = lastSelectionRef.current ?? activeBoundsRef.current;
        pendingMoveCauseRef.current = "restore";
        map.fitBounds(
          [
            [restore.west, restore.south],
            [restore.east, restore.north],
          ],
          {
            animate: false,
            padding: getFramePadding(map, activeAspectRef.current),
          },
        );
      } catch (error) {
        failMap(mapErrorMessage(error));
      }
    };

    const removeMap = () => {
      if (removed) return;
      removed = true;
      try {
        map.off("load", handleLoad);
        map.off("error", handleMapError);
        map.off("moveend", debouncedHandleUpdate);
        map.off("resize", handleResize);
        mapCanvas.removeEventListener("webglcontextlost", handleContextLost);
      } catch {
        // Listener cleanup is best-effort after a partial WebGL teardown.
      }
      if (updateTimeout !== null) clearTimeout(updateTimeout);
      if (settleTimeout !== null) clearTimeout(settleTimeout);
      if (loadTimeout !== null) clearTimeout(loadTimeout);
      try {
        map.remove();
      } catch {
        // A partially-constructed WebGL map may already have torn itself down.
      }
      if (mapRef.current === map) mapRef.current = null;
    };

    const failMap = (message: string) => {
      if (disposed || removed) return;
      setMapFailure({ message });
      removeMap();
    };

    function handleLoad() {
      if (disposed || removed) return;
      loaded = true;
      if (loadTimeout !== null) clearTimeout(loadTimeout);
      setMapFailure(null);
      // Force a resize after the container has proper dimensions, then fit the
      // already-active artwork bounds. App ignores the equal-bounds echo.
      settleTimeout = setTimeout(() => {
        if (disposed || removed) return;
        try {
          map.resize();
          const restore = activeBoundsRef.current;
          pendingMoveCauseRef.current = "restore";
          map.fitBounds(
            [
              [restore.west, restore.south],
              [restore.east, restore.north],
            ],
            {
              animate: false,
              padding: getFramePadding(map, activeAspectRef.current),
            },
          );
          pendingMoveCauseRef.current = null;
          frameSettledRef.current = true;
          handleUpdate("restore");
          flushPendingFlyTo();
        } catch (error) {
          failMap(mapErrorMessage(error));
        }
      }, 100);
    }

    function handleMapError(event: maplibregl.ErrorEvent) {
      const message = mapErrorMessage(event.error);
      if (!loaded || /style|webgl|context|initialize/i.test(message)) failMap(message);
    }

    function handleContextLost(event: Event) {
      event.preventDefault();
      failMap("The map's WebGL context was lost");
    }

    map.on("load", handleLoad);
    map.on("error", handleMapError);
    map.on("moveend", debouncedHandleUpdate);
    map.on("resize", handleResize);
    mapCanvas.addEventListener("webglcontextlost", handleContextLost);
    mapRef.current = map;
    flushPendingFlyTo();
    loadTimeout = setTimeout(
      () => failMap("The basemap did not finish loading in time"),
      MAP_LOAD_TIMEOUT_MS,
    );

    return () => {
      disposed = true;
      removeMap();
    };
  }, [flushPendingFlyTo, initialCenter, initialZoom, mapAttempt, onChange]);

  // The expand toggle changes the container's size out from under MapLibre;
  // nudge it after the layout settles so tiles fill the new viewport (the
  // resize handler above owns any mobile selection compensation).
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        mapRef.current?.resize();
        flushPendingFlyTo();
      } catch (error) {
        failCurrentMap(error);
      }
    }, 50);
    return () => window.clearTimeout(id);
  }, [expanded, failCurrentMap, flushPendingFlyTo]);

  // Changing artwork aspect changes the outlined geography at the current
  // center/zoom. Report it once through the normal debounced regeneration path.
  useEffect(() => {
    if (previousAspectRef.current === aspectRatio) return;
    previousAspectRef.current = aspectRatio;
    const id = window.setTimeout(() => reportSelectionRef.current("aspect"), 0);
    return () => window.clearTimeout(id);
  }, [aspectRatio]);

  // External fly-to requests (mobile sheet place picks / Surprise Me).
  useEffect(() => {
    if (!flyTo) return;
    requestFlyTo(
      flyTo.center,
      flyTo.zoom,
      flyTo.bounds ? "restore" : "curated",
      flyTo.bounds,
    );
  }, [flyTo, mapAttempt, requestFlyTo]);

  const retryMap = useCallback(() => {
    cancelSearch();
    setMapFailure(null);
    setMapAttempt((attempt) => attempt + 1);
  }, [cancelSearch]);

  if (mapFailure) {
    return (
      <NoMapFallback
        initialCenter={initialCenter}
        initialZoom={initialZoom}
        initialBounds={initialBounds}
        aspectRatio={aspectRatio}
        onChange={onChange}
        bounds={bounds}
        zoom={zoom}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        activePlaceId={activePlaceId}
        onSelectPlace={onSelectPlace}
        flyTo={flyTo}
        reason={mapFailure.message}
        onRetry={retryMap}
      />
    );
  }

  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;
  const areaKm2 = bboxAreaKm2(bounds);
  const osmEligible = isBboxSmallEnough(bounds);
  const frameAspect = getAspectValue(aspectRatio);

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
            onChange={onInputChange}
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
                  className={`flex h-11 shrink-0 flex-col items-start justify-center rounded-sm border bg-surface px-3 text-left press ${
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

      {/* Map area — the outlined aspect-aware frame and getFramedBounds share
          the same 70%-contained rectangle from app/aspect.ts. */}
      <div className="relative min-h-0 flex-1 overflow-hidden [container-type:size]">
        <div
          ref={containerRef}
          style={{ position: "absolute", inset: 0, background: "var(--color-ground)" }}
          aria-label="Map for area selection"
        />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            data-testid="export-frame"
            aria-hidden="true"
            className="relative shadow-[0_0_0_9999px_rgba(0,0,0,0.3)]"
            style={{
              width: `min(70cqw, calc(70cqh * ${frameAspect}))`,
              aspectRatio: String(frameAspect),
            }}
          >
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
        {locationSearch.state.phase !== "idle" && (
          <div
            className="pointer-events-auto absolute left-1/2 top-2 z-10 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-sm border border-hairline-2 bg-ground/95 px-3 py-1.5 text-center text-[12px] text-ink"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="min-w-0 truncate">
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
                <button
                  type="button"
                  onClick={locationSearch.dismiss}
                  aria-label="Dismiss search error"
                  className="text-ink-muted hover:text-ink"
                >
                  ✕
                </button>
              </>
            )}
          </div>
        )}
        {showResultMarker && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <div className="h-6 w-6 animate-ping rounded-full border-2 border-signal bg-signal/40 motion-reduce:animate-none" />
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
            onClick={(event) => onToggleExpand(event.currentTarget)}
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
