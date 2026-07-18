import { useCallback, useMemo, useState } from "react";
import type { Palette } from "../engine/types.ts";
import { palettes, paletteNames } from "../presets/palettes.ts";
import {
  loadCustomPalettes,
  saveCustomPalettes,
  type CustomPaletteEntry,
} from "../presets/customPalettes.ts";

/** Built-in palettes merged with localStorage-persisted and shared custom palettes. */
export function usePalettes(initialPalette?: { id: string; entry: CustomPaletteEntry } | null) {
  const [customPalettes, setCustomPalettes] = useState<Record<string, CustomPaletteEntry>>(() => {
    const stored = loadCustomPalettes();
    if (!initialPalette) return stored;
    const next = { ...stored, [initialPalette.id]: initialPalette.entry };
    saveCustomPalettes(next);
    return next;
  });

  const allPalettes = useMemo<Record<string, Palette>>(
    () => ({
      ...palettes,
      ...Object.fromEntries(Object.entries(customPalettes).map(([id, v]) => [id, v.palette])),
    }),
    [customPalettes],
  );

  const allPaletteNames = useMemo<Record<string, string>>(
    () => ({
      ...paletteNames,
      ...Object.fromEntries(Object.entries(customPalettes).map(([id, v]) => [id, v.name])),
    }),
    [customPalettes],
  );

  const savePalette = useCallback((id: string, name: string, palette: Palette) => {
    setCustomPalettes((prev) => {
      const next = { ...prev, [id]: { name, palette } };
      if (!saveCustomPalettes(next)) {
        console.warn("Failed to save custom palette to localStorage (storage may be full or disabled).");
      }
      return next;
    });
  }, []);

  const installPalette = useCallback((id: string, entry: CustomPaletteEntry) => {
    setCustomPalettes((prev) => {
      const next = { ...prev, [id]: entry };
      if (!saveCustomPalettes(next)) {
        console.warn("Failed to persist imported custom palette to localStorage.");
      }
      return next;
    });
  }, []);

  const deletePalette = useCallback((id: string) => {
    setCustomPalettes((prev) => {
      const { [id]: _, ...next } = prev;
      if (!saveCustomPalettes(next)) {
        console.warn("Failed to update localStorage after deleting custom palette.");
      }
      return next;
    });
  }, []);

  return {
    allPalettes,
    allPaletteNames,
    customPalettes,
    savePalette,
    installPalette,
    deletePalette,
  };
}
