/**
 * OG share-card rendering, isolated in its own module.
 *
 * workers-og drags in Satori + resvg/yoga WASM, which only exists in the
 * Workers runtime bundle. index.ts imports this file lazily (dynamic import)
 * so `bun test` and any non-/og request never touch it. Keep this module
 * free of logic worth unit-testing — the testable input parsing lives in
 * logic.ts (parseOgParams / escapeHtml).
 */

import { ImageResponse } from "workers-og";
import { escapeHtml, type OgParams } from "./logic";

/** Build the minimal Satori-compatible HTML for the 1200x630 card. */
export function buildOgHtml(p: OgParams): string {
  const chips = p.palette
    .map(
      (hex) =>
        `<div style="display: flex; width: 72px; height: 72px; border-radius: 12px; background: ${escapeHtml(hex)}; border: 2px solid rgba(255,255,255,0.25);"></div>`,
    )
    .join("");

  const subline = [p.coords, p.style].filter(Boolean).join("  ·  ");

  // Satori subset of HTML/CSS: every multi-child element needs display:flex.
  // 'Bitter' is workers-og's default font, fetched from Google Fonts at
  // runtime when no fonts option is passed to ImageResponse.
  return `
<div style="display: flex; flex-direction: column; justify-content: flex-end; width: 100%; height: 100%; background: #000000; padding: 72px; font-family: 'Bitter';">
  <div style="display: flex; gap: 20px; margin-bottom: 48px;">${chips}</div>
  <div style="display: flex; font-size: 84px; font-weight: 700; color: #ffffff; line-height: 1.05; letter-spacing: -2px;">${escapeHtml(p.place)}</div>
  <div style="display: flex; margin-top: 24px; font-size: 30px; color: #9ca3af; letter-spacing: 4px;">${escapeHtml(subline.toUpperCase())}</div>
</div>`;
}

/** Render the card to a 1200x630 PNG Response (uncustomized headers). */
export function renderOgCard(p: OgParams): Response {
  return new ImageResponse(buildOgHtml(p), {
    width: 1200,
    height: 630,
  });
}
