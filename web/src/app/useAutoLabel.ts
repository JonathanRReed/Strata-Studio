import { useCallback, useEffect, useRef } from "react";
import { reverseGeocodeName } from "../data/geocode.ts";
import type { ElevationGrid } from "../engine/types.ts";
import { MAX_LABEL_LENGTH } from "./stateSafety.ts";
import {
  boundsCenter,
  centerCacheKey,
  coordinateLabel,
  shouldAutoFill,
} from "./autoLabel.ts";

type ReverseGeocode = (
  lat: number,
  lng: number,
  signal?: AbortSignal,
) => Promise<string | null>;

function normalizeResolvedLabel(name: string): string {
  return name.trim().slice(0, MAX_LABEL_LENGTH);
}

/**
 * Auto-named poster labels with explicit provenance and center-key ownership.
 * Every transition aborts prior work; late completions must still match the
 * active center key, and user-authored labels are never overwritten.
 */
export function useAutoLabel({
  grid,
  label,
  initialCuratedName,
  initialCuratedCenter,
  onAutoLabel,
  reverseGeocode = reverseGeocodeName,
}: {
  grid: ElevationGrid | null;
  label: string;
  initialCuratedName?: string | null;
  initialCuratedCenter?: [number, number] | null;
  onAutoLabel: (name: string) => void;
  /** Hook-test/runtime injection; production uses the one-shot Nominatim call. */
  reverseGeocode?: ReverseGeocode;
}) {
  const initialName = initialCuratedName
    ? normalizeResolvedLabel(initialCuratedName)
    : null;
  // App seeds a fresh curated boot with this same label, so provenance starts
  // as auto-authored rather than accidentally treating it as user text.
  const lastAutoRef = useRef<string | null>(initialName);
  const pendingCuratedRef = useRef<{ name: string; key: string } | null>(
    initialName && initialCuratedCenter
      ? {
          name: initialName,
          key: centerCacheKey(initialCuratedCenter[1], initialCuratedCenter[0]),
        }
      : null,
  );
  // `null` is a negative geocode result. Map.has distinguishes it from a miss.
  const cacheRef = useRef(new Map<string, string | null>());
  const abortRef = useRef<AbortController | null>(null);
  const activeCenterKeyRef = useRef<string | null>(null);
  const labelRef = useRef(label);
  labelRef.current = label;
  const onAutoLabelRef = useRef(onAutoLabel);
  onAutoLabelRef.current = onAutoLabel;

  const abortActive = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    activeCenterKeyRef.current = null;
  }, []);

  const apply = useCallback((rawName: string, expectedCenterKey?: string) => {
    if (
      expectedCenterKey &&
      activeCenterKeyRef.current !== expectedCenterKey
    ) {
      return;
    }
    const name = normalizeResolvedLabel(rawName);
    if (!name || !shouldAutoFill(labelRef.current, lastAutoRef.current)) return;
    lastAutoRef.current = name;
    onAutoLabelRef.current(name);
  }, []);

  /**
   * Curated choices are an atomic transition: cancel the old geocode, mark the
   * next terrain settle as curated-owned, and apply immediately only if label
   * provenance is still empty/auto. User-authored text remains untouched.
   */
  const applyCuratedName = useCallback(
    (rawName: string, center: [number, number]) => {
      abortActive();
      const name = normalizeResolvedLabel(rawName);
      pendingCuratedRef.current = name
        ? { name, key: centerCacheKey(center[1], center[0]) }
        : null;
      if (name) apply(name);
    },
    [abortActive, apply],
  );

  useEffect(() => {
    // A user claiming the label makes any outstanding result irrelevant now,
    // rather than merely ignoring it after network completion.
    if (!shouldAutoFill(label, lastAutoRef.current)) abortActive();
  }, [abortActive, label]);

  useEffect(() => {
    // Abort first even on early-return paths (null grid, curated, cache hit).
    abortActive();
    if (!grid) return;

    const { lat, lng } = boundsCenter(grid.bounds);
    const key = centerCacheKey(lat, lng);
    const pendingCurated = pendingCuratedRef.current;
    pendingCuratedRef.current = null;
    if (pendingCurated?.key === key) {
      apply(pendingCurated.name);
      return;
    }
    if (!shouldAutoFill(labelRef.current, lastAutoRef.current)) return;

    activeCenterKeyRef.current = key;
    const fallback = coordinateLabel(lat, lng);

    if (cacheRef.current.has(key)) {
      apply(cacheRef.current.get(key) ?? fallback, key);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    void reverseGeocode(lat, lng, controller.signal)
      .then((resolved) => {
        if (
          controller.signal.aborted ||
          activeCenterKeyRef.current !== key
        ) {
          return;
        }
        const name = resolved ? normalizeResolvedLabel(resolved) : null;
        cacheRef.current.set(key, name);
        apply(name ?? fallback, key);
      })
      .catch(() => {
        if (
          controller.signal.aborted ||
          activeCenterKeyRef.current !== key
        ) {
          return;
        }
        // Transient provider failures should show a useful fallback now without
        // becoming a permanent negative cache entry for this center.
        apply(fallback, key);
      });
  }, [abortActive, apply, grid, reverseGeocode]);

  useEffect(() => abortActive, [abortActive]);

  return { applyCuratedName };
}
