import { useCallback, useState } from "react";
import { fetchTerrain, tileCountForFetch, TERRAIN_ATTRIBUTION } from "../data/terrainTiles.ts";
import { OSM_ATTRIBUTION } from "../data/osmOverpass.ts";
import { renderStyleCanvas, renderStyleSvg } from "../studios/registry.ts";
import {
  createOffscreenCanvas,
  downloadPngWithAttribution,
  downloadSvgWithAttribution,
} from "../engine/export.ts";
import { exportAnimation, type AnimationFormat, type ExportProgress } from "../engine/animationExport.ts";
import { DEFAULT_FRAMES, DEFAULT_FPS } from "../engine/animation.ts";
import type { GeoBounds, GeoFeatureCollection, Palette, StyleParams } from "../engine/types.ts";
import { getExportDimensions, getPreviewDimensions, PREVIEW_SIZE } from "./aspect.ts";
import { buildArtworkInput } from "./renderPipeline.ts";
import { classifyError, type AnimationExportStatus, type ExportStatus } from "./status.ts";

const ATTRIBUTION = `Map data © ${OSM_ATTRIBUTION} | ${TERRAIN_ATTRIBUTION}`;

/** Ask before exports that would fetch more terrain tiles than this. */
const EXPORT_TILE_CONFIRM_THRESHOLD = 100;
/** Rough download budget per 256² terrarium PNG tile, for the confirm message. */
const APPROX_MB_PER_TILE = 0.1;

/** Exports with a long side at or above this get the higher-detail terrain grid. */
const DETAIL_BUMP_EXPORT_SIZE = 2048;
/** Terrain grid size used for those large exports (2× the preview grid). */
const DETAIL_BUMP_GRID_SIZE = 1024;

/**
 * Terrain grid size for an export. Exports are WYSIWYG: the scene is always
 * generated at the preview's logical size, so they reuse the preview-sized
 * terrain grid rather than fetching hundreds of tiles at export resolution.
 * Large prints get one detail bump so upscaled renders keep terrain detail.
 */
function exportGridSize(size: number): number {
  return size >= DETAIL_BUMP_EXPORT_SIZE ? DETAIL_BUMP_GRID_SIZE : PREVIEW_SIZE;
}

/**
 * PNG/SVG/JSON/animation export handlers with their own status channels, so
 * an export never flips the Generate button into its loading state.
 */
export function useExports({
  bounds,
  features,
  params,
  styleId,
  allPalettes,
  backgroundColor,
}: {
  bounds: GeoBounds;
  features?: GeoFeatureCollection;
  params: StyleParams;
  styleId: string;
  allPalettes: Record<string, Palette>;
  backgroundColor: string;
}) {
  const [status, setStatus] = useState<ExportStatus>({ phase: "idle" });
  const [animationStatus, setAnimationStatus] = useState<AnimationExportStatus>({
    phase: "idle",
  });

  /**
   * Gate exports that would fetch an unreasonable number of tiles. Since
   * exports reuse the preview-sized terrain grid, the tile count depends on
   * the selected map area (not the export resolution) and this rarely fires.
   */
  const confirmLargeExport = useCallback(
    (gridSize: number): boolean => {
      const tiles = tileCountForFetch(bounds, gridSize);
      if (tiles <= EXPORT_TILE_CONFIRM_THRESHOLD) return true;
      const mb = Math.ceil(tiles * APPROX_MB_PER_TILE);
      // TODO: replace window.confirm with a proper dialog.
      return window.confirm(
        `This map area needs ${tiles} terrain tiles (~${mb} MB download) to export. Continue?`,
      );
    },
    [bounds],
  );

  const exportPng = useCallback(
    async (size: number, dpi?: number) => {
      const { width, height } = getExportDimensions(params.aspectRatio, size);
      const logical = getPreviewDimensions(params.aspectRatio);
      const gridSize = exportGridSize(size);
      if (!confirmLargeExport(gridSize)) return;
      setStatus({ phase: "fetching", note: `Fetching terrain for ${width}×${height} PNG...` });
      try {
        const grid = await fetchTerrain(bounds, gridSize);
        setStatus({ phase: "rendering" });
        // WYSIWYG: build the scene at the preview's logical size and let the
        // canvas transform scale it onto the export-sized bitmap.
        const input = buildArtworkInput({
          grid,
          features,
          params,
          width: logical.width,
          height: logical.height,
        });
        const { canvas, ctx } = createOffscreenCanvas(width, height);
        renderStyleCanvas(styleId, ctx, input, params, allPalettes);
        downloadPngWithAttribution(
          canvas,
          `strata-${styleId}-${params.seed}-${width}x${height}.png`,
          ATTRIBUTION,
          backgroundColor,
          width / logical.width,
          dpi,
        );
        setStatus({ phase: "idle" });
      } catch (err) {
        setStatus({ phase: "error", error: classifyError(err) });
      }
    },
    [bounds, features, params, styleId, allPalettes, backgroundColor, confirmLargeExport],
  );

  const exportSvg = useCallback(
    async (size: number) => {
      const { width, height } = getExportDimensions(params.aspectRatio, size);
      const logical = getPreviewDimensions(params.aspectRatio);
      const gridSize = exportGridSize(size);
      if (!confirmLargeExport(gridSize)) return;
      setStatus({ phase: "fetching", note: `Fetching terrain for ${width}×${height} SVG...` });
      try {
        const grid = await fetchTerrain(bounds, gridSize);
        setStatus({ phase: "rendering" });
        // WYSIWYG: geometry stays in logical preview coordinates (viewBox);
        // only the SVG's rendered pixel size is the export size.
        const input = buildArtworkInput({
          grid,
          features,
          params,
          width: logical.width,
          height: logical.height,
        });
        const svg = renderStyleSvg(styleId, input, params, allPalettes, false, { width, height });
        downloadSvgWithAttribution(
          svg,
          `strata-${styleId}-${params.seed}-${width}x${height}.svg`,
          ATTRIBUTION,
          backgroundColor,
        );
        setStatus({ phase: "idle" });
      } catch (err) {
        setStatus({ phase: "error", error: classifyError(err) });
      }
    },
    [bounds, features, params, styleId, allPalettes, backgroundColor, confirmLargeExport],
  );

  const exportJson = useCallback(() => {
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
  }, [styleId, params]);

  const handleExportAnimation = useCallback(
    async (format: AnimationFormat) => {
      // Animations render at the preview's logical size directly.
      const { width, height } = getPreviewDimensions(params.aspectRatio);
      if (!confirmLargeExport(PREVIEW_SIZE)) return;
      setAnimationStatus({ phase: "exporting", progress: 0, note: "Starting..." });
      try {
        const grid = await fetchTerrain(bounds, PREVIEW_SIZE);
        const input = buildArtworkInput({ grid, features, params, width, height });
        const onProgress: ExportProgress = (progress, note) => {
          setAnimationStatus({ phase: "exporting", progress, note });
        };
        await exportAnimation(styleId, input, params, allPalettes, format, {
          frames: DEFAULT_FRAMES,
          fps: DEFAULT_FPS,
          transparent: params.transparent,
          onProgress,
        });
        setAnimationStatus({ phase: "idle" });
      } catch (err) {
        setAnimationStatus({ phase: "error", error: classifyError(err) });
      }
    },
    [bounds, features, params, styleId, allPalettes, confirmLargeExport],
  );

  const dismissErrors = useCallback(() => {
    setStatus((prev) => (prev.phase === "error" ? { phase: "idle" } : prev));
    setAnimationStatus((prev) => (prev.phase === "error" ? { phase: "idle" } : prev));
  }, []);

  return {
    status,
    animationStatus,
    exportPng,
    exportSvg,
    exportJson,
    exportAnimation: handleExportAnimation,
    dismissErrors,
  };
}
