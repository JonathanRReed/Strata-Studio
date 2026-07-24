import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Artboard } from "./Artboard.tsx";
import type { AspectRatio, GeoBounds } from "../engine/types.ts";
import type { CuratedPlace } from "../data/places.ts";
import type {
  FlyToRequest,
  MapSelectionCause,
  MapSelectionProps,
} from "./mapSelectionTypes.ts";
import { NoMapFallback } from "./NoMapFallback.tsx";
import { MapErrorBoundary } from "./ErrorBoundaries.tsx";
import { OrientationCard } from "./OrientationCard.tsx";

type Props = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  aspectRatio: AspectRatio;
  /** Accessible description of the artwork for the canvas role=img. */
  artworkLabel: string;
  /** Active palette background; tints the museum wall at ~6% over ground. */
  wallColor: string;
  backgroundInert: boolean;
  hasArtwork: boolean;
  isGenerating: boolean;
  /** Loading pill text while generating ("Loading tiles", "Rendering", retry notes). */
  statusText: string | null;
  boundsDirty: boolean;
  onRegenerate: () => void;
  seed: string;
  /** Poster label (auto-filled place name or user text); leads the caption. */
  label: string;
  /** Opens the variations overlay (desktop ghost button by the caption). */
  onOpenVariations: () => void;
  variationsReady: boolean;
  terrainInfo: string | null;
  warning: string | null;
  errorMessage: string | null;
  onDismissError: () => void;
  showTerrainRetry: boolean;
  terrainRetryCount: number;
  onRetryTerrain: () => void;
  onCanvasResized: () => void;
  orientation: {
    place: string;
    style: string;
    onChoosePlace: (opener: HTMLElement) => void;
    onCustomizeArtwork: (opener: HTMLElement) => void;
    onDismiss: () => void;
  } | null;
  // Viewfinder wiring
  bounds: GeoBounds;
  mapZoom: number;
  onBoundsChange: (
    bounds: GeoBounds,
    zoom: number,
    cause: MapSelectionCause,
  ) => void;
  initialCenter: [number, number];
  initialZoom: number;
  initialBounds: GeoBounds | null;
  /** Last curated place chosen (chip strip / Surprise Me); highlights its chip. */
  activePlaceId: string | null;
  onSelectPlace: (place: CuratedPlace) => void;
  /** Viewfinder overlay state — owned by App so the mobile sheet can open it. */
  mapExpanded: boolean;
  onToggleMapExpand: (opener?: HTMLElement) => void;
  /** Imperative fly-to channel (mobile sheet place picks); null = none requested. */
  mapFlyTo: FlyToRequest | null;
};

/** Typographic minus for the instrument voice. */
function minus(value: string): string {
  return value.replace(/-/g, "−");
}

/**
 * Caption plate line: "AMSTERDAM · 52.3700°N 4.9000°E · ELEV −2–18 M · SEED
 * MONOLITH". The place name (auto-filled or user label) leads when present;
 * elevation is parsed out of the preformatted terrainInfo string (the
 * useTerrain hook owns that format); when unavailable the segment is omitted.
 */
function formatCaption(
  bounds: GeoBounds,
  terrainInfo: string | null,
  seed: string,
  label: string,
): string {
  const lat = (bounds.north + bounds.south) / 2;
  const lng = (bounds.east + bounds.west) / 2;
  const coords = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? "E" : "W"}`;
  const match = terrainInfo?.match(/Elevation (-?\d+)m – (-?\d+)m/);
  const elev = match ? `ELEV ${minus(match[1])}–${minus(match[2])} M` : null;
  return [label.trim() || null, coords, elev, `SEED ${seed}`].filter(Boolean).join(" · ");
}

const retryButtonClass =
  "instrument-label press flex h-9 items-center rounded-sm border border-alarm/40 px-3 text-alarm hover:bg-alarm/10";

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
  backgroundInert,
  hasArtwork,
  isGenerating,
  statusText,
  boundsDirty,
  onRegenerate,
  seed,
  label,
  onOpenVariations,
  variationsReady,
  terrainInfo,
  warning,
  errorMessage,
  onDismissError,
  showTerrainRetry,
  terrainRetryCount,
  onRetryTerrain,
  onCanvasResized,
  orientation,
  bounds,
  mapZoom,
  onBoundsChange,
  initialCenter,
  initialZoom,
  initialBounds,
  activePlaceId,
  onSelectPlace,
  mapExpanded,
  onToggleMapExpand,
  mapFlyTo,
}: Props) {
  const artworkVisible = hasArtwork || isGenerating;
  // Auto-regeneration owns the happy path (isGenerating covers pending
  // debounce + fetch), so the stale banner is only the fallback surface —
  // shown when regeneration failed (error banner owns the message then) or
  // was suppressed (animation export in progress).
  const showStale = boundsDirty && hasArtwork && !isGenerating && !errorMessage;
  const caption = formatCaption(bounds, terrainInfo, seed, label);
  const [mapAttempt, setMapAttempt] = useState(0);
  const mapDialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mapExpanded) return;
    const dialog = mapDialogRef.current;
    if (!dialog) return;

    dialog.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onToggleMapExpand();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], canvas[tabindex="0"], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.closest("[inert]") && element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (
        event.shiftKey &&
        (active === dialog || active === first || !dialog.contains(active))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === dialog || active === last || !dialog.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => dialog.removeEventListener("keydown", handleKeyDown);
  }, [mapExpanded, onToggleMapExpand]);

  // React.lazy caches a rejected import. Recreating the lazy component on retry
  // gives a recovered network/session a real second chunk-load attempt.
  const MapSelector = useMemo(() => {
    const retryAttempt = mapAttempt;
    return lazy(() => {
      void retryAttempt;
      return import("./MapSelector.tsx");
    });
  }, [mapAttempt]);
  const mapProps: MapSelectionProps = {
    onChange: onBoundsChange,
    initialCenter,
    initialZoom,
    initialBounds,
    aspectRatio,
    bounds,
    zoom: mapZoom,
    expanded: mapExpanded,
    onToggleExpand: onToggleMapExpand,
    activePlaceId,
    onSelectPlace,
    flyTo: mapFlyTo,
  };

  return (
    <main
      inert={backgroundInert ? true : undefined}
      className="relative flex min-w-0 flex-1 flex-col"
      style={{ backgroundColor: `color-mix(in srgb, ${wallColor} 6%, var(--color-ground))` }}
    >
      {/* Viewfinder — floating PiP at every size: ~120px locator bottom-left on
          mobile (tap to expand to the fullscreen overlay), 240px instrument at lg. */}
      <div
        ref={mapDialogRef}
        role={mapExpanded ? "dialog" : undefined}
        aria-modal={mapExpanded || undefined}
        aria-labelledby={mapExpanded ? "map-dialog-title" : undefined}
        aria-describedby={mapExpanded ? "map-keyboard-instructions" : undefined}
        tabIndex={mapExpanded ? -1 : undefined}
        className={
          mapExpanded
            ? "fixed inset-0 z-40 flex bg-ground/60 p-4 sm:p-8 lg:absolute lg:p-[7%]"
            : "absolute bottom-3 left-3 z-20 h-[120px] w-[120px] border border-hairline-2 bg-surface shadow-[0_12px_32px_rgba(0,0,0,0.5)] max-lg:overflow-hidden max-lg:rounded-sm lg:bottom-6 lg:left-6 lg:h-[200px] lg:w-[200px] lg:shadow-[0_16px_48px_rgba(0,0,0,0.5)] 2xl:h-[260px] 2xl:w-[260px]"
        }
        onClick={(e) => {
          if (mapExpanded && e.target === e.currentTarget) onToggleMapExpand();
        }}
      >
        <h2 id="map-dialog-title" className="sr-only">
          Choose artwork area
        </h2>
        <p id="map-keyboard-instructions" className="sr-only">
          Pan with the arrow keys and zoom with plus or minus when the map is focused.
          Changes apply automatically. The outlined frame is the exported area. Press
          Escape to close the expanded map.
        </p>
        <div
          className={
            mapExpanded
              ? "h-full w-full border border-hairline-2 bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
              : "h-full w-full"
          }
        >
          <MapErrorBoundary
            key={mapAttempt}
            onRetry={() => setMapAttempt((attempt) => attempt + 1)}
            fallback={(error, retry) => (
              <NoMapFallback
                {...mapProps}
                reason={`The interactive map code could not load: ${error.message}`}
                onRetry={retry}
              />
            )}
          >
            <Suspense
              fallback={
                <div className="flex h-full w-full items-center justify-center bg-surface">
                  <span className="instrument-label status-live text-ink-muted">Loading map</span>
                </div>
              }
            >
              <MapSelector {...mapProps} />
            </Suspense>
          </MapErrorBoundary>
        </div>
      </div>

      {/* Artwork wall. Below lg it fills the stage (viewport minus the sheet's
          collapsed chrome) so the artwork owns the screen. At lg–2xl the wall
          reserves a modest left margin for the floating viewfinder; at 2xl+
          the artwork is fully centered museum-style and the viewfinder floats
          clear of the caption. The viewfinder is compact (280px) and floats
          at the top-left, so the artboard claims the majority of the width. */}
      <div
        inert={mapExpanded ? true : undefined}
        className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-[144px] pt-12 lg:h-auto lg:min-h-0 lg:flex-1 lg:pb-8 lg:pl-[200px] lg:pr-8 lg:pt-14 2xl:pl-10"
      >
        {orientation && <OrientationCard {...orientation} />}
        {/* Status pill rail — top-center of the artwork area, so it never
            covers the stacked viewfinder or the caption plate. */}
        <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex flex-col items-center gap-2 px-4 lg:top-6">
          {isGenerating && statusText && (
            <div className="enter-banner pointer-events-auto flex min-h-9 items-center rounded-sm border border-hairline bg-surface px-4">
              <span className="instrument-label status-live text-ink" role="status">
                {statusText}
              </span>
            </div>
          )}
          {showStale && (
            <div className="enter-banner hatched pointer-events-auto flex items-center gap-3 rounded-sm border border-amber/40 bg-surface p-1.5 pl-4">
              <span className="instrument-label text-amber">Selection moved — artwork stale</span>
              <button
                type="button"
                onClick={onRegenerate}
                className="instrument-label press flex h-8 items-center rounded-sm bg-amber px-3 text-ground hover:opacity-85"
              >
                Regenerate now
              </button>
            </div>
          )}
          {errorMessage && (
            <div
              role="alert"
              className="enter-banner pointer-events-auto flex w-full max-w-xl flex-col gap-2.5 rounded-sm border border-alarm/40 bg-surface p-3"
            >
              <p className="text-[12px] leading-snug text-alarm">{errorMessage}</p>
              <div className="flex flex-wrap items-center gap-2">
                {showTerrainRetry && (
                  <button type="button" onClick={onRetryTerrain} className={retryButtonClass}>
                    Retry{terrainRetryCount > 0 ? ` (${terrainRetryCount})` : ""}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onDismissError}
                  className="instrument-label press flex h-9 items-center rounded-sm border border-hairline-2 px-3 text-ink-muted hover:bg-surface-2"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {warning && (
            <div
              role="status"
              className="enter-banner hatched pointer-events-auto flex min-h-9 max-w-xl items-center rounded-sm border border-amber/40 bg-surface px-4 py-1.5"
            >
              <span className="text-[12px] leading-snug text-amber">{warning}</span>
            </div>
          )}
        </div>
        {!artworkVisible && (
          <div className="enter-panel pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="display text-3xl tracking-[0.06em] text-ink sm:text-4xl">Strata Studio</p>
            <p className="text-sm text-ink-muted">Real places, rendered like sound.</p>
          </div>
        )}
        {/* Permanent watermark — the wordmark stays as a quiet corner mark
            even after the artwork arrives, so the surface always identifies
            itself. Fades to near-invisible so it never competes with the art. */}
        {artworkVisible && (
          <div className="pointer-events-none absolute bottom-3 right-3 z-10 select-none">
            <p className="display text-[10px] tracking-[0.14em] text-ink-faint/40">STRATA</p>
          </div>
        )}
        <Artboard
          ref={canvasRef}
          aspectRatio={aspectRatio}
          visible={artworkVisible}
          ariaLabel={artworkLabel}
          onCanvasResized={onCanvasResized}
        />
        <div
          className={`mt-4 flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 ${
            artworkVisible ? "" : "invisible"
          }`}
        >
          <p className="instrument-label enter-readout text-center text-ink-faint">{caption}</p>
          {/* Variations ghost button — desktop only; the mobile STYLE tab has its own. */}
          {variationsReady && (
            <button
              type="button"
              onClick={onOpenVariations}
              className="instrument-label press hidden h-7 items-center rounded-sm border border-hairline px-2.5 text-ink-muted hover:border-hairline-2 hover:text-ink lg:flex"
            >
              Variations
            </button>
          )}
        </div>
        <p className="mt-2 text-center font-mono text-[11px] leading-snug text-ink-muted">
          Map pan and zoom apply automatically · outlined frame = exported area
        </p>
      </div>
    </main>
  );
}
