import type { GeoBounds, GeoFeatureCollection, GeoGeometry, FeatureMasks } from './types.ts';
import { projectGeoPoint } from './grid.ts';

type Point = [number, number];

export function buildFeatureMasks(
  features: GeoFeatureCollection,
  bounds: GeoBounds,
  width: number,
  height: number,
): FeatureMasks {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create 2D canvas context');
  }

  const building = new Float32Array(width * height);
  const road = new Float32Array(width * height);
  const water = new Float32Array(width * height);

  for (const feature of features.features) {
    const strataType = feature.properties.strataType;
    const mode: 'fill' | 'stroke' = strataType === 'road' ? 'stroke' : 'fill';

    rasterizeGeometry(
      canvas,
      ctx,
      feature.geometry,
      bounds,
      width,
      height,
      mode,
    );

    const mask = readMaskFromCanvas(ctx, width, height);
    const target =
      strataType === 'building'
        ? building
        : strataType === 'road'
          ? road
          : water;

    for (let i = 0; i < mask.length; i++) {
      if (mask[i] > target[i]) {
        target[i] = mask[i];
      }
    }
  }

  return { width, height, building, road, water };
}

function projectPoint(
  point: Point,
  bounds: GeoBounds,
  width: number,
  height: number,
): { x: number; y: number } {
  return projectGeoPoint(point[0], point[1], bounds, width, height);
}

function rasterizeGeometry(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  geometry: GeoGeometry,
  bounds: GeoBounds,
  width: number,
  height: number,
  mode: 'fill' | 'stroke',
): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

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

function readMaskFromCanvas(
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
