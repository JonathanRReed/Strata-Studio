import type { Palette, StyleParams } from "./types.ts";
import { hashSeed } from "./noise.ts";

export type ScenePoint = { x: number; y: number };

export type Stroke = {
  points: ScenePoint[];
  role?: "foreground" | "accent" | "background";
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
  if (stroke.role === "accent") return palette.accent;
  if (stroke.role === "background") return palette.background;
  return palette.foreground;
}

export function renderSceneCanvas(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  params: StyleParams,
  palette: Palette,
  width: number,
  height: number,
): void {
  // Background is drawn before any rotation so corners are always filled.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const scaleX = ctx.canvas.width / width;
  const scaleY = ctx.canvas.height / height;
  ctx.scale(scaleX, scaleY);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);

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

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${defsXml}<rect width="${width}" height="${height}" fill="${palette.background}"/>
  <g${rotation}>
    ${paths}
  </g>${label}${grainRect}
</svg>`;
}
