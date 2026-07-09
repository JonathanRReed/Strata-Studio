import type {
  GeoBounds,
  GeoFeature,
  GeoFeatureCollection,
  GeoGeometry,
  FeatureMasks,
  WaterType,
} from './types.ts';
import { projectGeoPoint } from './grid.ts';

type Point = [number, number];

type Layer = 'building' | 'road' | 'ocean' | 'lake' | 'river';

function createLayerCanvas(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Could not create 2D canvas context');
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return ctx;
}

/** Stroke width (px) for line waterways, scaled to canvas size. */
function waterwayStrokeWidth(
  waterway: string | undefined,
  width: number,
  height: number,
): number {
  const base = Math.max(width, height) / 512;
  switch (waterway) {
    case 'river':
    case 'riverbank':
      return Math.max(3, 5 * base);
    case 'canal':
    case 'tidal_channel':
      return Math.max(2, 3.5 * base);
    default:
      return Math.max(1, 2 * base);
  }
}

export function buildFeatureMasks(
  features: GeoFeatureCollection,
  bounds: GeoBounds,
  width: number,
  height: number,
): FeatureMasks {
  const layers: Record<Layer, CanvasRenderingContext2D> = {
    building: createLayerCanvas(width, height),
    road: createLayerCanvas(width, height),
    ocean: createLayerCanvas(width, height),
    lake: createLayerCanvas(width, height),
    river: createLayerCanvas(width, height),
  };

  const oceanCoastlines: { points: { x: number; y: number }[]; isClosed: boolean; waterInside: boolean }[] = [];

  for (const feature of features.features) {
    const { strataType } = feature.properties;

    if (strataType === 'water') {
      const waterType: WaterType = feature.properties.waterType ?? 'lake';
      if (waterType === 'ocean' && feature.geometry.type === 'LineString') {
        const points = feature.geometry.coordinates.map((c) => projectPoint(c, bounds, width, height));
        const coast = classifyCoastline(points);
        if (coast) oceanCoastlines.push(coast);
        continue;
      }
      rasterizeWaterFeature(feature, layers, bounds, width, height);
      continue;
    }

    const ctx = layers[strataType];
    ctx.lineWidth = 2;
    drawGeometry(ctx, feature.geometry, bounds, width, height, strataType === 'road' ? 'stroke' : 'fill');
  }

  fillOceanLayer(layers.ocean, oceanCoastlines, width, height);

  const building = readMask(layers.building, width, height);
  const road = readMask(layers.road, width, height);
  const ocean = readMask(layers.ocean, width, height);
  const lake = readMask(layers.lake, width, height);
  const river = readMask(layers.river, width, height);

  const water = new Float32Array(width * height);
  for (let i = 0; i < water.length; i++) {
    water[i] = Math.max(ocean[i], lake[i], river[i]);
  }

  return { width, height, building, road, water, ocean, lake, river };
}

function rasterizeWaterFeature(
  feature: GeoFeature,
  layers: Record<Layer, CanvasRenderingContext2D>,
  bounds: GeoBounds,
  width: number,
  height: number,
): void {
  const waterType: WaterType = feature.properties.waterType ?? 'lake';
  const ctx = layers[waterType];
  const geometry = feature.geometry;

  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
    const waterway =
      typeof feature.properties.waterway === 'string' ? feature.properties.waterway : undefined;
    ctx.lineWidth = waterwayStrokeWidth(waterway, width, height);
    drawGeometry(ctx, geometry, bounds, width, height, 'stroke');
  } else {
    drawGeometry(ctx, geometry, bounds, width, height, 'fill');
  }
}

type Coastline = {
  points: { x: number; y: number }[];
  isClosed: boolean;
  waterInside: boolean;
};

/**
 * Classifies a projected coastline chain as open or closed, and for closed
 * rings determines whether water is inside (lake/bay) or outside (island).
 *
 * OSM convention: water is on the RIGHT of the coastline's direction of
 * travel. In screen space (y down), a clockwise ring (positive signed area)
 * has its interior on the right, so water is inside. A counter-clockwise
 * ring (negative signed area) has land inside — it's an island.
 */
function classifyCoastline(points: { x: number; y: number }[]): Coastline | null {
  if (points.length < 2) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const isClosed =
    Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6;

  if (!isClosed) {
    return { points, isClosed: false, waterInside: false };
  }

  // Signed area in screen space (y down): positive = clockwise on screen.
  let area = 0;
  for (let i = 0; i < points.length - 1; i++) {
    area += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y;
  }
  // Clockwise (positive area) → interior on right → water inside.
  // Counter-clockwise (negative area) → interior on left → land inside (island).
  return { points, isClosed: true, waterInside: area > 0 };
}

/**
 * Fills the ocean layer from all coastline chains in the viewport.
 *
 * Processing order:
 * 1. If there are islands but no open coastlines or water rings, flood the
 *    viewport once so island holes can be punched out.
 * 2. Fill open coastlines additively (water side via border walk).
 * 3. Fill closed water-enclosing rings additively (lakes/bays).
 * 4. Erase all islands (destination-out) in a single pass — LAST so that
 *    island holes are not refilled by subsequent source-over fills.
 *
 * This avoids the per-island fillRect that previously overwrote other fills.
 */
function fillOceanLayer(
  ctx: CanvasRenderingContext2D,
  coastlines: Coastline[],
  width: number,
  height: number,
): void {
  const open = coastlines.filter((c) => !c.isClosed);
  const waterRings = coastlines.filter((c) => c.isClosed && c.waterInside);
  const islands = coastlines.filter((c) => c.isClosed && !c.waterInside);

  // If there are islands but no open coastlines or water rings to define the
  // ocean boundary, flood the viewport first so island holes can be punched out.
  if (islands.length > 0 && open.length === 0 && waterRings.length === 0) {
    ctx.fillRect(0, 0, width, height);
  }

  // Fill open coastlines additively.
  for (const coast of open) {
    fillOpenCoastline(ctx, coast.points, width, height);
  }

  // Fill closed water-enclosing rings additively.
  for (const ring of waterRings) {
    ctx.beginPath();
    tracePath(ctx, ring.points);
    ctx.closePath();
    ctx.fill('evenodd');
  }

  // Erase all islands in a single destination-out pass — must be LAST so
  // island holes are not refilled by the source-over fills above.
  if (islands.length > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    for (const island of islands) {
      tracePath(ctx, island.points);
      ctx.closePath();
    }
    ctx.fill('evenodd');
    ctx.restore();
  }
}

/**
 * Fills the ocean side of an open coastline by closing along the viewport
 * border. Water is on the RIGHT of travel direction (OSM convention); we
 * walk clockwise (screen space) from the exit point to the entry point,
 * which encloses the right-hand (water) side.
 */
function fillOpenCoastline(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  width: number,
  height: number,
): void {
  const perimeter = 2 * (width + height);
  const borderPos = (p: { x: number; y: number }): number => {
    // Clockwise from top-left: top → right → bottom → left.
    const dTop = Math.abs(p.y);
    const dRight = Math.abs(p.x - width);
    const dBottom = Math.abs(p.y - height);
    const dLeft = Math.abs(p.x);
    const min = Math.min(dTop, dRight, dBottom, dLeft);
    const cx = Math.min(Math.max(p.x, 0), width);
    const cy = Math.min(Math.max(p.y, 0), height);
    if (min === dTop) return cx;
    if (min === dRight) return width + cy;
    if (min === dBottom) return width + height + (width - cx);
    return 2 * width + height + (height - cy);
  };
  const posToPoint = (t: number): { x: number; y: number } => {
    const m = ((t % perimeter) + perimeter) % perimeter;
    if (m < width) return { x: m, y: 0 };
    if (m < width + height) return { x: width, y: m - width };
    if (m < 2 * width + height) return { x: width - (m - width - height), y: height };
    return { x: 0, y: height - (m - 2 * width - height) };
  };

  const exit = borderPos(points[points.length - 1]);
  const entry = borderPos(points[0]);
  const corners = [0, width, width + height, 2 * width + height];

  // Build the closure path in one direction (clockwise from exit to entry).
  const buildClosure = (clockwise: boolean): { x: number; y: number }[] => {
    const span = clockwise
      ? (entry - exit + perimeter) % perimeter
      : (exit - entry + perimeter) % perimeter;
    const start = clockwise ? exit : entry;
    const passed: number[] = [];
    for (const c of corners) {
      const rel = (c - start + perimeter) % perimeter;
      if (rel > 0 && rel < span) passed.push(rel);
    }
    passed.sort((a, b) => a - b);
    const closure: { x: number; y: number }[] = [];
    for (const rel of passed) {
      closure.push(posToPoint(start + rel));
    }
    closure.push(posToPoint(clockwise ? entry : exit));
    return closure;
  };

  // Try clockwise closure first. Compute signed area of the full path
  // (coastline + closure). In screen space (y down), positive signed area
  // means clockwise polygon → interior is on the right of the path direction.
  // The path goes along the coastline from entry (first point) to exit (last
  // point), then along the border back to entry. OSM convention: water is on
  // the RIGHT of the coastline's direction. So if signed area > 0, the
  // clockwise closure correctly encloses the water side. If < 0, it encloses
  // the land side and we must use counter-clockwise instead.
  const cwClosure = buildClosure(true);
  const fullPath = [...points, ...cwClosure];
  let signedArea = 0;
  for (let i = 0; i < fullPath.length; i++) {
    const a = fullPath[i];
    const b = fullPath[(i + 1) % fullPath.length];
    signedArea += a.x * b.y - b.x * a.y;
  }

  let path = fullPath;
  if (signedArea < 0) {
    // Clockwise closure encloses the land side — use counter-clockwise instead.
    const ccwClosure = buildClosure(false);
    path = [...points, ...ccwClosure];
  }

  ctx.beginPath();
  tracePath(ctx, path);
  ctx.closePath();
  ctx.fill();
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
): void {
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
}

function projectPoint(
  point: Point,
  bounds: GeoBounds,
  width: number,
  height: number,
): { x: number; y: number } {
  return projectGeoPoint(point[0], point[1], bounds, width, height);
}

function drawGeometry(
  ctx: CanvasRenderingContext2D,
  geometry: GeoGeometry,
  bounds: GeoBounds,
  width: number,
  height: number,
  mode: 'fill' | 'stroke',
): void {
  ctx.beginPath();
  buildPath(ctx, geometry, bounds, width, height);

  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
    // Lines are always rendered as strokes.
    ctx.stroke();
  } else if (mode === 'fill') {
    ctx.fill('evenodd');
  } else {
    ctx.stroke();
  }
}

function buildPath(
  ctx: CanvasRenderingContext2D,
  geometry: GeoGeometry,
  bounds: GeoBounds,
  width: number,
  height: number,
): void {
  switch (geometry.type) {
    case 'Point': {
      const p = projectPoint(geometry.coordinates, bounds, width, height);
      ctx.moveTo(p.x + 2, p.y);
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      break;
    }
    case 'LineString': {
      drawLineString(ctx, geometry.coordinates, bounds, width, height);
      break;
    }
    case 'MultiLineString': {
      for (const line of geometry.coordinates) {
        drawLineString(ctx, line, bounds, width, height);
      }
      break;
    }
    case 'Polygon': {
      drawPolygon(ctx, geometry.coordinates, bounds, width, height);
      break;
    }
    case 'MultiPolygon': {
      for (const polygon of geometry.coordinates) {
        drawPolygon(ctx, polygon, bounds, width, height);
      }
      break;
    }
  }
}

function drawLineString(
  ctx: CanvasRenderingContext2D,
  coords: Point[],
  bounds: GeoBounds,
  width: number,
  height: number,
): void {
  if (coords.length === 0) return;

  const start = projectPoint(coords[0], bounds, width, height);
  ctx.moveTo(start.x, start.y);

  for (let i = 1; i < coords.length; i++) {
    const p = projectPoint(coords[i], bounds, width, height);
    ctx.lineTo(p.x, p.y);
  }
}

function drawPolygon(
  ctx: CanvasRenderingContext2D,
  rings: Point[][],
  bounds: GeoBounds,
  width: number,
  height: number,
): void {
  for (const ring of rings) {
    if (ring.length === 0) continue;

    const start = projectPoint(ring[0], bounds, width, height);
    ctx.moveTo(start.x, start.y);

    for (let i = 1; i < ring.length; i++) {
      const p = projectPoint(ring[i], bounds, width, height);
      ctx.lineTo(p.x, p.y);
    }

    ctx.closePath();
  }
}

function readMask(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): Float32Array {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const mask = new Float32Array(width * height);

  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3] / 255;
  }

  return mask;
}
