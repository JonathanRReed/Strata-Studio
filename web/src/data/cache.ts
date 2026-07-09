import type { GeoFeatureCollection } from "../engine/types.ts";

const DB_NAME = "strata-cache";
const DB_VERSION = 1;
const TILES_STORE = "tiles";
const OSM_STORE = "osm";

let dbPromise: Promise<IDBDatabase> | undefined;

function indexedDbAvailable(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function openDb(): Promise<IDBDatabase> {
  if (!indexedDbAvailable()) {
    return Promise.reject(new Error("IndexedDB not available"));
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(TILES_STORE)) {
        db.createObjectStore(TILES_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(OSM_STORE)) {
        db.createObjectStore(OSM_STORE, { keyPath: "key" });
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
    const result = await requestToPromise<{ key: string; data: Float32Array } | undefined>(
      store.get(key),
    );
    return result?.data;
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
    const store = openStore(db, TILES_STORE, "readwrite");
    await requestToPromise(store.put({ key, data }));
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
    const result = await requestToPromise<{ key: string; data: GeoFeatureCollection } | undefined>(
      store.get(boundsKey),
    );
    return result?.data;
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
    const store = openStore(db, OSM_STORE, "readwrite");
    await requestToPromise(store.put({ key: boundsKey, data }));
  } catch {
    // no-op: cache writes are best-effort
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
