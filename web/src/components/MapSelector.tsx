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

import "maplibre-gl/dist/maplibre-gl.css";

const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxzoom: 20,
    },
  },
  layers: [
    {
      id: "osm",
      type: "raster" as const,
      source: "osm",
    },
  ],
};

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

type Props = {
  initialCenter?: [number, number];
  initialZoom?: number;
  onChange: (bounds: GeoBounds, zoom: number) => void;
};

export default function MapSelector({
  initialCenter = [-122.4194, 37.7749],
  initialZoom = 11,
  onChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

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
  // only run on explicit submit (Enter or the Search button).
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
      style: OSM_STYLE as unknown as maplibregl.StyleSpecification,
      center: initialCenter,
      zoom: initialZoom,
      attributionControl: false,
    });

    map.on("load", () => {
      // Force a resize after the container has proper dimensions
      setTimeout(() => {
        map.resize();
        onChange(getSquareBounds(map), map.getZoom());
      }, 100);
    });

    const handleUpdate = () => {
      onChange(getSquareBounds(map), map.getZoom());
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const debouncedHandleUpdate = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(handleUpdate, 200);
    };

    map.on("moveend", debouncedHandleUpdate);
    map.on("resize", handleUpdate);

    mapRef.current = map;

    return () => {
      map.off("moveend", debouncedHandleUpdate);
      map.off("resize", handleUpdate);
      if (timeoutId !== null) clearTimeout(timeoutId);
      map.remove();
      mapRef.current = null;
    };
  }, [initialCenter, initialZoom, onChange]);

  return (
    <div className="relative w-full aspect-square rounded-lg overflow-hidden border border-white/10">
      <div
        ref={containerRef}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "#000" }}
        aria-label="Map for area selection"
      />
      <div className="pointer-events-none absolute top-2 left-2 right-2 z-10 flex justify-center">
        <form onSubmit={handleSubmit} className="flex items-center gap-1">
          <input
            type="text"
            aria-label="Search for a location"
            value={query}
            onChange={onInputChange}
            placeholder="Search location..."
            className="pointer-events-auto bg-black/70 border border-white/20 rounded text-xs text-white px-2 py-1.5 w-40 placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-white/40"
          />
          <button
            type="submit"
            className="pointer-events-auto bg-black/70 border border-white/20 rounded text-xs text-white px-2 py-1.5 hover:bg-white/10"
            aria-label="Search"
          >
            {loading ? "..." : "Search"}
          </button>
        </form>
        {message && (
          <div
            className="pointer-events-none absolute top-12 left-1/2 -translate-x-1/2 bg-black/80 border border-white/30 rounded text-xs text-white px-3 py-1.5 max-w-[90%] text-center"
            aria-live="polite"
          >
            {message}
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="relative w-[70%] h-[70%] border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]">
          {/* Corner markers */}
          <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 border-white" />
          <div className="absolute -top-1 -right-1 w-4 h-4 border-t-2 border-r-2 border-white" />
          <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-2 border-l-2 border-white" />
          <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 border-white" />
          {/* Label */}
          <div className="absolute -top-6 left-0 text-[10px] text-white/70 font-medium uppercase tracking-wider">
            Selection
          </div>
        </div>
      </div>
      {showResultMarker && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-20">
          <div className="w-6 h-6 rounded-full bg-blue-400/40 border-2 border-blue-300 animate-ping" />
          <div className="absolute w-3 h-3 rounded-full bg-blue-400 border-2 border-white" />
        </div>
      )}
      <div className="pointer-events-none absolute bottom-1.5 left-1.5 right-1.5 text-[10px] text-white/50 leading-tight">
        Map data &copy; OpenStreetMap contributors, CARTO | Terrain &copy;
        Mapzen / AWS Open Data
      </div>
    </div>
  );
}
