import { decodeTerrainGeoTiff } from "./terrainGeoTiff.ts";
import {
  lngToPixelX,
  latToPixelY,
  normalizeBounds,
} from "../engine/projection.ts";
import type { ElevationGrid, GeoBounds } from "../engine/types.ts";
import { getTile, setTile } from "./cache.ts";
import {
  abortErrorFromSignal,
  AttemptBudget,
  createRequestOperation,
  isAbortFailure,
  RequestPolicyError,
  requestFailureFromResponse,
  runRequestAttempt,
  systemRequestPolicyRuntime,
  waitForRetry,
  type RequestPolicyRuntime,
} from "./requestPolicy.ts";

/** Direct AWS is a deliberate runtime fallback, never the preferred production provider. */
export const DIRECT_TERRAIN_TILE_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/geotiff/{z}/{x}/{y}.tif";

const configuredTerrainUrl = import.meta.env.VITE_TERRAIN_TILE_URL?.trim();
const CONFIGURED_TERRAIN_PROXY_URL =
  configuredTerrainUrl && configuredTerrainUrl !== DIRECT_TERRAIN_TILE_URL
    ? configuredTerrainUrl.replace(/\/terrain\/?$/, "/terrain-geotiff/{z}/{x}/{y}.tif")
    : undefined;

/** Preferred tile URL retained as a public export for diagnostics/build assertions. */
export const TERRAIN_TILE_URL: string =
  CONFIGURED_TERRAIN_PROXY_URL || DIRECT_TERRAIN_TILE_URL;

export const TERRAIN_ATTRIBUTION =
  "Terrain: Tilezen scalar GeoTIFF via AWS Open Data (elevation data courtesy of USGS, NASA SRTM, and other sources)";

const TILE_SIZE = 512;
const MAX_ZOOM = 14;
const TILE_ATTEMPT_TIMEOUT_MS = 8000;
const TILE_OPERATION_TIMEOUT_MS = 30000;
const TILE_ATTEMPT_LIMIT = 3;
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 2500;
const MAX_CONCURRENCY = 6;
const DEFAULT_FETCH_DEADLINE_MS = 25000;
const PROXY_FAILURE_THRESHOLD = 2;
const PROXY_COOLDOWN_MS = 15000;

export type TerrainProviderName = "proxy" | "direct";

function tileUrl(template: string, z: number, x: number, y: number): string {
  if (template.includes("{z}")) {
    return template
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
  }
  return `${template.replace(/\/$/, "")}/${z}/${x}/${y}.${template.includes("terrain-geotiff") ? "tif" : "png"}`;
}


function discardResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    cancellation?.catch(() => {
      // The status failure is authoritative; cancellation is best effort.
    });
  } catch {
    // A locked/already-consumed body is already owned by its reader.
  }
}

async function decodeTerrainResponse(response: Response, signal: AbortSignal): Promise<Float32Array> {
  const contentType=response.headers.get("Content-Type")?.split(";",1)[0]?.trim();
  if(contentType!=="image/tiff" && contentType!=="image/geotiff" && contentType!=="application/octet-stream") {
    discardResponseBody(response);
    throw new RequestPolicyError("decode","Terrain source did not return a scalar GeoTIFF");
  }
  const reader=response.body?.getReader();
  if(!reader)throw new RequestPolicyError("decode","Terrain source returned no data");
  const chunks:Uint8Array[]=[];let length=0;
  try {
    for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;
      if(length>2*1024*1024)throw new RequestPolicyError("decode","Terrain raster exceeded its size limit");chunks.push(value);}
  } finally {void reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return decodeTerrainGeoTiff(bytes.buffer,signal);
}

function isCircuitFailure(error: RequestPolicyError): boolean {
  return (
    error.kind === "network" ||
    error.kind === "attempt-timeout" ||
    error.kind === "rate-limited" ||
    error.kind === "http-server"
  );
}

export type ProxyCircuitBreakerOptions = {
  failureThreshold?: number;
  cooldownMs?: number;
  runtime?: RequestPolicyRuntime;
};

/** Short process-local breaker that protects the proxy without reacting to caller cancellation. */
export class ProxyCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly runtime: RequestPolicyRuntime;
  private failures = 0;
  private openUntil = 0;

  constructor(options: ProxyCircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? PROXY_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? PROXY_COOLDOWN_MS;
    this.runtime = options.runtime ?? systemRequestPolicyRuntime;
  }

  canRequest(): boolean {
    if (this.openUntil === 0) return true;
    if (this.runtime.now() < this.openUntil) return false;
    this.openUntil = 0;
    this.failures = 0;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure(error: RequestPolicyError): void {
    if (!isCircuitFailure(error)) return;
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.openUntil = this.runtime.now() + this.cooldownMs;
    }
  }

  snapshot(): { failures: number; open: boolean; openUntil: number } {
    return {
      failures: this.failures,
      open: this.openUntil > this.runtime.now(),
      openUntil: this.openUntil,
    };
  }
}

export type SharedLoad<T> = {
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
};

/** Caller-scoped view: one subscriber abort never poisons another live subscriber. */
export function attachSubscriber<T>(
  shared: SharedLoad<T>,
  signal?: AbortSignal,
): Promise<T> {
  shared.subscribers++;
  let active = true;
  const release = (abortUnderlying: boolean, reason?: RequestPolicyError) => {
    if (!active) return;
    active = false;
    shared.subscribers--;
    if (abortUnderlying && shared.subscribers <= 0 && !shared.controller.signal.aborted) {
      shared.controller.abort(reason);
    }
  };

  if (!signal) {
    return shared.promise.then(
      (value) => {
        release(false);
        return value;
      },
      (error) => {
        release(false);
        throw error;
      },
    );
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const error = abortErrorFromSignal(signal);
      release(true, error);
      reject(error);
    };
    // Attach upstream settlement handlers before observing an already-aborted
    // subscriber. Otherwise aborting the only subscriber can reject the shared
    // load without any rejection handler, surfacing as page-level noise.
    shared.promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        release(false);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        release(false);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type TerrainTileLoader = {
  /** Native scalar GeoTIFF size; injectable legacy fixtures may use 256. */
  tileSize?: 256 | 512;
  getTileData: (
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ) => Promise<Float32Array>;
  circuit: ProxyCircuitBreaker;
};

export type TerrainFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type TerrainTileLoaderDependencies = {
  proxyUrl?: string;
  directUrl?: string;
  runtime?: RequestPolicyRuntime;
  fetch?: TerrainFetch;
  getCachedTile?: typeof getTile;
  setCachedTile?: typeof setTile;
  decodeResponse?: (response: Response, signal: AbortSignal) => Promise<Float32Array>;
  isOnline?: () => boolean;
  circuit?: ProxyCircuitBreaker;
};

/** Provider-aware, cache-first tile loader with one shared in-flight request per z/x/y. */
export function createTerrainTileLoader(
  dependencies: TerrainTileLoaderDependencies = {},
): TerrainTileLoader {
  const runtime = dependencies.runtime ?? systemRequestPolicyRuntime;
  const proxyUrl = dependencies.proxyUrl?.trim() || undefined;
  const directUrl = dependencies.directUrl ?? DIRECT_TERRAIN_TILE_URL;
  const fetchImpl: TerrainFetch =
    dependencies.fetch ?? ((input, init) => fetch(input, init));
  const getCachedTile = dependencies.getCachedTile ?? getTile;
  const setCachedTile = dependencies.setCachedTile ?? setTile;
  const decodeResponse = dependencies.decodeResponse ?? decodeTerrainResponse;
  const isOnline =
    dependencies.isOnline ??
    (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const circuit = dependencies.circuit ?? new ProxyCircuitBreaker({ runtime });
  const inflightTiles = new Map<string, SharedLoad<Float32Array>>();

  const requestProvider = async (
    provider: TerrainProviderName,
    template: string,
    z: number,
    x: number,
    y: number,
    operation: ReturnType<typeof createRequestOperation>,
    budget: AttemptBudget,
  ): Promise<Float32Array> => {
    const url = tileUrl(template, z, x, y);
    return runRequestAttempt({
      operation,
      budget,
      timeoutMs: TILE_ATTEMPT_TIMEOUT_MS,
      provider,
      run: async ({ signal }) => {
        const response = await fetchImpl(url, { signal });
        if (!response.ok) {
          discardResponseBody(response);
          throw requestFailureFromResponse(response, url, {
            provider,
            nowMs: runtime.now(),
          });
        }
        try {
          return await decodeResponse(response, signal);
        } catch (error) {
          if (signal.aborted) throw abortErrorFromSignal(signal);
          if (error instanceof RequestPolicyError) throw error;
          throw new RequestPolicyError("decode", "Terrain tile image could not be decoded", {
            provider,
            cause: error,
          });
        }
      },
    });
  };

  const loadUncachedTile = async (
    z: number,
    x: number,
    y: number,
    signal: AbortSignal,
  ): Promise<Float32Array> => {
    const operation = createRequestOperation({
      signal,
      timeoutMs: TILE_OPERATION_TIMEOUT_MS,
      runtime,
      label: "Terrain tile",
    });
    const budget = new AttemptBudget(TILE_ATTEMPT_LIMIT);
    let provider: TerrainProviderName = proxyUrl && circuit.canRequest() ? "proxy" : "direct";
    let proxyAttempts = 0;
    let retryIndex = 0;
    let lastFailure: RequestPolicyError | undefined;

    try {
      while (budget.remaining > 0) {
        operation.throwIfAborted();
        const template = provider === "proxy" ? proxyUrl : directUrl;
        if (!template) {
          provider = "direct";
          continue;
        }

        if (provider === "proxy" && !circuit.canRequest()) {
          provider = "direct";
          continue;
        }

        try {
          const data = await requestProvider(
            provider,
            template,
            z,
            x,
            y,
            operation,
            budget,
          );
          if (provider === "proxy") circuit.recordSuccess();
          return data;
        } catch (error) {
          const failure =
            error instanceof RequestPolicyError
              ? error
              : new RequestPolicyError("unknown", String(error), {
                  provider,
                  cause: error,
                });
          lastFailure = failure;
          if (isAbortFailure(failure) || failure.kind === "attempt-budget") throw failure;

          if (provider === "proxy") {
            proxyAttempts++;
            circuit.recordFailure(failure);
            const retryProxy =
              failure.retryable &&
              proxyAttempts < 2 &&
              budget.remaining > 0 &&
              circuit.canRequest();
            if (retryProxy) {
              try {
                await waitForRetry({
                  operation,
                  failure,
                  retryIndex: retryIndex++,
                  baseBackoffMs: BASE_BACKOFF_MS,
                  maxBackoffMs: MAX_BACKOFF_MS,
                });
                continue;
              } catch (retryError) {
                const retryDeadlineExceeded =
                  retryError instanceof RequestPolicyError &&
                  retryError.kind === "operation-deadline" &&
                  !operation.signal.aborted;
                if (!retryDeadlineExceeded) throw retryError;
              }
            }
            provider = "direct";
            continue;
          }

          if (!failure.retryable || budget.remaining <= 0) throw failure;
          await waitForRetry({
            operation,
            failure,
            retryIndex: retryIndex++,
            baseBackoffMs: BASE_BACKOFF_MS,
            maxBackoffMs: MAX_BACKOFF_MS,
          });
        }
      }
      throw (
        lastFailure ??
        new RequestPolicyError("attempt-budget", "Terrain tile attempt budget exhausted")
      );
    } finally {
      operation.dispose();
    }
  };

  const loadTileData = async (
    z: number,
    x: number,
    y: number,
    signal: AbortSignal,
  ): Promise<Float32Array> => {
    if (signal.aborted) throw abortErrorFromSignal(signal);
    const cached = await getCachedTile(z, x, y);
    if (signal.aborted) throw abortErrorFromSignal(signal);
    if (cached) return cached;
    if (!isOnline()) {
      throw new RequestPolicyError(
        "offline",
        "Offline and terrain tile is not available in cache",
      );
    }

    const data = await loadUncachedTile(z, x, y, signal);
    await setCachedTile(z, x, y, data);
    return data;
  };

  const getTileData = (
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<Float32Array> => {
    if (signal?.aborted) return Promise.reject(abortErrorFromSignal(signal));

    const key = `${z}/${x}/${y}`;
    let shared = inflightTiles.get(key);
    // The last subscriber aborts the underlying request synchronously, while
    // its promise/map cleanup settles in a later microtask. A new caller in
    // that window must start fresh instead of inheriting the prior abort.
    if (shared?.controller.signal.aborted) {
      if (inflightTiles.get(key) === shared) inflightTiles.delete(key);
      shared = undefined;
    }
    if (!shared) {
      const controller = new AbortController();
      let load!: SharedLoad<Float32Array>;
      const promise = loadTileData(z, x, y, controller.signal).finally(() => {
        // An older aborted load must not delete a replacement installed before
        // this cleanup callback runs.
        if (inflightTiles.get(key) === load) inflightTiles.delete(key);
      });
      load = { controller, subscribers: 0, promise };
      inflightTiles.set(key, load);
      shared = load;
    }
    return attachSubscriber(shared, signal);
  };

  return { getTileData, circuit, tileSize: TILE_SIZE };
}

const terrainTileLoader = createTerrainTileLoader({
  proxyUrl: CONFIGURED_TERRAIN_PROXY_URL,
});

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

export type TerrainGridDimensions = number | { width: number; height: number };

function normalizeGridDimensions(dimensions: TerrainGridDimensions): {
  width: number;
  height: number;
  longest: number;
} {
  const width =
    typeof dimensions === "number" ? dimensions : dimensions.width;
  const height =
    typeof dimensions === "number" ? dimensions : dimensions.height;
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.round(width)) : 1;
  const safeHeight = Number.isFinite(height) ? Math.max(1, Math.round(height)) : 1;
  return { width: safeWidth, height: safeHeight, longest: Math.max(safeWidth, safeHeight) };
}

function selectZoom(bounds: GeoBounds, longestDimension: number, tileSize: number): number {
  const scale = tileSize / 256;
  const maxZoom = tileSize === 512 ? MAX_ZOOM : 15;
  let selected = 0;
  for (let z = 0; z <= maxZoom; z++) {
    const west = lngToPixelX(bounds.west, z) * scale;
    const east = lngToPixelX(bounds.east, z) * scale;
    const north = latToPixelY(bounds.north, z) * scale;
    const south = latToPixelY(bounds.south, z) * scale;
    const width = Math.abs(east - west);
    const height = Math.abs(south - north);
    if (Math.max(width, height) >= longestDimension) {
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

function computeTileRange(bounds: GeoBounds, dimensions: TerrainGridDimensions, tileSize = TILE_SIZE): TileRange {
  const scale = tileSize / 256;
  const normalized = normalizeBounds(bounds);
  const { longest } = normalizeGridDimensions(dimensions);
  const zoom = selectZoom(normalized, longest, tileSize);
  const westPx = lngToPixelX(normalized.west, zoom) * scale;
  const eastPx = lngToPixelX(normalized.east, zoom) * scale;
  const northPx = latToPixelY(normalized.north, zoom) * scale;
  const southPx = latToPixelY(normalized.south, zoom) * scale;

  const minX = Math.min(westPx, eastPx);
  const maxX = Math.max(westPx, eastPx);
  const minY = Math.min(northPx, southPx);
  const maxY = Math.max(northPx, southPx);

  const tileForPixel = (pixel: number) => Math.max(0, Math.min(2 ** zoom - 1, Math.floor(pixel / tileSize)));
  return {
    normalized,
    zoom,
    minX,
    maxX,
    minY,
    maxY,
    // Scalar GeoTIFF samples are pixel-centered. Include every integer sample
    // needed by bilinear interpolation, even just beyond the selected tile.
    minTx: tileForPixel(Math.floor(minX - 0.5)),
    maxTx: tileForPixel(Math.ceil(maxX - 0.5)),
    minTy: tileForPixel(Math.floor(minY - 0.5)),
    maxTy: tileForPixel(Math.ceil(maxY - 0.5)),
  };
}

/** Number of tiles fetchTerrain would request for the given bounds and grid dimensions. */
export function tileCountForFetch(
  bounds: GeoBounds,
  dimensions: TerrainGridDimensions,
  tileSize = TILE_SIZE,
): number {
  const { minTx, maxTx, minTy, maxTy } = computeTileRange(bounds, dimensions, tileSize);
  return (maxTx - minTx + 1) * (maxTy - minTy + 1);
}

function sampleBilinear(read: (x: number, y: number) => number, px: number, py: number): number {
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.ceil(px), y1 = Math.ceil(py);
  const fx = px - x0, fy = py - y0;
  const v00 = read(x0, y0);
  const v10 = fx === 0 ? v00 : read(x1, y0);
  const top = v00 * (1 - fx) + v10 * fx;
  if (fy === 0) return top;
  const v01 = read(x0, y1);
  const v11 = fx === 0 ? v01 : read(x1, y1);
  return top * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

export type TerrainFetchOptions = {
  onDiagnostics?: (diagnostics: { totalTiles: number; failedTiles: number }) => void;
  operationTimeoutMs?: number;
  runtime?: RequestPolicyRuntime;
  tileLoader?: Pick<TerrainTileLoader, "getTileData" | "tileSize">;
};

export class TerrainLoadError extends Error {
  readonly kind: "all-tiles-failed" | "incomplete-terrain";

  constructor(message: string, cause?: unknown, kind: "all-tiles-failed" | "incomplete-terrain" = "all-tiles-failed") {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TerrainLoadError";
    this.kind = kind;
  }
}

export async function fetchTerrain(
  bounds: GeoBounds,
  dimensions: TerrainGridDimensions,
  signal?: AbortSignal,
  options: TerrainFetchOptions = {},
): Promise<ElevationGrid> {
  const operation = createRequestOperation({
    signal,
    timeoutMs: options.operationTimeoutMs ?? DEFAULT_FETCH_DEADLINE_MS,
    runtime: options.runtime,
    label: "Terrain fetch",
  });
  const loader = options.tileLoader ?? terrainTileLoader;
  const tileSize = loader.tileSize ?? 256;

  try {
    // Reject pre-aborted/zero-deadline operations before constructing tile
    // tasks or shared loads.
    operation.throwIfAborted();
    const grid = normalizeGridDimensions(dimensions);
    const { normalized, zoom, minX, maxX, minY, maxY, minTx, maxTx, minTy, maxTy } =
      computeTileRange(bounds, grid, tileSize);

    const tilesPerAxis = 2 ** zoom;
    const worldLastSample = tileSize * tilesPerAxis - 1;
    const tileCache = new Map<number, Float32Array>();
    const tileKeys: { key: number; tx: number; ty: number }[] = [];
    let failedCount = 0;
    let firstFailure: unknown;

    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        tileKeys.push({ key: ty * tilesPerAxis + tx, tx, ty });
      }
    }

    const tileTasks = tileKeys.map(
      ({ key, tx, ty }) =>
        async () => {
          try {
            const data = await loader.getTileData(zoom, tx, ty, operation.signal);
            tileCache.set(key, data);
          } catch (error) {
            if (operation.signal.aborted) {
              throw abortErrorFromSignal(operation.signal);
            }
            firstFailure ??= error;
            failedCount++;
            // Never substitute zero elevations for missing source tiles.
          }
        },
    );

    await runWithConcurrency(tileTasks, MAX_CONCURRENCY);

    const totalTiles = tileKeys.length;
    options.onDiagnostics?.({ totalTiles, failedTiles: failedCount });

    if (failedCount > 0 && failedCount === totalTiles) {
      throw new TerrainLoadError("All terrain tiles failed to load", firstFailure);
    }

    if (failedCount > 0) throw new TerrainLoadError("Terrain coverage is incomplete. Retry instead of rendering invented zero-height areas.", firstFailure, "incomplete-terrain");
    const data = new Float32Array(grid.width * grid.height);
    const sourceWidth = maxX - minX;
    const sourceHeight = maxY - minY;

    // GDAL/Tilezen registers sample (0,0) at world pixel center (.5,.5).
    // Clamp at the finite world's edges; latitude never wraps to another pole.
    const readSample = (x: number, y: number): number => {
      const tx = Math.floor(x / tileSize), ty = Math.floor(y / tileSize);
      const tile = tileCache.get(ty * tilesPerAxis + tx);
      if (!tile) throw new Error("Required terrain interpolation tile is missing");
      return tile[(y - ty * tileSize) * tileSize + x - tx * tileSize];
    };
    for (let row = 0; row < grid.height; row++) {
      const y = minY + (row / (grid.height - 1 || 1)) * sourceHeight;
      const py = Math.max(0, Math.min(worldLastSample, y - 0.5));
      for (let col = 0; col < grid.width; col++) {
        const x = minX + (col / (grid.width - 1 || 1)) * sourceWidth;
        const px = Math.max(0, Math.min(worldLastSample, x - 0.5));
        data[row * grid.width + col] = sampleBilinear(readSample, px, py);
      }
    }

    return { width: grid.width, height: grid.height, bounds: normalized, data };
  } finally {
    operation.dispose();
  }
}
