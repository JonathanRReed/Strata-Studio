import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchOsmFeatures,
  isBboxSmallEnough,
  MAX_BBOX_KM2,
  snapBoundsForQuery,
} from "../data/osmOverpass.ts";
import type { GeoBounds, GeoFeatureCollection } from "../engine/types.ts";
import { classifyError, type OsmStatus } from "./status.ts";

/** Snapped query key shared by request dedupe, memory state, and cache reuse. */
export function osmQueryKey(bounds: GeoBounds): string {
  const snapped = snapBoundsForQuery(bounds);
  return `${snapped.south.toFixed(4)},${snapped.west.toFixed(4)},${snapped.north.toFixed(4)},${snapped.east.toFixed(4)}`;
}

function summarizeFeatures(collected: GeoFeatureCollection): string {
  const counts = { building: 0, road: 0, water: 0 };
  const waterCounts = { ocean: 0, lake: 0, river: 0 };
  for (const feature of collected.features) {
    counts[feature.properties.strataType]++;
    if (feature.properties.strataType === "water") {
      waterCounts[feature.properties.waterType ?? "lake"]++;
    }
  }
  const waterDetail =
    counts.water > 0
      ? ` (${waterCounts.lake} lakes, ${waterCounts.river} rivers${waterCounts.ocean > 0 ? `, ${waterCounts.ocean} coastlines` : ""})`
      : "";
  return `Loaded ${counts.building} buildings, ${counts.road} roads, ${counts.water} water features${waterDetail}`;
}

type OsmEntry = {
  features?: GeoFeatureCollection;
  status: OsmStatus;
  featureInfo: string | null;
  retryCount: number;
};

const IDLE_ENTRY: OsmEntry = {
  status: { phase: "idle" },
  featureInfo: null,
  retryCount: 0,
};

export const OSM_MEMORY_ENTRY_LIMIT = 8;

function withRecentEntry(
  previous: Record<string, OsmEntry>,
  key: string,
  entry: OsmEntry,
): Record<string, OsmEntry> {
  const next: Record<string, OsmEntry> = {};
  for (const [existingKey, existingEntry] of Object.entries(previous)) {
    if (existingKey !== key) next[existingKey] = existingEntry;
  }
  next[key] = entry;
  const staleKeys = Object.keys(next).slice(0, -OSM_MEMORY_ENTRY_LIMIT);
  for (const staleKey of staleKeys) delete next[staleKey];
  return next;
}

type FetchOsm = (
  bounds: GeoBounds,
  signal?: AbortSignal,
) => Promise<GeoFeatureCollection>;

/** OSM feature state keyed to the active snapped query bounds. */
export function useOsmFeatures({
  bounds,
  fetcher = fetchOsmFeatures,
}: {
  bounds: GeoBounds;
  /** Test/runtime injection; production uses the IndexedDB-backed fetcher. */
  fetcher?: FetchOsm;
}) {
  const activeKey = useMemo(() => osmQueryKey(bounds), [bounds]);
  const [entries, setEntries] = useState<Record<string, OsmEntry>>({});
  const abortRef = useRef<AbortController | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);

  const updateEntry = useCallback(
    (key: string, update: (entry: OsmEntry) => OsmEntry) => {
      setEntries((previous) =>
        withRecentEntry(
          previous,
          key,
          update(previous[key] ?? IDLE_ENTRY),
        ),
      );
    },
    [],
  );

  const fetchFeatures = useCallback(
    async (isRetry = false) => {
      const key = activeKey;
      if (!isBboxSmallEnough(bounds)) {
        updateEntry(key, (entry) => ({
          ...entry,
          featureInfo: null,
          status: {
            phase: "error",
            error: {
              kind: "area-too-large",
              message: `Selected area is too large for OSM queries. Please zoom in (max ~${MAX_BBOX_KM2} km²).`,
            },
          },
        }));
        return;
      }

      const existing = entries[key];
      if (!isRetry) {
        if (existing?.features) {
          abortRef.current?.abort();
          inFlightKeyRef.current = null;
          updateEntry(key, (entry) => ({ ...entry, status: { phase: "done" } }));
          return;
        }
        if (inFlightKeyRef.current === key) return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      inFlightKeyRef.current = key;
      updateEntry(key, (entry) => ({
        ...entry,
        retryCount: isRetry ? entry.retryCount + 1 : 0,
        status: { phase: "fetching" },
      }));

      try {
        const collected = await fetcher(bounds, controller.signal);
        if (controller.signal.aborted) return;
        updateEntry(key, (entry) => ({
          ...entry,
          features: collected,
          featureInfo: summarizeFeatures(collected),
          status: { phase: "done" },
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        const classified = classifyError(error);
        if (classified.kind === "aborted") return;
        updateEntry(key, (entry) => ({
          ...entry,
          featureInfo: null,
          status: { phase: "error", error: classified },
        }));
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          inFlightKeyRef.current = null;
        }
      }
    },
    [activeKey, bounds, entries, fetcher, updateEntry],
  );

  /** Abort the old key and detach its transient status without deleting data. */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const key = inFlightKeyRef.current;
    inFlightKeyRef.current = null;
    if (!key) return;
    updateEntry(key, (entry) => ({
      ...entry,
      status:
        entry.status.phase === "fetching" || entry.status.phase === "error"
          ? { phase: "idle" }
          : entry.status,
    }));
  }, [updateEntry]);

  // Bounds can change outside App's normal map callback (tests/future state
  // restores). Abort any request that no longer belongs to the active key.
  useEffect(() => {
    if (inFlightKeyRef.current && inFlightKeyRef.current !== activeKey) cancel();
  }, [activeKey, cancel]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const dismissError = useCallback(() => {
    updateEntry(activeKey, (entry) => ({
      ...entry,
      status: entry.status.phase === "error" ? { phase: "idle" } : entry.status,
    }));
  }, [activeKey, updateEntry]);

  const activeEntry = entries[activeKey] ?? IDLE_ENTRY;
  return {
    activeKey,
    features: activeEntry.features,
    status: activeEntry.status,
    featureInfo: activeEntry.featureInfo,
    retryCount: activeEntry.retryCount,
    fetchFeatures,
    cancel,
    dismissError,
  };
}
