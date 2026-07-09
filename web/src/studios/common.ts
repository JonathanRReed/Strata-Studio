import type {
  ArtworkInput,
  StyleParams,
  FeatureMasks,
  MaskMode,
  GeoFeatureCollection,
  GeoBounds,
  GeoGeometry,
} from "../engine/types.ts";
import type { ScenePoint, Stroke } from "../engine/scene.ts";
import { sampleMask, normalizeGrid, clamp } from "../engine/grid.ts";
import { projectGeoPoint } from "../engine/grid.ts";
import { hashSeed } from "../engine/noise.ts";

export function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed: string) {
  return mulberry32(hashSeed(seed));
}

/** Returns a sampler of normalized elevation in [0, 1] over (u, v) in [0, 1]. */
export function elevationSampler(
  input: ArtworkInput,
): (u: number, v: number) => number {
  const grid = input.elevationGrid.data;
  const { width, height } = input.elevationGrid;
  const { min, range } = normalizeGrid(grid);
  return (u, v) => (sampleMask(grid, width, height, u, v) - min) / range;
}

/** Central-difference gradient of normalized elevation. */
export function elevationGradient(
  sample: (u: number, v: number) => number,
  u: number,
  v: number,
  eps = 0.01,
): { dx: number; dy: number } {
  const dx = (sample(clamp(u + eps, 0, 1), v) - sample(clamp(u - eps, 0, 1), v)) / (2 * eps);
  const dy = (sample(u, clamp(v + eps, 0, 1)) - sample(u, clamp(v - eps, 0, 1))) / (2 * eps);
  return { dx, dy };
}

/** Finds the (u, v) of the highest elevation cell. */
export function findPeak(input: ArtworkInput): { u: number; v: number } {
  const grid = input.elevationGrid.data;
  const { width, height } = input.elevationGrid;
  let best = -Infinity;
  let bestI = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > best) {
      best = grid[i];
      bestI = i;
    }
  }
  const x = bestI % width;
  const y = Math.floor(bestI / width);
  return { u: x / (width - 1 || 1), v: y / (height - 1 || 1) };
}

export type FeatureInfluenceResult = {
  displacement: number;
  glow: boolean;
  break_: boolean;
};

/** Applies building/road/water mask influence to a displacement value. */
export function applyFeatureInfluence(
  displacement: number,
  u: number,
  v: number,
  masks: FeatureMasks | undefined,
  params: StyleParams,
): FeatureInfluenceResult {
  if (!masks) return { displacement, glow: false, break_: false };

  let d = displacement;
  let glow = false;
  let break_ = false;

  const apply = (val: number, influence: number, mode: MaskMode) => {
    if (influence === 0 || val < 0.01) return;
    const strength = (influence / 100) * val;
    switch (mode) {
      case "interrupt":
        if (val > 0.3) break_ = true;
        break;
      case "amplify":
        d += d * strength * 0.75;
        break;
      case "flatten":
        d *= 1 - Math.abs(strength);
        break;
      case "glow":
        glow = true;
        break;
    }
  };

  apply(sampleMask(masks.building, masks.width, masks.height, u, v), params.buildingInfluence, params.buildingMode);
  apply(sampleMask(masks.road, masks.width, masks.height, u, v), params.roadInfluence, params.roadMode);
  apply(sampleMask(masks.water, masks.width, masks.height, u, v), params.waterInfluence, params.waterMode);

  return { displacement: d, glow, break_ };
}

/** Splits a polyline of points-with-glow into contiguous glow runs. */
export function glowRuns(
  points: { x: number; y: number; glow: boolean }[],
): ScenePoint[][] {
  const runs: ScenePoint[][] = [];
  let current: ScenePoint[] = [];
  for (const p of points) {
    if (p.glow) {
      current.push({ x: p.x, y: p.y });
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs.filter((r) => r.length > 1);
}

function geometryToLines(
  geometry: GeoGeometry,
  bounds: GeoBounds,
  width: number,
  height: number,
): { points: ScenePoint[]; closed: boolean }[] {
  const project = (c: [number, number]) => projectGeoPoint(c[0], c[1], bounds, width, height);
  switch (geometry.type) {
    case "Point":
      return [];
    case "LineString":
      return [{ points: geometry.coordinates.map(project), closed: false }];
    case "MultiLineString":
      return geometry.coordinates.map((line) => ({ points: line.map(project), closed: false }));
    case "Polygon":
      return geometry.coordinates.map((ring) => ({ points: ring.map(project), closed: true }));
    case "MultiPolygon":
      return geometry.coordinates.flatMap((poly) =>
        poly.map((ring) => ({ points: ring.map(project), closed: true })),
      );
  }
}

export type FeatureLine = {
  points: ScenePoint[];
  closed: boolean;
  strataType: "building" | "road" | "water";
};

/** Projects OSM features into canvas-space polylines. */
export function featureLines(
  features: GeoFeatureCollection | undefined,
  bounds: GeoBounds,
  width: number,
  height: number,
): FeatureLine[] {
  if (!features) return [];
  const out: FeatureLine[] = [];
  for (const f of features.features) {
    for (const line of geometryToLines(f.geometry, bounds, width, height)) {
      if (line.points.length > 1) {
        out.push({ ...line, strataType: f.properties.strataType });
      }
    }
  }
  return out;
}

/** Resamples a polyline so consecutive points are at most maxStep apart. */
export function densify(points: ScenePoint[], maxStep: number): ScenePoint[] {
  if (points.length < 2) return points;
  const out: ScenePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / maxStep));
    for (let s = 1; s <= steps; s++) {
      out.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
    }
  }
  return out;
}

/** Builds an occlusion fill polygon under a waveform row (down to the canvas bottom). */
export function occlusionFill(
  linePoints: ScenePoint[],
  height: number,
): Stroke {
  const points = [...linePoints];
  const last = linePoints[linePoints.length - 1];
  const first = linePoints[0];
  points.push({ x: last.x, y: height + 4 });
  points.push({ x: first.x, y: height + 4 });
  return { points, role: "background", fill: true, closed: true };
}

export { clamp };
