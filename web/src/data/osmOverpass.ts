import type {
  GeoBounds,
  GeoFeature,
  GeoFeatureCollection,
  GeoGeometry,
  WaterType,
} from "../engine/types.ts";
import { getOsm, setOsm } from "./cache.ts";
import {
  abortErrorFromSignal,
  AttemptBudget,
  createRequestOperation,
  fullJitterBackoffMs,
  isAbortFailure,
  normalizeRequestFailure,
  RequestPolicyError,
  requestFailureFromResponse,
  runRequestAttempt,
  systemRequestPolicyRuntime,
  waitForRetry,
  type RequestPolicyRuntime,
} from "./requestPolicy.ts";

export const OSM_ATTRIBUTION = "OpenStreetMap contributors";
export const MAX_BBOX_KM2 = 25;
export const MAX_BBOX_SPAN_KM = 25;
export const WEB_MERCATOR_MAX_LAT = 85.05112878;

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

export function bboxDimensionsKm(bounds: GeoBounds): {
  width: number;
  height: number;
} {
  const deltaLng = bounds.east - bounds.west;
  const deltaLat = bounds.north - bounds.south;
  const meanLat = (bounds.north + bounds.south) / 2;
  const rad = (meanLat * Math.PI) / 180;
  return {
    width: Math.abs(Math.cos(rad) * deltaLng * 111.32),
    height: Math.abs(deltaLat * 110.57),
  };
}

export function bboxAreaKm2(bounds: GeoBounds): number {
  const { width, height } = bboxDimensionsKm(bounds);
  return width * height;
}

export function isBboxSmallEnough(bounds: GeoBounds): boolean {
  const coordinates = [bounds.south, bounds.west, bounds.north, bounds.east];
  if (!coordinates.every(Number.isFinite)) return false;
  if (
    bounds.south < -WEB_MERCATOR_MAX_LAT ||
    bounds.north > WEB_MERCATOR_MAX_LAT ||
    bounds.west < -180 ||
    bounds.east > 180 ||
    bounds.south >= bounds.north ||
    bounds.west >= bounds.east
  ) {
    return false;
  }
  const { width, height } = bboxDimensionsKm(bounds);
  return (
    width <= MAX_BBOX_SPAN_KM &&
    height <= MAX_BBOX_SPAN_KM &&
    width * height <= MAX_BBOX_KM2
  );
}

export function buildOverpassQuery(bounds: GeoBounds): string {
  const bbox = `(${bounds.south},${bounds.west},${bounds.north},${bounds.east})`;
  return `[out:json][timeout:15][maxsize:16777216];
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
out skel qt;`;
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
      // The recursion output (`out skel qt`) re-emits relation-member ways
      // without tags; never let an untagged duplicate replace a tagged way.
      const existing = waysById.get(el.id);
      if (existing === undefined || existing.tags === undefined) {
        waysById.set(el.id, el);
      }
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

/** Grid steps (degrees) tried in order when snapping the bbox outward. */
const SNAP_STEPS_DEG = [0.01, 0.005, 0.0025, 0.001, 0.0005, 0.0001];
const PROXY_BBOX_DECIMAL_PLACES = 4;
const OSM_OPERATION_TIMEOUT_MS = 30_000;
// The proxy may spend up to 22 seconds trying two upstreams. Keep its browser
// attempt alive long enough to finish, then reserve the remaining operation
// budget for one distinct direct provider.
const OSM_ATTEMPT_TIMEOUT_MS = 24_000;
const OSM_BASE_BACKOFF_MS = 250;
const OSM_MAX_BACKOFF_MS = 1_500;
const OSM_MAX_RETRY_AFTER_MS = 2_000;
const OSM_MIN_ATTEMPT_RESERVE_MS = 750;

function snapBoundsToGrid(bounds: GeoBounds, step: number): GeoBounds {
  const epsilon = 1e-9;
  return {
    south: Math.floor(bounds.south / step + epsilon) * step,
    west: Math.floor(bounds.west / step + epsilon) * step,
    north: Math.ceil(bounds.north / step - epsilon) * step,
    east: Math.ceil(bounds.east / step - epsilon) * step,
  };
}

/** Nearby selections share a bounded canonical query without exceeding 25 km². */
export function snapBoundsForQuery(bounds: GeoBounds): GeoBounds {
  for (const step of SNAP_STEPS_DEG) {
    const snapped = snapBoundsToGrid(bounds, step);
    if (isBboxSmallEnough(snapped)) return snapped;
  }
  return bounds;
}

function formatProxyCoordinate(value: number): string {
  const formatted = value.toFixed(PROXY_BBOX_DECIMAL_PLACES);
  return formatted === "-0.0000" ? "0.0000" : formatted;
}

/** Exact parameter order/form expected by the proxy's bounded cache key. */
export function canonicalProxyBboxParams(bounds: GeoBounds): string {
  return [
    `south=${formatProxyCoordinate(bounds.south)}`,
    `west=${formatProxyCoordinate(bounds.west)}`,
    `north=${formatProxyCoordinate(bounds.north)}`,
    `east=${formatProxyCoordinate(bounds.east)}`,
  ].join("&");
}

export function proxyOverpassUrl(endpoint: string, bounds: GeoBounds): string {
  return `${endpoint.replace(/\/+$/, "")}?${canonicalProxyBboxParams(bounds)}`;
}

function boundsCacheKey(bounds: GeoBounds): string {
  return `v4:${canonicalProxyBboxParams(bounds)}`;
}

/** Overpass API instances, each attempted at most once after the proxy. */
export const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

export type OverpassEndpoint = {
  url: string;
  kind: "proxy" | "direct";
};

export function overpassEndpoints(
  proxyUrl: string | undefined = import.meta.env.VITE_OVERPASS_URL as string | undefined,
): OverpassEndpoint[] {
  const mirrors: OverpassEndpoint[] = OVERPASS_MIRRORS.map((url) => ({
    url,
    kind: "direct",
  }));
  const configured = proxyUrl?.trim();
  if (!configured) return mirrors;
  // The Worker already tries the first two providers. Keep one distinct direct
  // provider as the browser fallback so one operation cannot retry the same
  // upstreams and silently exceed its aggregate attempt budget.
  return [
    { url: configured.replace(/\/+$/, ""), kind: "proxy" },
    mirrors[mirrors.length - 1]!,
  ];
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function discardResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    cancellation?.catch(() => {
      // The status/media-type failure is authoritative; cancellation is best effort.
    });
  } catch {
    // A locked/already-consumed body is already owned by its reader.
  }
}

function validateOverpassPayload(value: unknown): { elements: OverpassElement[] } {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { elements?: unknown }).elements)
  ) {
    throw new RequestPolicyError(
      "decode",
      "Overpass response is missing an elements array",
      { retryable: true },
    );
  }
  return value as { elements: OverpassElement[] };
}

function boundedRetryDelayMs(
  failure: RequestPolicyError,
  retryIndex: number,
  remainingMs: number,
  endpointsRemaining: number,
  runtime: RequestPolicyRuntime,
): number {
  const reserveMs = endpointsRemaining * OSM_MIN_ATTEMPT_RESERVE_MS;
  const availableMs = Math.max(0, remainingMs - reserveMs);
  if (availableMs === 0) return 0;
  const jitterMs = fullJitterBackoffMs(
    OSM_BASE_BACKOFF_MS,
    OSM_MAX_BACKOFF_MS,
    retryIndex,
    runtime.random,
  );
  return Math.min(
    Math.max(jitterMs, Math.min(failure.retryAfterMs ?? 0, OSM_MAX_RETRY_AFTER_MS)),
    availableMs,
  );
}

export type OsmFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OsmFeatureFetcherDependencies = {
  fetch?: OsmFetch;
  getCached?: typeof getOsm;
  setCached?: typeof setOsm;
  runtime?: RequestPolicyRuntime;
  proxyUrl?: string;
  endpoints?: OverpassEndpoint[];
  operationTimeoutMs?: number;
  attemptTimeoutMs?: number;
};

/** Proxy-first OSM loader with one bounded attempt per configured endpoint. */
export function createOsmFeatureFetcher(
  dependencies: OsmFeatureFetcherDependencies = {},
): (bounds: GeoBounds, signal?: AbortSignal) => Promise<GeoFeatureCollection> {
  const runtime = dependencies.runtime ?? systemRequestPolicyRuntime;
  const fetchImpl = dependencies.fetch ?? ((input, init) => fetch(input, init));
  const getCached = dependencies.getCached ?? getOsm;
  const setCached = dependencies.setCached ?? setOsm;
  const endpoints =
    dependencies.endpoints ?? overpassEndpoints(dependencies.proxyUrl);
  const operationTimeoutMs =
    dependencies.operationTimeoutMs ?? OSM_OPERATION_TIMEOUT_MS;
  const attemptTimeoutMs = dependencies.attemptTimeoutMs ?? OSM_ATTEMPT_TIMEOUT_MS;

  return async (bounds, signal) => {
    if (!isBboxSmallEnough(bounds)) {
      throw new Error(
        `Bounding box is too large (> ${MAX_BBOX_KM2} km²). Please zoom in.`,
      );
    }

    const snapped = snapBoundsForQuery(bounds);
    const cacheKey = boundsCacheKey(snapped);
    const cached = await getCached(cacheKey);
    if (cached) return cached;

    const operation = createRequestOperation({
      signal,
      timeoutMs: operationTimeoutMs,
      runtime,
      label: "OSM fetch",
    });
    const budget = new AttemptBudget(Math.max(1, endpoints.length));
    const query = buildOverpassQuery(snapped);
    let lastFailure: RequestPolicyError | undefined;
    let retryIndex = 0;

    try {
      operation.throwIfAborted();
      for (let index = 0; index < endpoints.length; index++) {
        const endpoint = endpoints[index]!;
        try {
          const result = await runRequestAttempt({
            operation,
            budget,
            timeoutMs: attemptTimeoutMs,
            provider: endpoint.kind,
            run: async ({ signal: attemptSignal }) => {
              const url =
                endpoint.kind === "proxy"
                  ? proxyOverpassUrl(endpoint.url, snapped)
                  : endpoint.url;
              const response = await fetchImpl(
                url,
                endpoint.kind === "proxy"
                  ? { method: "GET", signal: attemptSignal }
                  : {
                      method: "POST",
                      headers: {
                        Accept: "application/json",
                        "Content-Type": "application/x-www-form-urlencoded",
                      },
                      body: new URLSearchParams({ data: query }).toString(),
                      signal: attemptSignal,
                    },
              );
              if (!response.ok) {
                discardResponseBody(response);
                throw requestFailureFromResponse(response, url, {
                  provider: endpoint.kind,
                  nowMs: runtime.now(),
                });
              }
              if (!isJsonContentType(response.headers.get("Content-Type"))) {
                discardResponseBody(response);
                throw new RequestPolicyError(
                  "decode",
                  "Overpass response did not use a JSON content type",
                  { provider: endpoint.kind, retryable: true },
                );
              }

              let payload: unknown;
              try {
                payload = await response.json();
              } catch (error) {
                if (attemptSignal.aborted) {
                  throw abortErrorFromSignal(attemptSignal);
                }
                throw new RequestPolicyError(
                  "decode",
                  "Overpass response contained malformed JSON",
                  { provider: endpoint.kind, retryable: true, cause: error },
                );
              }
              try {
                return overpassToGeoJSON(validateOverpassPayload(payload));
              } catch (error) {
                if (error instanceof RequestPolicyError) throw error;
                throw new RequestPolicyError(
                  "decode",
                  "Overpass response could not be converted",
                  { provider: endpoint.kind, retryable: true, cause: error },
                );
              }
            },
          });
          await setCached(cacheKey, result);
          return result;
        } catch (error) {
          const failure = normalizeRequestFailure(error, endpoint.kind);
          lastFailure = failure;
          if (isAbortFailure(failure) || failure.kind === "attempt-budget") {
            throw failure;
          }
          // A proxy-local 4xx (disabled route, canonicalization mismatch, or
          // deployment skew) must not suppress the deliberate direct fallback.
          // Once a direct provider reports a permanent failure, the shared
          // query itself is unlikely to succeed at another mirror.
          if (!failure.retryable && endpoint.kind !== "proxy") break;

          const endpointsRemaining = endpoints.length - index - 1;
          if (endpointsRemaining <= 0) break;
          const delayMs = failure.retryable
            ? boundedRetryDelayMs(
                failure,
                retryIndex++,
                operation.remainingMs(),
                endpointsRemaining,
                runtime,
              )
            : 0;
          if (delayMs > 0) {
            await waitForRetry({
              operation,
              failure: new RequestPolicyError(failure.kind, failure.message, {
                retryable: failure.retryable,
                status: failure.status,
                retryAfterMs: delayMs,
                provider: failure.provider,
                cause: failure,
              }),
              retryIndex: 0,
              baseBackoffMs: 0,
              maxBackoffMs: 0,
            });
          }
        }
      }

      if (lastFailure?.kind === "rate-limited") {
        throw new Error(
          "Overpass API rate limits are busy. Please wait a moment and try again.",
          { cause: lastFailure },
        );
      }
      throw new Error("OSM features are temporarily unavailable.", {
        cause: lastFailure,
      });
    } catch (error) {
      if (error instanceof RequestPolicyError) {
        if (error.kind === "caller-abort") {
          throw new Error("OSM fetch was cancelled.", { cause: error });
        }
        if (error.kind === "operation-deadline") {
          throw new Error("OSM fetch deadline exceeded.", { cause: error });
        }
      }
      throw error;
    } finally {
      operation.dispose();
    }
  };
}

const osmFeatureFetcher = createOsmFeatureFetcher();

export function fetchOsmFeatures(
  bounds: GeoBounds,
  signal?: AbortSignal,
): Promise<GeoFeatureCollection> {
  return osmFeatureFetcher(bounds, signal);
}
