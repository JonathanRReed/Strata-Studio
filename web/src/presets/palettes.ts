import type { Palette } from "../engine/types.ts";

export const palettes: Record<string, Palette> = {
  monochrome: {
    background: "#000000",
    foreground: "#ffffff",
    accent: "#ffffff",
  },
  cream: { background: "#f5f1e8", foreground: "#1a1a1a", accent: "#8b5e3c" },
  blueprint: {
    background: "#0a1f2b",
    foreground: "#a5d8ff",
    accent: "#ffffff",
  },
  neon: { background: "#0d0221", foreground: "#00ff9f", accent: "#ff00ff" },
  desert: { background: "#1c1410", foreground: "#e6c2a0", accent: "#ff8c42" },
  glacier: { background: "#051a25", foreground: "#d6f3ff", accent: "#8fd6ff" },
};

export const paletteNames: Record<string, string> = {
  monochrome: "Black & White",
  cream: "Cream & Ink",
  blueprint: "Blueprint",
  neon: "Neon",
  desert: "Desert",
  glacier: "Glacier",
};

export const defaultPalette = "monochrome";
