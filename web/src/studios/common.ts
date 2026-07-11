import type {
  ArtworkInput,
  StyleParams,
  FeatureMasks,
  MaskMode,
  GeoFeatureCollection,
  GeoBounds,
  GeoGeometry,
  WaterType,
} from "../engine/types.ts";
import type { Scene, ScenePoint, Stroke, StrokeRole } from "../engine/scene.ts";
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
  /**
   * Glow intensity in [0, 1]: (influence / 100) * mask value at this point
   * (for outline mode: (influence / 100) * mask edge magnitude). `glow` is
   * true whenever this is > 0, so full influence over a solid mask behaves
   * exactly like the old boolean glow.
   */
  glowStrength: number;
  break_: boolean;
};

/** Applies building/road/water mask influence to a displacement value. */
export function applyFeatureInfluence(
  displacement: number,
  u: number,
  v: number,
  masks: FeatureMasks | undefined,
  params: StyleParams,
  strataType?: "building" | "road" | "water",
): FeatureInfluenceResult {
  if (!masks) return { displacement, glow: false, glowStrength: 0, break_: false };

  let d = displacement;
  let glowStrength = 0;
  let break_ = false;

  const sampleAt = (mask: Float32Array) =>
    sampleMask(mask, masks.width, masks.height, u, v);

  // Mask edge magnitude at (u, v): finite differences over one mask texel,
  // so a hard 0-to-1 boundary reads as ~1 and mask interiors read as 0.
  const edgeAt = (mask: Float32Array) => {
    const eu = 1 / (masks.width - 1 || 1);
    const ev = 1 / (masks.height - 1 || 1);
    const gx =
      sampleMask(mask, masks.width, masks.height, clamp(u + eu, 0, 1), v) -
      sampleMask(mask, masks.width, masks.height, clamp(u - eu, 0, 1), v);
    const gy =
      sampleMask(mask, masks.width, masks.height, u, clamp(v + ev, 0, 1)) -
      sampleMask(mask, masks.width, masks.height, u, clamp(v - ev, 0, 1));
    return clamp(Math.hypot(gx, gy), 0, 1);
  };

  const apply = (mask: Float32Array, val: number, influence: number, mode: MaskMode) => {
    if (influence === 0 || val < 0.01) return;
    const strength = (influence / 100) * val;
    switch (mode) {
      case "interrupt":
        // Threshold scales with influence: higher influence = wider gaps.
        if (val > 1 - influence / 150) break_ = true;
        break;
      case "amplify":
        d += d * strength * 0.75;
        break;
      case "flatten":
        d *= 1 - Math.abs(strength);
        break;
      case "glow":
        // Glow intensity scales with influence and mask coverage.
        glowStrength = Math.max(glowStrength, clamp(Math.abs(strength), 0, 1));
        break;
      case "outline":
        // Accent the feature boundary: glow where the mask gradient is high.
        glowStrength = Math.max(
          glowStrength,
          clamp(Math.abs(influence / 100) * edgeAt(mask), 0, 1),
        );
        break;
      case "invert":
        // Negate displacement where the mask is active; partial influence
        // interpolates through zero (0.5 flattens, 1 fully mirrors).
        d *= 1 - 2 * clamp(Math.abs(strength), 0, 1);
        break;
    }
  };

  // When strataType is specified (feature-line styles), only apply the mask(s)
  // relevant to that feature type. When undefined (terrain-based styles),
  // apply all masks so the terrain responds to all features.
  if (!strataType || strataType === "building") {
    apply(masks.building, sampleAt(masks.building), params.buildingInfluence, params.buildingMode);
  }
  if (!strataType || strataType === "road") {
    apply(masks.road, sampleAt(masks.road), params.roadInfluence, params.roadMode);
  }
  if (!strataType || strataType === "water") {
    // Per-type influences take precedence. The combined water mask is
    // max(ocean, lake, river), so applying it on top of an active per-type
    // influence would double-apply on the same pixel; the combined water
    // influence only covers pixels no active per-type influence handles.
    const oceanVal = sampleAt(masks.ocean);
    const lakeVal = sampleAt(masks.lake);
    const riverVal = sampleAt(masks.river);
    const oceanActive = params.oceanInfluence !== 0 && oceanVal >= 0.01;
    const lakeActive = params.lakeInfluence !== 0 && lakeVal >= 0.01;
    const riverActive = params.riverInfluence !== 0 && riverVal >= 0.01;
    if (oceanActive) apply(masks.ocean, oceanVal, params.oceanInfluence, params.oceanMode);
    if (lakeActive) apply(masks.lake, lakeVal, params.lakeInfluence, params.lakeMode);
    if (riverActive) apply(masks.river, riverVal, params.riverInfluence, params.riverMode);
    if (!oceanActive && !lakeActive && !riverActive) {
      apply(masks.water, sampleAt(masks.water), params.waterInfluence, params.waterMode);
    }
  }

  return { displacement: d, glow: glowStrength > 0, glowStrength, break_ };
}

export type GlowRun = { points: ScenePoint[]; strength: number };

/**
 * Splits a polyline of points-with-glow into contiguous glow runs. Each run
 * carries the maximum glow strength of its points (defaulting to 1 for
 * callers without per-point strength) so accent strokes can scale their
 * alpha proportionally.
 */
export function glowRuns(
  points: { x: number; y: number; glow: boolean; glowStrength?: number }[],
): GlowRun[] {
  const runs: GlowRun[] = [];
  let current: ScenePoint[] = [];
  let strength = 0;
  const flush = () => {
    if (current.length > 1) runs.push({ points: current, strength });
    current = [];
    strength = 0;
  };
  for (const p of points) {
    if (p.glow) {
      current.push({ x: p.x, y: p.y });
      strength = Math.max(strength, p.glowStrength ?? 1);
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

/**
 * Processes a polyline through feature influence, splitting it at interrupt
 * points and marking glow segments. Returns an array of strokes (one per
 * contiguous segment). Uses displacement=1 so amplify/flatten modes produce
 * a modulate factor that can scale width/opacity. Glow is applied per
 * sub-segment: the base stroke keeps its role, and each contiguous glow run
 * is overlaid as an accent stroke whose alpha scales with glow strength.
 */
export function applyInfluenceToLine(
  points: ScenePoint[],
  width: number,
  height: number,
  masks: FeatureMasks | undefined,
  params: StyleParams,
  baseWidth: number,
  baseOpacity: number,
  role: StrokeRole,
  closed = false,
  strataType?: "building" | "road" | "water",
): Stroke[] {
  if (!masks) return [{ points, width: baseWidth, opacity: baseOpacity, role, closed: closed || undefined }];

  const strokes: Stroke[] = [];
  let current: { x: number; y: number; glow: boolean; glowStrength: number }[] = [];
  let hadBreak = false;

  const flush = () => {
    if (current.length > 1) {
      strokes.push({
        points: current.map((p) => ({ x: p.x, y: p.y })),
        role,
        width: baseWidth,
        opacity: baseOpacity,
        closed: !hadBreak && closed ? true : undefined,
      });
      for (const run of glowRuns(current)) {
        strokes.push({
          points: run.points,
          role: "accent",
          width: baseWidth,
          opacity: baseOpacity * run.strength,
          glow: true,
        });
      }
    }
    current = [];
  };

  for (const p of points) {
    const u = p.x / (width - 1 || 1);
    const v = p.y / (height - 1 || 1);
    // Only apply masks relevant to this line's feature type
    const res = applyFeatureInfluence(1, u, v, masks, params, strataType);
    if (res.break_) {
      hadBreak = true;
      flush();
      continue;
    }
    current.push({ x: p.x, y: p.y, glow: res.glow, glowStrength: res.glowStrength });
  }
  flush();
  return strokes;
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
  waterType?: WaterType;
};

/** Scene stroke role for a water feature line: per-type when known. */
export function waterRole(line: FeatureLine): StrokeRole {
  return line.waterType ?? "water";
}

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
        out.push({
          ...line,
          strataType: f.properties.strataType,
          waterType: f.properties.waterType,
        });
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

/** Cap on generated waveform rows, shared by every row-based style. */
export const MAX_ROWS = 500;

export type RowPoint = { x: number; y: number; glow: boolean; glowStrength: number };

export type WaveformRow = {
  baseY: number;
  segments: RowPoint[][];
};

export type RowPointResult = {
  /** Optional horizontal offset; defaults to the sample x when omitted. */
  x?: number;
  y: number;
  glow: boolean;
  glowStrength: number;
  break_: boolean;
};

/**
 * Shared row iterator for horizontal-line styles: walks rows top to bottom
 * (spacing/compression apart, capped at MAX_ROWS), samples points via
 * pointFn, and splits row segments wherever pointFn reports a break.
 */
export function generateRowSegments(
  width: number,
  height: number,
  params: StyleParams,
  pointFn: (u: number, v: number, x: number, baseY: number) => RowPointResult,
): WaveformRow[] {
  const rowStep = params.spacing / clamp(params.compression, 0.5, 5);
  const xStep = Math.max(1, Math.round((1.1 - clamp(params.detail, 0.1, 1)) * 10));

  const rows: WaveformRow[] = [];
  let rowCount = 0;

  for (let baseY = 0; baseY < height && rowCount < MAX_ROWS; baseY += rowStep, rowCount++) {
    const v = baseY / (height - 1 || 1);
    const segments: RowPoint[][] = [];
    let currentSegment: RowPoint[] = [];

    for (let x = 0; x < width; x += xStep) {
      const u = x / (width - 1 || 1);
      const r = pointFn(u, v, x, baseY);
      if (r.break_) {
        if (currentSegment.length > 0) {
          segments.push(currentSegment);
          currentSegment = [];
        }
        continue;
      }
      currentSegment.push({ x: r.x ?? x, y: r.y, glow: r.glow, glowStrength: r.glowStrength });
    }

    if (currentSegment.length > 0) {
      segments.push(currentSegment);
    }

    rows.push({ baseY, segments });
  }

  return rows;
}

/**
 * Converts waveform rows into scene strokes: an occlusion fill per segment
 * (when enabled and params.occlusion > 0), the foreground line, and accent
 * glow runs with alpha scaled by glow strength.
 */
export function rowsToScene(
  rows: WaveformRow[],
  params: StyleParams,
  height: number,
  occlusion = true,
): Scene {
  const strokes: Stroke[] = [];
  const occlude = occlusion && params.occlusion > 0;

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
        strokes.push({ points: run.points, role: "accent", glow: true, opacity: run.strength });
      }
    }
  }

  return { strokes };
}

export { clamp };
