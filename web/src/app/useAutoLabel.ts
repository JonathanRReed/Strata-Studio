import { useCallback, useEffect, useRef } from "react";
import { reverseGeocodeName } from "../data/geocode.ts";
import type { ElevationGrid } from "../engine/types.ts";
import { boundsCenter, centerCacheKey, shouldAutoFill } from "./autoLabel.ts";

/**
 * Auto-named poster labels: when a generate settles (a fresh terrain grid
 * lands), resolve the selection center to a short place name and fill the
 * label — but only while the label is empty or still holds the previous
 * auto-fill (user-typed labels are never overwritten; see shouldAutoFill).
 *
 * Throttling: at most one reverse-geocode request per generate settle, each
 * new settle aborting the previous in-flight request, with an in-session
 * cache per ~1 km center bucket. Curated place picks apply their display
 * name instantly and the settle they trigger skips the geocode round-trip.
 */
export function useAutoLabel({
  grid,
  label,
  initialCuratedName,
  onAutoLabel,
}: {
  /** Latest generated terrain grid; each successful generate is a new object. */
  grid: ElevationGrid | null;
  /** Current params.label, for the overwrite rules. */
  label: string;
  /** Boot-time curated place (Daily Strata) — names the first settle for free. */
  initialCuratedName?: string | null;
  onAutoLabel: (name: string) => void;
}) {
  const lastAutoRef = useRef<string | null>(null);
  const pendingCuratedRef = useRef<string | null>(initialCuratedName ?? null);
  const cacheRef = useRef(new Map<string, string>());
  const abortRef = useRef<AbortController | null>(null);
  const labelRef = useRef(label);
  labelRef.current = label;
  const onAutoLabelRef = useRef(onAutoLabel);
  onAutoLabelRef.current = onAutoLabel;

  const apply = useCallback((name: string) => {
    if (!shouldAutoFill(labelRef.current, lastAutoRef.current)) return;
    lastAutoRef.current = name;
    onAutoLabelRef.current(name);
  }, []);

  /**
   * Curated place picked (chip strip / Surprise Me / sheet): adopt its
   * display name instantly and let the generate it triggers skip the
   * geocode round-trip.
   *
   * The adopt is FORCED, bypassing shouldAutoFill: the caller applies the
   * place's preset in the same event, which resets params.label — but that
   * setParams hasn't flushed yet, so the gate would compare against the
   * stale pre-reset label and refuse, leaving the poster blank (any typed
   * label is already gone via the preset reset either way; the place name
   * is strictly better than empty). The label update below is queued after
   * the preset's own setParams, so it lands last in the same batch.
   */
  const applyCuratedName = useCallback((name: string) => {
    pendingCuratedRef.current = name;
    lastAutoRef.current = name;
    onAutoLabelRef.current(name);
  }, []);

  useEffect(() => {
    if (!grid) return;
    // A curated pick owns this settle — its name is already the label.
    if (pendingCuratedRef.current) {
      apply(pendingCuratedRef.current);
      pendingCuratedRef.current = null;
      return;
    }
    const { lat, lng } = boundsCenter(grid.bounds);
    const key = centerCacheKey(lat, lng);
    const cached = cacheRef.current.get(key);
    if (cached) {
      apply(cached);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void reverseGeocodeName(lat, lng, controller.signal).then((name) => {
      if (!name || controller.signal.aborted) return;
      cacheRef.current.set(key, name);
      apply(name);
    });
  }, [grid, apply]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { applyCuratedName };
}
