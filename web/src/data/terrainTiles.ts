import {
  lngToPixelX,
  latToPixelY,
  tileXForPixel,
  tileYForPixel,
  normalizeBounds,
} from "../engine/projection.ts";
import type { ElevationGrid, GeoBounds } from "../engine/types.ts";
import { getTile, setTile } from "./cache.ts";

const TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const TILE_SIZE = 256;
const MAX_ZOOM = 15;
const LOAD_TIMEOUT_MS = 15000;

function decodeElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => {
      img.src = "";
      reject(new Error(`Tile load timeout: ${url}`));
    }, LOAD_TIMEOUT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      img.src = "";
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    img.onload = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Tile load error: ${url}`));
    };
    img.src = url;
  });
}

async function getTileData(
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const cached = await getTile(z, x, y);
  if (cached) return cached;

  const url = `${TERRAIN_URL}/${z}/${x}/${y}.png`;
  const img = await loadImage(url, signal);
  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not get canvas context");
  }
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const pixels = imageData.data;
  const data = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
    data[j] = decodeElevation(pixels[i], pixels[i + 1], pixels[i + 2]);
  }
  await setTile(z, x, y, data);
  return data;
}

function selectZoom(bounds: GeoBounds, gridSize: number): number {
  let selected = 0;
  for (let z = 0; z <= MAX_ZOOM; z++) {
    const west = lngToPixelX(bounds.west, z);
    const east = lngToPixelX(bounds.east, z);
    const north = latToPixelY(bounds.north, z);
    const south = latToPixelY(bounds.south, z);
    const width = Math.abs(east - west);
    const height = Math.abs(south - north);
    if (Math.max(width, height) >= gridSize) {
      selected = z;
      break;
    }
    selected = z;
  }
  return selected;
}

function sampleBilinear(tile: Float32Array, px: number, py: number): number {
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, TILE_SIZE - 1);
  const y1 = Math.min(y0 + 1, TILE_SIZE - 1);
  const fx = px - x0;
  const fy = py - y0;

  const i00 = y0 * TILE_SIZE + x0;
  const i10 = y0 * TILE_SIZE + x1;
  const i01 = y1 * TILE_SIZE + x0;
  const i11 = y1 * TILE_SIZE + x1;

  const v00 = tile[i00];
  const v10 = tile[i10];
  const v01 = tile[i01];
  const v11 = tile[i11];

  return (
    v00 * (1 - fx) * (1 - fy) +
    v10 * fx * (1 - fy) +
    v01 * (1 - fx) * fy +
    v11 * fx * fy
  );
}

export async function fetchTerrain(
  bounds: GeoBounds,
  gridSize: number,
  signal?: AbortSignal,
): Promise<ElevationGrid> {
  const normalized = normalizeBounds(bounds);
  const zoom = selectZoom(normalized, gridSize);
  const westPx = lngToPixelX(normalized.west, zoom);
  const eastPx = lngToPixelX(normalized.east, zoom);
  const northPx = latToPixelY(normalized.north, zoom);
  const southPx = latToPixelY(normalized.south, zoom);

  const minX = Math.min(westPx, eastPx);
  const maxX = Math.max(westPx, eastPx);
  const minY = Math.min(northPx, southPx);
  const maxY = Math.max(northPx, southPx);

  const minTx = tileXForPixel(minX, zoom);
  const maxTx = tileXForPixel(maxX, zoom);
  const minTy = tileYForPixel(minY, zoom);
  const maxTy = tileYForPixel(maxY, zoom);

  const tileCache = new Map<string, Float32Array>();
  const tilePromises: Promise<void>[] = [];
  let failedCount = 0;

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const key = `${zoom}/${tx}/${ty}`;
      tilePromises.push(
        getTileData(zoom, tx, ty, signal)
          .then((data) => {
            tileCache.set(key, data);
          })
          .catch(() => {
            failedCount++;
            const fallback = new Float32Array(TILE_SIZE * TILE_SIZE);
            tileCache.set(key, fallback);
          }),
      );
    }
  }

  await Promise.all(tilePromises);

  if (failedCount > 0 && failedCount === tilePromises.length) {
    throw new Error("All terrain tiles failed to load");
  }

  const data = new Float32Array(gridSize * gridSize);
  const width = maxX - minX;
  const height = maxY - minY;

  for (let row = 0; row < gridSize; row++) {
    const y = minY + (row / (gridSize - 1 || 1)) * height;
    const ty = tileYForPixel(y, zoom);
    for (let col = 0; col < gridSize; col++) {
      const x = minX + (col / (gridSize - 1 || 1)) * width;
      const tx = tileXForPixel(x, zoom);
      const key = `${zoom}/${tx}/${ty}`;
      const tile = tileCache.get(key);
      if (!tile) {
        data[row * gridSize + col] = 0;
        continue;
      }
      const px = Math.min(Math.max(x - tx * TILE_SIZE, 0), TILE_SIZE - 0.001);
      const py = Math.min(Math.max(y - ty * TILE_SIZE, 0), TILE_SIZE - 0.001);
      data[row * gridSize + col] = sampleBilinear(tile, px, py);
    }
  }

  return { width: gridSize, height: gridSize, bounds: normalized, data };
}
