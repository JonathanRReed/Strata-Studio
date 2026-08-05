import { useCallback, useRef, useState } from "react";
import { fetchTerrain } from "../data/terrainTiles.ts";
import type { AspectRatio, ElevationGrid, GeoBounds } from "../engine/types.ts";
import { getPreviewDimensions } from "./aspect.ts";
import { classifyError, type GenerateStatus } from "./status.ts";

const PREVIEW_TERRAIN_DEADLINE_MS = 25000;

function describeTerrain(grid: ElevationGrid, bounds: GeoBounds): string {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < grid.data.length; i++) {
    const v = grid.data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Flat all-zeros terrain usually means open ocean (failed tiles now report
  // through fetchTerrain diagnostics instead of being inferred from zeros).
  if (min === 0 && max === 0) {
    return "Terrain: all zeros (ocean or failed tiles)";
  }
  const range = max - min;
  const centerLat = ((bounds.north + bounds.south) / 2).toFixed(4);
  const centerLng = ((bounds.east + bounds.west) / 2).toFixed(4);
  return `Elevation ${min.toFixed(0)}m – ${max.toFixed(0)}m (${range.toFixed(0)}m range) · ${centerLat}°, ${centerLng}°`;
}

/** Terrain grid state plus the Generate flow (fetch, deadline, diagnostics). */
export function useTerrain({
  bounds,
  aspectRatio,
}: {
  bounds: GeoBounds;
  aspectRatio: AspectRatio;
}) {
  const [grid, setGrid] = useState<ElevationGrid | null>(null);
  const [status, setStatus] = useState<GenerateStatus>({ phase: "idle" });
  const [terrainInfo, setTerrainInfo] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [boundsDirty, setBoundsDirty] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Fetches terrain for the current bounds and hands the fresh grid to
   * `renderArtwork` (React state hasn't propagated at that point).
   *
   * Tile-level policy owns bounded retries; the preview itself is one operation
   * with a 25-second deadline. On intentional abort we return without touching
   * status: whoever aborted (a newer generate call or bounds change) owns it.
   */
  const generate = useCallback(
    async (renderArtwork: (grid: ElevationGrid) => void | Promise<void>) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus({ phase: "fetching", note: "Loading terrain tiles..." });
      setWarning(null);
      setTerrainInfo(null);

      let totalTiles = 0;
      let failedTiles = 0;

      try {
        const newGrid = await fetchTerrain(
          bounds,
          getPreviewDimensions(aspectRatio),
          controller.signal,
          {
            operationTimeoutMs: PREVIEW_TERRAIN_DEADLINE_MS,
            onDiagnostics: (d) => {
              totalTiles = d.totalTiles;
              failedTiles = d.failedTiles;
            },
          },
        );
        if (controller.signal.aborted) return;
        setGrid(newGrid);
        setBoundsDirty(false);
        setStatus({ phase: "rendering" });
        await renderArtwork(newGrid);
        if (controller.signal.aborted) return;
        setHasGenerated(true);
        setTerrainInfo(describeTerrain(newGrid, bounds));
        if (failedTiles > 0) {
          setWarning(
            `${failedTiles} of ${totalTiles} terrain tiles failed to load. Showing partial data.`,
          );
        }
        setStatus({ phase: "done" });
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = classifyError(err);
        if (error.kind === "aborted") return;
        setStatus({ phase: "error", error });
      }
    },
    [aspectRatio, bounds],
  );

  /** Bounds changed: abort in-flight work and mark the preview stale. */
  const invalidate = useCallback(() => {
    abortRef.current?.abort();
    setStatus({ phase: "idle" });
    setWarning(null);
    setTerrainInfo(null);
    setBoundsDirty(true);
  }, []);

  const dismissError = useCallback(() => {
    setStatus((prev) => (prev.phase === "error" ? { phase: "idle" } : prev));
  }, []);

  /** Manual retry is a fresh user-triggered operation with a new controller/deadline. */
  const retry = useCallback((run: () => void) => {
    setRetryCount((count) => count + 1);
    run();
  }, []);

  return {
    grid,
    status,
    terrainInfo,
    warning,
    hasGenerated,
    boundsDirty,
    retryCount,
    generate,
    invalidate,
    dismissError,
    retry,
  };
}
