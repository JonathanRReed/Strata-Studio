import type {
  GeoBounds,
  GeoFeature,
  GeoFeatureCollection,
  GeoGeometry,
} from "../engine/types.ts";
import { getOsm, setOsm } from "./cache.ts";

export const OSM_ATTRIBUTION = "OpenStreetMap contributors";
export const MAX_BBOX_KM2 = 25;

type OverpassElement = {
  type: "node" | "way";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
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
  if (tags.natural === "water" || tags.waterway !== undefined) return "water";
  return "building";
}

export function overpassToGeoJSON(
  response: { elements: OverpassElement[] },
): GeoFeatureCollection {
  const nodes = new Map<number, [number, number]>();
  const ways: OverpassElement[] = [];

  for (const el of response.elements) {
    if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
      nodes.set(el.id, [el.lon, el.lat]);
    } else if (el.type === "way") {
      ways.push(el);
    }
  }

  const features: GeoFeature[] = [];

  for (const way of ways) {
    const coords: [number, number][] = [];
    for (const nodeId of way.nodes ?? []) {
      const point = nodes.get(nodeId);
      if (point) coords.push(point);
    }

    if (coords.length < 2) continue;

    const isClosed =
      coords.length >= 4 &&
      coords[0][0] === coords[coords.length - 1][0] &&
      coords[0][1] === coords[coords.length - 1][1];

    let geometry: GeoGeometry;
    if (isClosed) {
      geometry = { type: "Polygon", coordinates: [coords] };
    } else {
      geometry = { type: "LineString", coordinates: coords };
    }

    const tags = way.tags ?? {};
    const feature: GeoFeature = {
      type: "Feature",
      geometry,
      properties: {
        ...tags,
        strataType: classifyFeature(tags),
      },
    };
    features.push(feature);
  }

  return { type: "FeatureCollection", features };
}

function boundsCacheKey(bounds: GeoBounds): string {
  return `${bounds.south.toFixed(4)},${bounds.west.toFixed(4)},${bounds.north.toFixed(4)},${bounds.east.toFixed(4)}`;
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
    throw new Error(
      `Network error while fetching OSM features: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 504 || /timeout|too busy|server is probably too busy/i.test(text)) {
      throw new Error(
        "Overpass API is too busy right now. This is a public server with rate limits. Please wait a few seconds and try again.",
      );
    }
    if (response.status === 429) {
      throw new Error("Overpass API rate limit reached. Please wait a minute before trying again.");
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
