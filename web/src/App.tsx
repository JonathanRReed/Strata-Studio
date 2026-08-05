import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { ControlsPanel } from "./components/ControlsPanel.tsx";
import { MobileSheet } from "./components/MobileSheet.tsx";
import { Stage } from "./components/Stage.tsx";
import { ExportDialog } from "./components/ExportDialog.tsx";
import { VariationsDialog } from "./components/VariationsDialog.tsx";
import { EggToast } from "./components/EggToast.tsx";
import { useIsDesktop } from "./components/useIsDesktop.ts";
import type {
  FlyToRequest,
  MapSelectionCause,
} from "./components/mapSelectionTypes.ts";
import { getStyle } from "./studios/registry.ts";
import { isBboxSmallEnough, bboxAreaKm2 } from "./data/osmOverpass.ts";
import { defaultPalette } from "./presets/palettes.ts";
import { applyPreset, presets, type Preset } from "./presets/stylePresets.ts";
import type { GeoBounds, Palette, StyleParams } from "./engine/types.ts";
import { getPreviewDimensions } from "./app/aspect.ts";
import { createPlaceholderGrid } from "./app/renderPipeline.ts";
import { isRetryableError } from "./app/status.ts";
import { useTerrain } from "./app/useTerrain.ts";
import { useOsmFeatures } from "./app/useOsmFeatures.ts";
import { useArtworkRenderer } from "./app/useArtworkRenderer.ts";
import { useAnimationLoop } from "./app/useAnimationLoop.ts";
import { useExports } from "./app/useExports.ts";
import { usePalettes } from "./app/usePalettes.ts";
import { useEasterEggs } from "./app/useEasterEggs.ts";
import { useShare } from "./app/useShare.ts";
import { useAutoLabel } from "./app/useAutoLabel.ts";
import { readInitialUrlState, useUrlState } from "./app/useUrlState.ts";
import {
  AUTO_REGEN_DEBOUNCE_MS,
  computeInfluenceBump,
  firstRunPlace,
  urlLocksInfluence,
} from "./app/autopilot.ts";
import type { CuratedPlace } from "./data/places.ts";
import {
  claimInitialGeneration,
  mapSelectionAcknowledgesFlyTo,
  reconcileMapSelection,
  resolveBootSelection,
} from "./app/bootSelection.ts";
import { normalizeStyleParams } from "./app/stateSafety.ts";
import { detectCapabilities } from "./app/capabilities.ts";
import { ensurePosterFonts } from "./engine/posterFonts.ts";
import {
  prepareImportedComposition,
  readCompositionFile,
  type CompositionImportStatus,
} from "./app/composition.ts";
import {
  readOrientationDismissed,
  writeOrientationDismissed,
} from "./app/orientation.ts";

/** One-time boot decision: share-URL restore vs the daily curated place. */
function readBootState() {
  const search = window.location.search;
  const url = readInitialUrlState();
  const place = firstRunPlace(search);
  const preset = place ? (presets.find((p) => p.id === place.presetId) ?? null) : null;
  const initialParams = preset
    ? applyPreset(preset, getStyle(preset.styleId).defaultParams)
    : url.params;
  const selection = resolveBootSelection(url, place, initialParams.aspectRatio);
  return { url, place, preset, selection, urlLocksInfluence: urlLocksInfluence(search) };
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [boot] = useState(readBootState);
  const [capabilities] = useState(detectCapabilities);

  const [styleId, setStyleId] = useState(
    boot.preset ? boot.preset.styleId : boot.url.styleId,
  );
  const [params, setParamsState] = useState<StyleParams>(() => {
    const initial = boot.preset
      ? applyPreset(boot.preset, getStyle(boot.preset.styleId).defaultParams)
      : boot.url.params;
    return normalizeStyleParams(
      boot.place ? { ...initial, label: boot.place.name } : initial,
      initial,
    );
  });
  const setParams = useCallback((next: SetStateAction<StyleParams>) => {
    setParamsState((previous) => {
      const candidate = typeof next === "function" ? next(previous) : next;
      return normalizeStyleParams(candidate, previous);
    });
  }, []);
  const [bounds, setBounds] = useState<GeoBounds>(boot.selection.bounds);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const [mapZoom, setMapZoom] = useState(boot.selection.zoom);
  const [isAnimating, setIsAnimating] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importStatus, setImportStatus] = useState<CompositionImportStatus>({ phase: "idle" });
  const [variationsOpen, setVariationsOpen] = useState(false);
  const [activePlaceId, setActivePlaceId] = useState<string | null>(boot.place?.id ?? null);
  // Viewfinder overlay + fly-to live here so the mobile sheet can drive the
  // map (Stage/MapSelector render them; behavior at lg is unchanged).
  const [mapExpanded, setMapExpanded] = useState(false);
  const mapExpandedRef = useRef(false);
  mapExpandedRef.current = mapExpanded;
  const mapOpenerRef = useRef<HTMLElement | null>(null);
  const [mapFlyTo, setMapFlyTo] = useState<FlyToRequest | null>(null);
  const mapFlyToRef = useRef<FlyToRequest | null>(mapFlyTo);
  mapFlyToRef.current = mapFlyTo;
  const flyToKeyRef = useRef(0);
  const isDesktop = useIsDesktop();
  const [showOrientation, setShowOrientation] = useState(
    () => !readOrientationDismissed(),
  );
  const [customizeRequest, setCustomizeRequest] = useState(0);
  const [mobileSheetModal, setMobileSheetModal] = useState(false);
  const dismissOrientation = useCallback(() => {
    setShowOrientation(false);
    writeOrientationDismissed();
  }, []);

  // The first generation starts after mount from deterministic boot bounds;
  // later real map movements schedule debounced live regeneration.
  const [booted, setBooted] = useState(false);
  const [autoGen, setAutoGen] = useState<{ tick: number } | null>(null);
  const bootedRef = useRef(false);
  const influenceBumpedRef = useRef(boot.urlLocksInfluence);

  const {
    allPalettes,
    allPaletteNames,
    customPalettes,
    savePalette,
    installPalette,
    deletePalette,
  } = usePalettes(boot.url.customPalette);
  const terrain = useTerrain({ bounds, aspectRatio: params.aspectRatio });
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
    isAnimating,
  });
  useAnimationLoop({ canvasRef, isAnimating, input: previewInput, params, styleId, allPalettes });

  const backgroundColor = (allPalettes[params.palette] ?? allPalettes[defaultPalette]).background;
  const exports = useExports({
    bounds,
    terrainGrid: terrain.boundsDirty ? null : terrain.grid,
    previewInput: terrain.boundsDirty ? null : previewInput,
    features: osm.features,
    featureKey: osm.activeKey,
    params,
    styleId,
    mapZoom,
    allPalettes,
    selectedCustomPalette: customPalettes[params.palette] ?? null,
    backgroundColor,
    capabilities,
  });
  const { dismissErrors: dismissExportErrors } = exports;
  const { copiedUrl, copyUrl, copyError, dismissCopyError } = useUrlState({
    params,
    styleId,
    bounds,
    mapZoom,
    selectedCustomPalette: customPalettes[params.palette] ?? null,
  });

  // Landmark easter eggs: each completed generate (fresh grid) is checked;
  // first discoveries unlock a palette via the custom-palette store + toast.
  const { eggToast, dismissEggToast } = useEasterEggs({ grid: terrain.grid, savePalette });

  // Native share (artwork PNG attached where supported; hidden elsewhere).
  const {
    shareSupported,
    share,
    shareStatus,
    isSharing,
    cancelShare,
  } = useShare({
    styleId,
    seed: params.seed,
    label: params.label,
    capabilities,
    createSharePng: exports.createSharePng,
    onFallbackCopy: copyUrl,
  });

  // Auto-named poster labels: generate settles resolve a place name that
  // fills the label unless the user typed their own (see useAutoLabel).
  const handleAutoLabel = useCallback((name: string) => {
    setParams((prev) => (prev.label === name ? prev : { ...prev, label: name }));
  }, [setParams]);
  const { applyCuratedName } = useAutoLabel({
    grid: terrain.grid,
    label: params.label,
    initialCuratedName: boot.place?.name ?? null,
    initialCuratedCenter: boot.place?.center ?? null,
    onAutoLabel: handleAutoLabel,
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
    // Render placeholder noise artwork immediately for feedback (instant —
    // this also cancels any reveal a previous generate left running).
    void renderArtwork(
      createPlaceholderGrid(
        getPreviewDimensions(params.aspectRatio),
        params.seed,
        bounds,
      ),
      { skipMasks: true },
    );
    // Real terrain lands with the one-shot draw-in reveal.
    void generateTerrain((grid) => renderArtwork(grid, { reveal: true }));
    if (isBboxSmallEnough(bounds)) void fetchFeatures(false);
  }, [
    renderArtwork,
    generateTerrain,
    fetchFeatures,
    params.seed,
    params.aspectRatio,
    bounds,
  ]);

  // Latest generate for the auto-gen timer: by the time a timer fires, React
  // has committed the bounds change, so this ref points at a closure over the
  // fresh bounds (the inline handleGenerate above would be stale).
  const handleGenerateRef = useRef(handleGenerate);
  handleGenerateRef.current = handleGenerate;
  const initialGenerateStartedRef = useRef(false);

  // StrictMode replays mount effects in development; the ref keeps the boot
  // placeholder, terrain request, and optional OSM request exactly once.
  useEffect(() => {
    if (!claimInitialGeneration(initialGenerateStartedRef)) return;
    handleGenerateRef.current();
  }, []);

  // The poster title block is set in Archivo Variable + IBM Plex Mono. Canvas
  // text silently falls back to system fonts until the webfont is in memory, so
  // force-load the faces on mount and repaint once they're ready — otherwise
  // the first preview frame (and any export raced before fonts settle) would
  // be set in the wrong typeface.
  useEffect(() => {
    let cancelled = false;
    void ensurePosterFonts().then(() => {
      if (cancelled) return;
      notifyCanvasResized();
    });
    return () => {
      cancelled = true;
    };
  }, [notifyCanvasResized]);

  const handleRetry = useCallback(() => {
    retryTerrain(() => handleGenerateRef.current());
  }, [retryTerrain]);

  const handleBoundsChange = useCallback(
    (newBounds: GeoBounds, zoom: number, cause: MapSelectionCause) => {
      const selection = reconcileMapSelection(
        boundsRef.current,
        newBounds,
        zoom,
        boot.selection.zoom,
      );
      if (!selection) return;
      const pendingFlyTo = mapFlyToRef.current;
      if (pendingFlyTo && mapSelectionAcknowledgesFlyTo(selection, pendingFlyTo)) {
        // Keep the request alive through stale resize/move reports; clear it
        // only after the requested center and zoom actually land.
        mapFlyToRef.current = null;
        setMapFlyTo(null);
      }
      setMapZoom(selection.zoom);
      // MapLibre fits to the already-active boot bounds on load. Its first
      // floating-point echo must synchronize the camera without invalidating
      // or generating the same selection a second time.
      if (!selection.changed) return;
      if (cause === "manual" || cause === "search") {
        setActivePlaceId(null);
        dismissOrientation();
      }

      boundsRef.current = selection.bounds;
      setBounds(selection.bounds);
      // Abort in-flight fetches so stale results don't overwrite state, stop
      // the animation, and mark the preview stale (the artwork is preserved
      // so small camera movements don't lose it).
      invalidateTerrain();
      cancelOsm();
      dismissExportErrors();
      setIsAnimating(false);
      if (bootedRef.current && !isExportingAnimationRef.current) {
        setAutoGen((prev) => ({ tick: (prev?.tick ?? 0) + 1 }));
      }
    },
    [
      boot.selection.zoom,
      invalidateTerrain,
      cancelOsm,
      dismissExportErrors,
      dismissOrientation,
    ],
  );

  // Fires scheduled live regeneration. Every bounds change replaces
  // `autoGen`, so the cleanup restarts the debounce timer.
  useEffect(() => {
    if (!autoGen) return;
    const timer = setTimeout(() => {
      if (isExportingAnimationRef.current) {
        setAutoGen(null);
        return;
      }
      handleGenerateRef.current();
    }, AUTO_REGEN_DEBOUNCE_MS);
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
  }, [osm.features, setParams]);

  const handleStyleChange = useCallback((newStyleId: string) => {
    const style = getStyle(newStyleId);
    setStyleId(style.id);
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
  }, [setParams]);

  const handleApplyPreset = useCallback(
    (preset: Preset) => {
      const style = getStyle(preset.styleId);
      setStyleId(style.id);
      setParams((previous) => ({
        ...applyPreset(preset, style.defaultParams),
        // Labels are composition provenance, not preset styling. Keeping the
        // previous value lets useAutoLabel preserve user-authored text while
        // replacing an auto-authored place name when appropriate.
        label: previous.label,
      }));
      // A preset is a fresh composition baseline: re-arm the influence bump
      // (unless the share URL pinned influence values for this session).
      influenceBumpedRef.current = boot.urlLocksInfluence;
    },
    [boot.urlLocksInfluence, setParams],
  );

  /** Curated place chosen (chip strip or Surprise Me): apply its preset and
   * remember it; the map flies there and live regeneration does the rest. */
  const handleSelectPlace = useCallback(
    (place: CuratedPlace) => {
      dismissOrientation();
      setActivePlaceId(place.id);
      const request = {
        center: place.center,
        zoom: place.zoom,
        key: ++flyToKeyRef.current,
      };
      mapFlyToRef.current = request;
      setMapFlyTo(request);
      const preset = presets.find((p) => p.id === place.presetId);
      if (preset) handleApplyPreset(preset);
      // Curated names label the poster instantly — no geocode round-trip.
      // After the preset so its functional setParams lands on preset params.
      applyCuratedName(place.name, place.center);
    },
    [handleApplyPreset, applyCuratedName, dismissOrientation],
  );

  /** Place chosen from the mobile sheet: the map isn't the click target
   * there, so request the fly-to explicitly, then run the shared flow. */
  const handleSelectPlaceFromSheet = useCallback(
    (place: CuratedPlace) => {
      handleSelectPlace(place);
    },
    [handleSelectPlace],
  );

  const toggleMapExpand = useCallback((opener?: HTMLElement) => {
    if (!mapExpandedRef.current) {
      const active = document.activeElement;
      mapOpenerRef.current =
        opener ?? (active instanceof HTMLElement ? active : null);
      mapExpandedRef.current = true;
      setMapExpanded(true);
      return;
    }

    mapExpandedRef.current = false;
    setMapExpanded(false);
    const restore = mapOpenerRef.current;
    mapOpenerRef.current = null;
    window.requestAnimationFrame(() => {
      if (restore?.isConnected) {
        restore.focus();
        return;
      }
      const fallback = Array.from(
        document.querySelectorAll<HTMLElement>('button[aria-label="Expand map"]'),
      ).find((element) => element.offsetParent !== null);
      fallback?.focus();
    });
  }, []);

  const handleCustomizeArtwork = useCallback(
    (_opener: HTMLElement) => {
      if (!isDesktop) {
        setCustomizeRequest((request) => request + 1);
        return;
      }
      window.requestAnimationFrame(() => {
        const target = document.getElementById("style-controls-section-toggle");
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ block: "nearest" });
          target.focus();
        }
      });
    },
    [isDesktop],
  );

  const handleOrientationChoosePlace = useCallback(
    (opener: HTMLElement) => {
      toggleMapExpand(opener);
      dismissOrientation();
    },
    [dismissOrientation, toggleMapExpand],
  );
  const handleOrientationCustomizeArtwork = useCallback(
    (opener: HTMLElement) => {
      dismissOrientation();
      handleCustomizeArtwork(opener);
    },
    [dismissOrientation, handleCustomizeArtwork],
  );

  const handleSavePalette = useCallback(
    (id: string, name: string, palette: Palette) => {
      savePalette(id, name, palette);
      setParams((prev) => (prev.palette === id ? prev : { ...prev, palette: id }));
    },
    [savePalette, setParams],
  );

  const handleDeletePalette = useCallback(
    (id: string) => {
      deletePalette(id);
      setParams((prev) => (prev.palette === id ? { ...prev, palette: defaultPalette } : prev));
    },
    [deletePalette, setParams],
  );

  const handleImportComposition = useCallback(
    async (file: File) => {
      setImportStatus({ phase: "reading" });
      try {
        // Read and validate the entire document before touching any live state.
        const next = prepareImportedComposition(await readCompositionFile(file));
        if (next.customPalette) {
          installPalette(next.customPalette.id, next.customPalette.entry);
        }

        boundsRef.current = next.bounds;
        setStyleId(next.styleId);
        setParams(next.params);
        setBounds(next.bounds);
        setMapZoom(next.mapZoom);
        setActivePlaceId(null);
        setIsAnimating(false);
        influenceBumpedRef.current = true;
        invalidateTerrain();
        cancelOsm();
        dismissExportErrors();

        const request: FlyToRequest = {
          center: [
            (next.bounds.west + next.bounds.east) / 2,
            (next.bounds.south + next.bounds.north) / 2,
          ],
          zoom: next.mapZoom,
          bounds: next.bounds,
          key: ++flyToKeyRef.current,
        };
        mapFlyToRef.current = request;
        setMapFlyTo(request);
        setBooted(true);
        bootedRef.current = true;
        setAutoGen((previous) => ({ tick: (previous?.tick ?? 0) + 1 }));
        setImportStatus({
          phase: "success",
          message: `Imported ${file.name || "composition"}. The artwork will regenerate with the validated settings.`,
        });
      } catch (error) {
        setImportStatus({
          phase: "error",
          message:
            error instanceof Error
              ? error.message
              : "The composition could not be imported.",
        });
      }
    },
    [
      cancelOsm,
      dismissExportErrors,
      installPalette,
      invalidateTerrain,
      setParams,
    ],
  );

  const dismissImportStatus = useCallback(() => setImportStatus({ phase: "idle" }), []);

  const handleToggleAnimation = useCallback(() => setIsAnimating((prev) => !prev), []);

  const openVariations = useCallback(() => setVariationsOpen(true), []);
  /** Adopt a variation: its seed becomes the artwork's (instant re-render + URL). */
  const handleAdoptVariation = useCallback((seed: string) => {
    setParams((prev) => ({ ...prev, seed }));
    setVariationsOpen(false);
  }, [setParams]);

  // Derived UI state from the per-operation statuses
  const terrainBusy = terrain.status.phase === "fetching" || terrain.status.phase === "rendering";
  const regenPending = autoGen !== null;
  // The stage treats the brief post-mount boot effect and pending live
  // regeneration as generating so the empty/stale states never flash.
  const isGenerating = terrainBusy || regenPending || !booted;
  const variationsReady =
    !!terrain.grid && !terrain.boundsDirty && !isGenerating;
  const statusText =
    terrain.status.phase === "fetching"
      ? terrain.status.note.startsWith("Loading")
        ? "Loading tiles…"
        : terrain.status.note
      : terrain.status.phase === "rendering"
        ? "Rendering…"
        : !booted
          ? "Preparing…"
          : regenPending
            ? "Regenerating…"
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

  // One prop bundle, two containers: the desktop rail and the mobile sheet
  // render the same section components from the same state — never both.
  const controlsProps = {
    params,
    styleId,
    onChange: setParams,
    onStyleChange: handleStyleChange,
    onApplyPreset: handleApplyPreset,
    onGenerate: handleGenerate,
    onOpenExport: () => setExportOpen(true),
    onFetchFeatures: osm.fetchFeatures,
    isLoading: isGenerating,
    isExporting,
    isExportingAnimation,
    isFeatureLoading: osm.status.phase === "fetching",
    featureInfo: osm.featureInfo,
    featureError: osm.status.phase === "error" ? osm.status.error.message : null,
    hasFeatures: !!osm.features,
    osmAreaHint: !isBboxSmallEnough(bounds) ? `Area is ${bboxAreaKm2(bounds).toFixed(1)} km². Zoom in to under 25 km² to fetch OSM features` : null,
    terrainGrid: terrain.grid,
    allPalettes,
    allPaletteNames,
    onSavePalette: handleSavePalette,
    onDeletePalette: handleDeletePalette,
    isAnimating,
    onToggleAnimation: handleToggleAnimation,
    backgroundInert: mapExpanded,
  };

  return (
    <div className="flex min-h-screen flex-col bg-ground text-ink max-lg:h-[100svh] max-lg:min-h-0 max-lg:overflow-hidden max-lg:pb-[var(--sheet-peek)] lg:h-screen lg:flex-row lg:overflow-hidden">
      {isDesktop && <ControlsPanel {...controlsProps} />}
      <Stage
        canvasRef={canvasRef}
        aspectRatio={params.aspectRatio}
        artworkLabel={artworkLabel}
        wallColor={backgroundColor}
        backgroundInert={mobileSheetModal && !mapExpanded}
        hasArtwork={terrain.hasGenerated}
        isGenerating={isGenerating}
        statusText={statusText}
        boundsDirty={terrain.boundsDirty}
        onRegenerate={handleGenerate}
        seed={params.seed}
        label={params.label}
        onOpenVariations={openVariations}
        variationsReady={variationsReady}
        terrainInfo={terrain.terrainInfo}
        warning={terrain.warning}
        errorMessage={errorMessage}
        onDismissError={dismissError}
        showTerrainRetry={!!terrainError && isRetryableError(terrainError)}
        terrainRetryCount={terrain.retryCount}
        onRetryTerrain={handleRetry}
        onCanvasResized={notifyCanvasResized}
        orientation={
          showOrientation
            ? {
                place:
                  params.label ||
                  `${centerLat.toFixed(4)}, ${centerLng.toFixed(4)}`,
                style: getStyle(styleId).name,
                onChoosePlace: handleOrientationChoosePlace,
                onCustomizeArtwork: handleOrientationCustomizeArtwork,
                onDismiss: dismissOrientation,
              }
            : null
        }
        bounds={bounds}
        mapZoom={mapZoom}
        onBoundsChange={handleBoundsChange}
        initialCenter={boot.selection.center}
        initialZoom={boot.selection.zoom}
        initialBounds={boot.selection.bounds}
        activePlaceId={activePlaceId}
        onSelectPlace={handleSelectPlace}
        mapExpanded={mapExpanded}
        onToggleMapExpand={toggleMapExpand}
        mapFlyTo={mapFlyTo}
      />
      {!isDesktop && (
        <MobileSheet
          {...controlsProps}
          bounds={bounds}
          mapZoom={mapZoom}
          activePlaceId={activePlaceId}
          onSelectPlace={handleSelectPlaceFromSheet}
          onOpenMap={toggleMapExpand}
          onCopyUrl={() => void copyUrl()}
          copiedUrl={copiedUrl}
          mapExpanded={mapExpanded}
          onOpenVariations={openVariations}
          variationsReady={variationsReady}
          onShare={() => void share()}
          shareSupported={shareSupported}
          customizeRequest={customizeRequest}
          onModalStateChange={setMobileSheetModal}
        />
      )}
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onExportPng={exports.exportPng}
        onExportSvg={exports.exportSvg}
        onExportAnimation={exports.exportAnimation}
        onExportJson={exports.exportJson}
        onImportComposition={handleImportComposition}
        importStatus={importStatus}
        onDismissImportStatus={dismissImportStatus}
        onCopyUrl={copyUrl}
        copiedUrl={copiedUrl}
        onShare={share}
        shareSupported={shareSupported}
        shareStatus={shareStatus}
        exportStatus={exports.status}
        animationStatus={exports.animationStatus}
        isExporting={isExporting}
        isExportingAnimation={isExportingAnimation}
        isSharing={isSharing}
        animationAvailable={params.animationMode !== "none"}
        capabilities={capabilities}
        onCancel={() => {
          exports.cancelExport();
          cancelShare();
        }}
        onDismissErrors={dismissExportErrors}
      />
      <VariationsDialog
        open={variationsOpen}
        onClose={() => setVariationsOpen(false)}
        grid={terrain.grid}
        features={osm.features}
        params={params}
        styleId={styleId}
        allPalettes={allPalettes}
        supportsNativeDialog={capabilities.dialog}
        onAdopt={handleAdoptVariation}
      />
      {eggToast && (
        <EggToast
          text={eggToast}
          onDismiss={dismissEggToast}
          backgroundInert={mapExpanded}
        />
      )}
    </div>
  );
}
