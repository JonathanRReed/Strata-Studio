import type { GeoFeatureCollection } from "../engine/types.ts";

const DB_NAME = "strata-cache";
// v2: timestamped records, Int16-packed tiles, ts index for eviction.
// v3: per-record packing scale — v2 packed at a fixed quarter-meter scale,
// silently clamping elevations beyond ±8191.75 m (Everest summit tiles,
// hadal bathymetry). The upgrade handler clears both stores so any clamped
// records are purged (refetching is cheap; corrupted terrain is not).
const DB_VERSION = 3;
const TILES_STORE = "tiles";
const OSM_STORE = "osm";
const TS_INDEX = "ts";

// Terrain data is frozen upstream, so tile TTL is about storage, not staleness.
const TILE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const OSM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Int16-packed tiles are ~131 KB each: 1024 entries ≈ 134 MB worst case.
const MAX_TILE_ENTRIES = 1024;
const MAX_OSM_ENTRIES = 60;
// Only check the entry cap on ~1 of every N writes to keep writes cheap.
const EVICTION_SAMPLE_RATE = 16;

// Elevations are stored as Int16 with a per-record scale chosen from the
// tile's own range: 4 (0.25 m steps, tiles within ±8191 m — nearly all
// land), 2 (0.5 m, covers Everest with headroom), or 1 (1 m, covers full
// terrestrial + hadal range ±32767 m). Even 1 m steps are invisible in
// artwork; what matters is never clamping real extremes (see DB v3 note).
const ELEVATION_SCALES = [4, 2, 1] as const;
const ELEVATION_LIMIT = 32767;

type TileRecord = { key: string; data: Int16Array; scale: number; ts: number };
type OsmRecord = { key: string; data: GeoFeatureCollection; ts: number };

let dbPromise: Promise<IDBDatabase> | undefined;
let persistRequested = false;

function indexedDbAvailable(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function requestPersistence(): void {
  if (persistRequested) return;
  persistRequested = true;
  try {
    void navigator.storage?.persist?.();
  } catch {
    // no-op: persistence is best-effort
  }
}

function openDb(): Promise<IDBDatabase> {
  if (!indexedDbAvailable()) {
    return Promise.reject(new Error("IndexedDB not available"));
  }

  if (dbPromise) return dbPromise;
  requestPersistence();

  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const tx = (event.target as IDBOpenDBRequest).transaction;
      for (const storeName of [TILES_STORE, OSM_STORE]) {
        if (db.objectStoreNames.contains(storeName)) {
          // Records from older versions lack timestamps and use the old
          // encodings — clear rather than migrate.
          tx?.objectStore(storeName).clear();
        } else {
          db.createObjectStore(storeName, { keyPath: "key" });
        }
        const store = tx?.objectStore(storeName);
        if (store && !store.indexNames.contains(TS_INDEX)) {
          store.createIndex(TS_INDEX, "ts");
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });

  return dbPromise;
}

function openStore(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
): IDBObjectStore {
  const transaction = db.transaction(storeName, mode);
  return transaction.objectStore(storeName);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function packElevations(data: Float32Array): { packed: Int16Array; scale: number } {
  let maxAbs = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > maxAbs) maxAbs = abs;
  }
  const scale =
    ELEVATION_SCALES.find((s) => Math.round(maxAbs * s) <= ELEVATION_LIMIT) ??
    ELEVATION_SCALES[ELEVATION_SCALES.length - 1];
  const packed = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const scaled = Math.round(data[i] * scale);
    // Only reachable at scale 1 for values beyond Earth's real range;
    // kept as a guard against NaN/garbage tiles.
    packed[i] = Math.max(-ELEVATION_LIMIT, Math.min(ELEVATION_LIMIT, scaled));
  }
  return { packed, scale };
}

export function unpackElevations(packed: Int16Array, scale: number): Float32Array {
  const data = new Float32Array(packed.length);
  for (let i = 0; i < packed.length; i++) {
    data[i] = packed[i] / scale;
  }
  return data;
}

function isExpired(ts: number | undefined, ttlMs: number): boolean {
  return typeof ts !== "number" || Date.now() - ts > ttlMs;
}

/**
 * Delete the oldest entries (by write timestamp) until the store is back
 * under its cap. Runs on a sample of writes; failures are swallowed.
 */
async function evictOldest(storeName: string, maxEntries: number): Promise<void> {
  const db = await openDb();
  const store = openStore(db, storeName, "readwrite");
  const count = await requestToPromise(store.count());
  if (count <= maxEntries) return;

  let toDelete = count - maxEntries;
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = store.index(TS_INDEX).openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || toDelete <= 0) {
        resolve();
        return;
      }
      cursor.delete();
      toDelete--;
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
}

function maybeEvict(storeName: string, maxEntries: number): void {
  if (Math.random() * EVICTION_SAMPLE_RATE >= 1) return;
  evictOldest(storeName, maxEntries).catch(() => {
    // no-op: eviction is best-effort
  });
}

export async function getTile(
  z: number,
  x: number,
  y: number,
): Promise<Float32Array | undefined> {
  if (!indexedDbAvailable()) return undefined;

  try {
    const db = await openDb();
    const key = `${z}/${x}/${y}`;
    const store = openStore(db, TILES_STORE, "readonly");
    const result = await requestToPromise<TileRecord | undefined>(store.get(key));
    if (!result || isExpired(result.ts, TILE_TTL_MS)) return undefined;
    return unpackElevations(result.data, result.scale);
  } catch {
    return undefined;
  }
}

export async function setTile(
  z: number,
  x: number,
  y: number,
  data: Float32Array,
): Promise<void> {
  if (!indexedDbAvailable()) return;

  try {
    const db = await openDb();
    const key = `${z}/${x}/${y}`;
    const { packed, scale } = packElevations(data);
    const record: TileRecord = { key, data: packed, scale, ts: Date.now() };
    const store = openStore(db, TILES_STORE, "readwrite");
    await requestToPromise(store.put(record));
    maybeEvict(TILES_STORE, MAX_TILE_ENTRIES);
  } catch {
    // no-op: cache writes are best-effort
  }
}

export async function getOsm(
  boundsKey: string,
): Promise<GeoFeatureCollection | undefined> {
  if (!indexedDbAvailable()) return undefined;

  try {
    const db = await openDb();
    const store = openStore(db, OSM_STORE, "readonly");
    const result = await requestToPromise<OsmRecord | undefined>(store.get(boundsKey));
    if (!result || isExpired(result.ts, OSM_TTL_MS)) return undefined;
    return result.data;
  } catch {
    return undefined;
  }
}

export async function setOsm(
  boundsKey: string,
  data: GeoFeatureCollection,
): Promise<void> {
  if (!indexedDbAvailable()) return;

  try {
    const db = await openDb();
    const record: OsmRecord = { key: boundsKey, data, ts: Date.now() };
    const store = openStore(db, OSM_STORE, "readwrite");
    await requestToPromise(store.put(record));
    maybeEvict(OSM_STORE, MAX_OSM_ENTRIES);
  } catch {
    // no-op: cache writes are best-effort
  }
}

export type CacheStats = {
  tileEntries: number;
  osmEntries: number;
  approxBytes: number;
};

/** Rough cache footprint for the settings UI; OSM entries use a coarse estimate. */
export async function cacheStats(): Promise<CacheStats | undefined> {
  if (!indexedDbAvailable()) return undefined;

  try {
    const db = await openDb();
    const tileEntries = await requestToPromise(
      openStore(db, TILES_STORE, "readonly").count(),
    );
    const osmEntries = await requestToPromise(
      openStore(db, OSM_STORE, "readonly").count(),
    );
    const approxBytes = tileEntries * 256 * 256 * 2 + osmEntries * 2 * 1024 * 1024;
    return { tileEntries, osmEntries, approxBytes };
  } catch {
    return undefined;
  }
}

export async function clearCache(): Promise<void> {
  if (!indexedDbAvailable()) return;

  try {
    const db = await openDb();
    const transaction = db.transaction([TILES_STORE, OSM_STORE], "readwrite");
    const stores = [TILES_STORE, OSM_STORE] as const;

    await Promise.all(
      stores.map(
        (storeName) =>
          new Promise<void>((resolve, reject) => {
            const request = transaction.objectStore(storeName).clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          }),
      ),
    );
  } catch {
    // no-op: cache clear is best-effort
  }
}
