import type { ArtStyle, ArtworkInput, StyleParams, ControlKey } from "../../engine/types.ts";
import { createAnimatedNoise } from "../../engine/noise.ts";
import {
  elevationSampler,
  applyFeatureInfluence,
  generateRowSegments,
  rowsToScene,
  type WaveformRow,
} from "../common.ts";

const NOISE_SCALE = 4.0;

export type { WaveformRow };

export function generateRows(input: ArtworkInput, params: StyleParams): WaveformRow[] {
  const { width, height, masks } = input;
  const sample = elevationSampler(input);

  // Use animated noise (phase defaults to 0, making it equivalent to createNoise)
  const phase = params.phase ?? 0;
  const noise = createAnimatedNoise(params.seed, 4, 0.5);
  const noiseStrength = params.noise * params.amplitude;

  return generateRowSegments(width, height, params, (u, v, _x, baseY) => {
    const elevation = sample(u, v);
    const n = phase > 0
      ? noise(u * NOISE_SCALE, v * NOISE_SCALE, phase)
      : noise(u * NOISE_SCALE, v * NOISE_SCALE);
    const displacement = -params.amplitude * elevation + noiseStrength * n;
    const result = applyFeatureInfluence(displacement, u, v, masks, params);
    return {
      y: baseY + result.displacement,
      glow: result.glow,
      glowStrength: result.glowStrength,
      break_: result.break_,
    };
  });
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
    "oceanInfluence", "lakeInfluence", "riverInfluence",
  ] as ControlKey[],
  generate: (input, params) => rowsToScene(generateRows(input, params), params, input.height),
};
