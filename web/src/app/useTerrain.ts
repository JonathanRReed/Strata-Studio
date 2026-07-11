import { useCallback, useRef, useState } from "react";
import { fetchTerrain } from "../data/terrainTiles.ts";
import type { ElevationGrid, GeoBounds } from "../engine/types.ts";
import { PREVIEW_SIZE } from "./aspect.ts";
import { classifyError, retryWithBackoff, type GenerateStatus } from "./status.ts";

const MAX_AUTO_RETRIES = 2;
const BASE_BACKOFF_MS = 800;

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

/** Terrain grid state plus the Generate flow (fetch, auto-retry, diagnostics). */
export function useTerrain({ bounds }: { bounds: GeoBounds }) {
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
   * Status is set once before the retry loop and resolved exactly once after
   * it (success, terminal error, or abort). The old inline loop had a
   * `finally` inside the `for`, which cleared the loading state on every
   * retry `continue` — re-enabling the Generate button mid-backoff.
   * On abort we return without touching status: whoever aborted (a newer
   * generate call or a bounds change) owns the status from then on.
   */
  const generate = useCallback(
    async (renderArtwork: (grid: ElevationGrid) => void) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus({ phase: "fetching", note: "Loading terrain tiles..." });
      setWarning(null);
      setTerrainInfo(null);

      let totalTiles = 0;
      let failedTiles = 0;

      try {
        const newGrid = await retryWithBackoff(
          () => {
            setStatus({ phase: "fetching", note: "Loading terrain tiles..." });
            totalTiles = 0;
            failedTiles = 0;
            return fetchTerrain(bounds, PREVIEW_SIZE, controller.signal, {
              onDiagnostics: (d) => {
                totalTiles = d.totalTiles;
                failedTiles = d.failedTiles;
              },
            });
          },
          {
            maxRetries: MAX_AUTO_RETRIES,
            baseBackoffMs: BASE_BACKOFF_MS,
            signal: controller.signal,
            onWait: (backoffMs, attempt) =>
              setStatus({
                phase: "fetching",
                note: `Retrying in ${backoffMs / 1000}s... (${attempt + 1}/${MAX_AUTO_RETRIES})`,
              }),
          },
        );
        if (controller.signal.aborted) return;
        setGrid(newGrid);
        setBoundsDirty(false);
        setStatus({ phase: "rendering" });
        renderArtwork(newGrid);
        setHasGenerated(true);
        setTerrainInfo(describeTerrain(newGrid, bounds));
        if (failedTiles > 0) {
          setWarning(
            `${failedTiles} of ${totalTiles} terrain tiles failed to load — showing partial data.`,
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
    [bounds],
  );

  /** Bounds changed: abort in-flight work and mark the preview stale. */
  const invalidate = useCallback(() => {
    abortRef.current?.abort();
    setStatus({ phase: "idle" });
    setWarning(null);
    setBoundsDirty(true);
  }, []);

  const dismissError = useCallback(() => {
    setStatus((prev) => (prev.phase === "error" ? { phase: "idle" } : prev));
  }, []);

  /** Manual retry: bump the counter and re-run after a polite delay. */
  const retry = useCallback((run: () => void) => {
    setRetryCount((count) => count + 1);
    setTimeout(run, 500);
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
