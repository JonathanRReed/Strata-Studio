import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchTerrain,
  tileCountForFetch,
  TERRAIN_ATTRIBUTION,
  type TerrainGridDimensions,
} from "../data/terrainTiles.ts";
import { OSM_ATTRIBUTION } from "../data/osmOverpass.ts";
import { renderStyleCanvas, renderStyleSvg } from "../studios/registry.ts";
import {
  createOffscreenCanvas,
  downloadSvgWithAttribution,
  pngBlobWithAttribution,
  startBlobDownload,
  throwIfExportAborted,
  type DownloadReceipt,
} from "../engine/export.ts";
import {
  exportAnimation,
  type AnimationFormat,
  type ExportProgress,
} from "../engine/animationExport.ts";
import { DEFAULT_FRAMES, DEFAULT_FPS } from "../engine/animation.ts";
import { ensurePosterFonts } from "../engine/posterFonts.ts";
import type {
  ArtworkInput,
  ElevationGrid,
  GeoBounds,
  GeoFeatureCollection,
  Palette,
  StyleParams,
} from "../engine/types.ts";
import { createRequestOperation } from "../data/requestPolicy.ts";
import { getExportDimensions, getPreviewDimensions, PREVIEW_SIZE } from "./aspect.ts";
import { buildArtworkInput } from "./renderPipeline.ts";
import { classifyError, type AnimationExportStatus, type ExportStatus } from "./status.ts";
import type { CapabilityMatrix } from "./capabilities.ts";
import {
  createCompositionDocument,
  serializeCompositionDocument,
} from "./composition.ts";
import type { CustomPaletteEntry } from "../presets/customPalettes.ts";
import { osmQueryKey } from "./useOsmFeatures.ts";
import { SHARE_LONG_EDGE } from "./shareSpec.ts";

const ATTRIBUTION = `Map data © ${OSM_ATTRIBUTION} | ${TERRAIN_ATTRIBUTION}`;
const STATIC_EXPORT_DEADLINE_MS = 75_000;
const ANIMATION_EXPORT_DEADLINE_MS = 180_000;
const STATUS_HOLD_MS = 6_000;
const EXPORT_TILE_CONFIRM_THRESHOLD = 100;
const APPROX_MB_PER_TILE = 0.1;
const DETAIL_BUMP_EXPORT_SIZE = 2048;
const DETAIL_BUMP_GRID_SIZE = 1024;

export type PngArtifact = {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
};

function exportGridSize(size: number): number {
  return size >= DETAIL_BUMP_EXPORT_SIZE ? DETAIL_BUMP_GRID_SIZE : PREVIEW_SIZE;
}

function exportFilename(
  styleId: string,
  seed: string,
  width: number,
  height: number,
  extension: string,
): string {
  return `strata-${styleId}-${seed}-${width}x${height}.${extension}`;
}

function cancellationReason(): DOMException {
  return new DOMException("Export was cancelled", "AbortError");
}

export function useExports({
  bounds,
  terrainGrid,
  previewInput,
  features,
  featureKey,
  params,
  styleId,
  mapZoom,
  allPalettes,
  selectedCustomPalette,
  backgroundColor,
  capabilities,
}: {
  bounds: GeoBounds;
  /** Current non-stale preview data; sharing can reuse it without terrain work. */
  terrainGrid?: ElevationGrid | null;
  previewInput?: ArtworkInput | null;
  features?: GeoFeatureCollection;
  /** Snapped key that owns `features`; stale-key data is never exported. */
  featureKey?: string;
  params: StyleParams;
  styleId: string;
  mapZoom: number;
  allPalettes: Record<string, Palette>;
  selectedCustomPalette?: CustomPaletteEntry | null;
  backgroundColor: string;
  capabilities: CapabilityMatrix;
}) {
  const [status, setStatus] = useState<ExportStatus>({ phase: "idle" });
  const [animationStatus, setAnimationStatus] = useState<AnimationExportStatus>({ phase: "idle" });
  const staticControllerRef = useRef<AbortController | null>(null);
  const animationControllerRef = useRef<AbortController | null>(null);
  const staticStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animationStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const receiptsRef = useRef(new Set<DownloadReceipt>());
  const receiptCleanupTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const mountedRef = useRef(true);

  const currentFeatures = useMemo(
    () => (featureKey === osmQueryKey(bounds) ? features : undefined),
    [bounds, featureKey, features],
  );

  const clearStatusTimer = useCallback((kind: "static" | "animation") => {
    const ref = kind === "static" ? staticStatusTimerRef : animationStatusTimerRef;
    if (ref.current) clearTimeout(ref.current);
    ref.current = null;
  }, []);

  const holdStatus = useCallback(
    (kind: "static" | "animation") => {
      clearStatusTimer(kind);
      const ref = kind === "static" ? staticStatusTimerRef : animationStatusTimerRef;
      ref.current = setTimeout(() => {
        if (!mountedRef.current) return;
        if (kind === "static") setStatus({ phase: "idle" });
        else setAnimationStatus({ phase: "idle" });
        ref.current = null;
      }, STATUS_HOLD_MS);
    },
    [clearStatusTimer],
  );

  const trackReceipt = useCallback((receipt: DownloadReceipt) => {
    receiptsRef.current.add(receipt);
    const timer = setTimeout(() => {
      receiptsRef.current.delete(receipt);
      receiptCleanupTimersRef.current.delete(timer);
    }, 2_500);
    receiptCleanupTimersRef.current.add(timer);
  }, []);

  const disposeOperations = useCallback(() => {
    mountedRef.current = false;
    staticControllerRef.current?.abort(cancellationReason());
    animationControllerRef.current?.abort(cancellationReason());
    if (staticStatusTimerRef.current) clearTimeout(staticStatusTimerRef.current);
    if (animationStatusTimerRef.current) clearTimeout(animationStatusTimerRef.current);
    for (const timer of receiptCleanupTimersRef.current) clearTimeout(timer);
    receiptCleanupTimersRef.current.clear();
    for (const receipt of receiptsRef.current) receipt.dispose();
    receiptsRef.current.clear();
  }, []);

  useEffect(() => {
    // StrictMode replays setup after its development-only cleanup.
    mountedRef.current = true;
    return disposeOperations;
  }, [disposeOperations]);

  const confirmLargeExport = useCallback(
    (gridDimensions: TerrainGridDimensions): boolean => {
      const tiles = tileCountForFetch(bounds, gridDimensions);
      if (tiles <= EXPORT_TILE_CONFIRM_THRESHOLD) return true;
      const mb = Math.ceil(tiles * APPROX_MB_PER_TILE);
      return window.confirm(
        `This map area needs ${tiles} terrain tiles (~${mb} MB download) to export. Continue?`,
      );
    },
    [bounds],
  );

  const renderPngArtifact = useCallback(
    async (
      size: number,
      dpi: number | undefined,
      signal: AbortSignal,
      report?: (phase: "fetching" | "rendering", note: string) => void,
      reusePreview = false,
    ): Promise<PngArtifact> => {
      if (!capabilities.pngExport) throw new Error("PNG export is not supported in this browser");
      const { width, height } = getExportDimensions(params.aspectRatio, size);
      const logical = getPreviewDimensions(params.aspectRatio);
      const gridDimensions = getExportDimensions(params.aspectRatio, exportGridSize(size));
      const matchingPreviewInput =
        reusePreview &&
        previewInput &&
        previewInput.width === logical.width &&
        previewInput.height === logical.height &&
        previewInput.seed === params.seed &&
        previewInput.features === currentFeatures
          ? previewInput
          : null;
      let input = matchingPreviewInput;
      if (!input) {
        const matchingPreviewGrid =
          reusePreview &&
          terrainGrid &&
          terrainGrid.width === gridDimensions.width &&
          terrainGrid.height === gridDimensions.height
            ? terrainGrid
            : null;
        if (!matchingPreviewGrid) {
          report?.("fetching", `Fetching terrain for ${width}×${height} PNG…`);
        }
        const grid =
          matchingPreviewGrid ??
          (await fetchTerrain(bounds, gridDimensions, signal, {
            operationTimeoutMs: STATIC_EXPORT_DEADLINE_MS,
          }));
        throwIfExportAborted(signal);
        input = buildArtworkInput({
          grid,
          features: currentFeatures,
          params,
          width: logical.width,
          height: logical.height,
        });
      }
      report?.("rendering", `Rendering ${width}×${height} PNG…`);
      await ensurePosterFonts();
      throwIfExportAborted(signal);
      const { canvas, ctx } = createOffscreenCanvas(width, height);
      renderStyleCanvas(styleId, ctx, input, params, allPalettes);
      throwIfExportAborted(signal);
      const blob = await pngBlobWithAttribution(
        canvas,
        ATTRIBUTION,
        backgroundColor,
        width / logical.width,
        dpi,
        signal,
      );
      return {
        blob,
        filename: exportFilename(styleId, params.seed, width, height, "png"),
        width,
        height,
      };
    },
    [
      allPalettes,
      backgroundColor,
      bounds,
      capabilities.pngExport,
      currentFeatures,
      params,
      previewInput,
      styleId,
      terrainGrid,
    ],
  );

  const createSharePng = useCallback(
    async (signal: AbortSignal): Promise<PngArtifact> => {
      const gridDimensions = getExportDimensions(params.aspectRatio, exportGridSize(SHARE_LONG_EDGE));
      if (!confirmLargeExport(gridDimensions)) throw cancellationReason();
      const operation = createRequestOperation({
        signal,
        timeoutMs: STATIC_EXPORT_DEADLINE_MS,
        label: "Share image",
      });
      try {
        const artifact = await renderPngArtifact(
          SHARE_LONG_EDGE,
          undefined,
          operation.signal,
          undefined,
          true,
        );
        operation.throwIfAborted();
        return artifact;
      } finally {
        operation.dispose();
      }
    },
    [confirmLargeExport, params.aspectRatio, renderPngArtifact],
  );

  const beginStaticOperation = useCallback(() => {
    staticControllerRef.current?.abort(cancellationReason());
    clearStatusTimer("static");
    const controller = new AbortController();
    staticControllerRef.current = controller;
    const operation = createRequestOperation({
      signal: controller.signal,
      timeoutMs: STATIC_EXPORT_DEADLINE_MS,
      label: "Export",
    });
    return { controller, operation };
  }, [clearStatusTimer]);

  const exportPng = useCallback(
    async (size: number, dpi?: number): Promise<void> => {
      const dimensions = getExportDimensions(params.aspectRatio, exportGridSize(size));
      if (!confirmLargeExport(dimensions)) {
        setStatus({ phase: "cancelled", message: "PNG export cancelled." });
        holdStatus("static");
        return;
      }
      const { controller, operation } = beginStaticOperation();
      try {
        const artifact = await renderPngArtifact(
          size,
          dpi,
          operation.signal,
          (phase, note) => {
            if (staticControllerRef.current === controller) setStatus({ phase, note });
          },
        );
        operation.throwIfAborted();
        const receipt = startBlobDownload(artifact.blob, artifact.filename);
        trackReceipt(receipt);
        setStatus({
          phase: "done",
          filename: artifact.filename,
          width: artifact.width,
          height: artifact.height,
          message: `Download started: ${artifact.filename} (${artifact.width}×${artifact.height}).`,
        });
        holdStatus("static");
      } catch (error) {
        if (staticControllerRef.current === controller) {
          const classified = classifyError(error);
          if (classified.kind === "aborted") {
            setStatus({ phase: "cancelled", message: "PNG export cancelled." });
            holdStatus("static");
          } else {
            setStatus({ phase: "error", error: classified });
          }
        }
      } finally {
        operation.dispose();
        if (staticControllerRef.current === controller) staticControllerRef.current = null;
      }
    },
    [
      beginStaticOperation,
      confirmLargeExport,
      holdStatus,
      params.aspectRatio,
      renderPngArtifact,
      trackReceipt,
    ],
  );

  const exportSvg = useCallback(
    async (size: number): Promise<void> => {
      if (!capabilities.svgExport) throw new Error("SVG export is not supported in this browser");
      const { width, height } = getExportDimensions(params.aspectRatio, size);
      const logical = getPreviewDimensions(params.aspectRatio);
      const gridDimensions = getExportDimensions(params.aspectRatio, exportGridSize(size));
      if (!confirmLargeExport(gridDimensions)) {
        setStatus({ phase: "cancelled", message: "SVG export cancelled." });
        holdStatus("static");
        return;
      }
      const { controller, operation } = beginStaticOperation();
      setStatus({ phase: "fetching", note: `Fetching terrain for ${width}×${height} SVG…` });
      try {
        const grid = await fetchTerrain(bounds, gridDimensions, operation.signal, {
          operationTimeoutMs: STATIC_EXPORT_DEADLINE_MS,
        });
        operation.throwIfAborted();
        setStatus({ phase: "rendering", note: `Rendering ${width}×${height} SVG…` });
        const input = buildArtworkInput({
          grid,
          features: currentFeatures,
          params,
          width: logical.width,
          height: logical.height,
        });
        const svg = renderStyleSvg(styleId, input, params, allPalettes, false, { width, height });
        operation.throwIfAborted();
        const filename = exportFilename(styleId, params.seed, width, height, "svg");
        const receipt = downloadSvgWithAttribution(
          svg,
          filename,
          ATTRIBUTION,
          backgroundColor,
          operation.signal,
        );
        trackReceipt(receipt);
        setStatus({
          phase: "done",
          filename,
          width,
          height,
          message: `Download started: ${filename} (${width}×${height}).`,
        });
        holdStatus("static");
      } catch (error) {
        if (staticControllerRef.current === controller) {
          const classified = classifyError(error);
          if (classified.kind === "aborted") {
            setStatus({ phase: "cancelled", message: "SVG export cancelled." });
            holdStatus("static");
          } else {
            setStatus({ phase: "error", error: classified });
          }
        }
      } finally {
        operation.dispose();
        if (staticControllerRef.current === controller) staticControllerRef.current = null;
      }
    },
    [
      allPalettes,
      backgroundColor,
      beginStaticOperation,
      bounds,
      capabilities.svgExport,
      confirmLargeExport,
      currentFeatures,
      holdStatus,
      params,
      styleId,
      trackReceipt,
    ],
  );

  const exportJson = useCallback(async (): Promise<void> => {
    const { controller, operation } = beginStaticOperation();
    setStatus({ phase: "rendering", note: "Preparing validated composition JSON…" });
    try {
      const document = createCompositionDocument({
        styleId,
        params,
        bounds,
        mapZoom,
        selectedCustomPalette,
      });
      operation.throwIfAborted();
      const filename = `strata-${styleId}-${params.seed}.composition.json`;
      const receipt = startBlobDownload(
        new Blob([serializeCompositionDocument(document, true)], {
          type: "application/json",
        }),
        filename,
      );
      trackReceipt(receipt);
      setStatus({
        phase: "done",
        filename,
        message: `Download started: ${filename}.`,
      });
      holdStatus("static");
    } catch (error) {
      if (staticControllerRef.current === controller) {
        const classified = classifyError(error);
        if (classified.kind === "aborted") {
          setStatus({ phase: "cancelled", message: "Settings export cancelled." });
          holdStatus("static");
        } else {
          setStatus({ phase: "error", error: classified });
        }
      }
    } finally {
      operation.dispose();
      if (staticControllerRef.current === controller) staticControllerRef.current = null;
    }
  }, [
    beginStaticOperation,
    bounds,
    holdStatus,
    mapZoom,
    params,
    selectedCustomPalette,
    styleId,
    trackReceipt,
  ]);

  const handleExportAnimation = useCallback(
    async (format: AnimationFormat): Promise<void> => {
      const supported =
        (format === "gif" && capabilities.gifExport) ||
        (format === "apng" && capabilities.apngExport) ||
        (format === "webm" && capabilities.webmExport);
      if (!supported) {
        setAnimationStatus({
          phase: "error",
          error: { kind: "unknown", message: `${format.toUpperCase()} export is not supported in this browser.` },
        });
        return;
      }
      const previewDimensions = getPreviewDimensions(params.aspectRatio);
      const { width, height } = previewDimensions;
      if (!confirmLargeExport(previewDimensions)) {
        setAnimationStatus({ phase: "cancelled", message: "Animation export cancelled." });
        holdStatus("animation");
        return;
      }

      animationControllerRef.current?.abort(cancellationReason());
      clearStatusTimer("animation");
      const controller = new AbortController();
      animationControllerRef.current = controller;
      const operation = createRequestOperation({
        signal: controller.signal,
        timeoutMs: ANIMATION_EXPORT_DEADLINE_MS,
        label: "Animation export",
      });
      setAnimationStatus({ phase: "exporting", progress: 0, note: "Fetching terrain…" });
      try {
        const grid = await fetchTerrain(bounds, previewDimensions, operation.signal, {
          operationTimeoutMs: STATIC_EXPORT_DEADLINE_MS,
        });
        operation.throwIfAborted();
        const input = buildArtworkInput({
          grid,
          features: currentFeatures,
          params,
          width,
          height,
        });
        const onProgress: ExportProgress = (progress, note) => {
          if (
            !operation.signal.aborted &&
            animationControllerRef.current === controller
          ) {
            setAnimationStatus({ phase: "exporting", progress, note });
          }
        };
        const result = await exportAnimation(styleId, input, params, allPalettes, format, {
          frames: DEFAULT_FRAMES,
          fps: DEFAULT_FPS,
          transparent: params.transparent,
          onProgress,
          signal: operation.signal,
          webmMimeType: capabilities.webmMimeType,
        });
        trackReceipt(result.receipt);
        setAnimationStatus({
          phase: "done",
          filename: result.filename,
          width: result.width,
          height: result.height,
          message: `Download started: ${result.filename} (${result.width}×${result.height}, ${DEFAULT_FRAMES} frames).`,
        });
        holdStatus("animation");
      } catch (error) {
        if (animationControllerRef.current === controller) {
          const classified = classifyError(error);
          if (classified.kind === "aborted") {
            setAnimationStatus({ phase: "cancelled", message: "Animation export cancelled." });
            holdStatus("animation");
          } else {
            setAnimationStatus({ phase: "error", error: classified });
          }
        }
      } finally {
        operation.dispose();
        if (animationControllerRef.current === controller) animationControllerRef.current = null;
      }
    },
    [
      allPalettes,
      bounds,
      capabilities,
      clearStatusTimer,
      confirmLargeExport,
      currentFeatures,
      holdStatus,
      params,
      styleId,
      trackReceipt,
    ],
  );

  const cancelExport = useCallback(() => {
    staticControllerRef.current?.abort(cancellationReason());
    animationControllerRef.current?.abort(cancellationReason());
  }, []);

  const dismissErrors = useCallback(() => {
    setStatus((previous) =>
      previous.phase === "error" || previous.phase === "done" || previous.phase === "cancelled"
        ? { phase: "idle" }
        : previous,
    );
    setAnimationStatus((previous) =>
      previous.phase === "error" || previous.phase === "done" || previous.phase === "cancelled"
        ? { phase: "idle" }
        : previous,
    );
  }, []);

  return {
    status,
    animationStatus,
    exportPng,
    exportSvg,
    exportJson,
    exportAnimation: handleExportAnimation,
    createSharePng,
    cancelExport,
    dismissErrors,
  };
}
