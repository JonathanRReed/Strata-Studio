import { lazy, Suspense, useState, type RefObject } from "react";
import { Artboard } from "./Artboard.tsx";
import type { AspectRatio, GeoBounds } from "../engine/types.ts";

const MapSelector = lazy(() => import("./MapSelector.tsx"));

type Props = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  aspectRatio: AspectRatio;
  /** Accessible description of the artwork for the canvas role=img. */
  artworkLabel: string;
  /** Active palette background; tints the museum wall at ~6% over ground. */
  wallColor: string;
  hasArtwork: boolean;
  isGenerating: boolean;
  /** Loading pill text while generating ("Loading tiles", "Rendering", retry notes). */
  statusText: string | null;
  boundsDirty: boolean;
  onRegenerate: () => void;
  seed: string;
  terrainInfo: string | null;
  warning: string | null;
  errorMessage: string | null;
  onDismissError: () => void;
  showTerrainRetry: boolean;
  terrainRetryCount: number;
  onRetryTerrain: () => void;
  showOsmRetry: boolean;
  osmRetryCount: number;
  onRetryOsm: () => void;
  onCanvasResized: () => void;
  // Viewfinder wiring
  bounds: GeoBounds;
  mapZoom: number;
  onBoundsChange: (bounds: GeoBounds, zoom: number) => void;
  initialCenter: [number, number];
  initialZoom: number;
  initialBounds: GeoBounds | null;
};

/** Typographic minus for the instrument voice. */
function minus(value: string): string {
  return value.replace(/-/g, "−");
}

/**
 * Caption plate line: "37.7749°N 122.4194°W · ELEV −110–282 M · SEED MONOLITH".
 * Elevation is parsed out of the preformatted terrainInfo string (the useTerrain
 * hook owns that format); when unavailable the segment is omitted.
 */
function formatCaption(bounds: GeoBounds, terrainInfo: string | null, seed: string): string {
  const lat = (bounds.north + bounds.south) / 2;
  const lng = (bounds.east + bounds.west) / 2;
  const coords = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? "E" : "W"}`;
  const match = terrainInfo?.match(/Elevation (-?\d+)m – (-?\d+)m/);
  const elev = match ? `ELEV ${minus(match[1])}–${minus(match[2])} M` : null;
  return [coords, elev, `SEED ${seed}`].filter(Boolean).join(" · ");
}

const retryButtonClass =
  "instrument-label flex h-9 items-center rounded-sm border border-alarm/40 px-3 text-alarm transition-colors hover:bg-alarm/10";

/**
 * The main stage: artwork presented museum-style on a palette-tinted wall,
 * with the status pill rail top-center, the caption plate under the frame,
 * and the picture-in-picture map viewfinder (floating on desktop, a static
 * block above the artboard below lg).
 */
export function Stage({
  canvasRef,
  aspectRatio,
  artworkLabel,
  wallColor,
  hasArtwork,
  isGenerating,
  statusText,
  boundsDirty,
  onRegenerate,
  seed,
  terrainInfo,
  warning,
  errorMessage,
  onDismissError,
  showTerrainRetry,
  terrainRetryCount,
  onRetryTerrain,
  showOsmRetry,
  osmRetryCount,
  onRetryOsm,
  onCanvasResized,
  bounds,
  mapZoom,
  onBoundsChange,
  initialCenter,
  initialZoom,
  initialBounds,
}: Props) {
  const [mapExpanded, setMapExpanded] = useState(false);
  const toggleExpand = () => setMapExpanded((prev) => !prev);

  const artworkVisible = hasArtwork || isGenerating;
  const showStale = boundsDirty && hasArtwork && !isGenerating;
  const caption = formatCaption(bounds, terrainInfo, seed);

  return (
    <main
      className="relative flex min-w-0 flex-1 flex-col"
      style={{ backgroundColor: `color-mix(in srgb, ${wallColor} 6%, var(--color-ground))` }}
    >
      {/* Viewfinder — static block above the artboard below lg, floating PiP at lg. */}
      <div
        className={
          mapExpanded
            ? "fixed inset-0 z-40 flex bg-ground/60 p-4 sm:p-8 lg:absolute lg:p-[7%]"
            : "relative z-10 h-[300px] w-full shrink-0 border-b border-hairline bg-surface lg:absolute lg:bottom-6 lg:left-6 lg:z-20 lg:h-[240px] lg:w-[240px] lg:border lg:border-hairline-2 lg:shadow-[0_16px_48px_rgba(0,0,0,0.5)] 2xl:h-[300px] 2xl:w-[300px]"
        }
        onClick={(e) => {
          if (mapExpanded && e.target === e.currentTarget) toggleExpand();
        }}
      >
        <div
          className={
            mapExpanded
              ? "h-full w-full border border-hairline-2 bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
              : "h-full w-full"
          }
        >
          <Suspense fallback={<div className="h-full w-full bg-surface" />}>
            <MapSelector
              onChange={onBoundsChange}
              initialCenter={initialCenter}
              initialZoom={initialZoom}
              initialBounds={initialBounds}
              bounds={bounds}
              zoom={mapZoom}
              expanded={mapExpanded}
              onToggleExpand={toggleExpand}
            />
          </Suspense>
        </div>
      </div>

      {/* Artwork wall. At lg–2xl the wall reserves a left column for the
          floating viewfinder so it never occludes the frame or caption; at
          2xl+ the artwork is fully centered museum-style and the (larger)
          viewfinder floats clear of the caption. */}
      <div className="relative flex h-[75vh] flex-col items-center justify-center px-6 py-10 lg:h-auto lg:min-h-0 lg:flex-1 lg:pb-8 lg:pl-[296px] lg:pr-10 lg:pt-14 2xl:pl-10">
        {/* Status pill rail — top-center of the artwork area, so it never
            covers the stacked viewfinder or the caption plate. */}
        <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex flex-col items-center gap-2 px-4 lg:top-6">
          {isGenerating && statusText && (
            <div className="pointer-events-auto flex min-h-9 items-center rounded-sm border border-hairline bg-surface px-4">
              <span className="instrument-label status-live text-ink" role="status">
                {statusText}
              </span>
            </div>
          )}
          {showStale && (
            <div className="hatched pointer-events-auto flex items-center gap-3 rounded-sm border border-amber/40 bg-surface p-1.5 pl-4">
              <span className="instrument-label text-amber">Selection moved — artwork stale</span>
              <button
                type="button"
                onClick={onRegenerate}
                className="instrument-label flex h-8 items-center rounded-sm bg-amber px-3 text-ground transition-opacity hover:opacity-85"
              >
                Regenerate
              </button>
            </div>
          )}
          {errorMessage && (
            <div
              role="alert"
              className="pointer-events-auto flex w-full max-w-xl flex-col gap-2.5 rounded-sm border border-alarm/40 bg-surface p-3"
            >
              <p className="text-[12px] leading-snug text-alarm">{errorMessage}</p>
              <div className="flex flex-wrap items-center gap-2">
                {showTerrainRetry && (
                  <button type="button" onClick={onRetryTerrain} className={retryButtonClass}>
                    Retry{terrainRetryCount > 0 ? ` (${terrainRetryCount})` : ""}
                  </button>
                )}
                {showOsmRetry && (
                  <button type="button" onClick={onRetryOsm} className={retryButtonClass}>
                    Retry OSM{osmRetryCount > 0 ? ` (${osmRetryCount})` : ""}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onDismissError}
                  className="instrument-label flex h-9 items-center rounded-sm border border-hairline-2 px-3 text-ink-muted transition-colors hover:bg-surface-2"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {warning && (
            <div
              role="status"
              className="hatched pointer-events-auto flex min-h-9 max-w-xl items-center rounded-sm border border-amber/40 bg-surface px-4 py-1.5"
            >
              <span className="text-[12px] leading-snug text-amber">{warning}</span>
            </div>
          )}
        </div>
        {!artworkVisible && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="display text-3xl tracking-[0.06em] text-ink sm:text-4xl">Strata Studio</p>
            <p className="text-sm text-ink-muted">Real places, rendered like sound.</p>
          </div>
        )}
        <Artboard
          ref={canvasRef}
          aspectRatio={aspectRatio}
          visible={artworkVisible}
          ariaLabel={artworkLabel}
          onCanvasResized={onCanvasResized}
        />
        <p
          className={`instrument-label mt-4 shrink-0 text-center text-ink-faint ${
            artworkVisible ? "" : "invisible"
          }`}
        >
          {caption}
        </p>
      </div>
    </main>
  );
}
