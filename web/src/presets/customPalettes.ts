import type { Palette } from "../engine/types.ts";

const STORAGE_KEY = "strata-custom-palettes";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const MAX_CUSTOM_PALETTE_NAME_LENGTH = 80;

export type CustomPaletteEntry = { name: string; palette: Palette };

function isValidHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

export function validateCustomPaletteEntry(value: unknown): CustomPaletteEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string" || !entry.name.trim()) return null;

  const palette = entry.palette;
  if (!palette || typeof palette !== "object" || Array.isArray(palette)) return null;
  const p = palette as Record<string, unknown>;

  if (!isValidHex(p.background) || !isValidHex(p.foreground) || !isValidHex(p.accent)) {
    return null;
  }

  return {
    name: entry.name.trim().slice(0, MAX_CUSTOM_PALETTE_NAME_LENGTH),
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

/** Canonical palette-only content used for stable cross-profile identifiers. */
export function canonicalPaletteContent(palette: Palette): string {
  return JSON.stringify({
    background: palette.background.toLowerCase(),
    foreground: palette.foreground.toLowerCase(),
    accent: palette.accent.toLowerCase(),
    water: palette.water?.toLowerCase() ?? null,
    ocean: palette.ocean?.toLowerCase() ?? null,
    lake: palette.lake?.toLowerCase() ?? null,
    river: palette.river?.toLowerCase() ?? null,
  });
}

/** Deterministic FNV-1a content id; the display name deliberately does not affect identity. */
export function deterministicCustomPaletteId(palette: Palette): string {
  const content = canonicalPaletteContent(palette);
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `custom-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function loadCustomPalettes(): Record<string, CustomPaletteEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const result: Record<string, CustomPaletteEntry> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isCustomPaletteId(key)) continue;
      const entry = validateCustomPaletteEntry(value);
      if (entry) result[key] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveCustomPalettes(map: Record<string, CustomPaletteEntry>): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

export function isCustomPaletteId(id: string): boolean {
  return id.startsWith("custom-");
}
