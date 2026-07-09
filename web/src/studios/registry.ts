import type { ArtStyle, ArtworkInput, Palette, StyleParams, Studio } from "../engine/types.ts";
import { renderSceneCanvas, sceneToSvg } from "../engine/scene.ts";
import { palettes } from "../presets/palettes.ts";
import { classicStyles } from "./classic/classicStyles.ts";
import { waveformTerrain } from "./experimental/waveformTerrain.ts";
import {
  noiseAmplifier,
  seismic,
  meltMap,
  gravityWell,
  magneticField,
  pulseRings,
  terrainSonogram,
  buildingInterference,
} from "./experimental/experimentalStyles.ts";

export const experimentalStyles: ArtStyle[] = [
  waveformTerrain,
  noiseAmplifier,
  seismic,
  meltMap,
  gravityWell,
  magneticField,
  pulseRings,
  terrainSonogram,
  buildingInterference,
];

export const allStyles: ArtStyle[] = [...classicStyles, ...experimentalStyles];

export const stylesById: Record<string, ArtStyle> = Object.fromEntries(
  allStyles.map((s) => [s.id, s]),
);

export const stylesByStudio: Record<Studio, ArtStyle[]> = {
  classic: classicStyles,
  experimental: experimentalStyles,
};

export const DEFAULT_STYLE_ID = waveformTerrain.id;

export function getStyle(id: string): ArtStyle {
  return stylesById[id] ?? waveformTerrain;
}

export function renderStyleCanvas(
  styleId: string,
  ctx: CanvasRenderingContext2D,
  input: ArtworkInput,
  params: StyleParams,
  paletteMap: Record<string, Palette> = palettes,
  transparent = false,
): void {
  const style = getStyle(styleId);
  const scene = style.generate(input, params);
  const palette = paletteMap[params.palette] ?? palettes.monochrome;
  renderSceneCanvas(ctx, scene, params, palette, input.width, input.height, transparent, input.masks);
}

export function renderStyleSvg(
  styleId: string,
  input: ArtworkInput,
  params: StyleParams,
  paletteMap: Record<string, Palette> = palettes,
  transparent = false,
): string {
  const style = getStyle(styleId);
  const scene = style.generate(input, params);
  const palette = paletteMap[params.palette] ?? palettes.monochrome;
  return sceneToSvg(scene, params, palette, input.width, input.height, transparent, input.masks);
}

export { classicStyles };
