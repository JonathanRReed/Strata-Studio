// --- PNG pHYs (physical density) injection -------------------------------
//
// Print shops open a PNG at its declared physical size only when it carries
// a pHYs chunk (pixels per metre). Canvas.toBlob never writes one, so print
// exports splice it in at the byte level before download.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const METERS_PER_INCH = 0.0254;

let crcTable: Uint32Array | null = null;

/** Standard PNG CRC-32 (polynomial 0xEDB88320), as an unsigned 32-bit int. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Pixels per metre a pHYs chunk declares for the given DPI. */
export function dpiToPpm(dpi: number): number {
  return Math.round(dpi / METERS_PER_INCH);
}

/**
 * A complete pHYs chunk (length + type + data + CRC) declaring `dpi` in both
 * axes: 9 data bytes — x ppm (u32be), y ppm (u32be), unit specifier 1 (metre).
 */
export function buildPhysChunk(dpi: number): Uint8Array<ArrayBuffer> {
  const ppm = dpiToPpm(dpi);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk[4] = 0x70; // p
  chunk[5] = 0x48; // H
  chunk[6] = 0x59; // Y
  chunk[7] = 0x73; // s
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  return chunk;
}

/**
 * Splices a pHYs chunk into PNG bytes immediately before the first IDAT
 * (dropping any existing pHYs). Pure byte-level chunk walk — no decode.
 * Returns the input untouched when it isn't a well-formed PNG.
 */
export function insertPhysChunk(
  png: Uint8Array<ArrayBuffer>,
  dpi: number,
): Uint8Array<ArrayBuffer> {
  if (png.length < 8 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts: Uint8Array<ArrayBuffer>[] = [png.subarray(0, 8)];
  let inserted = false;
  let offset = 8;
  while (offset + 12 <= png.length) {
    const dataLength = view.getUint32(offset);
    const end = offset + 12 + dataLength;
    if (end > png.length) return png; // truncated chunk — leave untouched
    const type = String.fromCharCode(
      png[offset + 4],
      png[offset + 5],
      png[offset + 6],
      png[offset + 7],
    );
    if (type === "IDAT" && !inserted) {
      parts.push(buildPhysChunk(dpi));
      inserted = true;
    }
    if (type !== "pHYs") parts.push(png.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }
  if (!inserted) return png;
  if (offset < png.length) parts.push(png.subarray(offset));
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** PNG blob → the same PNG with a pHYs chunk declaring `dpi`. */
export async function withPngDpi(blob: Blob, dpi: number): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const spliced = insertPhysChunk(bytes, dpi);
  if (spliced === bytes) return blob;
  return new Blob([spliced], { type: "image/png" });
}

// --- Download helpers -----------------------------------------------------

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to create PNG blob"))),
      "image/png",
    );
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadPng(
  canvas: HTMLCanvasElement,
  filename: string,
  /** When set, a pHYs chunk declaring this density is spliced into the PNG. */
  dpi?: number,
) {
  try {
    let blob = await canvasToPngBlob(canvas);
    if (dpi) blob = await withPngDpi(blob, dpi);
    downloadBlob(blob, filename);
  } catch (err) {
    console.error("PNG export failed:", err);
  }
}

export function downloadSvg(svgString: string, filename: string) {
  downloadBlob(new Blob([svgString], { type: "image/svg+xml" }), filename);
}

export function createOffscreenCanvas(
  width: number,
  height: number,
): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not create canvas context");
  }
  return { canvas, ctx };
}

export function isLightColor(hex: string): boolean {
  const m = hex.replace("#", "");
  if (m.length < 6) return false;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

/**
 * Largest font size ≤ `target` at which `text` fits within `maxWidth` when
 * measured on `ctx` (sans-serif). Keeps attribution readable at any export
 * scale without overflowing the artwork.
 */
function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  target: number,
  maxWidth: number,
): number {
  ctx.font = `${target}px sans-serif`;
  const width = ctx.measureText(text).width;
  if (width <= maxWidth || width <= 0) return target;
  return Math.max(1, target * (maxWidth / width));
}

export function downloadPngWithAttribution(
  canvas: HTMLCanvasElement,
  filename: string,
  attribution: string,
  backgroundColor = "#000000",
  /** Device pixels per logical pixel, so attribution text scales with exports. */
  scale = 1,
  /** When set, a pHYs chunk declaring this print density is spliced in. */
  dpi?: number,
) {
  // Draw onto a copy so the source canvas (e.g. the live preview) is untouched.
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext("2d");
  if (!ctx) {
    void downloadPng(canvas, filename, dpi);
    return;
  }
  ctx.drawImage(canvas, 0, 0);
  const fontSize = fitFontSize(ctx, attribution, 10 * scale, copy.width - 16 * scale);
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = isLightColor(backgroundColor)
    ? "rgba(0,0,0,0.45)"
    : "rgba(255,255,255,0.4)";
  ctx.textAlign = "right";
  ctx.fillText(attribution, copy.width - 8 * scale, copy.height - 8 * scale);
  void downloadPng(copy, filename, dpi);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseSvgLength(value: string | undefined): number | null {
  if (!value) return null;
  const num = parseFloat(value);
  if (Number.isNaN(num)) return null;
  if (value.includes("%")) return null;
  return num;
}

/**
 * User-space (viewBox) dimensions of an SVG, for placing overlay elements.
 * The viewBox is preferred over width/height: exported SVGs render at export
 * pixel size but keep their geometry in logical preview coordinates, and
 * overlays must be placed (and sized) in that logical space so they scale
 * with the artwork.
 */
function getSvgDimensions(svgString: string): { width: number; height: number } | null {
  const openTag = svgString.match(/<svg([^>]*)>/i);
  if (!openTag) return null;
  const attrString = openTag[1];
  const viewBoxMatch = attrString.match(/viewBox=(["'])([^"']+)\1/);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[2]
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(parseFloat);
    if (parts.length >= 4 && !Number.isNaN(parts[2]) && !Number.isNaN(parts[3])) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const widthMatch = attrString.match(/width=(["'])([^"']+)\1/);
  const heightMatch = attrString.match(/height=(["'])([^"']+)\1/);
  const width = parseSvgLength(widthMatch?.[2]);
  const height = parseSvgLength(heightMatch?.[2]);
  if (width !== null && height !== null) {
    return { width, height };
  }
  return null;
}

export function downloadSvgWithAttribution(
  svgString: string,
  filename: string,
  attribution: string,
  backgroundColor = "#000000",
) {
  let modified = svgString;
  const escaped = escapeXml(attribution);
  const openTag = svgString.match(/<svg([^>]*)>/i);
  if (openTag) {
    const openEnd = (openTag.index ?? 0) + openTag[0].length;
    modified = `${modified.slice(0, openEnd)}<metadata>${escaped}</metadata>${modified.slice(openEnd)}`;
  }
  const dims = getSvgDimensions(modified);
  const width = dims?.width ?? 0;
  const height = dims?.height ?? 0;
  const attributionFill = isLightColor(backgroundColor)
    ? "rgba(0,0,0,0.45)"
    : "rgba(255,255,255,0.4)";
  // Text is placed in viewBox (logical) units, so it scales with the export;
  // shrink from the 10-unit target if the attribution is wider than the art.
  let fontSize = 10;
  const measureCtx = document.createElement("canvas").getContext("2d");
  if (measureCtx && width > 16) {
    fontSize = fitFontSize(measureCtx, attribution, 10, width - 16);
  }
  const textEl = `<text x="${width - 8}" y="${height - 8}" text-anchor="end" font-size="${fontSize.toFixed(2)}" font-family="sans-serif" fill="${attributionFill}">${escaped}</text>`;
  const closeIndex = modified.toLowerCase().lastIndexOf("</svg>");
  if (closeIndex >= 0) {
    modified = `${modified.slice(0, closeIndex)}${textEl}${modified.slice(closeIndex)}`;
  } else {
    modified += textEl;
  }
  downloadSvg(modified, filename);
}
