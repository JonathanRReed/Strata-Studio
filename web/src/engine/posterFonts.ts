import { POSTER_TITLE_FAMILY, POSTER_META_FAMILY } from "./scene.ts";

/**
 * The poster title block is set in Archivo Variable (display) and IBM Plex
 * Mono (coordinate readout) — the same two faces as the app chrome. Canvas
 * text rendering silently falls back to system fonts if a webfont has not
 * finished loading, which would make the exported artwork the one surface
 * where the typography is wrong. This module forces the FontFaceSet to load
 * the exact faces the poster uses before any canvas or SVG rasterization
 * that includes a poster label.
 *
 * The CSS imports in main.tsx (@fontsource-variable/archivo,
 * @fontsource/ibm-plex-mono) declare the faces; this function ensures they
 * are actually in memory before we draw with them.
 */

let ensurePromise: Promise<void> | null = null;

/**
 * Loads the poster font faces and resolves once they are ready to draw.
 * Idempotent — concurrent callers share the same promise. Safe to call in a
 * non-DOM context (tests, SSR), where it resolves immediately.
 */
export function ensurePosterFonts(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  if (typeof document === "undefined" || !document.fonts) {
    ensurePromise = Promise.resolve();
    return ensurePromise;
  }

  const faces = document.fonts;
  // Load the specific faces the poster uses. The weight matches
  // POSTER_TITLE_FONT_WEIGHT (600) and the meta line uses 400.
  const loads = [
    faces.load(`600 64px ${POSTER_TITLE_FAMILY}`),
    faces.load(`400 16px ${POSTER_META_FAMILY}`),
    faces.load(`500 16px ${POSTER_META_FAMILY}`),
  ];
  ensurePromise = Promise.all([faces.ready, ...loads])
    .then(() => undefined)
    .catch(() => undefined); // A failed load is not fatal — fallbacks apply.
  return ensurePromise;
}
