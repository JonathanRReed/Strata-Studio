import { useCallback, useRef, useState } from "react";
import {
  fetchOsmFeatures,
  isBboxSmallEnough,
  MAX_BBOX_KM2,
  snapBoundsForQuery,
} from "../data/osmOverpass.ts";
import type { GeoBounds, GeoFeatureCollection } from "../engine/types.ts";
import { classifyError, type OsmStatus } from "./status.ts";

/**
 * Dedupe key for a fetch: the snapped query bbox (the same quantization the
 * Overpass cache uses), so nearby selections collapse onto one request.
 */
function queryKey(bounds: GeoBounds): string {
  const s = snapBoundsForQuery(bounds);
  return `${s.south.toFixed(4)},${s.west.toFixed(4)},${s.north.toFixed(4)},${s.east.toFixed(4)}`;
}

function summarizeFeatures(collected: GeoFeatureCollection): string {
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
  return `Loaded ${counts.building} buildings, ${counts.road} roads, ${counts.water} water features${waterDetail}`;
}

/** OSM feature state plus the fetch flow and its status channel. */
export function useOsmFeatures({ bounds }: { bounds: GeoBounds }) {
  const [features, setFeatures] = useState<GeoFeatureCollection | undefined>();
  const [status, setStatus] = useState<OsmStatus>({ phase: "idle" });
  const [featureInfo, setFeatureInfo] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Dedupe bookkeeping: what's currently being fetched, and what the loaded
  // features correspond to. Lets auto-generate call fetchFeatures freely
  // without stacking redundant requests for the same snapped bbox.
  const inFlightKeyRef = useRef<string | null>(null);
  const loadedKeyRef = useRef<string | null>(null);

  const fetchFeatures = useCallback(
    async (isRetry = false) => {
      if (!isBboxSmallEnough(bounds)) {
        setStatus({
          phase: "error",
          error: {
            kind: "area-too-large",
            message: `Selected area is too large for OSM queries. Please zoom in (max ~${MAX_BBOX_KM2} km²).`,
          },
        });
        return;
      }
      const key = queryKey(bounds);
      if (!isRetry) {
        // Reuse: features for this snapped bbox are already loaded. Abort
        // any stray fetch for other bounds so it can't overwrite them later.
        if (loadedKeyRef.current === key) {
          abortRef.current?.abort();
          inFlightKeyRef.current = null;
          setStatus({ phase: "done" });
          return;
        }
        // Coalesce: an identical fetch is already in flight.
        if (inFlightKeyRef.current === key) return;
      }
      if (isRetry) {
        setRetryCount((c) => c + 1);
      } else {
        setRetryCount(0);
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      inFlightKeyRef.current = key;
      setStatus({ phase: "fetching" });
      try {
        const collected = await fetchOsmFeatures(bounds, controller.signal);
        if (controller.signal.aborted) return;
        setFeatures(collected);
        setFeatureInfo(summarizeFeatures(collected));
        loadedKeyRef.current = key;
        setStatus({ phase: "done" });
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = classifyError(err);
        if (error.kind === "aborted") return;
        setFeatureInfo(null);
        setStatus({ phase: "error", error });
      } finally {
        // Only clear if a newer call hasn't taken over the slot.
        if (abortRef.current === controller) inFlightKeyRef.current = null;
      }
    },
    [bounds],
  );

  /** Bounds changed: abort any in-flight fetch but keep loaded features. */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    inFlightKeyRef.current = null;
    setStatus((prev) =>
      prev.phase === "fetching" || prev.phase === "error" ? { phase: "idle" } : prev,
    );
  }, []);

  const dismissError = useCallback(() => {
    setStatus((prev) => (prev.phase === "error" ? { phase: "idle" } : prev));
  }, []);

  return { features, status, featureInfo, retryCount, fetchFeatures, cancel, dismissError };
}
