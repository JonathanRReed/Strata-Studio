import { createNoise } from "../engine/noise.ts";
import type {
  ElevationGrid,
  GeoBounds,
  GeoFeature,
  GeoFeatureCollection,
} from "../engine/types.ts";

/**
 * Baked-in miniature terrain used to render style/preset thumbnails before
 * the user has generated anything. Zero network: the grid is composed
 * procedurally at module load from deterministic seeded noise, shaped to
 * read like dramatic alpine terrain — a main SW→NE ridge with distinct
 * summits, two subsidiary peaks, and a valley floor holding a lake.
 */

export const SAMPLE_GRID_SIZE = 96;

/** Peak elevation of the sample terrain in meters (valley floor is 0). */
export const SAMPLE_MAX_ELEVATION = 1200;

/** Roughly a 10 km box in the Pennine Alps above Zermatt. */
export const SAMPLE_BOUNDS: GeoBounds = {
  west: 7.62,
  south: 45.93,
  east: 7.75,
  north: 46.02,
};

const SAMPLE_SEED = "strata-sample";

/** Ridge endpoints in unit space (u east, v north). */
const RIDGE_A = { u: 0.12, v: 0.2 };
const RIDGE_B = { u: 0.86, v: 0.84 };

/** Lake center in unit space; the terrain dips into a bowl here. */
const LAKE_U = 0.7;
const LAKE_V = 0.16;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Distance to the ridge segment plus normalized position along it. */
function ridgeDistance(u: number, v: number): { d: number; t: number } {
  const dx = RIDGE_B.u - RIDGE_A.u;
  const dy = RIDGE_B.v - RIDGE_A.v;
  const len2 = dx * dx + dy * dy;
  const t = clamp01(((u - RIDGE_A.u) * dx + (v - RIDGE_A.v) * dy) / len2);
  const px = RIDGE_A.u + t * dx;
  const py = RIDGE_A.v + t * dy;
  return { d: Math.hypot(u - px, v - py), t };
}

function gaussianBump(
  u: number,
  v: number,
  cu: number,
  cv: number,
  radius: number,
): number {
  const d = Math.hypot(u - cu, v - cv) / radius;
  return Math.exp(-d * d);
}

/**
 * Builds the sample terrain. Exported as a factory so callers (and tests)
 * can verify determinism; app code should normally use the shared
 * `sampleHeightmap` singleton below.
 */
export function createSampleHeightmap(): ElevationGrid {
  const size = SAMPLE_GRID_SIZE;
  const detailNoise = createNoise(`${SAMPLE_SEED}:detail`, 5, 0.55);
  const crestNoise = createNoise(`${SAMPLE_SEED}:crest`, 3, 0.5);
  const baseNoise = createNoise(`${SAMPLE_SEED}:base`, 3, 0.5);

  const data = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      // v runs south→north while rows run top→bottom.
      const v = 1 - y / (size - 1);

      // Wobble the ridge line so it meanders like a real crest.
      const wu = u + 0.06 * baseNoise(v * 2.3, 7.1);
      const wv = v + 0.06 * baseNoise(u * 2.3, 3.7);
      const { d, t } = ridgeDistance(wu, wv);

      // Crest height varies along the ridge → distinct summits and cols.
      const crest = 760 + 300 * crestNoise(t * 2.8, 0.5);
      const ridge = crest * Math.exp(-((d / 0.17) * (d / 0.17)));

      // Two subsidiary peaks flanking the main ridge.
      const peaks =
        520 * gaussianBump(u, v, 0.24, 0.72, 0.11) +
        430 * gaussianBump(u, v, 0.82, 0.34, 0.1);

      // Gently undulating valley floor, dipping into a bowl at the lake.
      const base = 40 + 90 * (0.5 + 0.5 * baseNoise(u * 1.8, v * 1.8));
      const lakeBowl = -70 * gaussianBump(u, v, LAKE_U, LAKE_V, 0.12);

      let h = base + ridge + peaks + lakeBowl;
      // FBM crag detail, rougher at altitude.
      h += (30 + h * 0.22) * detailNoise(u * 4.5, v * 4.5);

      data[y * size + x] = h;
    }
  }

  // Remap to exactly [0, SAMPLE_MAX_ELEVATION] meters. Min/max are taken
  // from the stored float32 values so the extremes land exactly on 0/1200.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  const range = max - min || 1;
  for (let i = 0; i < data.length; i++) {
    data[i] = ((data[i] - min) / range) * SAMPLE_MAX_ELEVATION;
  }

  return { width: size, height: size, bounds: SAMPLE_BOUNDS, data };
}

/** Shared sample terrain; safe to reuse — render code never mutates grids. */
export const sampleHeightmap: ElevationGrid = createSampleHeightmap();

/** Unit-space (u east, v north) → [lng, lat] inside SAMPLE_BOUNDS. */
function geo(u: number, v: number): [number, number] {
  const { west, east, south, north } = SAMPLE_BOUNDS;
  return [west + u * (east - west), south + v * (north - south)];
}

function buildingRect(
  cu: number,
  cv: number,
  w: number,
  h: number,
): GeoFeature {
  const ring: [number, number][] = [
    geo(cu - w / 2, cv - h / 2),
    geo(cu + w / 2, cv - h / 2),
    geo(cu + w / 2, cv + h / 2),
    geo(cu - w / 2, cv + h / 2),
    geo(cu - w / 2, cv - h / 2),
  ];
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { strataType: "building" },
  };
}

function road(points: [number, number][]): GeoFeature {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: points.map(([u, v]) => geo(u, v)),
    },
    properties: { strataType: "road" },
  };
}

/** Irregular lake outline (squashed vertically) around the valley bowl. */
function lakePolygon(): GeoFeature {
  const radii = [0.13, 0.11, 0.14, 0.1, 0.12, 0.135, 0.105, 0.125];
  const ring: [number, number][] = radii.map((r, i) => {
    const angle = (i / radii.length) * Math.PI * 2;
    return geo(LAKE_U + r * Math.cos(angle), LAKE_V + r * 0.75 * Math.sin(angle));
  });
  ring.push(ring[0]);
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { strataType: "water", waterType: "lake" },
  };
}

/**
 * Tiny synthetic feature set matching the sample terrain: a valley village
 * (building blocks, exaggerated so they read at thumbnail scale), a valley
 * road plus a pass road crossing the ridge, and the lake. Gives
 * feature-driven styles material to showcase their influence params.
 */
export const sampleFeatures: GeoFeatureCollection = {
  type: "FeatureCollection",
  features: [
    // Village blocks on the valley floor.
    buildingRect(0.26, 0.12, 0.07, 0.05),
    buildingRect(0.34, 0.17, 0.06, 0.045),
    buildingRect(0.42, 0.1, 0.065, 0.05),
    buildingRect(0.3, 0.25, 0.05, 0.04),
    buildingRect(0.19, 0.2, 0.045, 0.055),
    // Valley road skirting the lake, then a pass road over the ridge.
    road([
      [0.02, 0.06],
      [0.2, 0.1],
      [0.36, 0.14],
      [0.55, 0.13],
      [0.62, 0.28],
      [0.85, 0.3],
      [0.98, 0.34],
    ]),
    road([
      [0.36, 0.14],
      [0.4, 0.32],
      [0.5, 0.48],
      [0.46, 0.66],
      [0.55, 0.85],
      [0.6, 0.98],
    ]),
    lakePolygon(),
  ],
};
