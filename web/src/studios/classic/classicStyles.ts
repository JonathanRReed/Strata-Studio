import type { ArtStyle, ArtworkInput, StyleParams, ControlKey } from "../../engine/types.ts";
import type { ScenePoint, Stroke } from "../../engine/scene.ts";
import { createNoise } from "../../engine/noise.ts";
import { clamp } from "../../engine/grid.ts";
import { marchingSquares, smoothLine } from "../../engine/contours.ts";
import {
  elevationSampler,
  elevationGradient,
  featureLines,
  densify,
  createRng,
} from "../common.ts";
import { generateRows, rowsToScene } from "../experimental/waveformTerrain.ts";

function contourLines(
  input: ArtworkInput,
  params: StyleParams,
  levels: number,
  smooth = 2,
): ScenePoint[][][] {
  const { width, height } = input;
  const sample = elevationSampler(input);
  const n = Math.round(48 + clamp(params.detail, 0.1, 1) * 96);
  const lattice = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      lattice[y * n + x] = sample(x / (n - 1), y / (n - 1));
    }
  }
  const field = (ix: number, iy: number) => lattice[iy * n + ix];

  const perLevel: ScenePoint[][][] = [];
  for (let l = 1; l <= levels; l++) {
    const level = l / (levels + 1);
    const lines = marchingSquares(field, n, level).map((line) =>
      smoothLine(line, smooth).map((p) => ({
        x: (p.x / (n - 1)) * width,
        y: (p.y / (n - 1)) * height,
      })),
    );
    perLevel.push(lines);
  }
  return perLevel;
}

const classicControls: ControlKey[] = ["spacing", "lineWidth", "detail", "grain", "rotation", "label", "aspectRatio", "seed", "palette"];

export const contour: ArtStyle = {
  id: "contour",
  name: "Contour",
  studio: "classic",
  description: "Traditional topographic contour lines with clean spacing and elevation bands.",
  defaultParams: { spacing: 10, lineWidth: 1.2, detail: 0.8, noise: 0, occlusion: 0 },
  controls: classicControls,
  generate: (input, params) => {
    const levels = Math.round(clamp(160 / params.spacing, 6, 48));
    const strokes: Stroke[] = [];
    const perLevel = contourLines(input, params, levels);
    perLevel.forEach((lines, i) => {
      const isIndex = (i + 1) % 5 === 0;
      for (const points of lines) {
        strokes.push({
          points,
          role: "foreground",
          width: isIndex ? params.lineWidth * 1.8 : params.lineWidth,
          opacity: isIndex ? 1 : 0.75,
        });
      }
    });
    return { strokes };
  },
};

export const ridge: ArtStyle = {
  id: "ridge",
  name: "Ridge",
  studio: "classic",
  description: "Dense ridge-line terrain with occluded horizontal relief lines.",
  defaultParams: { amplitude: 55, spacing: 4, lineWidth: 1, noise: 0, occlusion: 1 },
  controls: [...classicControls, "amplitude", "occlusion"],
  generate: (input, params) => rowsToScene(generateRows(input, params), params, input.height),
};

export const flow: ArtStyle = {
  id: "flow",
  name: "Flow",
  studio: "classic",
  description: "Terrain and streets bent into smooth flow-field paths.",
  defaultParams: { amplitude: 50, spacing: 12, lineWidth: 1, noise: 0.3, detail: 0.7, occlusion: 0 },
  controls: [...classicControls, "amplitude", "noise"],
  generate: (input, params) => {
    const { width, height } = input;
    const sample = elevationSampler(input);
    const noise = createNoise(params.seed + ":flow", 3, 0.5);
    const rng = createRng(params.seed + ":flowseeds");
    const strokes: Stroke[] = [];

    const gridN = Math.round(clamp(500 / params.spacing, 10, 50));
    const stepLen = 3;
    const steps = Math.round(40 + params.amplitude);

    for (let gy = 0; gy < gridN; gy++) {
      for (let gx = 0; gx < gridN; gx++) {
        let x = ((gx + rng()) / gridN) * width;
        let y = ((gy + rng()) / gridN) * height;
        const points: ScenePoint[] = [{ x, y }];
        for (let s = 0; s < steps; s++) {
          const u = clamp(x / (width - 1 || 1), 0, 1);
          const v = clamp(y / (height - 1 || 1), 0, 1);
          const grad = elevationGradient(sample, u, v, 0.02);
          const baseAngle = Math.atan2(grad.dx, -grad.dy);
          const angle = baseAngle + noise(u * 4, v * 4) * Math.PI * (0.3 + params.noise);
          x += Math.cos(angle) * stepLen;
          y += Math.sin(angle) * stepLen;
          if (x < 0 || x > width || y < 0 || y > height) break;
          points.push({ x, y });
        }
        if (points.length > 6) {
          strokes.push({ points, role: "foreground", opacity: 0.85 });
        }
      }
    }

    // Streets and rivers as emphasized flow paths when available.
    for (const line of featureLines(input.features, input.bounds, width, height)) {
      if (line.strataType === "building") continue;
      strokes.push({
        points: densify(line.points, 6),
        role: line.strataType === "water" ? "accent" : "foreground",
        width: params.lineWidth * 1.5,
      });
    }
    return { strokes };
  },
};

export const blueprint: ArtStyle = {
  id: "blueprint",
  name: "Blueprint",
  studio: "classic",
  description: "Thin cyan technical drawing with grid overlays and register marks.",
  defaultParams: { spacing: 12, lineWidth: 0.8, detail: 0.8, noise: 0, palette: "blueprint", occlusion: 0 },
  controls: classicControls,
  generate: (input, params) => {
    const { width, height } = input;
    const strokes: Stroke[] = [];

    // Grid overlay
    const gridStep = Math.max(16, params.spacing * 4);
    for (let x = 0; x <= width; x += gridStep) {
      strokes.push({
        points: [{ x, y: 0 }, { x, y: height }],
        role: "foreground",
        width: 0.4,
        opacity: 0.25,
      });
    }
    for (let y = 0; y <= height; y += gridStep) {
      strokes.push({
        points: [{ x: 0, y }, { x: width, y }],
        role: "foreground",
        width: 0.4,
        opacity: 0.25,
      });
    }

    // Contours
    const levels = Math.round(clamp(80 / params.spacing, 5, 30));
    for (const lines of contourLines(input, params, levels)) {
      for (const points of lines) {
        strokes.push({ points, role: "foreground", width: params.lineWidth });
      }
    }

    // Roads / water in accent
    for (const line of featureLines(input.features, input.bounds, width, height)) {
      if (line.strataType === "building") {
        strokes.push({ points: line.points, role: "accent", width: 0.7, closed: line.closed, opacity: 0.9 });
      } else {
        strokes.push({ points: line.points, role: "foreground", width: params.lineWidth, opacity: 0.8 });
      }
    }

    // Register crosshair marks
    const m = 14;
    for (const [cx, cy] of [[m, m], [width - m, m], [m, height - m], [width - m, height - m]] as const) {
      strokes.push({ points: [{ x: cx - 6, y: cy }, { x: cx + 6, y: cy }], role: "accent", width: 0.8 });
      strokes.push({ points: [{ x: cx, y: cy - 6 }, { x: cx, y: cy + 6 }], role: "accent", width: 0.8 });
    }
    // Border
    strokes.push({
      points: [
        { x: 4, y: 4 },
        { x: width - 4, y: 4 },
        { x: width - 4, y: height - 4 },
        { x: 4, y: height - 4 },
      ],
      role: "foreground",
      width: 1,
      closed: true,
    });

    return { strokes };
  },
};

export const woodcut: ArtStyle = {
  id: "woodcut",
  name: "Woodcut",
  studio: "classic",
  description: "Rough carved linework with grain, imperfections, and hatch shading.",
  defaultParams: { amplitude: 30, spacing: 5, lineWidth: 1.6, noise: 0.4, grain: 0.35, palette: "cream", occlusion: 0 },
  controls: [...classicControls, "amplitude", "noise"],
  generate: (input, params) => {
    const { width, height } = input;
    const sample = elevationSampler(input);
    const rough = createNoise(params.seed + ":woodcut", 4, 0.6);
    const strokes: Stroke[] = [];

    const rowStep = Math.max(2, params.spacing);
    const xStep = Math.max(2, Math.round((1.1 - clamp(params.detail, 0.1, 1)) * 10) + 1);

    let flip = false;
    for (let baseY = 0; baseY < height; baseY += rowStep) {
      flip = !flip;
      const v = baseY / (height - 1 || 1);
      let segment: ScenePoint[] = [];
      let segElev = 0;
      const flush = () => {
        if (segment.length > 1) {
          strokes.push({
            points: segment,
            role: "foreground",
            width: params.lineWidth * (0.5 + segElev * 1.2),
          });
        }
        segment = [];
        segElev = 0;
      };
      for (let x = 0; x < width; x += xStep) {
        const u = x / (width - 1 || 1);
        const elev = sample(u, v);
        const jag = rough(u * 20, v * 20);
        // Carve gaps in low-elevation areas for the hatched-band look.
        const cut = (jag * 0.5 + 0.5) * (1 - elev);
        if (cut > 0.62) {
          flush();
          continue;
        }
        const wobble = rough(u * 8 + (flip ? 40 : 0), v * 8) * params.noise * rowStep * 0.9;
        segment.push({ x, y: baseY + wobble - elev * params.amplitude * 0.25 });
        segElev = Math.max(segElev, elev);
      }
      flush();
    }
    return { strokes };
  },
};

export const drift: ArtStyle = {
  id: "drift",
  name: "Drift",
  studio: "classic",
  description: "Roads and boundaries offset into dreamy layered motion trails.",
  defaultParams: { amplitude: 25, spacing: 8, lineWidth: 1.2, noise: 0.25, occlusion: 0 },
  controls: [...classicControls, "amplitude", "noise"],
  generate: (input, params) => {
    const { width, height } = input;
    const strokes: Stroke[] = [];
    const noise = createNoise(params.seed + ":drift", 3, 0.5);
    const echoes = Math.round(clamp(params.amplitude / 8, 2, 8));

    const lines = featureLines(input.features, input.bounds, width, height);
    const source: { points: ScenePoint[]; role: "foreground" | "accent" }[] = [];

    if (lines.length > 0) {
      for (const line of lines) {
        if (line.strataType === "building") continue;
        source.push({
          points: densify(line.points, 8),
          role: line.strataType === "water" ? "accent" : "foreground",
        });
      }
    }
    if (source.length === 0) {
      // No feature data: drift the terrain contours instead.
      const levels = Math.round(clamp(70 / params.spacing, 4, 24));
      for (const perLevel of contourLines(input, params, levels)) {
        for (const points of perLevel) {
          source.push({ points, role: "foreground" });
        }
      }
    }

    for (const line of source) {
      for (let e = 0; e < echoes; e++) {
        const t = e / Math.max(1, echoes - 1);
        const offset = e * params.spacing * 0.6;
        const opacity = 1 - t * 0.82;
        const points = line.points.map((p, i) => {
          const wob = noise(p.x * 0.01 + e * 3, p.y * 0.01 + i * 0.001) * params.noise * 20;
          return { x: p.x + offset + wob, y: p.y + offset * 0.5 + wob * 0.5 };
        });
        strokes.push({
          points,
          role: line.role,
          width: params.lineWidth * (1 - t * 0.5),
          opacity,
        });
      }
    }
    return { strokes };
  },
};

export const signal: ArtStyle = {
  id: "signal",
  name: "Signal",
  studio: "classic",
  description: "Street grids rendered like circuit traces and radio paths.",
  defaultParams: { spacing: 8, lineWidth: 1.1, detail: 0.8, noise: 0, occlusion: 0 },
  controls: classicControls,
  generate: (input, params) => {
    const { width, height } = input;
    const strokes: Stroke[] = [];
    const lines = featureLines(input.features, input.bounds, width, height);
    const rng = createRng(params.seed + ":signal");

    const roads = lines.filter((l) => l.strataType === "road");
    if (roads.length > 0) {
      for (const road of roads) {
        strokes.push({ points: road.points, role: "foreground", width: params.lineWidth });
        // Circuit "pads" at trace endpoints.
        for (const end of [road.points[0], road.points[road.points.length - 1]]) {
          if (rng() < 0.35) {
            strokes.push(circleStroke(end, params.lineWidth * 2.2, "accent"));
          }
        }
      }
      for (const line of lines) {
        if (line.strataType === "building") {
          strokes.push({ points: line.points, role: "foreground", width: 0.6, closed: line.closed, opacity: 0.45 });
        } else if (line.strataType === "water") {
          strokes.push({ points: line.points, role: "accent", width: params.lineWidth, opacity: 0.6, closed: line.closed });
        }
      }
    } else {
      // No street data: synthesize circuit traces from terrain contours.
      const levels = Math.round(clamp(70 / params.spacing, 5, 24));
      for (const perLevel of contourLines(input, params, levels, 0)) {
        for (const points of perLevel) {
          strokes.push({ points, role: "foreground", width: params.lineWidth });
          if (rng() < 0.3 && points.length > 0) {
            strokes.push(circleStroke(points[0], params.lineWidth * 2.2, "accent"));
          }
        }
      }
    }
    return { strokes };
  },
};

function circleStroke(
  center: ScenePoint,
  radius: number,
  role: "foreground" | "accent",
): Stroke {
  const points: ScenePoint[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    points.push({ x: center.x + Math.cos(t) * radius, y: center.y + Math.sin(t) * radius });
  }
  return { points, role, width: 1, closed: true };
}

export const classicStyles: ArtStyle[] = [contour, ridge, flow, blueprint, woodcut, drift, signal];
