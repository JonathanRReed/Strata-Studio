import { useCallback, useEffect, useRef, useState } from "react";
import {
  detectNewEasterEgg,
  loadFoundEggIds,
  saveFoundEggIds,
} from "../data/easterEggs.ts";
import type { ElevationGrid, Palette } from "../engine/types.ts";

/** Toast auto-dismiss delay. */
export const EGG_TOAST_MS = 6000;

/**
 * Watches completed generates for landmark easter eggs. Every successful
 * generate produces a fresh grid object whose bounds are the generated
 * selection, so the grid is the trigger AND the coordinate source. First
 * discovery of an egg persists its palette through the custom-palette store
 * (it then appears in the picker automatically) and raises a toast;
 * localStorage remembers discoveries so an egg never re-toasts.
 */
export function useEasterEggs({
  grid,
  savePalette,
}: {
  grid: ElevationGrid | null;
  savePalette: (id: string, name: string, palette: Palette) => void;
}) {
  const [toast, setToast] = useState<string | null>(null);
  const foundRef = useRef<Set<string> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePaletteRef = useRef(savePalette);
  savePaletteRef.current = savePalette;

  useEffect(() => {
    if (!grid) return;
    foundRef.current ??= loadFoundEggIds();
    const { bounds } = grid;
    const center = {
      lat: (bounds.north + bounds.south) / 2,
      lng: (bounds.east + bounds.west) / 2,
    };
    const egg = detectNewEasterEgg(center, foundRef.current);
    if (!egg) return;
    foundRef.current.add(egg.id);
    saveFoundEggIds(foundRef.current);
    savePaletteRef.current(egg.palette.id, egg.palette.name, egg.palette.palette);
    setToast(egg.toastText);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToast(null), EGG_TOAST_MS);
  }, [grid]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const dismissEggToast = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(null);
  }, []);

  return { eggToast: toast, dismissEggToast };
}
