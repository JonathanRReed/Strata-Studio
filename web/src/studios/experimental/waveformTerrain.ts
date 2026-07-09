import type { ArtStyle, ArtworkInput, StyleParams, ControlKey } from "../../engine/types.ts";
import type { Scene, Stroke } from "../../engine/scene.ts";
import { createNoise } from "../../engine/noise.ts";
import { clamp } from "../../engine/grid.ts";
import {
  elevationSampler,
  applyFeatureInfluence,
  glowRuns,
  occlusionFill,
} from "../common.ts";

const NOISE_SCALE = 4.0;
const MAX_ROWS = 500;

export type WaveformRow = {
  baseY: number;
  segments: { x: number; y: number; glow: boolean }[][];
};

export function generateRows(input: ArtworkInput, params: StyleParams): WaveformRow[] {
  const { width, height, masks } = input;
  const sample = elevationSampler(input);

  const noise = createNoise(params.seed, 4, 0.5);
  const noiseStrength = params.noise * params.amplitude;

  const rowStep = params.spacing / clamp(params.compression, 0.5, 5);
  const xStep = Math.max(1, Math.round((1.1 - clamp(params.detail, 0.1, 1)) * 10));

  const rows: WaveformRow[] = [];
  let rowCount = 0;

  for (let baseY = 0; baseY < height && rowCount < MAX_ROWS; baseY += rowStep, rowCount++) {
    const v = baseY / (height - 1 || 1);
    const segments: { x: number; y: number; glow: boolean }[][] = [];
    let currentSegment: { x: number; y: number; glow: boolean }[] = [];

    for (let x = 0; x < width; x += xStep) {
      const u = x / (width - 1 || 1);
      const elevation = sample(u, v);
      const n = noise(u * NOISE_SCALE, v * NOISE_SCALE);
      const displacement = -params.amplitude * elevation + noiseStrength * n;
      const result = applyFeatureInfluence(displacement, u, v, masks, params);

      if (result.break_) {
        if (currentSegment.length > 0) {
          segments.push(currentSegment);
          currentSegment = [];
        }
        continue;
      }

      currentSegment.push({ x, y: baseY + result.displacement, glow: result.glow });
    }

    if (currentSegment.length > 0) {
      segments.push(currentSegment);
    }

    rows.push({ baseY, segments });
  }

  return rows;
}

export function rowsToScene(
  rows: WaveformRow[],
  params: StyleParams,
  height: number,
): Scene {
  const strokes: Stroke[] = [];
  const occlude = params.occlusion > 0;

  for (const row of rows) {
    for (const segment of row.segments) {
      if (segment.length < 2) continue;
      if (occlude) {
        strokes.push({
          ...occlusionFill(segment, height),
          opacity: clamp(params.occlusion, 0, 1),
        });
      }
      strokes.push({ points: segment, role: "foreground" });
      for (const run of glowRuns(segment)) {
        strokes.push({ points: run, role: "accent", glow: true });
      }
    }
  }

  return { strokes };
}

export const waveformTerrain: ArtStyle = {
  id: "waveform-terrain",
  name: "Waveform Terrain",
  studio: "experimental",
  description: "Horizontal terrain slices displaced by elevation, like a topographic pulse record.",
  defaultParams: {
    amplitude: 45,
    spacing: 6,
    lineWidth: 1.2,
    noise: 0.1,
    occlusion: 1,
  },
  controls: [
    "amplitude", "spacing", "lineWidth", "noise", "detail", "compression",
    "occlusion", "grain", "rotation", "label", "aspectRatio", "seed", "palette",
    "buildingInfluence", "roadInfluence", "waterInfluence",
  ] as ControlKey[],
  generate: (input, params) => rowsToScene(generateRows(input, params), params, input.height),
};
