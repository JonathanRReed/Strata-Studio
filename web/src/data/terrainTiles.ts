import {
  lngToPixelX,
  latToPixelY,
  tileXForPixel,
  tileYForPixel,
  normalizeBounds,
} from "../engine/projection.ts";
import type { ElevationGrid, GeoBounds } from "../engine/types.ts";
import { getTile, setTile } from "./cache.ts";

/**
 * Tile URL template. Override via VITE_TERRAIN_TILE_URL (e.g. a Cloudflare
 * Worker proxy) using {z}/{x}/{y} placeholders; a bare base URL without
 * placeholders also works and gets /{z}/{x}/{y}.png appended.
 */
export const TERRAIN_TILE_URL: string =
  import.meta.env.VITE_TERRAIN_TILE_URL ??
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

export const TERRAIN_ATTRIBUTION =
  "Terrain: Mapzen/Tilezen terrain tiles via AWS Open Data — elevation data courtesy of USGS, NASA SRTM, and other sources";

const TILE_SIZE = 256;
const MAX_ZOOM = 15;
const LOAD_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 300;
const MAX_CONCURRENCY = 6;

function tileUrl(z: number, x: number, y: number): string {
  if (TERRAIN_TILE_URL.includes("{z}")) {
    return TERRAIN_TILE_URL.replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
  }
  return `${TERRAIN_TILE_URL}/${z}/${x}/${y}.png`;
}

function decodeElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

/** A failure that should not be retried (e.g. 404: the tile does not exist). */
class PermanentTileError extends Error {}

/** Fetch and decode a tile image with a per-attempt timeout. */
async function loadTileBitmap(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  if (signal?.aborted) throw new Error("Aborted");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const message = `Tile fetch failed (${response.status}): ${url}`;
      // 4xx (except 429) means the request itself is bad; retrying won't help.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new PermanentTileError(message);
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch (err) {
    if (signal?.aborted) throw new Error("Aborted");
    if (err instanceof PermanentTileError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Tile load timeout: ${url}`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Load a tile image with exponential backoff retry. */
async function loadTileBitmapWithRetry(
  url: string,
  signal?: AbortSignal,
  maxRetries = MAX_RETRIES,
): Promise<ImageBitmap> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");
    try {
      return await loadTileBitmap(url, signal);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Don't retry on abort
      if (lastError.message === "Aborted") throw lastError;
      // Don't retry permanent failures (4xx other than 429)
      if (lastError instanceof PermanentTileError) throw lastError;
      // Don't retry on the last attempt
      if (attempt < maxRetries) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(backoff, signal);
      }
    }
  }
  throw lastError ?? new Error(`Failed to load tile: ${url}`);
}

async function loadTileData(
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const cached = await getTile(z, x, y);
  if (cached) return cached;

  const url = tileUrl(z, x, y);
  const bitmap = await loadTileBitmapWithRetry(url, signal);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not get canvas context");
    }
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
    const pixels = imageData.data;
    const data = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
      data[j] = decodeElevation(pixels[i], pixels[i + 1], pixels[i + 2]);
    }
    await setTile(z, x, y, data);
    return data;
  } finally {
    bitmap.close();
  }
}

/**
 * In-flight tile loads keyed z/x/y so concurrent fetches share one request.
 * The underlying fetch runs on its OWN controller: each caller gets a
 * subscriber view that rejects on that caller's abort, and the shared fetch
 * is aborted only when its last live subscriber has gone. Without this, a
 * preview fetch aborted by a map move would poison an overlapping export
 * that had innocently joined the same tile promise.
 */
export type SharedLoad<T> = {
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
};

/** Caller-scoped view of a shared load (exported for tests). */
export function attachSubscriber<T>(
  shared: SharedLoad<T>,
  signal?: AbortSignal,
): Promise<T> {
  shared.subscribers++;
  if (!signal) return shared.promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      shared.subscribers--;
      if (shared.subscribers <= 0) shared.controller.abort();
      reject(new Error("Aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    shared.promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const inflightTiles = new Map<string, SharedLoad<Float32Array>>();

function getTileData(
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const key = `${z}/${x}/${y}`;
  let shared = inflightTiles.get(key);
  if (!shared) {
    const controller = new AbortController();
    const load: SharedLoad<Float32Array> = {
      controller,
      subscribers: 0,
      promise: loadTileData(z, x, y, controller.signal).finally(() => {
        inflightTiles.delete(key);
      }),
    };
    inflightTiles.set(key, load);
    shared = load;
  }
  return attachSubscriber(shared, signal);
}

/** Run async tasks with a concurrency cap. */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
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

interface TileRange {
  normalized: GeoBounds;
  zoom: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minTx: number;
  maxTx: number;
  minTy: number;
  maxTy: number;
}

function computeTileRange(bounds: GeoBounds, gridSize: number): TileRange {
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

  return {
    normalized,
    zoom,
    minX,
    maxX,
    minY,
    maxY,
    minTx: tileXForPixel(minX, zoom),
    maxTx: tileXForPixel(maxX, zoom),
    minTy: tileYForPixel(minY, zoom),
    maxTy: tileYForPixel(maxY, zoom),
  };
}

/** Number of tiles fetchTerrain would request for the given bounds and grid size. */
export function tileCountForFetch(bounds: GeoBounds, gridSize: number): number {
  const { minTx, maxTx, minTy, maxTy } = computeTileRange(bounds, gridSize);
  return (maxTx - minTx + 1) * (maxTy - minTy + 1);
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
  opts?: {
    onDiagnostics?: (d: { totalTiles: number; failedTiles: number }) => void;
  },
): Promise<ElevationGrid> {
  const { normalized, zoom, minX, maxX, minY, maxY, minTx, maxTx, minTy, maxTy } =
    computeTileRange(bounds, gridSize);

  const tileCache = new Map<string, Float32Array>();
  const tileKeys: { key: string; tx: number; ty: number }[] = [];
  let failedCount = 0;
  let totalTiles = 0;

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      tileKeys.push({ key: `${zoom}/${tx}/${ty}`, tx, ty });
      totalTiles++;
    }
  }

  const tileTasks = tileKeys.map(
    ({ key, tx, ty }) =>
      () =>
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

  await runWithConcurrency(tileTasks, MAX_CONCURRENCY);

  opts?.onDiagnostics?.({ totalTiles, failedTiles: failedCount });

  if (failedCount > 0 && failedCount === totalTiles) {
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
