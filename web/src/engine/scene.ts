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

/*
 * The poster is set in the same two faces as the app chrome, on a real
 * contrast axis: a grotesque display for the place name, a monospace for the
 * coordinate readout. The previous generic `sans-serif` made the exported
 * artwork the least typographically considered surface in the product, and a
 * mono coordinate line is what a survey document would actually use.
 *
 * Both stacks keep full fallbacks: if the webfont has not loaded, the poster
 * still sets rather than failing (see ensurePosterFonts in posterFonts.ts,
 * which exports await before rasterizing).
 */
export const POSTER_TITLE_FAMILY = '"Archivo Variable", system-ui, sans-serif';
export const POSTER_META_FAMILY =
  '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/** Fraction of the poster width the title aims to occupy (optical measure). */
const POSTER_TITLE_MEASURE = 0.58;
/** Hard ceiling for any single title line. */
const POSTER_TITLE_MAX_MEASURE = 0.88;
/** Optical sizing bounds, as multiples of the nominal titleSize. */
const POSTER_TITLE_MIN_SCALE = 0.8;
const POSTER_TITLE_MAX_SCALE = 1.55;

export type FittedLabelText = {
  fontSize: number;
  tracking: number;
  estimatedWidth: number;
};

function glyphWidthEm(character: string): number {
  if (/\s/u.test(character)) return 0.38;
  if (/[MW@#%&]/u.test(character)) return 1;
  if (/[Iil1|!.,:'`]/u.test(character)) return 0.4;
  if (/[A-Z0-9]/u.test(character)) return 0.75;
  if (/[a-z]/u.test(character)) return 0.68;
  // Emoji/CJK/unknown glyphs are conservatively treated as full-em.
  return 1;
}

/**
 * Deterministic label fitting shared by Canvas and SVG. The conservative
 * glyph-width model avoids relying on browser-only SVG measurement while still
 * guaranteeing both renderers choose the same font size and tracking.
 */
export function fitLabelText(
  text: string,
  targetFontSize: number,
  trackingRatio: number,
  maxWidth: number,
): FittedLabelText {
  const characters = [...text];
  const emWidth = characters.reduce((sum, character) => sum + glyphWidthEm(character), 0);
  const trackedEm = emWidth + Math.max(0, characters.length - 1) * trackingRatio;
  const targetWidth = trackedEm * targetFontSize;
  const scale = targetWidth > maxWidth && targetWidth > 0 ? maxWidth / targetWidth : 1;
  const fontSize = Math.max(1, targetFontSize * scale);
  return {
    fontSize,
    tracking: fontSize * trackingRatio,
    estimatedWidth: trackedEm * fontSize,
  };
}

/**
 * Tracking tapers as the title lengthens. A fixed 0.28em is a poster
 * convention for short names but turns a long place name into a smear, and it
 * was previously applied to every label regardless of length. Short names get
 * the widest track (they need the air, and they are optically scaled up to
 * fill the measure); long names tighten toward normal so the line stays a
 * word rather than a row of letters.
 */
export function posterTitleTrackingRatio(characterCount: number): number {
  if (characterCount <= 6) return 0.3;
  if (characterCount <= 12) return 0.24;
  if (characterCount <= 18) return 0.18;
  if (characterCount <= 26) return 0.13;
  return 0.09;
}

/**
 * Splits an over-long title across at most two lines on a word boundary,
 * choosing the break that most evenly balances the two lines. Previously a
 * long place name was shrunk by fitLabelText until it fit on one line, which
 * drove it toward illegibility; wrapping keeps the type at a readable size.
 * Single-word labels are never split — they fall back to optical shrinking.
 */
export function wrapPosterTitle(text: string, maxLines = 2): string[] {
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length < 2 || maxLines < 2) return [text];

  let bestSplit = 1;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let split = 1; split < words.length; split++) {
    const head = words.slice(0, split).join(" ").length;
    const tail = words.slice(split).join(" ").length;
    const delta = Math.abs(head - tail);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestSplit = split;
    }
  }
  return [words.slice(0, bestSplit).join(" "), words.slice(bestSplit).join(" ")];
}

export type PosterTitleLine = {
  text: string;
  fontSize: number;
  tracking: number;
  baseline: number;
};

export type PosterComposition = {
  cx: number;
  titleLines: PosterTitleLine[];
  rule: { x: number; y: number; width: number; height: number };
  meta: { text: string; fontSize: number; tracking: number; baseline: number } | null;
  /** Top edge of the legibility scrim behind the lockup. */
  scrimTop: number;
  scrimHeight: number;
};

/**
 * Resolves the complete poster lockup: optically-sized title lines, the rule,
 * the coordinate readout, and the legibility scrim behind them. Canvas and SVG
 * both consume this one function, so parity is structural rather than two
 * parallel implementations that must be kept in step by hand.
 *
 * Optical sizing is the key move: rather than a fixed font size, the title is
 * scaled so its tracked width lands on POSTER_TITLE_MEASURE. A three-letter
 * name and a fifteen-letter name therefore occupy the same optical measure,
 * which is what makes a set of these posters read as a series.
 */
export function composePosterTitle(
  label: string,
  width: number,
  height: number,
  meta?: ArtworkMeta,
): PosterComposition {
  const L = posterLayout(width, height);
  const upper = label.toUpperCase();
  const maxWidth = width * POSTER_TITLE_MAX_MEASURE;

  // Try one line; wrap only when a single line cannot hold its size.
  const singleRatio = posterTitleTrackingRatio([...upper].length);
  const single = fitOpticalTitle(upper, L.titleSize, singleRatio, width, maxWidth);
  let lineTexts = [upper];
  if (single.clipped) {
    const wrapped = wrapPosterTitle(upper);
    if (wrapped.length > 1) lineTexts = wrapped;
  }

  const fitted = lineTexts.map((text) => {
    const ratio = posterTitleTrackingRatio([...text].length);
    return fitOpticalTitle(text, L.titleSize, ratio, width, maxWidth);
  });
  // A wrapped title uses one shared size (the smallest that fits every line)
  // so the two lines read as one lockup rather than two unrelated headings.
  const sharedSize = Math.min(...fitted.map((f) => f.fontSize));

  const lineHeight = sharedSize * 1.16;
  const lastTitleBaseline = L.ruleY - sharedSize * 0.92;
  const titleLines: PosterTitleLine[] = lineTexts.map((text, index) => {
    const ratio = posterTitleTrackingRatio([...text].length);
    const offset = (lineTexts.length - 1 - index) * lineHeight;
    return {
      text,
      fontSize: sharedSize,
      tracking: sharedSize * ratio,
      baseline: lastTitleBaseline - offset,
    };
  });

  const metaBlock = meta
    ? (() => {
        const text = posterMetaLine(meta);
        const fit = fitLabelText(text, L.subSize, 0.12, maxWidth);
        return {
          text,
          fontSize: fit.fontSize,
          tracking: fit.tracking,
          baseline: L.subBaseline,
        };
      })()
    : null;

  // The scrim starts a full line-height above the topmost title so the ramp is
  // never visible as an edge, and runs to the bottom of the frame.
  const scrimTop = Math.max(0, titleLines[0].baseline - sharedSize * 2.1);
  return {
    cx: L.cx,
    titleLines,
    rule: {
      x: L.cx - L.ruleHalf,
      y: L.ruleY - L.ruleThickness / 2,
      width: L.ruleHalf * 2,
      height: L.ruleThickness,
    },
    meta: metaBlock,
    scrimTop,
    scrimHeight: height - scrimTop,
  };
}

/**
 * Scales a title toward the target optical measure, clamped so it never grows
 * absurd or shrinks to illegibility. `clipped` reports that even the minimum
 * size overruns the hard maximum, which is the caller's signal to wrap.
 */
function fitOpticalTitle(
  text: string,
  nominalSize: number,
  trackingRatio: number,
  width: number,
  maxWidth: number,
): { fontSize: number; tracking: number; clipped: boolean } {
  const target = width * POSTER_TITLE_MEASURE;
  const probe = fitLabelText(text, nominalSize, trackingRatio, Number.POSITIVE_INFINITY);
  const naturalWidth = probe.estimatedWidth;
  const desired = naturalWidth > 0 ? (target / naturalWidth) * nominalSize : nominalSize;
  const bounded = Math.min(
    nominalSize * POSTER_TITLE_MAX_SCALE,
    Math.max(nominalSize * POSTER_TITLE_MIN_SCALE, desired),
  );
  const atBounded = fitLabelText(text, bounded, trackingRatio, Number.POSITIVE_INFINITY);
  if (atBounded.estimatedWidth <= maxWidth) {
    return { fontSize: bounded, tracking: bounded * trackingRatio, clipped: false };
  }
  // Overruns the hard max: shrink to fit and report it so the caller can wrap.
  const shrunk = fitLabelText(text, bounded, trackingRatio, maxWidth);
  return {
    fontSize: shrunk.fontSize,
    tracking: shrunk.tracking,
    clipped: shrunk.fontSize < nominalSize * POSTER_TITLE_MIN_SCALE,
  };
}

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
 * The poster title block: optically-sized letterspaced-caps label, a thin
 * rule, and the coordinates/elevation meta line (when ArtworkMeta is
 * available). Drawn in logical coordinates under the render transform, so
 * exports scale it exactly like the artwork. A legibility scrim is laid down
 * behind the lockup so the type stays readable over dense terrain.
 *
 * Geometry comes from composePosterTitle, which the SVG renderer also calls,
 * so the two outputs share one layout rather than two parallel
 * implementations.
 */
function drawPosterTitleBlock(
  ctx: CanvasRenderingContext2D,
  label: string,
  palette: Palette,
  width: number,
  height: number,
  meta?: ArtworkMeta,
): void {
  const C = composePosterTitle(label, width, height, meta);
  ctx.fillStyle = palette.foreground;

  // Legibility scrim: a soft ramp from transparent at the top to the
  // background color toward the bottom, so the lockup reads over any terrain
  // density without a hard card edge.
  const bgRgb = hexToRgb(palette.background);
  const scrim = ctx.createLinearGradient(0, C.scrimTop, 0, height);
  scrim.addColorStop(0, `rgba(${bgRgb[0]},${bgRgb[1]},${bgRgb[2]},0)`);
  scrim.addColorStop(1, `rgba(${bgRgb[0]},${bgRgb[1]},${bgRgb[2]},0.72)`);
  ctx.globalAlpha = 1;
  ctx.fillStyle = scrim;
  ctx.fillRect(0, C.scrimTop, width, C.scrimHeight);

  ctx.fillStyle = palette.foreground;
  ctx.globalAlpha = POSTER_TITLE_OPACITY;
  for (const line of C.titleLines) {
    ctx.font = `${POSTER_TITLE_FONT_WEIGHT} ${line.fontSize}px ${POSTER_TITLE_FAMILY}`;
    fillTextTracked(ctx, line.text, C.cx, line.baseline, line.tracking);
  }

  ctx.globalAlpha = POSTER_RULE_OPACITY;
  ctx.fillRect(C.rule.x, C.rule.y, C.rule.width, C.rule.height);

  if (C.meta) {
    ctx.globalAlpha = POSTER_META_OPACITY;
    ctx.font = `${C.meta.fontSize}px ${POSTER_META_FAMILY}`;
    fillTextTracked(ctx, C.meta.text, C.cx, C.meta.baseline, C.meta.tracking);
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
    // Background-role strokes are occlusion shapes (they hide strokes behind
    // them). On a transparent export, painting them in the palette background
    // would leave opaque blobs — erase to transparency instead.
    const erase = transparent && stroke.role === "background";
    ctx.globalAlpha = stroke.opacity ?? 1;
    const color = strokeColor(stroke, palette);

    // Glow strokes get a two-pass treatment: a wide soft halo (large
    // shadowBlur, reduced alpha) lays down the bloom, then the crisp stroke
    // paints on top at full alpha. This reads as luminous emission rather
    // than a flat shadow ring, and the halo's lower alpha prevents it from
    // washing out adjacent strokes.
    if (stroke.glow && !erase) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 14 * renderScale;
      ctx.globalAlpha = (stroke.opacity ?? 1) * 0.45;
      ctx.strokeStyle = color;
      ctx.lineWidth = (stroke.width ?? params.lineWidth) * 1.4;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      if (stroke.closed) ctx.closePath();
      ctx.stroke();
      // Reset for the crisp pass.
      ctx.shadowBlur = 5 * renderScale;
      ctx.globalAlpha = stroke.opacity ?? 1;
      ctx.lineWidth = stroke.width ?? params.lineWidth;
    } else {
      ctx.shadowBlur = stroke.glow ? 5 * renderScale : 0;
    }

    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    if (stroke.closed) ctx.closePath();

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
      const fitted = fitLabelText(
        params.label,
        Math.max(12, Math.round(width / 36)),
        0,
        Math.max(1, width - 32),
      );
      ctx.font = `${fitted.fontSize}px sans-serif`;
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
  // instead of an upscaled, blurry tile. A smaller tile (96 vs 128) gives
  // finer, more film-like grain rather than coarse digital noise.
  const tileSize = 96;
  const deviceTile = Math.max(1, Math.round(tileSize * scale));
  const noiseCanvas = document.createElement("canvas");
  noiseCanvas.width = deviceTile;
  noiseCanvas.height = deviceTile;
  const noiseCtx = noiseCanvas.getContext("2d");
  if (!noiseCtx) return;
  const imageData = noiseCtx.createImageData(deviceTile, deviceTile);
  const data = imageData.data;
  // Two-octave noise: a coarse base + a fine high-frequency layer, so the
  // grain has texture rather than being uniform static. The fine layer is
  // weighted lower so it reads as sparkle, not interference.
  for (let i = 0; i < data.length; i += 4) {
    const coarse = (rng() - 0.5) * params.grain * 50;
    const fine = (rng() - 0.5) * params.grain * 30;
    const n = coarse + fine * 0.4;
    data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, 128 + n));
    // Alpha tapers with grain intensity; the soft cap keeps it from
    // overwhelming the artwork at high settings.
    data[i + 3] = Math.round(Math.min(100, params.grain * 75));
  }
  noiseCtx.putImageData(imageData, 0, 0);
  const prev = ctx.globalCompositeOperation;
  // "soft-light" is gentler than "overlay" — it reads as photographic grain
  // rather than a contrast filter, preserving midtones better.
  ctx.globalCompositeOperation = "soft-light";
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
 * SVG twin of drawPosterTitleBlock: identical layout math
 * (composePosterTitle), letter-spacing attributes for the tracking, and the
 * same trailing-space centering compensation (+tracking/2 with
 * text-anchor="middle"). The legibility scrim is a linearGradient rect.
 */
function posterTitleSvg(
  label: string,
  palette: Palette,
  width: number,
  height: number,
  meta?: ArtworkMeta,
): string {
  const C = composePosterTitle(label, width, height, meta);
  const fg = palette.foreground;
  const n = (v: number) => +v.toFixed(2);
  const bgRgb = hexToRgb(palette.background);
  const scrimId = "strata-poster-scrim";
  const scrim = `<defs><linearGradient id="${scrimId}" x1="0" y1="${n(C.scrimTop)}" x2="0" y2="${n(height)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="rgb(${bgRgb[0]},${bgRgb[1]},${bgRgb[2]})" stop-opacity="0"/><stop offset="1" stop-color="rgb(${bgRgb[0]},${bgRgb[1]},${bgRgb[2]})" stop-opacity="0.72"/></linearGradient></defs>`;
  const scrimRect = `<rect x="0" y="${n(C.scrimTop)}" width="${n(width)}" height="${n(C.scrimHeight)}" fill="url(#${scrimId})"/>`;
  const parts = [scrim, scrimRect];
  for (const line of C.titleLines) {
    parts.push(
      `<text x="${n(C.cx + line.tracking / 2)}" y="${n(line.baseline)}" text-anchor="middle" font-family='${POSTER_TITLE_FAMILY}' font-weight="${POSTER_TITLE_FONT_WEIGHT}" font-size="${n(line.fontSize)}" letter-spacing="${n(line.tracking)}" fill="${fg}" opacity="${POSTER_TITLE_OPACITY}">${escapeXml(line.text)}</text>`,
    );
  }
  parts.push(
    `<rect x="${n(C.rule.x)}" y="${n(C.rule.y)}" width="${n(C.rule.width)}" height="${n(C.rule.height)}" fill="${fg}" opacity="${POSTER_RULE_OPACITY}"/>`,
  );
  if (C.meta) {
    parts.push(
      `<text x="${n(C.cx + C.meta.tracking / 2)}" y="${n(C.meta.baseline)}" text-anchor="middle" font-family='${POSTER_META_FAMILY}' font-size="${n(C.meta.fontSize)}" letter-spacing="${n(C.meta.tracking)}" fill="${fg}" opacity="${POSTER_META_OPACITY}">${escapeXml(C.meta.text)}</text>`,
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
    // Two-stage blur: a wide halo (stdDeviation 5) merged under a tighter
    // bloom (stdDeviation 2), then the source on top — mirrors the canvas
    // two-pass glow so SVG exports have the same luminous quality.
    defs.push('<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="halo"/><feGaussianBlur in="SourceGraphic" stdDeviation="2" result="bloom"/><feMerge><feMergeNode in="halo"/><feMergeNode in="bloom"/><feMergeNode in="SourceGraphic"/></feMerge></filter>');
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

  const plainLabelFit = fitLabelText(
    params.label,
    Math.max(12, Math.round(width / 36)),
    0,
    Math.max(1, width - 32),
  );
  const label = params.label
    ? params.labelStyle === "poster"
      ? posterTitleSvg(params.label, palette, width, height, masks?.meta)
      : `\n  <text x="16" y="${height - 16}" font-size="${+plainLabelFit.fontSize.toFixed(2)}" font-family="sans-serif" fill="${palette.foreground}" opacity="0.6">${escapeXml(params.label)}</text>`
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
