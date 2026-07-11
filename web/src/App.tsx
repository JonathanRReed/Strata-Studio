import { useCallback, useEffect, useRef, useState } from "react";
import { ControlsPanel } from "./components/ControlsPanel.tsx";
import { Stage } from "./components/Stage.tsx";
import { ExportDialog } from "./components/ExportDialog.tsx";
import { getStyle } from "./studios/registry.ts";
import { isBboxSmallEnough, bboxAreaKm2 } from "./data/osmOverpass.ts";
import { defaultPalette } from "./presets/palettes.ts";
import { applyPreset, presets, type Preset } from "./presets/stylePresets.ts";
import type { GeoBounds, Palette, StyleParams } from "./engine/types.ts";
import { PREVIEW_SIZE } from "./app/aspect.ts";
import { createPlaceholderGrid } from "./app/renderPipeline.ts";
import { isRetryableError } from "./app/status.ts";
import { useTerrain } from "./app/useTerrain.ts";
import { useOsmFeatures } from "./app/useOsmFeatures.ts";
import { useArtworkRenderer } from "./app/useArtworkRenderer.ts";
import { useAnimationLoop } from "./app/useAnimationLoop.ts";
import { useExports } from "./app/useExports.ts";
import { usePalettes } from "./app/usePalettes.ts";
import { readInitialUrlState, useUrlState } from "./app/useUrlState.ts";
import {
  AUTO_REGEN_DEBOUNCE_MS,
  computeInfluenceBump,
  firstRunPlace,
  urlLocksInfluence,
} from "./app/autopilot.ts";
import type { CuratedPlace } from "./data/places.ts";

const DEFAULT_BOUNDS: GeoBounds = { west: -122.5, north: 37.85, east: -122.35, south: 37.7 };
const DEFAULT_CENTER: [number, number] = [-122.4194, 37.7749];
const DEFAULT_ZOOM = 11;

/** One-time boot decision: share-URL restore vs the daily curated place. */
function readBootState() {
  const search = window.location.search;
  const url = readInitialUrlState();
  const place = firstRunPlace(search);
  const preset = place ? (presets.find((p) => p.id === place.presetId) ?? null) : null;
  return { url, place, preset, urlLocksInfluence: urlLocksInfluence(search) };
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [boot] = useState(readBootState);

  const [styleId, setStyleId] = useState(
    boot.preset ? boot.preset.styleId : boot.url.styleId,
  );
  const [params, setParams] = useState<StyleParams>(() =>
    boot.preset ? applyPreset(boot.preset, getStyle(boot.preset.styleId).defaultParams) : boot.url.params,
  );
  const [bounds, setBounds] = useState<GeoBounds>(boot.url.bounds ?? DEFAULT_BOUNDS);
  const [mapZoom, setMapZoom] = useState(boot.url.zoom ?? boot.place?.zoom ?? DEFAULT_ZOOM);
  const [isAnimating, setIsAnimating] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [activePlaceId, setActivePlaceId] = useState<string | null>(boot.place?.id ?? null);

  // Autopilot state: `booted` flips when the first generate fires (map's
  // first bounds report), `autoGen` schedules pending auto-generation.
  // "first" fires immediately; "live" debounces after map movement.
  const [booted, setBooted] = useState(false);
  const [autoGen, setAutoGen] = useState<{ mode: "first" | "live"; tick: number } | null>(null);
  const bootedRef = useRef(false);
  const influenceBumpedRef = useRef(boot.urlLocksInfluence);

  const { allPalettes, allPaletteNames, savePalette, deletePalette } = usePalettes();
  const terrain = useTerrain({ bounds });
  const osm = useOsmFeatures({ bounds });
  const { generate: generateTerrain, invalidate: invalidateTerrain, retry: retryTerrain } = terrain;
  const { cancel: cancelOsm, fetchFeatures } = osm;
  const { previewInput, renderArtwork, notifyCanvasResized } = useArtworkRenderer({
    canvasRef,
    grid: terrain.grid,
    features: osm.features,
    params,
    styleId,
    allPalettes,
    suspended: isAnimating || terrain.boundsDirty,
  });
  useAnimationLoop({ canvasRef, isAnimating, input: previewInput, params, styleId, allPalettes });

  const backgroundColor = (allPalettes[params.palette] ?? allPalettes[defaultPalette]).background;
  const exports = useExports({
    bounds,
    features: osm.features,
    params,
    styleId,
    allPalettes,
    backgroundColor,
  });
  const { dismissErrors: dismissExportErrors } = exports;
  const { copiedUrl, copyUrl, copyError, dismissCopyError } = useUrlState({
    params,
    styleId,
    bounds,
    mapZoom,
  });

  const isExportingAnimation = exports.animationStatus.phase === "exporting";
  const isExportingAnimationRef = useRef(isExportingAnimation);
  isExportingAnimationRef.current = isExportingAnimation;

  /**
   * Generate = terrain + (when the area is small enough) OSM features, in
   * parallel. Terrain owns the artwork; features are an enhancement layered
   * in when they arrive — an OSM failure never blocks the render. Manual
   * calls also clear any pending auto-regeneration so we don't double-fire.
   */
  const handleGenerate = useCallback(() => {
    setAutoGen(null);
    if (!canvasRef.current) return;
    setBooted(true);
    bootedRef.current = true;
    // Render placeholder noise artwork immediately for feedback
    renderArtwork(createPlaceholderGrid(PREVIEW_SIZE, params.seed, bounds), { skipMasks: true });
    void generateTerrain(renderArtwork);
    if (isBboxSmallEnough(bounds)) void fetchFeatures(false);
  }, [renderArtwork, generateTerrain, fetchFeatures, params.seed, bounds]);

  // Latest generate for the auto-gen timer: by the time a timer fires, React
  // has committed the bounds change, so this ref points at a closure over the
  // fresh bounds (the inline handleGenerate above would be stale).
  const handleGenerateRef = useRef(handleGenerate);
  handleGenerateRef.current = handleGenerate;

  const handleRetry = useCallback(() => {
    retryTerrain(() => handleGenerateRef.current());
  }, [retryTerrain]);

  const handleBoundsChange = useCallback(
    (newBounds: GeoBounds, zoom: number) => {
      setBounds(newBounds);
      setMapZoom(zoom);
      // Abort in-flight fetches so stale results don't overwrite state, stop
      // the animation, and mark the preview stale (the artwork is preserved
      // so small camera movements don't lose it).
      invalidateTerrain();
      cancelOsm();
      dismissExportErrors();
      setIsAnimating(false);
      // Autopilot: the map's first bounds report triggers the initial
      // generate immediately (fresh visits and share-URL restores alike);
      // afterwards every settle schedules a debounced regenerate — except
      // while an animation export is rendering frames.
      if (!bootedRef.current) {
        setAutoGen((prev) => ({ mode: "first", tick: (prev?.tick ?? 0) + 1 }));
      } else if (!isExportingAnimationRef.current) {
        setAutoGen((prev) => ({ mode: "live", tick: (prev?.tick ?? 0) + 1 }));
      }
    },
    [invalidateTerrain, cancelOsm, dismissExportErrors],
  );

  // Fires the scheduled auto-generation. Every bounds change replaces
  // `autoGen`, so the cleanup restarts the timer — that's the debounce.
  useEffect(() => {
    if (!autoGen) return;
    const delay = autoGen.mode === "first" ? 0 : AUTO_REGEN_DEBOUNCE_MS;
    const timer = setTimeout(() => {
      if (isExportingAnimationRef.current) {
        setAutoGen(null);
        return;
      }
      handleGenerateRef.current();
    }, delay);
    return () => clearTimeout(timer);
  }, [autoGen]);

  // Influence bump: the first time features arrive while every influence the
  // active style declares is still 0, nudge them to tasteful defaults so the
  // feature trick is visible. Applied at most once per composition — a share
  // URL that encodes influence values (user choices, zeros included) locks it
  // for the whole session.
  const styleIdRef = useRef(styleId);
  styleIdRef.current = styleId;
  useEffect(() => {
    if (!osm.features || influenceBumpedRef.current) return;
    setParams((prev) => {
      const bump = computeInfluenceBump(prev, getStyle(styleIdRef.current).controls);
      if (!bump) return prev;
      influenceBumpedRef.current = true;
      return { ...prev, ...bump };
    });
  }, [osm.features]);

  const handleStyleChange = useCallback((newStyleId: string) => {
    setStyleId(newStyleId);
    const style = getStyle(newStyleId);
    // Stop animation when switching styles — the new style may not support the current mode
    setIsAnimating(false);
    setParams((prev) => ({
      ...prev,
      ...style.defaultParams,
      // Preserve user's composition choices when switching styles
      seed: prev.seed,
      grain: prev.grain,
      rotation: prev.rotation,
      label: prev.label,
      aspectRatio: prev.aspectRatio,
      palette: style.defaultParams.palette ?? prev.palette,
      // Reset animation to none — let the user re-enable it for the new style
      animationMode: "none",
    }));
  }, []);

  const handleApplyPreset = useCallback(
    (preset: Preset) => {
      setStyleId(preset.styleId);
      setParams(applyPreset(preset, getStyle(preset.styleId).defaultParams));
      // A preset is a fresh composition baseline: re-arm the influence bump
      // (unless the share URL pinned influence values for this session).
      influenceBumpedRef.current = boot.urlLocksInfluence;
    },
    [boot.urlLocksInfluence],
  );

  /** Curated place chosen (chip strip or Surprise Me): apply its preset and
   * remember it; the map flies there and live regeneration does the rest. */
  const handleSelectPlace = useCallback(
    (place: CuratedPlace) => {
      setActivePlaceId(place.id);
      const preset = presets.find((p) => p.id === place.presetId);
      if (preset) handleApplyPreset(preset);
    },
    [handleApplyPreset],
  );

  const handleSavePalette = useCallback(
    (id: string, name: string, palette: Palette) => {
      savePalette(id, name, palette);
      setParams((prev) => (prev.palette === id ? prev : { ...prev, palette: id }));
    },
    [savePalette],
  );

  const handleDeletePalette = useCallback(
    (id: string) => {
      deletePalette(id);
      setParams((prev) => (prev.palette === id ? { ...prev, palette: defaultPalette } : prev));
    },
    [deletePalette],
  );

  const handleToggleAnimation = useCallback(() => setIsAnimating((prev) => !prev), []);

  // Derived UI state from the per-operation statuses
  const terrainBusy = terrain.status.phase === "fetching" || terrain.status.phase === "rendering";
  const regenPending = autoGen !== null;
  // The stage treats "about to regenerate" and "waiting for the map's first
  // bounds" as generating too, so the stale banner and the empty state never
  // flash during the happy path.
  const isGenerating = terrainBusy || regenPending || !booted;
  const statusText =
    terrain.status.phase === "fetching"
      ? terrain.status.note.startsWith("Loading")
        ? "Loading tiles"
        : terrain.status.note
      : terrain.status.phase === "rendering"
        ? "Rendering"
        : !booted
          ? "Locating"
          : regenPending
            ? "Regenerating"
            : null;
  const isExporting = exports.status.phase === "fetching" || exports.status.phase === "rendering";

  // OSM failures stay off the main error surface: features are an
  // enhancement, so their errors live in the quieter FEATURES section chip
  // (which falls back to "No features loaded" + the manual fetch button).
  const terrainError = terrain.status.phase === "error" ? terrain.status.error : null;
  const errorMessage = terrainError?.message ?? copyError;
  const dismissError = () => {
    terrain.dismissError();
    dismissCopyError();
  };

  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;
  const artworkLabel = `${getStyle(styleId).name} artwork of ${
    params.label || `${centerLat.toFixed(4)}, ${centerLng.toFixed(4)}`
  }`;

  return (
    <div className="flex min-h-screen flex-col bg-ground text-ink lg:h-screen lg:flex-row lg:overflow-hidden">
      <ControlsPanel
        params={params}
        styleId={styleId}
        onChange={setParams}
        onStyleChange={handleStyleChange}
        onApplyPreset={handleApplyPreset}
        onGenerate={handleGenerate}
        onOpenExport={() => setExportOpen(true)}
        onFetchFeatures={osm.fetchFeatures}
        isLoading={terrainBusy}
        isExporting={isExporting}
        isExportingAnimation={isExportingAnimation}
        isFeatureLoading={osm.status.phase === "fetching"}
        featureInfo={osm.featureInfo}
        hasFeatures={!!osm.features}
        osmAreaHint={!isBboxSmallEnough(bounds) ? `Area is ${bboxAreaKm2(bounds).toFixed(1)} km² — zoom in to under 25 km² to fetch OSM features` : null}
        terrainGrid={terrain.grid}
        allPalettes={allPalettes}
        allPaletteNames={allPaletteNames}
        onSavePalette={handleSavePalette}
        onDeletePalette={handleDeletePalette}
        isAnimating={isAnimating}
        onToggleAnimation={handleToggleAnimation}
      />
      <Stage
        canvasRef={canvasRef}
        aspectRatio={params.aspectRatio}
        artworkLabel={artworkLabel}
        wallColor={backgroundColor}
        hasArtwork={terrain.hasGenerated}
        isGenerating={isGenerating}
        statusText={statusText}
        boundsDirty={terrain.boundsDirty}
        onRegenerate={handleGenerate}
        seed={params.seed}
        terrainInfo={terrain.terrainInfo}
        warning={terrain.warning}
        errorMessage={errorMessage}
        onDismissError={dismissError}
        showTerrainRetry={!!terrainError && isRetryableError(terrainError)}
        terrainRetryCount={terrain.retryCount}
        onRetryTerrain={handleRetry}
        onCanvasResized={notifyCanvasResized}
        bounds={bounds}
        mapZoom={mapZoom}
        onBoundsChange={handleBoundsChange}
        initialCenter={boot.url.center ?? boot.place?.center ?? DEFAULT_CENTER}
        initialZoom={boot.url.zoom ?? boot.place?.zoom ?? DEFAULT_ZOOM}
        initialBounds={boot.url.bounds}
        activePlaceId={activePlaceId}
        onSelectPlace={handleSelectPlace}
      />
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onExportPng={exports.exportPng}
        onExportSvg={exports.exportSvg}
        onExportAnimation={exports.exportAnimation}
        onExportJson={exports.exportJson}
        onCopyUrl={copyUrl}
        copiedUrl={copiedUrl}
        exportStatus={exports.status}
        animationStatus={exports.animationStatus}
        isExporting={isExporting}
        isExportingAnimation={isExportingAnimation}
        animationAvailable={params.animationMode !== "none"}
        onDismissErrors={dismissExportErrors}
      />
    </div>
  );
}
