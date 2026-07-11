import { useCallback, useRef, useState } from "react";
import { ControlsPanel } from "./components/ControlsPanel.tsx";
import { Stage } from "./components/Stage.tsx";
import { ExportDialog } from "./components/ExportDialog.tsx";
import { getStyle } from "./studios/registry.ts";
import { isBboxSmallEnough, bboxAreaKm2 } from "./data/osmOverpass.ts";
import { defaultPalette } from "./presets/palettes.ts";
import { applyPreset, type Preset } from "./presets/stylePresets.ts";
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

const DEFAULT_BOUNDS: GeoBounds = { west: -122.5, north: 37.85, east: -122.35, south: 37.7 };
const DEFAULT_CENTER: [number, number] = [-122.4194, 37.7749];
const DEFAULT_ZOOM = 11;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [initialUrl] = useState(() => readInitialUrlState());

  const [styleId, setStyleId] = useState(initialUrl.styleId);
  const [params, setParams] = useState<StyleParams>(initialUrl.params);
  const [bounds, setBounds] = useState<GeoBounds>(initialUrl.bounds ?? DEFAULT_BOUNDS);
  const [mapZoom, setMapZoom] = useState(initialUrl.zoom ?? DEFAULT_ZOOM);
  const [isAnimating, setIsAnimating] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const { allPalettes, allPaletteNames, savePalette, deletePalette } = usePalettes();
  const terrain = useTerrain({ bounds });
  const osm = useOsmFeatures({ bounds });
  const { generate: generateTerrain, invalidate: invalidateTerrain, retry: retryTerrain } = terrain;
  const { cancel: cancelOsm } = osm;
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

  const handleGenerate = useCallback(() => {
    if (!canvasRef.current) return;
    // Render placeholder noise artwork immediately for feedback
    renderArtwork(createPlaceholderGrid(PREVIEW_SIZE, params.seed, bounds), { skipMasks: true });
    void generateTerrain(renderArtwork);
  }, [renderArtwork, generateTerrain, params.seed, bounds]);

  const handleRetry = useCallback(() => {
    retryTerrain(handleGenerate);
  }, [retryTerrain, handleGenerate]);

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
    },
    [invalidateTerrain, cancelOsm, dismissExportErrors],
  );

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

  const handleApplyPreset = useCallback((preset: Preset) => {
    setStyleId(preset.styleId);
    setParams(applyPreset(preset, getStyle(preset.styleId).defaultParams));
  }, []);

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
  const isGenerating = terrain.status.phase === "fetching" || terrain.status.phase === "rendering";
  const statusText =
    terrain.status.phase === "fetching"
      ? terrain.status.note.startsWith("Loading")
        ? "Loading tiles"
        : terrain.status.note
      : terrain.status.phase === "rendering"
        ? "Rendering"
        : null;
  const isExporting = exports.status.phase === "fetching" || exports.status.phase === "rendering";
  const isExportingAnimation = exports.animationStatus.phase === "exporting";

  const terrainError = terrain.status.phase === "error" ? terrain.status.error : null;
  const osmError = osm.status.phase === "error" ? osm.status.error : null;
  const errorMessage = terrainError?.message ?? osmError?.message ?? copyError;
  const dismissError = () => {
    terrain.dismissError();
    osm.dismissError();
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
        isLoading={isGenerating}
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
        showOsmRetry={!!osmError && isRetryableError(osmError)}
        osmRetryCount={osm.retryCount}
        onRetryOsm={() => void osm.fetchFeatures(true)}
        onCanvasResized={notifyCanvasResized}
        bounds={bounds}
        mapZoom={mapZoom}
        onBoundsChange={handleBoundsChange}
        initialCenter={initialUrl.center ?? DEFAULT_CENTER}
        initialZoom={initialUrl.zoom ?? DEFAULT_ZOOM}
        initialBounds={initialUrl.bounds}
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
