export function downloadPng(canvas: HTMLCanvasElement, filename: string) {
  try {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          console.error("Failed to create PNG blob");
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.download = filename;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      "image/png",
    );
  } catch (err) {
    console.error("PNG export failed:", err);
  }
}

export function downloadSvg(svgString: string, filename: string) {
  const blob = new Blob([svgString], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
) {
  // Draw onto a copy so the source canvas (e.g. the live preview) is untouched.
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext("2d");
  if (!ctx) {
    downloadPng(canvas, filename);
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
  downloadPng(copy, filename);
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
