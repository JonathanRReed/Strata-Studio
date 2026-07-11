import type { ArtworkMeta, Palette, StyleParams, FeatureMasks } from "./types.ts";
import { hashSeed } from "./noise.ts";

export type ScenePoint = { x: number; y: number };

export type StrokeRole =
  | "foreground"
  | "accent"
  | "background"
  | "water"
  | "ocean"
  | "lake"
  | "river";

export type Stroke = {
  points: ScenePoint[];
  role?: StrokeRole;
  width?: number;
  glow?: boolean;
  closed?: boolean;
  fill?: boolean;
  opacity?: number;
};

export type Scene = {
  strokes: Stroke[];
};

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function strokeColor(stroke: Stroke, palette: Palette): string {
  const waterFallback = palette.water ?? palette.accent;
  switch (stroke.role) {
    case "accent":
      return palette.accent;
    case "background":
      return palette.background;
    case "water":
      return waterFallback;
    case "ocean":
      return palette.ocean ?? waterFallback;
    case "lake":
      return palette.lake ?? waterFallback;
    case "river":
      return palette.river ?? waterFallback;
    default:
      return palette.foreground;
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

/**
 * Draws the water mask as a colored underlay so water areas are visually
 * distinct from land in all styles — including terrain-only styles that
 * don't render water feature lines.
 */
function drawWaterUnderlay(
  ctx: CanvasRenderingContext2D,
  masks: FeatureMasks,
  palette: Palette,
  width: number,
  height: number,
): void {
  if (typeof document === "undefined") return; // DOM-less tests
  const { width: maskW, height: maskH, ocean, lake, river } = masks;
  const canvas = document.createElement("canvas");
  canvas.width = maskW;
  canvas.height = maskH;
  const tempCtx = canvas.getContext("2d");
  if (!tempCtx) return;

  const oceanRgb = hexToRgb(palette.ocean ?? palette.water ?? palette.accent);
  const lakeRgb = hexToRgb(palette.lake ?? palette.water ?? palette.accent);
  const riverRgb = hexToRgb(palette.river ?? palette.water ?? palette.accent);

  const imageData = tempCtx.createImageData(maskW, maskH);
  const data = imageData.data;

  for (let i = 0; i < maskW * maskH; i++) {
    const ov = ocean[i];
    const lv = lake[i];
    const rv = river[i];
    const maxVal = Math.max(ov, lv, rv);
    if (maxVal > 0.01) {
      // Pick the dominant water type's color
      let rgb: [number, number, number];
      if (ov >= lv && ov >= rv) rgb = oceanRgb;
      else if (lv >= rv) rgb = lakeRgb;
      else rgb = riverRgb;
      data[i * 4] = rgb[0];
      data[i * 4 + 1] = rgb[1];
      data[i * 4 + 2] = rgb[2];
      data[i * 4 + 3] = Math.round(maxVal * 255);
    }
  }

  tempCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(canvas, 0, 0, width, height);
}

/**
 * Encodes the water mask as a base64 PNG string for embedding in SVG output.
 * Returns an empty string if no water is present.
 */
function waterMaskToPng(masks: FeatureMasks, palette: Palette): string {
  if (typeof document === "undefined") return ""; // DOM-less tests
  const { width: maskW, height: maskH, ocean, lake, river } = masks;
  const canvas = document.createElement("canvas");
  canvas.width = maskW;
  canvas.height = maskH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const oceanRgb = hexToRgb(palette.ocean ?? palette.water ?? palette.accent);
  const lakeRgb = hexToRgb(palette.lake ?? palette.water ?? palette.accent);
  const riverRgb = hexToRgb(palette.river ?? palette.water ?? palette.accent);

  const imageData = ctx.createImageData(maskW, maskH);
  const data = imageData.data;
  let hasWater = false;

  for (let i = 0; i < maskW * maskH; i++) {
    const ov = ocean[i];
    const lv = lake[i];
    const rv = river[i];
    const maxVal = Math.max(ov, lv, rv);
    if (maxVal > 0.01) {
      hasWater = true;
      let rgb: [number, number, number];
      if (ov >= lv && ov >= rv) rgb = oceanRgb;
      else if (lv >= rv) rgb = lakeRgb;
      else rgb = riverRgb;
      data[i * 4] = rgb[0];
      data[i * 4 + 1] = rgb[1];
      data[i * 4 + 2] = rgb[2];
      data[i * 4 + 3] = Math.round(maxVal * 255);
    }
  }

  if (!hasWater) return "";
  ctx.putImageData(imageData, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/**
 * Poster title block layout, in logical (preview) pixels. Both the canvas
 * and SVG renderers derive their geometry from this single function so the
 * two outputs stay in parity, and because everything is expressed in logical
 * units the block scales perfectly with the export transform/viewBox.
 *
 * Stack, bottom-up from the artwork's bottom edge:
 *   line 3 — coordinates + elevation range (small caps-style meta line)
 *   line 2 — a thin centered rule
 *   line 1 — the label in letterspaced uppercase
 */
export type PosterLayout = {
  /** Horizontal center of the artwork. */
  cx: number;
  titleSize: number;
  subSize: number;
  /** Extra advance between title glyphs (px, logical). */
  titleTracking: number;
  /** Extra advance between meta-line glyphs (px, logical). */
  subTracking: number;
  titleBaseline: number;
  ruleY: number;
  subBaseline: number;
  /** Half the rule's length. */
  ruleHalf: number;
  ruleThickness: number;
};

export function posterLayout(width: number, height: number): PosterLayout {
  const titleSize = Math.max(13, width * 0.042);
  const subSize = Math.max(9, width * 0.023);
  const subBaseline = height - height * 0.058;
  const ruleY = subBaseline - subSize * 1.9;
  const titleBaseline = ruleY - titleSize * 0.9;
  return {
    cx: width / 2,
    titleSize,
    subSize,
    titleTracking: titleSize * 0.28,
    subTracking: subSize * 0.12,
    titleBaseline,
    ruleY,
    subBaseline,
    ruleHalf: width * 0.055,
    ruleThickness: Math.max(0.6, width * 0.0014),
  };
}

const POSTER_TITLE_OPACITY = 0.92;
const POSTER_RULE_OPACITY = 0.5;
const POSTER_META_OPACITY = 0.62;
const POSTER_TITLE_FONT_WEIGHT = 600;

/** Minus sign (U+2212) reads better than a hyphen in the elevation figures. */
const MINUS = "−";

/**
 * "37.77°N 122.42°W · ELEV −110–282 M" — center coordinates of the artwork
 * bounds plus the elevation range of the rendered grid.
 */
export function posterMetaLine(meta: ArtworkMeta): string {
  const lat = (meta.bounds.north + meta.bounds.south) / 2;
  const lng = (meta.bounds.east + meta.bounds.west) / 2;
  const latStr = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}`;
  const lngStr = `${Math.abs(lng).toFixed(2)}°${lng >= 0 ? "E" : "W"}`;
  const fmt = (m: number) => {
    const r = Math.round(m);
    return r < 0 ? `${MINUS}${Math.abs(r)}` : `${r}`;
  };
  return `${latStr} ${lngStr} · ELEV ${fmt(meta.elevation.min)}–${fmt(meta.elevation.max)} M`;
}

/**
 * Draws `text` centered at `cx` with per-glyph tracking. Prefers the native
 * ctx.letterSpacing (tracking then applies in the same logical space as the
 * font size, and the canvas transform scales both); falls back to manual
 * per-character advances via measureText where unsupported. The native path
 * offsets by tracking/2 because CSS letter-spacing trails the last glyph,
 * which would otherwise pull the centered text left by half a track.
 */
function fillTextTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  tracking: number,
): void {
  // Runtime feature detection (letterSpacing shipped in Chrome 99 / Safari
  // 17.4); typed as optional so older engines fall through to the manual path.
  const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if (typeof spaced.letterSpacing === "string") {
    const prev = spaced.letterSpacing;
    spaced.letterSpacing = `${tracking}px`;
    ctx.textAlign = "center";
    ctx.fillText(text, cx + tracking / 2, y);
    spaced.letterSpacing = prev;
    return;
  }
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * (chars.length - 1);
  ctx.textAlign = "left";
  let x = cx - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, y);
    x += widths[i] + tracking;
  }
}

/**
 * The poster title block: letterspaced-caps label, a thin rule, and the
 * coordinates/elevation meta line (when ArtworkMeta is available). Drawn in
 * logical coordinates under the render transform, so exports scale it
 * exactly like the artwork.
 */
function drawPosterTitleBlock(
  ctx: CanvasRenderingContext2D,
  label: string,
  palette: Palette,
  width: number,
  height: number,
  meta?: ArtworkMeta,
): void {
  const L = posterLayout(width, height);
  ctx.fillStyle = palette.foreground;

  ctx.globalAlpha = POSTER_TITLE_OPACITY;
  ctx.font = `${POSTER_TITLE_FONT_WEIGHT} ${L.titleSize}px sans-serif`;
  fillTextTracked(ctx, label.toUpperCase(), L.cx, L.titleBaseline, L.titleTracking);

  ctx.globalAlpha = POSTER_RULE_OPACITY;
  ctx.fillRect(L.cx - L.ruleHalf, L.ruleY - L.ruleThickness / 2, L.ruleHalf * 2, L.ruleThickness);

  if (meta) {
    ctx.globalAlpha = POSTER_META_OPACITY;
    ctx.font = `${L.subSize}px sans-serif`;
    fillTextTracked(ctx, posterMetaLine(meta), L.cx, L.subBaseline, L.subTracking);
  }
  ctx.globalAlpha = 1;
}

/**
 * Renders a scene onto a canvas of any pixel size. The scene is ALWAYS
 * generated in logical coordinates (`width`×`height`, preview-sized); the
 * canvas transform maps logical space onto the full canvas bitmap, so the
 * same scene renders identically at preview DPR or at poster export sizes —
 * just sharper. Effects that live in device-pixel space (glow shadowBlur,
 * grain tile resolution) are multiplied by the derived scale factor so their
 * logical appearance is resolution-independent.
 */
export function renderSceneCanvas(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  params: StyleParams,
  palette: Palette,
  width: number,
  height: number,
  transparent = false,
  masks?: FeatureMasks,
): void {
  // Background is drawn before any rotation so corners are always filled.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const scaleX = ctx.canvas.width / width;
  const scaleY = ctx.canvas.height / height;
  // Device pixels per logical pixel (axes may differ by rounding; average).
  const renderScale = (scaleX + scaleY) / 2;
  ctx.scale(scaleX, scaleY);
  if (!transparent) {
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }

  ctx.save();
  if (params.rotation !== 0) {
    ctx.translate(width / 2, height / 2);
    ctx.rotate((params.rotation * Math.PI) / 180);
    ctx.translate(-width / 2, -height / 2);
  }

  // Water underlay: fill water areas with the palette's water color so they're
  // visually distinct from land in all styles. Drawn inside the rotation
  // transform so water stays aligned with the rotated strokes.
  if (masks) {
    drawWaterUnderlay(ctx, masks, palette, width, height);
  }

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const stroke of scene.strokes) {
    if (stroke.points.length === 0) continue;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    if (stroke.closed) ctx.closePath();
    ctx.globalAlpha = stroke.opacity ?? 1;
    const color = strokeColor(stroke, palette);
    if (stroke.glow) {
      ctx.shadowColor = color;
      // shadowBlur is not affected by the canvas transform: scale it manually.
      ctx.shadowBlur = 8 * renderScale;
    } else {
      ctx.shadowBlur = 0;
    }
    // Background-role strokes are occlusion shapes (they hide strokes behind
    // them). On a transparent export, painting them in the palette background
    // would leave opaque blobs — erase to transparency instead.
    const erase = transparent && stroke.role === "background";
    if (erase) ctx.globalCompositeOperation = "destination-out";
    if (stroke.fill) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = stroke.width ?? params.lineWidth;
      ctx.stroke();
    }
    if (erase) ctx.globalCompositeOperation = "source-over";
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.restore(); // undo rotation; label stays unrotated

  if (params.label) {
    if (params.labelStyle === "poster") {
      drawPosterTitleBlock(ctx, params.label, palette, width, height, masks?.meta);
    } else {
      ctx.font = `${Math.max(12, Math.round(width / 36))}px sans-serif`;
      ctx.fillStyle = palette.foreground;
      ctx.globalAlpha = 0.6;
      ctx.textAlign = "left";
      ctx.fillText(params.label, 16, height - 16);
      ctx.globalAlpha = 1;
    }
  }

  if (params.grain > 0) {
    applyGrain(ctx, params, width, height, renderScale);
  }

  ctx.restore();
}

function applyGrain(
  ctx: CanvasRenderingContext2D,
  params: StyleParams,
  width: number,
  height: number,
  scale = 1,
): void {
  const rng = mulberry32(hashSeed(params.seed + ":grain"));
  // Tile layout stays in logical pixels (same tiling as the preview), but the
  // noise is generated at device resolution so exports get per-pixel grain
  // instead of an upscaled, blurry 128px tile.
  const tileSize = 128;
  const deviceTile = Math.max(1, Math.round(tileSize * scale));
  const noiseCanvas = document.createElement("canvas");
  noiseCanvas.width = deviceTile;
  noiseCanvas.height = deviceTile;
  const noiseCtx = noiseCanvas.getContext("2d");
  if (!noiseCtx) return;
  const imageData = noiseCtx.createImageData(deviceTile, deviceTile);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rng() - 0.5) * params.grain * 60;
    data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, 128 + n));
    data[i + 3] = Math.round(params.grain * 80);
  }
  noiseCtx.putImageData(imageData, 0, 0);
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "overlay";
  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      ctx.drawImage(noiseCanvas, x, y, tileSize, tileSize);
    }
  }
  ctx.globalCompositeOperation = prev;
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function strokeToPath(stroke: Stroke): string {
  let d = `M ${stroke.points[0].x.toFixed(2)} ${stroke.points[0].y.toFixed(2)}`;
  for (let i = 1; i < stroke.points.length; i++) {
    d += ` L ${stroke.points[i].x.toFixed(2)} ${stroke.points[i].y.toFixed(2)}`;
  }
  if (stroke.closed) d += " Z";
  return d;
}

/**
 * SVG twin of drawPosterTitleBlock: identical layout math (posterLayout),
 * letter-spacing attributes for the tracking, and the same trailing-space
 * centering compensation (+tracking/2 with text-anchor="middle").
 */
function posterTitleSvg(
  label: string,
  palette: Palette,
  width: number,
  height: number,
  meta?: ArtworkMeta,
): string {
  const L = posterLayout(width, height);
  const fg = palette.foreground;
  const n = (v: number) => +v.toFixed(2);
  const parts = [
    `<text x="${n(L.cx + L.titleTracking / 2)}" y="${n(L.titleBaseline)}" text-anchor="middle" font-family="sans-serif" font-weight="${POSTER_TITLE_FONT_WEIGHT}" font-size="${n(L.titleSize)}" letter-spacing="${n(L.titleTracking)}" fill="${fg}" opacity="${POSTER_TITLE_OPACITY}">${escapeXml(label.toUpperCase())}</text>`,
    `<rect x="${n(L.cx - L.ruleHalf)}" y="${n(L.ruleY - L.ruleThickness / 2)}" width="${n(L.ruleHalf * 2)}" height="${n(L.ruleThickness)}" fill="${fg}" opacity="${POSTER_RULE_OPACITY}"/>`,
  ];
  if (meta) {
    parts.push(
      `<text x="${n(L.cx + L.subTracking / 2)}" y="${n(L.subBaseline)}" text-anchor="middle" font-family="sans-serif" font-size="${n(L.subSize)}" letter-spacing="${n(L.subTracking)}" fill="${fg}" opacity="${POSTER_META_OPACITY}">${escapeXml(posterMetaLine(meta))}</text>`,
    );
  }
  return `\n  ${parts.join("\n  ")}`;
}

/**
 * Serializes a scene to SVG. Geometry is always emitted in logical (preview)
 * coordinates via the viewBox; pass `exportSize` to set the rendered pixel
 * size — the vector content scales cleanly, so a 3000px SVG export is the
 * preview composition exactly, just sharper. Because filter effects (glow,
 * grain turbulence) are defined in viewBox user units, they scale with the
 * artwork automatically and need no per-scale correction.
 *
 * In transparent mode, background-role occlusion shapes are OMITTED: SVG has
 * no equivalent of canvas `destination-out` without per-stroke nested masks,
 * so strokes that the canvas export would erase remain visible here. This is
 * a documented vector-export limitation.
 */
export function sceneToSvg(
  scene: Scene,
  params: StyleParams,
  palette: Palette,
  width: number,
  height: number,
  transparent = false,
  masks?: FeatureMasks,
  exportSize?: { width: number; height: number },
): string {
  const hasGlow = scene.strokes.some((s) => s.glow);
  const paths = scene.strokes
    .filter((s) => s.points.length > 0)
    .filter((s) => !(transparent && s.role === "background"))
    .map((stroke) => {
      const color = strokeColor(stroke, palette);
      const d = strokeToPath(stroke);
      const opacity = stroke.opacity !== undefined && stroke.opacity !== 1 ? ` opacity="${stroke.opacity.toFixed(3)}"` : "";
      const glow = stroke.glow ? ` filter="url(#glow)"` : "";
      if (stroke.fill) {
        return `<path d="${d}" fill="${color}" stroke="none"${opacity}${glow}/>`;
      }
      const w = stroke.width ?? params.lineWidth;
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"${opacity}${glow}/>`;
    })
    .join("\n    ");

  const defs: string[] = [];
  if (hasGlow) {
    defs.push('<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>');
  }
  if (params.grain > 0) {
    const turbScale = 0.6 + params.grain * 1.5;
    const opacity = (params.grain * 0.35).toFixed(2);
    defs.push(`<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${turbScale.toFixed(3)}" numOctaves="2" seed="${hashSeed(params.seed + ":grain") % 1000}" result="noise"/><feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 ${opacity} 0"/></filter>`);
  }
  const defsXml = defs.length > 0 ? `<defs>${defs.join("")}</defs>\n  ` : "";

  const rotation = params.rotation !== 0
    ? ` transform="rotate(${params.rotation} ${width / 2} ${height / 2})"`
    : "";

  const fontSize = Math.max(12, Math.round(width / 36));
  const label = params.label
    ? params.labelStyle === "poster"
      ? posterTitleSvg(params.label, palette, width, height, masks?.meta)
      : `\n  <text x="16" y="${height - 16}" font-size="${fontSize}" font-family="sans-serif" fill="${palette.foreground}" opacity="0.6">${escapeXml(params.label)}</text>`
    : "";

  const grainRect = params.grain > 0
    ? `\n  <rect width="${width}" height="${height}" filter="url(#grain)" opacity="0.5"/>`
    : "";

  const bgRect = transparent
    ? ""
    : `\n  <rect width="${width}" height="${height}" fill="${palette.background}"/>`;

  // Water underlay as an embedded PNG image; lives inside the rotated group
  // so water stays aligned with the rotated strokes.
  let waterImg = "";
  if (masks) {
    const waterPng = waterMaskToPng(masks, palette);
    if (waterPng) {
      waterImg = `\n    <image width="${width}" height="${height}" href="data:image/png;base64,${waterPng}"/>`;
    }
  }

  const outW = exportSize?.width ?? width;
  const outH = exportSize?.height ?? height;
  // Export dims are rounded independently per axis, so allow the hairline
  // non-uniform stretch instead of letterboxing (matches the canvas path).
  const preserve = exportSize ? ' preserveAspectRatio="none"' : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${width} ${height}"${preserve}>
  ${defsXml}${bgRect}
  <g${rotation}>${waterImg}
    ${paths}
  </g>${label}${grainRect}
</svg>`;
}
