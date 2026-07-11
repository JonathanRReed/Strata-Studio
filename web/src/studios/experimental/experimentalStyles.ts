import type { ArtStyle, ArtworkInput, StyleParams, ControlKey } from "../../engine/types.ts";
import type { Scene, Stroke } from "../../engine/scene.ts";
import { createAnimatedNoise } from "../../engine/noise.ts";
import { clamp } from "../../engine/grid.ts";
import {
  elevationSampler,
  elevationGradient,
  findPeak,
  applyFeatureInfluence,
  glowRuns,
  createRng,
  generateRowSegments,
  rowsToScene,
  type RowPoint,
  type RowPointResult,
} from "../common.ts";
import { generateRows } from "./waveformTerrain.ts";

const expControls: ControlKey[] = [
  "amplitude", "spacing", "lineWidth", "noise", "detail", "compression",
  "occlusion", "grain", "rotation", "label", "aspectRatio", "seed", "palette",
  "buildingInfluence", "roadInfluence", "waterInfluence",
  "oceanInfluence", "lakeInfluence", "riverInfluence",
];

// Variant for styles that don't use all expControls
const expControlsNoCompressionOcclusion: ControlKey[] = expControls.filter(
  (c) => c !== "compression" && c !== "occlusion",
);

function rowLoop(
  input: ArtworkInput,
  params: StyleParams,
  pointFn: (u: number, v: number, x: number, baseY: number) => RowPointResult,
): Scene {
  return rowsToScene(
    generateRowSegments(input.width, input.height, params, pointFn),
    params,
    input.height,
  );
}

export const noiseAmplifier: ArtStyle = {
  id: "noise-amplifier",
  name: "Noise Amplifier",
  studio: "experimental",
  description: "Terrain acts as an amplitude source for signal-like waves on black.",
  defaultParams: { amplitude: 40, spacing: 7, lineWidth: 1, noise: 0.6, occlusion: 0 },
  controls: expControls,
  generate: (input, params) => {
    const sample = elevationSampler(input);
    const phase = params.phase ?? 0;
    const hf = createAnimatedNoise(params.seed, 5, 0.6);
    return rowLoop(input, params, (u, v, _x, baseY) => {
      const elev = sample(u, v);
      const signal = (phase > 0 ? hf(u * 24, v * 24, phase) : hf(u * 24, v * 24)) * (0.25 + elev);
      const displacement = -params.amplitude * signal * (0.3 + params.noise);
      const res = applyFeatureInfluence(displacement, u, v, input.masks, params);
      return { y: baseY + res.displacement, glow: res.glow, glowStrength: res.glowStrength, break_: res.break_ };
    });
  },
};

export const seismic: ArtStyle = {
  id: "seismic",
  name: "Seismic",
  studio: "experimental",
  description: "Elevation becomes earthquake-style traces; sharp relief creates violent breaks.",
  defaultParams: { amplitude: 55, spacing: 10, lineWidth: 1, noise: 0.3, occlusion: 0 },
  controls: expControls,
  generate: (input, params) => {
    const sample = elevationSampler(input);
    const phase = params.phase ?? 0;
    const jitter = createAnimatedNoise(params.seed + ":seismic", 5, 0.7);
    return rowLoop(input, params, (u, v, _x, baseY) => {
      const grad = elevationGradient(sample, u, v);
      const magnitude = Math.min(1, Math.hypot(grad.dx, grad.dy) * 0.5);
      const spike = (phase > 0 ? jitter(u * 40, v * 6, phase) : jitter(u * 40, v * 6)) * magnitude;
      const displacement =
        -params.amplitude * (sample(u, v) * 0.25 + spike) -
        params.noise * params.amplitude * (phase > 0 ? jitter(u * 90, v * 90, phase) : jitter(u * 90, v * 90)) * magnitude;
      const res = applyFeatureInfluence(displacement, u, v, input.masks, params);
      return { y: baseY + res.displacement, glow: res.glow, glowStrength: res.glowStrength, break_: res.break_ };
    });
  },
};

export const meltMap: ArtStyle = {
  id: "melt-map",
  name: "Melt Map",
  studio: "experimental",
  description: "Contour rows drip downward like heat distortion over the terrain.",
  defaultParams: { amplitude: 50, spacing: 9, lineWidth: 1.4, noise: 0.25, occlusion: 0.85 },
  controls: expControls,
  generate: (input, params) => {
    const sample = elevationSampler(input);
    const phase = params.phase ?? 0;
    const drip = createAnimatedNoise(params.seed + ":melt", 3, 0.55);
    return rowLoop(input, params, (u, v, _x, baseY) => {
      const elev = sample(u, v);
      const dripLength = Math.max(0, phase > 0 ? drip(u * 14, v * 3, phase) : drip(u * 14, v * 3)) * elev;
      const displacement =
        params.amplitude * dripLength * (1 + params.noise * 2) -
        params.amplitude * elev * 0.3;
      const res = applyFeatureInfluence(displacement, u, v, input.masks, params);
      return { y: baseY + res.displacement, glow: res.glow, glowStrength: res.glowStrength, break_: res.break_ };
    });
  },
};

export const gravityWell: ArtStyle = {
  id: "gravity-well",
  name: "Gravity Well",
  studio: "experimental",
  description: "Lines bend toward the highest peak in the selected area.",
  defaultParams: { amplitude: 60, spacing: 8, lineWidth: 1.2, noise: 0.05, occlusion: 0 },
  controls: expControls,
  generate: (input, params) => {
    const { width, masks } = input;
    const sample = elevationSampler(input);
    const peak = findPeak(input);
    const px = peak.u * width;
    const py = peak.v * input.height;
    const pull = params.amplitude / 100;
    const phase = params.phase ?? 0;
    const noise = createAnimatedNoise(params.seed + ":gravity", 3, 0.5);

    return rowLoop(input, params, (u, v, x, baseY) => {
      const dx = px - x;
      const dy = py - baseY;
      const dist = Math.hypot(dx, dy) || 1;
      const falloff = 1 / (1 + Math.pow(dist / (width * 0.35), 2));
      const w = pull * falloff * (0.5 + sample(u, v) * 0.5);
      const n = params.noise * params.amplitude * (noise(u * 6, v * 6, phase)) * 0.2;
      const res = applyFeatureInfluence(dy * w + n, u, v, masks, params);
      return {
        x: x + dx * w,
        y: baseY + res.displacement,
        glow: res.glow,
        glowStrength: res.glowStrength,
        break_: res.break_,
      };
    });
  },
};

export const magneticField: ArtStyle = {
  id: "magnetic-field",
  name: "Magnetic Field",
  studio: "experimental",
  description: "Streamlines wrap around terrain like iron filings around a magnet.",
  defaultParams: { amplitude: 50, spacing: 14, lineWidth: 1, noise: 0.2, detail: 0.8, occlusion: 0 },
  controls: expControlsNoCompressionOcclusion,
  generate: (input, params) => {
    const { width, height, masks } = input;
    const sample = elevationSampler(input);
    const phase = params.phase ?? 0;
    const noise = createAnimatedNoise(params.seed + ":field", 3, 0.5);
    const rng = createRng(params.seed + ":fieldseeds");
    const strokes: Stroke[] = [];

    const gridN = Math.round(clamp(600 / params.spacing, 12, 60));
    const stepLen = 3 + (1 - clamp(params.detail, 0.1, 1)) * 3;
    const steps = Math.round(20 + params.amplitude * 0.6);

    for (let gy = 0; gy < gridN; gy++) {
      for (let gx = 0; gx < gridN; gx++) {
        let x = ((gx + rng()) / gridN) * width;
        let y = ((gy + rng()) / gridN) * height;
        const points: RowPoint[] = [{ x, y, glow: false, glowStrength: 0 }];
        for (let s = 0; s < steps; s++) {
          const u = clamp(x / (width - 1 || 1), 0, 1);
          const v = clamp(y / (height - 1 || 1), 0, 1);
          const grad = elevationGradient(sample, u, v, 0.02);
          const angleNoise = (noise(u * 5, v * 5, phase)) * Math.PI * params.noise * 2;
          // Rotate gradient 90 degrees to follow iso-elevation lines.
          let fx = -grad.dy;
          let fy = grad.dx;
          const mag = Math.hypot(fx, fy);
          if (mag < 0.02) break;
          fx /= mag;
          fy /= mag;
          const cos = Math.cos(angleNoise);
          const sin = Math.sin(angleNoise);
          const rx = fx * cos - fy * sin;
          const ry = fx * sin + fy * cos;
          // Features modulate the step length: amplify stretches streamlines,
          // flatten stalls them inside the feature, interrupt cuts them.
          const res = applyFeatureInfluence(stepLen, u, v, masks, params);
          if (res.break_) break;
          x += rx * res.displacement;
          y += ry * res.displacement;
          if (x < 0 || x > width || y < 0 || y > height) break;
          points.push({ x, y, glow: res.glow, glowStrength: res.glowStrength });
        }
        if (points.length > 4) {
          strokes.push({ points: points.map((p) => ({ x: p.x, y: p.y })), role: "foreground" });
          for (const run of glowRuns(points)) {
            strokes.push({ points: run.points, role: "accent", glow: true, opacity: run.strength });
          }
        }
      }
    }
    return { strokes };
  },
};

export const pulseRings: ArtStyle = {
  id: "pulse-rings",
  name: "Pulse Rings",
  studio: "experimental",
  description: "Concentric rings radiate from the highest peak, distorted by terrain.",
  defaultParams: { amplitude: 40, spacing: 10, lineWidth: 1.2, noise: 0.15, occlusion: 0 },
  controls: expControlsNoCompressionOcclusion,
  generate: (input, params) => {
    const { width, height, masks } = input;
    const sample = elevationSampler(input);
    const peak = findPeak(input);
    const cx = peak.u * width;
    const cy = peak.v * height;
    const phase = params.phase ?? 0;
    const noise = createAnimatedNoise(params.seed + ":rings", 3, 0.5);
    const strokes: Stroke[] = [];

    const maxR = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
    const ringStep = Math.max(3, params.spacing);
    const angleSteps = Math.round(90 + clamp(params.detail, 0.1, 1) * 180);

    for (let r = ringStep; r < maxR; r += ringStep) {
      let segment: RowPoint[] = [];
      const flush = () => {
        if (segment.length > 1) {
          strokes.push({ points: segment, role: "foreground" });
          for (const run of glowRuns(segment)) {
            strokes.push({ points: run.points, role: "accent", glow: true, opacity: run.strength });
          }
        }
        segment = [];
      };
      for (let a = 0; a <= angleSteps; a++) {
        const theta = (a / angleSteps) * Math.PI * 2;
        const bx = cx + Math.cos(theta) * r;
        const by = cy + Math.sin(theta) * r;
        const u = clamp(bx / (width - 1 || 1), 0, 1);
        const v = clamp(by / (height - 1 || 1), 0, 1);
        const elev = sample(u, v);
        const n = (noise(u * 5 + r * 0.01, v * 5, phase)) * params.noise;
        const offset = params.amplitude * (elev - 0.5 + n) * 0.6;
        const res = applyFeatureInfluence(offset, u, v, masks, params);
        if (res.break_) {
          flush();
          continue;
        }
        const rr = r + res.displacement;
        const x = cx + Math.cos(theta) * rr;
        const y = cy + Math.sin(theta) * rr;
        if (x < -20 || x > width + 20 || y < -20 || y > height + 20) {
          flush();
          continue;
        }
        segment.push({ x, y, glow: res.glow, glowStrength: res.glowStrength });
      }
      flush();
    }
    return { strokes };
  },
};

export const terrainSonogram: ArtStyle = {
  id: "terrain-sonogram",
  name: "Terrain Sonogram",
  studio: "experimental",
  description: "Elevation becomes a dense spectrogram-like field of vertical intensity lines.",
  defaultParams: { amplitude: 60, spacing: 4, lineWidth: 1.6, noise: 0.2, occlusion: 0 },
  controls: expControlsNoCompressionOcclusion,
  generate: (input, params) => {
    const { width, height, masks } = input;
    const sample = elevationSampler(input);
    const phase = params.phase ?? 0;
    const noise = createAnimatedNoise(params.seed + ":sono", 4, 0.6);
    const strokes: Stroke[] = [];

    const colStep = Math.max(2, params.spacing);
    const vStep = Math.max(0.004, (1.05 - clamp(params.detail, 0.1, 1)) * 0.02);
    const threshold = 1 - params.amplitude / 100;

    for (let x = 0; x < width; x += colStep) {
      const u = x / (width - 1 || 1);
      let segment: RowPoint[] = [];
      const flush = () => {
        if (segment.length > 1) {
          strokes.push({ points: segment, role: "foreground", width: params.lineWidth });
          for (const run of glowRuns(segment)) {
            strokes.push({ points: run.points, role: "accent", glow: true, opacity: run.strength });
          }
        }
        segment = [];
      };
      for (let v = 0; v <= 1; v += vStep) {
        const elev = sample(u, v);
        const n = (noise(u * 30, v * 30, phase) * 0.5 + 0.5) * params.noise;
        const intensity = elev * (1 - params.noise * 0.5) + n;
        // Bar intensity is the influenced quantity: amplify boosts bars over
        // the feature, flatten suppresses them below the visibility cutoff.
        const res = applyFeatureInfluence(intensity, u, v, masks, params);
        if (res.break_ || res.displacement < threshold * 0.6) {
          flush();
          continue;
        }
        segment.push({ x, y: v * height, glow: res.glow, glowStrength: res.glowStrength });
      }
      flush();
    }
    return { strokes };
  },
};

export const buildingInterference: ArtStyle = {
  id: "building-interference",
  name: "Building Interference",
  studio: "experimental",
  description: "Building footprints interrupt and modulate the waveform lines.",
  defaultParams: {
    amplitude: 40,
    spacing: 5,
    lineWidth: 1,
    noise: 0.15,
    occlusion: 1,
    buildingInfluence: 80,
    buildingMode: "interrupt",
    roadInfluence: 30,
    roadMode: "amplify",
    waterInfluence: 40,
    waterMode: "flatten",
  },
  controls: expControls,
  generate: (input, params) => rowsToScene(generateRows(input, params), params, input.height),
};
