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
import { sampleMask, sampleRasterMask, normalizeGrid, clamp } from "../engine/grid.ts";
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
  const u0 = clamp(u - eps, 0, 1), u1 = clamp(u + eps, 0, 1);
  const v0 = clamp(v - eps, 0, 1), v1 = clamp(v + eps, 0, 1);
  const dx = u1 === u0 ? 0 : (sample(u1, v) - sample(u0, v)) / (u1 - u0);
  const dy = v1 === v0 ? 0 : (sample(u, v1) - sample(u, v0)) / (v1 - v0);
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
    sampleRasterMask(mask, masks.width, masks.height, u, v);

  // Mask edge magnitude at (u, v): finite differences over one mask texel,
  // so a hard 0-to-1 boundary reads as ~1 and mask interiors read as 0.
  const edgeAt = (mask: Float32Array) => {
    const eu = 1 / masks.width;
    const ev = 1 / masks.height;
    const gx =
      sampleRasterMask(mask, masks.width, masks.height, clamp(u + eu, 0, 1), v) -
      sampleRasterMask(mask, masks.width, masks.height, clamp(u - eu, 0, 1), v);
    const gy =
      sampleRasterMask(mask, masks.width, masks.height, u, clamp(v + ev, 0, 1)) -
      sampleRasterMask(mask, masks.width, masks.height, u, clamp(v - ev, 0, 1));
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
  closed = false,
): GlowRun[] {
  const runs: GlowRun[] = [];
  let current: ScenePoint[] = [];
  let strength = 0;
  const flush = () => {
    if (current.length > 0) runs.push({ points: current, strength });
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
  if (closed && runs.length > 1 && points[0]?.glow && points[points.length - 1]?.glow) {
    const first = runs[0], last = runs[runs.length - 1];
    runs[0] = { points: [...last.points, ...first.points.slice(1)], strength: Math.max(first.strength, last.strength) };
    runs.pop();
  }
  return runs.filter(run => run.points.length > 1);
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
  const active = (!strataType || strataType === "building") && params.buildingInfluence !== 0 ||
    (!strataType || strataType === "road") && params.roadInfluence !== 0 ||
    (!strataType || strataType === "water") && [params.waterInfluence, params.oceanInfluence, params.lakeInfluence, params.riverInfluence].some(value => value !== 0);
  if (!masks || !active) return [{ points, width: baseWidth, opacity: baseOpacity, role, closed: closed || undefined }];
  if (points.length < 2) return [];
  const first = points[0], last = points[points.length - 1];
  const path = closed && (first.x !== last.x || first.y !== last.y) ? [...points, first] : points;
  const samples = path.map(point => ({ point, influence: applyFeatureInfluence(
    1, point.x / (width - 1 || 1), point.y / (height - 1 || 1), masks, params, strataType,
  ) }));
  type InkRun = { negative: boolean; ink: number; length: number; points: ScenePoint[] };
  const runs: InkRun[] = [];
  let current: InkRun | undefined;
  let drawnEdges = 0;
  const flush = () => {
    if (!current) return;
    runs.push(current);
    current = undefined;
  };
  const emitEdge = (a: ScenePoint, b: ScenePoint, value: number): boolean => {
    if (value === 0) { flush(); return false; }
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) return true;
    const negative = value < 0, ink = Math.abs(value) * length;
    // One arc-length-weighted ink gain per uninterrupted same-sign run.
    // Per-vertex strokes create overlapping translucent caps and thousands
    // of draw calls on feathered masks. This preserves integrated ink weight
    // without claiming a continuously varying stroke-width gradient.
    if (current?.negative === negative) {
      current.points.push(b); current.ink += ink; current.length += length;
    } else {
      flush(); current = { negative, ink, length, points: [a, b] };
    }
    return true;
  };
  // Signed ink gain changes weight/opacity rather than distorting real-world
  // coordinates. Inversion passes through zero to negative (knockout) ink.
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.influence.break_ || b.influence.break_) { flush(); continue; }
    const da = a.influence.displacement, db = b.influence.displacement;
    if (da !== 0 && db !== 0 && (da < 0) !== (db < 0)) {
      // Averaging opposite signs could erase an entire boundary-crossing
      // edge. Split at its actual linear zero, preserving both sides.
      const t = da / (da - db);
      const midpoint = { x: a.point.x + (b.point.x - a.point.x) * t,
        y: a.point.y + (b.point.y - a.point.y) * t };
      const firstVisible = emitEdge(a.point, midpoint, da / 2);
      const secondVisible = emitEdge(midpoint, b.point, db / 2);
      if (firstVisible || secondVisible) drawnEdges++;
    } else if (emitEdge(a.point, b.point, (da + db) / 2)) drawnEdges++;
  }
  flush();
  if (closed && runs.length > 1) {
    const head = runs[0], tail = runs[runs.length - 1];
    if (head.negative === tail.negative && head.points[0] === path[0] &&
        tail.points[tail.points.length - 1] === path[path.length - 1]) {
      runs[0] = { negative: head.negative, ink: head.ink + tail.ink,
        length: head.length + tail.length, points: [...tail.points, ...head.points.slice(1)] };
      runs.pop();
    }
  }
  const toStroke = (run: InkRun): Stroke => {
    const magnitude = run.ink / run.length;
    return { points: run.points, role: run.negative ? "background" : role,
      width: baseWidth * Math.max(1, magnitude), opacity: baseOpacity * Math.min(1, magnitude),
      closed: closed && runs.length === 1 && drawnEdges === path.length - 1 ? true : undefined };
  };
  // Apply negative ink last within this line, independently of the arbitrary
  // first vertex of a closed ring (or the direction of an open line).
  const strokes = runs.filter(run => !run.negative).map(toStroke);
  const glowPoints = samples.map(({ point, influence }) => ({ ...point,
    glow: !influence.break_ && influence.displacement > 0 && influence.glow,
    glowStrength: influence.glowStrength }));
  for (const run of glowRuns(glowPoints, closed)) {
    strokes.push({ points: run.points, role: "accent", width: baseWidth,
      opacity: baseOpacity * run.strength, glow: true });
  }
  strokes.push(...runs.filter(run => run.negative).map(toStroke));
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
/** Adaptive row samples retain thin map features without globally increasing terrain detail. */
export function createFeatureAwareRowSampler(width: number, xStep: number, params: StyleParams, masks?: FeatureMasks): (v: number) => number[] {
  // Keep terrain's chosen detail outside geographic features, but never let
  // coarse row vertices step completely over a thin loaded road/building.
  const activeMasks = masks ? [
    [masks.building, params.buildingInfluence], [masks.road, params.roadInfluence],
    [masks.water, params.waterInfluence], [masks.ocean, params.oceanInfluence],
    [masks.lake, params.lakeInfluence], [masks.river, params.riverInfluence],
  ].filter((entry) => (entry[1] as number) > 0).map((entry) => entry[0] as Float32Array) : [];
  return (v) => {
    const sampleXs = new Set<number>();
    for (let x = 0; x < width; x += xStep) sampleXs.add(x);
    sampleXs.add(Math.max(0, width - 1));
    if (masks && activeMasks.length) {
      const maskY = clamp(v * masks.height - 0.5, 0, masks.height - 1);
      const y0 = Math.floor(maskY), y1 = Math.ceil(maskY);
      for (let column = 0; column < masks.width; column++) {
        const crossesFeature = activeMasks.some((mask) => {
          for (const row of [y0, y1]) {
            const offset = row * masks.width;
            const center = mask[offset + column];
            const left = mask[offset + Math.max(0, column - 1)];
            const right = mask[offset + Math.min(masks.width - 1, column + 1)];
            if (Math.max(center, left, right) >= 0.01 &&
              (Math.abs(center - left) > 1e-6 || Math.abs(center - right) > 1e-6)) return true;
          }
          return false;
        });
        if (!crossesFeature) continue;
        // Include the texel center and sub-texel threshold crossings. Sampling
        // only whole output pixels can miss even a fully occupied thin mask.
        for (let quarter = -3; quarter <= 3; quarter++) {
          const x = ((column + 0.5 + quarter / 4) / masks.width) * (width - 1);
          if (x >= 0 && x < width) sampleXs.add(x);
        }
      }
    }
    return [...sampleXs].sort((a, b) => a - b);
  };
}

export function generateRowSegments(
  width: number,
  height: number,
  params: StyleParams,
  pointFn: (u: number, v: number, x: number, baseY: number) => RowPointResult,
  masks?: FeatureMasks,
): WaveformRow[] {
  const rowStep = Math.max(params.spacing / clamp(params.compression, 0.5, 5), height / MAX_ROWS);
  const xStep = Math.max(1, Math.round((1.1 - clamp(params.detail, 0.1, 1)) * 10));

  const rowSamples = createFeatureAwareRowSampler(width, xStep, params, masks);
  const rows: WaveformRow[] = [];
  for (let rowCount = 0; rowCount < MAX_ROWS; rowCount++) {
    const baseY = rowCount * rowStep;
    if (baseY >= height) break;
    const v = baseY / (height - 1 || 1);
    const segments: RowPoint[][] = [];
    let currentSegment: RowPoint[] = [];

    for (const x of rowSamples(v)) {
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
