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

  for (const feature of features.features) {
    const { strataType } = feature.properties;

    if (strataType === 'water') {
      rasterizeWaterFeature(feature, layers, bounds, width, height);
      continue;
    }

    const ctx = layers[strataType];
    ctx.lineWidth = 2;
    drawGeometry(ctx, feature.geometry, bounds, width, height, strataType === 'road' ? 'stroke' : 'fill');
  }

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
  const geometry = feature.geometry;

  if (waterType === 'ocean' && geometry.type === 'LineString') {
    fillOceanFromCoastline(
      layers.ocean,
      geometry.coordinates.map((c) => projectPoint(c, bounds, width, height)),
      width,
      height,
    );
    return;
  }

  const ctx = layers[waterType];
  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
    const waterway =
      typeof feature.properties.waterway === 'string' ? feature.properties.waterway : undefined;
    ctx.lineWidth = waterwayStrokeWidth(waterway, width, height);
    drawGeometry(ctx, geometry, bounds, width, height, 'stroke');
  } else {
    drawGeometry(ctx, geometry, bounds, width, height, 'fill');
  }
}

/**
 * Fills the ocean side of a projected coastline.
 *
 * OSM convention: water is on the RIGHT of the coastline's direction of
 * travel. Open coastlines are closed by walking the viewport border
 * clockwise (screen space) from the exit point back to the entry point,
 * which encloses the water side. Closed coastlines are islands: the whole
 * viewport is flooded and the land ring is erased.
 */
function fillOceanFromCoastline(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  width: number,
  height: number,
): void {
  if (points.length < 2) return;

  const first = points[0];
  const last = points[points.length - 1];
  const isClosed =
    Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6;

  if (isClosed) {
    // Signed area in screen space (y down): positive = clockwise on screen.
    let area = 0;
    for (let i = 0; i < points.length - 1; i++) {
      area += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y;
    }
    const waterInside = area < 0; // counterclockwise ring: water on right = interior

    if (waterInside) {
      ctx.beginPath();
      tracePath(ctx, points);
      ctx.closePath();
      ctx.fill('evenodd');
    } else {
      // Island: flood the viewport, then erase the land.
      ctx.fillRect(0, 0, width, height);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      tracePath(ctx, points);
      ctx.closePath();
      ctx.fill('evenodd');
      ctx.restore();
    }
    return;
  }

  // Open coastline: close along the viewport border, keeping water enclosed.
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

  const exit = borderPos(last);
  const entry = borderPos(first);
  const path = [...points];

  // Walk clockwise from exit to entry, inserting the corners passed.
  const corners = [0, width, width + height, 2 * width + height];
  const span = (entry - exit + perimeter) % perimeter;
  const passed: number[] = [];
  for (const c of corners) {
    const rel = (c - exit + perimeter) % perimeter;
    if (rel > 0 && rel < span) passed.push(rel);
  }
  passed.sort((a, b) => a - b);
  for (const rel of passed) {
    path.push(posToPoint(exit + rel));
  }
  path.push(posToPoint(entry));

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
