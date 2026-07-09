import type { StyleParams } from "../engine/types.ts";

export const defaultStyleParams: StyleParams = {
  amplitude: 40,
  spacing: 8,
  lineWidth: 1.5,
  noise: 0.15,
  detail: 1,
  compression: 1,
  seed: "monolith",
  palette: "monochrome",
  buildingInfluence: 0,
  roadInfluence: 0,
  waterInfluence: 0,
  buildingMode: "interrupt",
  roadMode: "amplify",
  waterMode: "flatten",
  grain: 0,
  rotation: 0,
  label: "",
  aspectRatio: "square",
  occlusion: 1,
};

export type Preset = {
  id: string;
  name: string;
  styleId: string;
  params: Partial<StyleParams>;
};

export const presets: Preset[] = [
  // Experimental presets
  {
    id: "monolith",
    name: "Monolith",
    styleId: "waveform-terrain",
    params: { amplitude: 45, spacing: 6, lineWidth: 1.2, noise: 0.1, seed: "monolith", palette: "monochrome", occlusion: 1 },
  },
  {
    id: "signal-peak",
    name: "Signal Peak",
    styleId: "waveform-terrain",
    params: { amplitude: 70, spacing: 10, lineWidth: 1.5, noise: 0.2, compression: 0.85, seed: "signal", palette: "monochrome", occlusion: 1 },
  },
  {
    id: "white-noise",
    name: "White Noise",
    styleId: "noise-amplifier",
    params: { amplitude: 30, spacing: 4, lineWidth: 0.8, noise: 0.55, compression: 1.2, seed: "noise", palette: "monochrome" },
  },
  {
    id: "mountain-broadcast",
    name: "Mountain Broadcast",
    styleId: "waveform-terrain",
    params: { amplitude: 60, spacing: 12, lineWidth: 1.5, noise: 0.05, compression: 0.9, seed: "broadcast", palette: "cream", occlusion: 1 },
  },
  {
    id: "fault-line",
    name: "Fault Line",
    styleId: "seismic",
    params: { amplitude: 65, spacing: 8, lineWidth: 1, noise: 0.4, seed: "fault", palette: "monochrome" },
  },
  {
    id: "seismic-choir",
    name: "Seismic Choir",
    styleId: "seismic",
    params: { amplitude: 50, spacing: 6, lineWidth: 1.4, noise: 0.2, compression: 1.3, seed: "choir", palette: "glacier" },
  },
  {
    id: "black-ridge",
    name: "Black Ridge",
    styleId: "ridge",
    params: { amplitude: 60, spacing: 3, lineWidth: 0.8, noise: 0, occlusion: 1, seed: "blackridge", palette: "monochrome" },
  },
  {
    id: "interference-map",
    name: "Interference Map",
    styleId: "building-interference",
    params: { amplitude: 45, spacing: 5, lineWidth: 1, noise: 0.1, occlusion: 1, seed: "interference", palette: "monochrome", buildingInfluence: 90, buildingMode: "interrupt", roadInfluence: 40, roadMode: "amplify" },
  },
  {
    id: "neon-pulse",
    name: "Neon Pulse",
    styleId: "pulse-rings",
    params: { amplitude: 50, spacing: 8, lineWidth: 1.5, noise: 0.25, seed: "neon", palette: "neon" },
  },
  {
    id: "iron-filings",
    name: "Iron Filings",
    styleId: "magnetic-field",
    params: { amplitude: 55, spacing: 12, lineWidth: 0.8, noise: 0.15, seed: "iron", palette: "monochrome" },
  },
  {
    id: "ghost-terrain",
    name: "Ghost Terrain",
    styleId: "melt-map",
    params: { amplitude: 55, spacing: 7, lineWidth: 1.2, noise: 0.3, occlusion: 0.9, seed: "ghost", palette: "glacier" },
  },
  {
    id: "gravity-collapse",
    name: "Gravity Collapse",
    styleId: "gravity-well",
    params: { amplitude: 80, spacing: 6, lineWidth: 1, noise: 0.1, seed: "collapse", palette: "monochrome" },
  },
  {
    id: "static-bloom",
    name: "Static Bloom",
    styleId: "terrain-sonogram",
    params: { amplitude: 70, spacing: 3, lineWidth: 1.8, noise: 0.3, seed: "bloom", palette: "desert" },
  },
  // Classic presets
  {
    id: "topo-classic",
    name: "Topo Classic",
    styleId: "contour",
    params: { spacing: 8, lineWidth: 1.2, seed: "topo", palette: "cream" },
  },
  {
    id: "drafting-table",
    name: "Drafting Table",
    styleId: "blueprint",
    params: { spacing: 12, lineWidth: 0.8, seed: "blueprint", palette: "blueprint" },
  },
  {
    id: "carved-ink",
    name: "Carved Ink",
    styleId: "woodcut",
    params: { amplitude: 30, spacing: 5, lineWidth: 1.6, noise: 0.4, grain: 0.35, seed: "carve", palette: "cream" },
  },
  {
    id: "city-circuit",
    name: "City Circuit",
    styleId: "signal",
    params: { spacing: 8, lineWidth: 1.1, seed: "circuit", palette: "neon" },
  },
  {
    id: "atlas",
    name: "Atlas",
    styleId: "contour",
    params: { spacing: 6, lineWidth: 0.9, detail: 1, seed: "atlas", palette: "monochrome", grain: 0.1 },
  },
  {
    id: "quarry",
    name: "Quarry",
    styleId: "ridge",
    params: { amplitude: 70, spacing: 5, lineWidth: 1.2, noise: 0.05, occlusion: 1, seed: "quarry", palette: "desert" },
  },
  {
    id: "survey",
    name: "Survey",
    styleId: "flow",
    params: { amplitude: 40, spacing: 10, lineWidth: 0.9, noise: 0.2, detail: 0.8, seed: "survey", palette: "blueprint" },
  },
];

export function applyPreset(
  preset: Preset,
  styleDefaults: Partial<StyleParams> = {},
): StyleParams {
  return { ...defaultStyleParams, ...styleDefaults, ...preset.params };
}
