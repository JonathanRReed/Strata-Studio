import type { Palette, StyleParams, FeatureMasks } from "./types.ts";
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
  ctx.scale(scaleX, scaleY);
  if (!transparent) {
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }

  // Water underlay: fill water areas with the palette's water color so they're
  // visually distinct from land in all styles.
  if (masks) {
    drawWaterUnderlay(ctx, masks, palette, width, height);
  }

  ctx.save();
  if (params.rotation !== 0) {
    ctx.translate(width / 2, height / 2);
    ctx.rotate((params.rotation * Math.PI) / 180);
    ctx.translate(-width / 2, -height / 2);
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
      ctx.shadowBlur = 8;
    } else {
      ctx.shadowBlur = 0;
    }
    if (stroke.fill) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = stroke.width ?? params.lineWidth;
      ctx.stroke();
    }
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.restore(); // undo rotation; label stays unrotated

  if (params.label) {
    ctx.font = `${Math.max(12, Math.round(width / 36))}px sans-serif`;
    ctx.fillStyle = palette.foreground;
    ctx.globalAlpha = 0.6;
    ctx.textAlign = "left";
    ctx.fillText(params.label, 16, height - 16);
    ctx.globalAlpha = 1;
  }

  if (params.grain > 0) {
    applyGrain(ctx, params, width, height);
  }

  ctx.restore();
}

function applyGrain(ctx: CanvasRenderingContext2D, params: StyleParams, width: number, height: number): void {
  const rng = mulberry32(hashSeed(params.seed + ":grain"));
  const tileSize = 128;
  const noiseCanvas = document.createElement("canvas");
  noiseCanvas.width = tileSize;
  noiseCanvas.height = tileSize;
  const noiseCtx = noiseCanvas.getContext("2d");
  if (!noiseCtx) return;
  const imageData = noiseCtx.createImageData(tileSize, tileSize);
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
      ctx.drawImage(noiseCanvas, x, y);
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

export function sceneToSvg(
  scene: Scene,
  params: StyleParams,
  palette: Palette,
  width: number,
  height: number,
  transparent = false,
  masks?: FeatureMasks,
): string {
  const hasGlow = scene.strokes.some((s) => s.glow);
  const paths = scene.strokes
    .filter((s) => s.points.length > 0)
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
    ? `\n  <text x="16" y="${height - 16}" font-size="${fontSize}" font-family="sans-serif" fill="${palette.foreground}" opacity="0.6">${escapeXml(params.label)}</text>`
    : "";

  const grainRect = params.grain > 0
    ? `\n  <rect width="${width}" height="${height}" filter="url(#grain)" opacity="0.5"/>`
    : "";

  const bgRect = transparent
    ? ""
    : `\n  <rect width="${width}" height="${height}" fill="${palette.background}"/>`;

  // Water underlay as an embedded PNG image
  let waterImg = "";
  if (masks) {
    const waterPng = waterMaskToPng(masks, palette);
    if (waterPng) {
      waterImg = `\n  <image width="${width}" height="${height}" href="data:image/png;base64,${waterPng}"/>`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${defsXml}${bgRect}${waterImg}
  <g${rotation}>
    ${paths}
  </g>${label}${grainRect}
</svg>`;
}
