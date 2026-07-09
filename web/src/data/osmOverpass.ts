import type {
  GeoBounds,
  GeoFeature,
  GeoFeatureCollection,
  GeoGeometry,
  WaterType,
} from "../engine/types.ts";
import { getOsm, setOsm } from "./cache.ts";

export const OSM_ATTRIBUTION = "OpenStreetMap contributors";
export const MAX_BBOX_KM2 = 25;

type OverpassMember = {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
};

type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: OverpassMember[];
  tags?: Record<string, string>;
};

export function bboxAreaKm2(bounds: GeoBounds): number {
  const deltaLng = bounds.east - bounds.west;
  const deltaLat = bounds.north - bounds.south;
  const meanLat = (bounds.north + bounds.south) / 2;
  const rad = (meanLat * Math.PI) / 180;
  return Math.abs(Math.cos(rad) * deltaLng * 111.32 * deltaLat * 110.57);
}

export function isBboxSmallEnough(bounds: GeoBounds): boolean {
  return bboxAreaKm2(bounds) <= MAX_BBOX_KM2;
}

export function buildOverpassQuery(bounds: GeoBounds): string {
  const bbox = `(${bounds.south},${bounds.west},${bounds.north},${bounds.east})`;
  return `[out:json][timeout:25];
(
  way["building"]${bbox};
  way["highway"]${bbox};
  way["natural"="water"]${bbox};
  way["waterway"]${bbox};
  way["natural"="coastline"]${bbox};
  relation["natural"="water"]${bbox};
  relation["waterway"]${bbox};
);
out body;
>;
out body;`;
}

export function classifyFeature(
  tags: Record<string, string>,
): "building" | "road" | "water" {
  if (tags.building !== undefined) return "building";
  if (tags.highway !== undefined) return "road";
  if (
    tags.natural === "water" ||
    tags.natural === "coastline" ||
    tags.waterway !== undefined
  ) {
    return "water";
  }
  return "building";
}

const RIVER_WATER_VALUES = new Set([
  "river",
  "canal",
  "stream",
  "ditch",
  "drain",
  "oxbow",
  "rapids",
  "moat",
]);

const RIVER_WATERWAY_VALUES = new Set([
  "river",
  "riverbank",
  "canal",
  "stream",
  "tidal_channel",
  "ditch",
  "drain",
]);

export function classifyWaterType(
  tags: Record<string, string>,
): WaterType | undefined {
  if (classifyFeature(tags) !== "water") return undefined;
  if (tags.natural === "coastline") return "ocean";
  if (tags.water !== undefined) {
    if (tags.water === "ocean" || tags.water === "sea" || tags.water === "lagoon") return "ocean";
    if (RIVER_WATER_VALUES.has(tags.water)) return "river";
    return "lake";
  }
  if (tags.waterway !== undefined) {
    return RIVER_WATERWAY_VALUES.has(tags.waterway) ? "river" : "lake";
  }
  return "lake";
}

/** Chains member ways into closed rings by matching shared endpoint node IDs. */
function assembleRings(memberNodeLists: number[][]): number[][] {
  const remaining = memberNodeLists
    .map((nodes) => [...nodes])
    .filter((nodes) => nodes.length >= 2);
  const rings: number[][] = [];

  while (remaining.length > 0) {
    const ring = remaining.shift()!;
    let extended = true;
    while (extended && ring[0] !== ring[ring.length - 1]) {
      extended = false;
      const head = ring[0];
      const tail = ring[ring.length - 1];
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        if (seg[0] === tail) {
          ring.push(...seg.slice(1));
        } else if (seg[seg.length - 1] === tail) {
          ring.push(...seg.slice(0, -1).reverse());
        } else if (seg[seg.length - 1] === head) {
          ring.unshift(...seg.slice(0, -1));
        } else if (seg[0] === head) {
          ring.unshift(...seg.slice(1).reverse());
        } else {
          continue;
        }
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) {
      rings.push(ring);
    }
  }

  return rings;
}

/** Chains open ways into maximal polylines by shared endpoint node IDs. */
function chainOpenWays(memberNodeLists: number[][]): number[][] {
  const remaining = memberNodeLists
    .map((nodes) => [...nodes])
    .filter((nodes) => nodes.length >= 2);
  const chains: number[][] = [];

  while (remaining.length > 0) {
    const chain = remaining.shift()!;
    let extended = true;
    while (extended && chain[0] !== chain[chain.length - 1]) {
      extended = false;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        if (seg[0] === tail) {
          chain.push(...seg.slice(1));
        } else if (seg[seg.length - 1] === tail) {
          chain.push(...seg.slice(0, -1).reverse());
        } else if (seg[seg.length - 1] === head) {
          chain.unshift(...seg.slice(0, -1));
        } else if (seg[0] === head) {
          chain.unshift(...seg.slice(1).reverse());
        } else {
          continue;
        }
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    chains.push(chain);
  }

  return chains;
}

/**
 * Ray-casting point-in-polygon test for a closed ring (first point == last
 * point). Returns true if the point is strictly inside the ring.
 */
function isPointInRing(point: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function overpassToGeoJSON(
  response: { elements: OverpassElement[] },
): GeoFeatureCollection {
  const nodes = new Map<number, [number, number]>();
  const waysById = new Map<number, OverpassElement>();
  const relations: OverpassElement[] = [];

  for (const el of response.elements) {
    if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
      nodes.set(el.id, [el.lon, el.lat]);
    } else if (el.type === "way") {
      waysById.set(el.id, el);
    } else if (el.type === "relation") {
      relations.push(el);
    }
  }

  const features: GeoFeature[] = [];
  const consumedWayIds = new Set<number>();

  const nodesToCoords = (nodeIds: number[]): [number, number][] => {
    const coords: [number, number][] = [];
    for (const nodeId of nodeIds) {
      const point = nodes.get(nodeId);
      if (point) coords.push(point);
    }
    return coords;
  };

  // Assemble water multipolygon relations (lakes, wide rivers, reservoirs).
  for (const relation of relations) {
    const tags = relation.tags ?? {};
    if (classifyFeature(tags) !== "water") continue;

    const collectRings = (role: "outer" | "inner") => {
      const memberWays = (relation.members ?? [])
        .filter((m) => m.type === "way" && (m.role === role || (role === "outer" && m.role === "")))
        .map((m) => waysById.get(m.ref))
        .filter((w): w is OverpassElement => w !== undefined);
      const rings = assembleRings(memberWays.map((w) => w.nodes ?? []));
      for (const w of memberWays) consumedWayIds.add(w.id);
      return rings.map(nodesToCoords).filter((coords) => coords.length >= 4);
    };

    const outers = collectRings("outer");
    const inners = collectRings("inner");
    if (outers.length === 0) continue;

    // Assign each inner ring to the outer ring that contains it. This avoids
    // duplicating inners across all outers, which would flip evenodd hole
    // parity and fill holes with water.
    const polygons: [number, number][][][] = outers.map((outer) => {
      const contained = inners.filter((inner) =>
        inner.length > 0 ? isPointInRing(inner[0], outer) : false,
      );
      return [outer, ...contained];
    });
    const geometry: GeoGeometry =
      polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0] }
        : { type: "MultiPolygon", coordinates: polygons };

    features.push({
      type: "Feature",
      geometry,
      properties: {
        ...tags,
        strataType: "water",
        waterType: classifyWaterType(tags),
      },
    });
  }

  // Chain coastline ways into maximal segments so the ocean can be filled
  // from consistent, connected coastline geometry.
  const coastlineWays: OverpassElement[] = [];
  for (const way of waysById.values()) {
    if (consumedWayIds.has(way.id)) continue;
    if ((way.tags ?? {}).natural === "coastline") {
      coastlineWays.push(way);
      consumedWayIds.add(way.id);
    }
  }
  for (const chain of chainOpenWays(coastlineWays.map((w) => w.nodes ?? []))) {
    const coords = nodesToCoords(chain);
    if (coords.length < 2) continue;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {
        natural: "coastline",
        strataType: "water",
        waterType: "ocean",
      },
    });
  }

  for (const way of waysById.values()) {
    if (consumedWayIds.has(way.id)) continue;

    const coords = nodesToCoords(way.nodes ?? []);
    if (coords.length < 2) continue;

    const tags = way.tags ?? {};
    const strataType = classifyFeature(tags);
    const waterType = classifyWaterType(tags);

    const isClosed =
      coords.length >= 4 &&
      coords[0][0] === coords[coords.length - 1][0] &&
      coords[0][1] === coords[coords.length - 1][1];

    const geometry: GeoGeometry = isClosed
      ? { type: "Polygon", coordinates: [coords] }
      : { type: "LineString", coordinates: coords };

    const feature: GeoFeature = {
      type: "Feature",
      geometry,
      properties: {
        ...tags,
        strataType,
        ...(waterType ? { waterType } : {}),
      },
    };
    features.push(feature);
  }

  return { type: "FeatureCollection", features };
}

function boundsCacheKey(bounds: GeoBounds): string {
  // v2: invalidates pre-relation/pre-waterType cached responses.
  return `v2:${bounds.south.toFixed(4)},${bounds.west.toFixed(4)},${bounds.north.toFixed(4)},${bounds.east.toFixed(4)}`;
}

const OSM_MAX_RETRIES = 2;
const OSM_BASE_BACKOFF_MS = 1500;

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

/** Returns true if the error is retryable (rate limit, timeout, network). */
function isRetryableOsmError(status: number | undefined, text: string): boolean {
  if (status === 429 || status === 504 || status === 502 || status === 503) return true;
  if (/timeout|too busy|server is probably too busy|rate limit/i.test(text)) return true;
  return false;
}

export async function fetchOsmFeatures(
  bounds: GeoBounds,
  signal?: AbortSignal,
): Promise<GeoFeatureCollection> {
  if (!isBboxSmallEnough(bounds)) {
    throw new Error(
      `Bounding box is too large (> ${MAX_BBOX_KM2} km²). Please zoom in.`,
    );
  }

  const cacheKey = boundsCacheKey(bounds);
  const cached = await getOsm(cacheKey);
  if (cached) return cached;

  const query = buildOverpassQuery(bounds);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= OSM_MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("OSM fetch was cancelled.");

    let response: Response;
    try {
      response = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("OSM fetch was cancelled.");
      }
      // Network error — retryable
      lastError = new Error(
        `Network error while fetching OSM features: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt < OSM_MAX_RETRIES) {
        const backoff = OSM_BASE_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(backoff, signal);
        continue;
      }
      throw lastError;
    }

    if (!response.ok) {
      const text = await response.text();
      if (isRetryableOsmError(response.status, text)) {
        // Honor Retry-After header if present
        const retryAfter = response.headers.get("Retry-After");
        const backoff = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000, 30000)
          : OSM_BASE_BACKOFF_MS * Math.pow(2, attempt);
        lastError = new Error(
          response.status === 429
            ? "Overpass API rate limit reached. Please wait a minute before trying again."
            : "Overpass API is too busy right now. This is a public server with rate limits. Please wait a few seconds and try again.",
        );
        if (attempt < OSM_MAX_RETRIES) {
          await sleep(backoff, signal);
          continue;
        }
        throw lastError;
      }
      throw new Error(
        `Overpass API returned ${response.status}: ${text.slice(0, 120).replace(/\s+/g, " ")}`,
      );
    }

    let data: { elements: OverpassElement[] };
    try {
      data = await response.json();
    } catch (err) {
      throw new Error(
        `Failed to parse Overpass API response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = overpassToGeoJSON(data);
    await setOsm(cacheKey, result);
    return result;
  }

  throw lastError ?? new Error("OSM fetch failed after retries.");
}
