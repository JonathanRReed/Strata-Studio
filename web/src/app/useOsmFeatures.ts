import { useCallback, useRef, useState } from "react";
import { fetchOsmFeatures, isBboxSmallEnough, MAX_BBOX_KM2 } from "../data/osmOverpass.ts";
import type { GeoBounds, GeoFeatureCollection } from "../engine/types.ts";
import { classifyError, type OsmStatus } from "./status.ts";

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
      if (isRetry) {
        setRetryCount((c) => c + 1);
      } else {
        setRetryCount(0);
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus({ phase: "fetching" });
      try {
        const collected = await fetchOsmFeatures(bounds, controller.signal);
        if (controller.signal.aborted) return;
        setFeatures(collected);
        setFeatureInfo(summarizeFeatures(collected));
        setStatus({ phase: "done" });
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = classifyError(err);
        if (error.kind === "aborted") return;
        setFeatureInfo(null);
        setStatus({ phase: "error", error });
      }
    },
    [bounds],
  );

  /** Bounds changed: abort any in-flight fetch but keep loaded features. */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setStatus((prev) =>
      prev.phase === "fetching" || prev.phase === "error" ? { phase: "idle" } : prev,
    );
  }, []);

  const dismissError = useCallback(() => {
    setStatus((prev) => (prev.phase === "error" ? { phase: "idle" } : prev));
  }, []);

  return { features, status, featureInfo, retryCount, fetchFeatures, cancel, dismissError };
}
