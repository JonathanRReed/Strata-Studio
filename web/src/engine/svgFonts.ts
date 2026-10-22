import { awaitExportTask, throwIfExportAborted } from "./export.ts";
export type SvgFontManifest = {
  licenses: string[];
  faces: {
    family: string;
    weight: string;
    unicodeRange: string;
    url: string;
  }[];
};
const cache = new Map<string, Promise<string>>();
const MAX_FONT_BYTES = 256 * 1024;
async function fontData(url: string): Promise<string> {
  let pending = cache.get(url);
  if (!pending) {
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!response.ok || !response.body)
          throw new Error("Could not load SVG fonts; retry or export PNG");
        const reader = response.body.getReader();
        const parts: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_FONT_BYTES)
              throw new Error("SVG font exceeds its size limit");
            parts.push(value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        if (
          length < 4 ||
          String.fromCharCode(...bytes.subarray(0, 4)) !== "wOF2"
        )
          throw new Error("SVG font data is invalid");
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(binary);
      } finally {
        clearTimeout(timer);
      }
    })();
    cache.set(url, pending);
    pending.catch(() => {
      if (cache.get(url) === pending) cache.delete(url);
    });
  }
  return pending;
}
const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Embeds licensed poster faces for standalone SVG viewers supporting webfonts. */
export async function embedPosterFonts(
  svg: string,
  signal?: AbortSignal,
  manifest?: SvgFontManifest,
): Promise<string> {
  throwIfExportAborted(signal);
  if (
    !svg.includes('font-family=\'"Archivo Variable"') ||
    svg.includes('id="strata-font-licenses"')
  )
    return svg;
  const assets =
    manifest ??
    (await awaitExportTask(import("./svgFontAssets.ts"), signal, 5000))
      .fontManifest;
  const css = await awaitExportTask(
    Promise.all(
      assets.faces.map(
        async (face) =>
          `@font-face{font-family:'${face.family}';font-style:normal;font-weight:${face.weight};unicode-range:${face.unicodeRange};src:url(data:font/woff2;base64,${await fontData(face.url)}) format('woff2');}`,
      ),
    ),
    signal,
  );
  throwIfExportAborted(signal);
  return svg.replace(
    /<svg\b[^>]*>/,
    (tag) =>
      `${tag}<defs><style type="text/css">${css.join("\n")}</style></defs><metadata id="strata-font-licenses">${xml(assets.licenses.join("\n\n"))}</metadata>`,
  );
}
