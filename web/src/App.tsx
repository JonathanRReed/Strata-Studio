import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ControlsPanel } from "./components/ControlsPanel.tsx";
import { Artboard } from "./components/Artboard.tsx";
import { renderStyleCanvas, renderStyleSvg, getStyle, DEFAULT_STYLE_ID, stylesById } from "./studios/registry.ts";
import { renderSceneCanvas } from "./engine/scene.ts";
import { fetchTerrain } from "./data/terrainTiles.ts";
import { fetchOsmFeatures, isBboxSmallEnough, bboxAreaKm2, OSM_ATTRIBUTION } from "./data/osmOverpass.ts";
import { buildFeatureMasks } from "./engine/maskRasterizer.ts";
import { createOffscreenCanvas, downloadPngWithAttribution, downloadSvgWithAttribution } from "./engine/export.ts";
import { exportAnimation, type AnimationFormat, type ExportProgress } from "./engine/animationExport.ts";
import { createNoise } from "./engine/noise.ts";
import { cropGridToAspect } from "./engine/grid.ts";
import { animateScene, DEFAULT_FRAMES, DEFAULT_FPS, needsRegeneration } from "./engine/animation.ts";
import type { GeoBounds, StyleParams, GeoFeatureCollection, ElevationGrid, AspectRatio, Palette } from "./engine/types.ts";
import { applyPreset, defaultStyleParams, presets, type Preset } from "./presets/stylePresets.ts";
import { palettes, paletteNames, defaultPalette } from "./presets/palettes.ts";
import { loadCustomPalettes, saveCustomPalettes } from "./presets/customPalettes.ts";

const MapSelector = lazy(() => import("./components/MapSelector.tsx"));

const PREVIEW_SIZE = 512;
const DEBOUNCE_MS = 150;
const TERRAIN_ATTRIBUTION = "Terrain: Mapzen / AWS Open Data";

const ASPECT_RATIOS: Record<AspectRatio, { w: number; h: number }> = {
  "square": { w: 1, h: 1 },
  "16:9": { w: 16, h: 9 },
  "9:16": { w: 9, h: 16 },
  "12:18": { w: 12, h: 18 },
};

function getPreviewDimensions(aspect: AspectRatio): { width: number; height: number } {
  const ratio = ASPECT_RATIOS[aspect];
  if (ratio.w === ratio.h) return { width: PREVIEW_SIZE, height: PREVIEW_SIZE };
  const maxDim = PREVIEW_SIZE;
  if (ratio.w > ratio.h) {
    return { width: maxDim, height: Math.round((maxDim * ratio.h) / ratio.w) };
  }
  return { width: Math.round((maxDim * ratio.w) / ratio.h), height: maxDim };
}

function createPlaceholderGrid(size: number, seed: string, bounds: GeoBounds): ElevationGrid {
  const noise = createNoise(seed, 4, 0.5);
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      const v = y / (size - 1);
      data[y * size + x] = noise(u * 4, v * 4) * 0.5 + 0.5;
    }
  }
  return { width: size, height: size, bounds, data };
}

type UrlState = Partial<StyleParams> & {
  lat?: number;
  lng?: number;
  z?: number;
  styleId?: string;
};

function parseUrlParams(): UrlState {
  const search = new URLSearchParams(window.location.search);
  const result: UrlState = {};
  const lat = search.get("lat");
  const lng = search.get("lng");
  const z = search.get("z");
  const seed = search.get("seed");
  const palette = search.get("palette");
  const style = search.get("style");
  const preset = search.get("preset");
  if (lat) result.lat = parseFloat(lat);
  if (lng) result.lng = parseFloat(lng);
  if (z) result.z = parseInt(z, 10);
  if (preset) {
    const found = presets.find((p) => p.id === preset);
    if (found) {
      result.styleId = found.styleId;
      Object.assign(result, applyPreset(found, getStyle(found.styleId).defaultParams));
    }
  }
  if (style && stylesById[style]) result.styleId = style;
  if (seed) result.seed = seed;
  if (palette) {
    const customPalettes = loadCustomPalettes();
    if (palettes[palette] || customPalettes[palette]) {
      result.palette = palette;
    }
  }
  return result;
}

function updateUrl(params: StyleParams, styleId: string, bounds: GeoBounds, mapZoom: number) {
  const lat = (bounds.north + bounds.south) / 2;
  const lng = (bounds.east + bounds.west) / 2;
  const search = new URLSearchParams();
  search.set("lat", lat.toFixed(4));
  search.set("lng", lng.toFixed(4));
  search.set("z", String(mapZoom));
  search.set("style", styleId);
  search.set("seed", params.seed);
  search.set("palette", params.palette);
  const newUrl = `${window.location.pathname}?${search.toString()}`;
  window.history.replaceState(null, "", newUrl);
}

function isAllZeros(grid: ElevationGrid): boolean {
  for (let i = 0; i < grid.data.length; i++) {
    if (grid.data[i] !== 0) return false;
  }
  return true;
}

function isAtOcean(features?: GeoFeatureCollection): boolean {
  if (!features) return false;
  const hasLand = features.features.some(
    (f) => f.properties.strataType === "building" || f.properties.strataType === "road",
  );
  return !hasLand;
}

function isRetryableError(error: string | null): boolean {
  if (!error) return false;
  return (
    /all terrain tiles failed|tile load (error|timeout)|fetch|network|too busy|rate limit|timeout/i.test(
      error,
    ) && !/bbox is too large/i.test(error)
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const osmAbortRef = useRef<AbortController | null>(null);
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const urlParams = useRef(parseUrlParams());

  const [styleId, setStyleId] = useState<string>(urlParams.current.styleId ?? DEFAULT_STYLE_ID);
  const [params, setParams] = useState<StyleParams>(() => ({
    ...defaultStyleParams,
    ...getStyle(urlParams.current.styleId ?? DEFAULT_STYLE_ID).defaultParams,
    ...urlParams.current,
  }));

  const defaultCenter = useRef<[number, number]>(
    urlParams.current.lng && urlParams.current.lat
      ? [urlParams.current.lng, urlParams.current.lat]
      : [-122.4194, 37.7749],
  ).current;
  const defaultZoom = useRef<number>(urlParams.current.z ?? 11).current;

  const [bounds, setBounds] = useState<GeoBounds>(() => {
    if (urlParams.current.lat && urlParams.current.lng && urlParams.current.z) {
      const lat = urlParams.current.lat;
      const lng = urlParams.current.lng;
      const halfLat = 0.075 / Math.pow(2, (urlParams.current.z - 11) || 0);
      const halfLng = halfLat * Math.cos((lat * Math.PI) / 180);
      return {
        west: lng - halfLng,
        east: lng + halfLng,
        north: lat + halfLat,
        south: lat - halfLat,
      };
    }
    return { west: -122.5, north: 37.85, east: -122.35, south: 37.7 };
  });

  const [grid, setGrid] = useState<ElevationGrid | null>(null);
  const [features, setFeatures] = useState<GeoFeatureCollection | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [isFeatureLoading, setIsFeatureLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [featureInfo, setFeatureInfo] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [osmRetryCount, setOsmRetryCount] = useState(0);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [mapZoom, setMapZoom] = useState(urlParams.current.z ?? 11);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [terrainInfo, setTerrainInfo] = useState<string | null>(null);
  const [customPalettes, setCustomPalettes] = useState<Record<string, { name: string; palette: Palette }>>(
    () => loadCustomPalettes(),
  );
  const [isAnimating, setIsAnimating] = useState(false);
  const [isExportingAnimation, setIsExportingAnimation] = useState(false);
  const [animationProgress, setAnimationProgress] = useState<{ progress: number; status: string } | null>(null);
  const [boundsDirty, setBoundsDirty] = useState(false);

  const allPalettes = useMemo<Record<string, Palette>>(
    () => ({
      ...palettes,
      ...Object.fromEntries(Object.entries(customPalettes).map(([id, v]) => [id, v.palette])),
    }),
    [customPalettes],
  );

  const allPaletteNames = useMemo<Record<string, string>>(
    () => ({
      ...paletteNames,
      ...Object.fromEntries(Object.entries(customPalettes).map(([id, v]) => [id, v.name])),
    }),
    [customPalettes],
  );

  const masks = useMemo(() => {
    if (!features || !grid) return undefined;
    // Build masks aligned to the cropped preview bounds and dimensions
    const { width: pvW, height: pvH } = getPreviewDimensions(params.aspectRatio);
    const croppedGrid = params.aspectRatio === "square" ? grid : cropGridToAspect(grid, pvW, pvH);
    const maskSize = 512;
    const maskW = pvW >= pvH ? maskSize : Math.round((maskSize * pvW) / pvH);
    const maskH = pvW >= pvH ? Math.round((maskSize * pvH) / pvW) : maskSize;
    return buildFeatureMasks(features, croppedGrid.bounds, maskW, maskH);
  }, [features, grid, params.aspectRatio]);

  useEffect(() => {
    updateUrl(params, styleId, bounds, mapZoom);
  }, [params, styleId, bounds, mapZoom]);

  const renderPreview = useCallback(
    (useGrid?: ElevationGrid) => {
      const canvas = canvasRef.current;
      const g = useGrid ?? grid;
      if (!canvas || !g) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width, height } = getPreviewDimensions(params.aspectRatio);
      const croppedGrid = params.aspectRatio === "square" ? g : cropGridToAspect(g, width, height);

      renderStyleCanvas(
        styleId,
        ctx,
        {
          bounds: croppedGrid.bounds,
          elevationGrid: croppedGrid,
          features,
          masks,
          width,
          height,
          seed: params.seed,
        },
        params,
        allPalettes,
      );
    },
    [grid, features, masks, params, styleId, allPalettes],
  );

  // Debounced live preview when params/style/features change
  useEffect(() => {
    if (!grid) return;
    if (isAnimating) return; // animation loop handles rendering
    if (boundsDirty) return; // don't re-render stale grid for new bounds
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = setTimeout(() => {
      renderPreview();
    }, DEBOUNCE_MS);
    return () => {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    };
  }, [grid, renderPreview, isAnimating, boundsDirty]);

  // Animation preview loop
  const animFrameRef = useRef<number>(0);
  const animStartRef = useRef<number>(0);
  const animSceneRef = useRef<import("./engine/scene.ts").Scene | null>(null);
  // Ref for the latest params so the loop can read animationSpeed without restarting
  const animParamsRef = useRef(params);
  animParamsRef.current = params;

  // Signature of params that should restart the animation loop (excluding animationSpeed)
  const animRestartKey = JSON.stringify({
    ...params,
    animationSpeed: undefined,
    phase: undefined,
  });

  useEffect(() => {
    if (!isAnimating || !grid) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = getPreviewDimensions(params.aspectRatio);
    const croppedGrid = params.aspectRatio === "square" ? grid : cropGridToAspect(grid, width, height);
    const input = {
      bounds: croppedGrid.bounds,
      elevationGrid: croppedGrid,
      features,
      masks,
      width,
      height,
      seed: params.seed,
    };
    const style = getStyle(styleId);
    const palette = allPalettes[params.palette] ?? allPalettes[defaultPalette];

    // For non-regeneration modes, generate the scene once
    if (!needsRegeneration(params.animationMode)) {
      animSceneRef.current = style.generate(input, { ...params, phase: 0 });
    } else {
      animSceneRef.current = null;
    }

    animStartRef.current = performance.now();
    const totalFrames = DEFAULT_FRAMES;

    const loop = (now: number) => {
      const currentParams = animParamsRef.current;
      const elapsed = now - animStartRef.current;
      const loopDurationMs = (1 / currentParams.animationSpeed) * 1000;
      // Use continuous phase (not wrapping) for drift to avoid noise discontinuity.
      // For draw/parallax, wrap to [0,1) for frame indexing.
      const rawPhase = elapsed / loopDurationMs;
      const phase = needsRegeneration(currentParams.animationMode)
        ? rawPhase // continuous — noise field scrolls seamlessly
        : rawPhase % 1;
      const frame = Math.floor((rawPhase % 1) * totalFrames);

      if (needsRegeneration(currentParams.animationMode)) {
        // Drift: regenerate with continuous phase
        const animParams = { ...currentParams, phase };
        renderStyleCanvas(styleId, ctx, input, animParams, allPalettes);
      } else {
        // Draw-in / parallax: post-process the static scene
        const scene = animateScene(animSceneRef.current!, currentParams, frame, totalFrames, width, height);
        renderSceneCanvas(ctx, scene, currentParams, palette, width, height, false, input.masks);
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };
    animFrameRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnimating, grid, features, masks, styleId, allPalettes, animRestartKey]);

  const handleBoundsChange = useCallback((newBounds: GeoBounds, zoom: number) => {
    setBounds(newBounds);
    setMapZoom(zoom);
    // Abort any in-flight terrain/OSM fetches so stale results don't overwrite state
    abortRef.current?.abort();
    osmAbortRef.current?.abort();
    setIsLoading(false);
    setIsFeatureLoading(false);
    // Stop animation — the grid/features are now stale
    setIsAnimating(false);
    // Preserve the existing preview — just mark it as stale so the user knows
    // they need to regenerate. This prevents accidental data loss from small
    // camera movements.
    setBoundsDirty(true);
    setError(null);
    setWarning(null);
  }, []);

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

  const handleSavePalette = useCallback((id: string, name: string, palette: Palette) => {
    setCustomPalettes((prev) => {
      const next = { ...prev, [id]: { name, palette } };
      if (!saveCustomPalettes(next)) {
        console.warn("Failed to save custom palette to localStorage (storage may be full or disabled).");
      }
      return next;
    });
    if (params.palette !== id) {
      setParams((prev) => ({ ...prev, palette: id }));
    }
  }, [params.palette]);

  const handleDeletePalette = useCallback((id: string) => {
    setCustomPalettes((prev) => {
      const { [id]: _, ...next } = prev;
      if (!saveCustomPalettes(next)) {
        console.warn("Failed to update localStorage after deleting custom palette.");
      }
      return next;
    });
    if (params.palette === id) {
      setParams((prev) => ({ ...prev, palette: defaultPalette }));
    }
  }, [params.palette]);

  const handleGenerate = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width: pvW, height: pvH } = getPreviewDimensions(params.aspectRatio);

    // Render placeholder noise artwork immediately for feedback
    const placeholder = createPlaceholderGrid(PREVIEW_SIZE, params.seed, bounds);
    const phGrid = params.aspectRatio === "square" ? placeholder : cropGridToAspect(placeholder, pvW, pvH);
    const phCtx = canvas.getContext("2d");
    if (phCtx) {
      renderStyleCanvas(
        styleId,
        phCtx,
        {
          bounds: phGrid.bounds,
          elevationGrid: phGrid,
          features,
          masks: undefined,
          width: pvW,
          height: pvH,
          seed: params.seed,
        },
        params,
        allPalettes,
      );
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);
    setWarning(null);
    setStatusText("Loading terrain tiles...");
    setTerrainInfo(null);

    // Auto-retry with exponential backoff for transient failures
    const MAX_AUTO_RETRIES = 2;
    const BASE_BACKOFF = 800;
    for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
      if (controller.signal.aborted) return;
      try {
        const newGrid = await fetchTerrain(bounds, PREVIEW_SIZE, controller.signal);
        if (controller.signal.aborted) return;
        setGrid(newGrid);
        setBoundsDirty(false);
        setStatusText("Rendering artwork...");
        const { width: rW, height: rH } = getPreviewDimensions(params.aspectRatio);
        const renderGrid = params.aspectRatio === "square" ? newGrid : cropGridToAspect(newGrid, rW, rH);
        // Rebuild masks locally — the `masks` useMemo hasn't recomputed yet
        // because setGrid hasn't triggered a re-render at this point.
        const maskSize = 512;
        const maskW = rW >= rH ? maskSize : Math.round((maskSize * rW) / rH);
        const maskH = rW >= rH ? Math.round((maskSize * rH) / rW) : maskSize;
        const renderMasks = features
          ? buildFeatureMasks(features, renderGrid.bounds, maskW, maskH)
          : undefined;
        const canvas2 = canvasRef.current;
        const ctx2 = canvas2?.getContext("2d");
        if (ctx2) {
          renderStyleCanvas(
            styleId,
            ctx2,
            {
              bounds: renderGrid.bounds,
              elevationGrid: renderGrid,
              features,
              masks: renderMasks,
              width: rW,
              height: rH,
              seed: params.seed,
            },
            params,
            allPalettes,
          );
        }
        setHasGenerated(true);

        let min = Infinity, max = -Infinity;
        for (let i = 0; i < newGrid.data.length; i++) {
          const v = newGrid.data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        if (min === 0 && max === 0) {
          setTerrainInfo("Terrain: all zeros (ocean or failed tiles)");
        } else {
          const range = max - min;
          const centerLat = ((bounds.north + bounds.south) / 2).toFixed(4);
          const centerLng = ((bounds.east + bounds.west) / 2).toFixed(4);
          setTerrainInfo(`Elevation ${min.toFixed(0)}m – ${max.toFixed(0)}m (${range.toFixed(0)}m range) · ${centerLat}°, ${centerLng}°`);
        }

        if (isAllZeros(newGrid) && !isAtOcean(features)) {
          setWarning("Some terrain tiles failed to load — showing partial data.");
        }
        setStatusText(null);
        break; // Success — exit retry loop
      } catch (err) {
        if (controller.signal.aborted) return;
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        // Only retry on transient/network errors, not on permanent ones
        if (attempt < MAX_AUTO_RETRIES && isRetryableError(errMsg)) {
          const backoff = BASE_BACKOFF * Math.pow(2, attempt);
          setStatusText(`Retrying in ${backoff / 1000}s... (${attempt + 1}/${MAX_AUTO_RETRIES})`);
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, backoff);
            controller.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("Aborted"));
            }, { once: true });
          });
          if (controller.signal.aborted) return;
          setStatusText("Loading terrain tiles...");
          continue;
        }
        setError(errMsg);
        break;
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
          setStatusText(null);
        }
      }
    }
  };

  const handleRetry = () => {
    setRetryCount((count) => count + 1);
    // Small delay before manual retry to avoid hammering the server
    setTimeout(() => handleGenerate(), 500);
  };

  const getExportDimensions = (size: number): { width: number; height: number } => {
    const ratio = ASPECT_RATIOS[params.aspectRatio];
    if (ratio.w === ratio.h) return { width: size, height: size };
    if (ratio.w > ratio.h) {
      return { width: size, height: Math.round((size * ratio.h) / ratio.w) };
    }
    return { width: Math.round((size * ratio.w) / ratio.h), height: size };
  };

  const backgroundColor = (allPalettes[params.palette] ?? allPalettes[defaultPalette]).background;

  const prepareExportInput = async (width: number, height: number, signal?: AbortSignal) => {
    const squareGrid = await fetchTerrain(bounds, Math.max(width, height), signal);
    const exportGrid = cropGridToAspect(squareGrid, width, height);
    const maskSize = 512;
    const maskW = width >= height ? maskSize : Math.round((maskSize * width) / height);
    const maskH = width >= height ? Math.round((maskSize * height) / width) : maskSize;
    const exportMasks = features
      ? buildFeatureMasks(features, exportGrid.bounds, maskW, maskH)
      : undefined;
    return {
      bounds: exportGrid.bounds,
      elevationGrid: exportGrid,
      features,
      masks: exportMasks,
      width,
      height,
      seed: params.seed,
    };
  };

  const handleExportPng = async (size: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const { width, height } = getExportDimensions(size);
      const input = await prepareExportInput(width, height);
      const { canvas, ctx } = createOffscreenCanvas(width, height);
      renderStyleCanvas(styleId, ctx, input, params, allPalettes);
      const attribution = `Map data © ${OSM_ATTRIBUTION} | ${TERRAIN_ATTRIBUTION}`;
      downloadPngWithAttribution(
        canvas,
        `strata-${styleId}-${params.seed}-${width}x${height}.png`,
        attribution,
        backgroundColor,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleExportSvg = async (size: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const { width, height } = getExportDimensions(size);
      const input = await prepareExportInput(width, height);
      const svg = renderStyleSvg(styleId, input, params, allPalettes);
      const attribution = `Map data © ${OSM_ATTRIBUTION} | ${TERRAIN_ATTRIBUTION}`;
      downloadSvgWithAttribution(
        svg,
        `strata-${styleId}-${params.seed}-${width}x${height}.svg`,
        attribution,
        backgroundColor,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleFetchFeatures = async (isRetry = false) => {
    if (!isBboxSmallEnough(bounds)) {
      setError(`Selected area is too large for OSM queries. Please zoom in (max ~25 km²).`);
      return;
    }
    if (isRetry) {
      setOsmRetryCount((c) => c + 1);
    } else {
      setOsmRetryCount(0);
    }
    osmAbortRef.current?.abort();
    const controller = new AbortController();
    osmAbortRef.current = controller;
    setIsFeatureLoading(true);
    setError(null);
    try {
      const collected = await fetchOsmFeatures(bounds, controller.signal);
      if (controller.signal.aborted) return;
      setFeatures(collected);
      const counts = { building: 0, road: 0, water: 0 };
      const waterCounts = { ocean: 0, lake: 0, river: 0 };
      for (const f of collected.features) {
        counts[f.properties.strataType]++;
        if (f.properties.strataType === "water") {
          waterCounts[f.properties.waterType ?? "lake"]++;
        }
      }
      const waterDetail =
        counts.water > 0
          ? ` (${waterCounts.lake} lakes, ${waterCounts.river} rivers${waterCounts.ocean > 0 ? `, ${waterCounts.ocean} coastlines` : ""})`
          : "";
      setFeatureInfo(
        `Loaded ${counts.building} buildings, ${counts.road} roads, ${counts.water} water features${waterDetail}`,
      );

      setWarning(
        grid && isAllZeros(grid) && !isAtOcean(collected)
          ? "Some terrain tiles failed to load — showing partial data."
          : null,
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Failed to fetch OSM data");
        setFeatureInfo(null);
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsFeatureLoading(false);
      }
    }
  };

  const handleExportJson = () => {
    const json = JSON.stringify({ styleId, ...params }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `strata-${styleId}-${params.seed}.json`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      setError("Failed to copy URL to clipboard");
    }
  };

  const handleToggleAnimation = () => {
    setIsAnimating((prev) => !prev);
  };

  const handleExportAnimation = async (format: AnimationFormat) => {
    setIsExportingAnimation(true);
    setAnimationProgress({ progress: 0, status: "Starting..." });
    setError(null);
    try {
      const size = 512;
      const { width, height } = getExportDimensions(size);
      const input = await prepareExportInput(width, height);
      const onProgress: ExportProgress = (progress, status) => {
        setAnimationProgress({ progress, status });
      };
      await exportAnimation(styleId, input, params, allPalettes, format, {
        frames: DEFAULT_FRAMES,
        fps: DEFAULT_FPS,
        transparent: params.transparent,
        onProgress,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Animation export failed");
    } finally {
      setIsExportingAnimation(false);
      setAnimationProgress(null);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row h-screen bg-black text-white">
      <ControlsPanel
        params={params}
        styleId={styleId}
        onChange={setParams}
        onStyleChange={handleStyleChange}
        onApplyPreset={handleApplyPreset}
        onGenerate={handleGenerate}
        onExportPng={handleExportPng}
        onExportSvg={handleExportSvg}
        onExportAnimation={handleExportAnimation}
        onFetchFeatures={handleFetchFeatures}
        onExportJson={handleExportJson}
        onCopyUrl={handleCopyUrl}
        copiedUrl={copiedUrl}
        isLoading={isLoading}
        isFeatureLoading={isFeatureLoading}
        isExportingAnimation={isExportingAnimation}
        animationProgress={animationProgress}
        featureInfo={featureInfo}
        hasFeatures={!!features}
        osmAreaHint={!isBboxSmallEnough(bounds) ? `Area is ${bboxAreaKm2(bounds).toFixed(1)} km² — zoom in to under 25 km² to fetch OSM features` : null}
        allPalettes={allPalettes}
        allPaletteNames={allPaletteNames}
        onSavePalette={handleSavePalette}
        onDeletePalette={handleDeletePalette}
        isAnimating={isAnimating}
        onToggleAnimation={handleToggleAnimation}
      />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
          <div className="flex flex-col gap-2 min-h-0">
            <span className="text-xs font-medium uppercase tracking-wider text-white/40">
              Select area
            </span>
            <div className="flex-1 min-h-0">
              <Suspense
                fallback={<div className="w-full h-full bg-neutral-950" />}
              >
                <MapSelector
                  onChange={handleBoundsChange}
                  initialCenter={defaultCenter}
                  initialZoom={defaultZoom}
                />
              </Suspense>
            </div>
            <p className="text-xs text-white/40">
              Pan and zoom to your place. The square is the selected area.
            </p>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-white/30 font-mono">
                {((bounds.north + bounds.south) / 2).toFixed(4)}°, {((bounds.east + bounds.west) / 2).toFixed(4)}° · zoom {mapZoom}
              </span>
              <span className={`font-mono ${isBboxSmallEnough(bounds) ? "text-green-400/60" : "text-yellow-400/70"}`}>
                {bboxAreaKm2(bounds).toFixed(1)} km²{isBboxSmallEnough(bounds) ? "" : " · zoom in for OSM"}
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-2 min-h-0">
            <span className="text-xs font-medium uppercase tracking-wider text-white/40">
              Preview
            </span>
            <div className="flex-1 min-h-0 relative flex items-center justify-center bg-neutral-950 rounded-lg border border-white/10 overflow-hidden">
              {!hasGenerated && !isLoading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none z-10">
                  <div className="w-12 h-12 rounded-full border-2 border-white/20 flex items-center justify-center">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/30">
                      <path d="M3 12h4l3-8 4 16 3-8h4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <span className="text-xs text-white/40">Select an area and click Generate</span>
                </div>
              )}
              {isLoading && statusText && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-black/80 border border-white/20 rounded-full text-xs text-white px-4 py-2 z-10 flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-white/60 animate-pulse" />
                  {statusText}
                </div>
              )}
              {boundsDirty && hasGenerated && !isLoading && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-yellow-500/20 border border-yellow-400/40 rounded-full text-xs text-yellow-200 px-4 py-2 z-10 flex items-center gap-3">
                  <span>Selection moved — artwork is stale</span>
                  <button
                    type="button"
                    onClick={handleGenerate}
                    className="bg-yellow-400 text-black rounded-full px-2.5 py-0.5 text-[10px] font-medium hover:bg-yellow-300 transition-colors"
                  >
                    Regenerate
                  </button>
                </div>
              )}
              <Artboard ref={canvasRef} aspectRatio={params.aspectRatio} />
              {terrainInfo && !isLoading && (
                <div className="absolute bottom-2 left-2 right-2 bg-black/60 rounded text-[10px] text-white/50 px-2 py-1 font-mono truncate">
                  {terrainInfo}
                </div>
              )}
            </div>
            {error && (
              <div role="alert" className="bg-red-950/50 border border-red-500/30 rounded p-3 text-xs text-red-300">
                <div className="flex flex-col gap-2">
                  <p>{error}</p>
                  <div className="flex items-center gap-2">
                    {isRetryableError(error) && (
                      <button
                        type="button"
                        onClick={handleRetry}
                        className="px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-200"
                      >
                        Retry{retryCount > 0 ? ` (${retryCount})` : ""}
                      </button>
                    )}
                    {error && /too busy|rate limit|timeout|overpass/i.test(error) && (
                      <button
                        type="button"
                        onClick={() => handleFetchFeatures(true)}
                        className="px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-200"
                      >
                        Retry OSM{osmRetryCount > 0 ? ` (${osmRetryCount})` : ""}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setError(null)}
                      className="px-2 py-1 rounded hover:bg-red-500/20 border border-red-500/30 text-red-300"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            )}
            {warning && (
              <div role="status" className="bg-yellow-950/50 border border-yellow-500/30 rounded p-3 text-xs text-yellow-300">
                {warning}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
