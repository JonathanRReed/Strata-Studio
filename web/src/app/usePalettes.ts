import { useCallback, useMemo, useState } from "react";
import type { Palette } from "../engine/types.ts";
import { palettes, paletteNames } from "../presets/palettes.ts";
import { loadCustomPalettes, saveCustomPalettes } from "../presets/customPalettes.ts";

/** Built-in palettes merged with localStorage-persisted custom palettes. */
export function usePalettes() {
  const [customPalettes, setCustomPalettes] = useState<
    Record<string, { name: string; palette: Palette }>
  >(() => loadCustomPalettes());

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

  const deletePalette = useCallback((id: string) => {
    setCustomPalettes((prev) => {
      const { [id]: _, ...next } = prev;
      if (!saveCustomPalettes(next)) {
        console.warn("Failed to update localStorage after deleting custom palette.");
      }
      return next;
    });
  }, []);

  return { allPalettes, allPaletteNames, savePalette, deletePalette };
}
