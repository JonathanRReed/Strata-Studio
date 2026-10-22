import { awaitExportTask } from "./export.ts";
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

const fontLoads = new WeakMap<FontFaceSet, Promise<void>>();

/** Shared font loading is bounded; cancelling one export does not cancel others. */
export function ensurePosterFonts(signal?: AbortSignal): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) {
    return awaitExportTask(Promise.resolve(), signal);
  }
  const faces = document.fonts;
  let ready = fontLoads.get(faces);
  if (!ready) {
    // Wait only for our faces, not document.fonts.ready (which includes
    // unrelated page fonts). A stalled server falls back after five seconds.
    let timer: ReturnType<typeof setTimeout> | undefined;
    ready = Promise.race([
      Promise.resolve()
        .then(() =>
          Promise.all([
            faces.load(`600 64px ${POSTER_TITLE_FAMILY}`),
            faces.load(`400 16px ${POSTER_META_FAMILY}`),
            faces.load(`500 16px ${POSTER_META_FAMILY}`),
          ]),
        )
        .then(() => undefined)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    fontLoads.set(faces, ready);
  }
  return awaitExportTask(ready, signal);
}
