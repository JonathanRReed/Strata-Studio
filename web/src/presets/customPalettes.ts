import type { Palette } from "../engine/types.ts";

const STORAGE_KEY = "strata-custom-palettes";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isValidHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

function validateEntry(value: unknown): { name: string; palette: Palette } | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string" || !entry.name.trim()) return null;

  const palette = entry.palette;
  if (!palette || typeof palette !== "object") return null;
  const p = palette as Record<string, unknown>;

  if (!isValidHex(p.background) || !isValidHex(p.foreground) || !isValidHex(p.accent)) {
    return null;
  }

  return {
    name: entry.name.trim(),
    palette: {
      background: p.background.toLowerCase(),
      foreground: p.foreground.toLowerCase(),
      accent: p.accent.toLowerCase(),
      water: isValidHex(p.water) ? p.water.toLowerCase() : undefined,
      ocean: isValidHex(p.ocean) ? p.ocean.toLowerCase() : undefined,
      lake: isValidHex(p.lake) ? p.lake.toLowerCase() : undefined,
      river: isValidHex(p.river) ? p.river.toLowerCase() : undefined,
    },
  };
}

export function loadCustomPalettes(): Record<string, { name: string; palette: Palette }> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};

    const result: Record<string, { name: string; palette: Palette }> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isCustomPaletteId(key)) continue;
      const entry = validateEntry(value);
      if (entry) result[key] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveCustomPalettes(map: Record<string, { name: string; palette: Palette }>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage may be disabled or full; ignore silently.
  }
}

export function isCustomPaletteId(id: string): boolean {
  return id.startsWith("custom-");
}
