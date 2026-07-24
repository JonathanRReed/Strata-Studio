import { buildFeatureMasks } from "../engine/maskRasterizer.ts";
import { renderStyleCanvas } from "../studios/registry.ts";
import { sampleFeatures, sampleHeightmap } from "../data/sampleHeightmap.ts";
import { PREVIEW_SIZE } from "./aspect.ts";
import type {
  ArtworkInput,
  ElevationGrid,
  FeatureMasks,
  StyleParams,
} from "../engine/types.ts";

/** Default thumbnail edge length in pixels (thumbnails are always square). */
export const THUMBNAIL_SIZE = 96;

/**
 * Logical space every thumbnail is COMPOSED in, independent of the pixel size
 * it is rasterized to.
 *
 * This must equal the preview's logical size. `spacing` and `lineWidth` are
 * absolute logical values, so composing a thumbnail in its own 96-unit space
 * (as this module used to) changed two things at once: `spacing` yielded ~5×
 * fewer lines, and a 1.2-unit stroke covered 1.25% of the frame instead of
 * 0.23% — over five times its true relative weight. Dense line styles
 * collapsed into a solid mass and read as tonally inverted, so the style and
 * variation pickers showed something the renderer would never produce.
 *
 * Composing at PREVIEW_SIZE and letting the canvas transform scale down makes
 * every thumbnail a true miniature of the artwork.
 */
export const THUMBNAIL_LOGICAL_SIZE = PREVIEW_SIZE;

/** Maximum number of rendered thumbnails kept in the module cache. */
export const THUMBNAIL_CACHE_CAP = 64;

/**
 * Params forced for every thumbnail render, overriding whatever the item
 * specifies. Thumbnails skip everything expensive or irrelevant at 96 px:
 * grain off, no animation, no label, square aspect, opaque background.
 * `thumbnailKey` applies the same overrides, so params that differ only in
 * these fields share one cache entry.
 */
export const THUMBNAIL_PARAM_OVERRIDES = {
  grain: 0,
  label: "",
  aspectRatio: "square",
  animationMode: "none",
  phase: 0,
  transparent: false,
} as const satisfies Partial<StyleParams>;

/**
 * Stable cache key for a style + params combination. Key order in the
 * params object is irrelevant (fields are serialized sorted), and fields
 * neutralized by THUMBNAIL_PARAM_OVERRIDES do not affect the key.
 */
export function thumbnailKey(styleId: string, params: StyleParams): string {
  const effective: Record<string, unknown> = {
    ...params,
    ...THUMBNAIL_PARAM_OVERRIDES,
  };
  const fields = Object.keys(effective)
    .sort()
    .map((k) => `${k}:${JSON.stringify(effective[k])}`);
  return `${styleId}|${fields.join("|")}`;
}

export type LruCache<K, V> = {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  clear(): void;
  readonly size: number;
};

/**
 * Minimal LRU built on Map insertion order: `get` refreshes recency by
 * re-inserting, `set` evicts the oldest entries past `cap`.
 */
export function createLruCache<K, V>(cap: number): LruCache<K, V> {
  const map = new Map<K, V>();
  return {
    get(key: K): V | undefined {
      if (!map.has(key)) return undefined;
      const value = map.get(key) as V;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key: K, value: V): void {
      map.delete(key);
      map.set(key, value);
      while (map.size > cap) {
        const oldest = map.keys().next().value as K;
        map.delete(oldest);
      }
    },
    has(key: K): boolean {
      return map.has(key);
    },
    clear(): void {
      map.clear();
    },
    get size(): number {
      return map.size;
    },
  };
}

const thumbnailCache = createLruCache<string, HTMLCanvasElement>(
  THUMBNAIL_CACHE_CAP,
);

/** Drops all cached thumbnails (e.g. after custom palettes change). */
export function clearThumbnailCache(): void {
  thumbnailCache.clear();
}

/**
 * Identity tokens for override grids so cached thumbnails rendered from the
 * user's real terrain are keyed per grid object without retaining it.
 */
let nextGridToken = 0;
const gridTokens = new WeakMap<ElevationGrid, number>();

function gridToken(grid: ElevationGrid | undefined): string {
  if (!grid) return "sample";
  let token = gridTokens.get(grid);
  if (token === undefined) {
    token = ++nextGridToken;
    gridTokens.set(grid, token);
  }
  return `g${token}`;
}

/** Sample-feature masks are static per size, so rasterize them only once. */
const sampleMaskCache = new Map<number, FeatureMasks>();

function getSampleMasks(size: number): FeatureMasks {
  let masks = sampleMaskCache.get(size);
  if (!masks) {
    masks = buildFeatureMasks(sampleFeatures, sampleHeightmap.bounds, size, size);
    sampleMaskCache.set(size, masks);
  }
  return masks;
}

/**
 * Renders a square thumbnail of a style through the real style pipeline.
 *
 * Without `gridOverride` it renders the baked-in sample terrain plus the
 * synthetic feature masks (so feature-driven styles have material). With
 * `gridOverride` it renders the caller's terrain instead — features and
 * masks are omitted because the sample features would not align with the
 * override's geography.
 *
 * Results are cached (LRU, THUMBNAIL_CACHE_CAP entries); the returned
 * canvas may be shared, so callers must treat it as read-only and
 * `drawImage` it into their own canvas. Returns null outside the DOM
 * (tests, SSR) or when a 2D context is unavailable.
 */
export function renderThumbnail(
  styleId: string,
  params: StyleParams,
  size: number = THUMBNAIL_SIZE,
  gridOverride?: ElevationGrid,
): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;

  const key = `${thumbnailKey(styleId, params)}|size:${size}|grid:${gridToken(gridOverride)}`;
  const cached = thumbnailCache.get(key);
  if (cached) return cached;

  const effective: StyleParams = { ...params, ...THUMBNAIL_PARAM_OVERRIDES };
  const grid = gridOverride ?? sampleHeightmap;
  // Composed at the preview's logical size; the canvas transform in
  // renderSceneCanvas scales the result down to `size` device pixels, so the
  // thumbnail is a faithful miniature rather than a differently-composed image.
  const logical = THUMBNAIL_LOGICAL_SIZE;
  const input: ArtworkInput = {
    bounds: grid.bounds,
    elevationGrid: grid,
    features: gridOverride ? undefined : sampleFeatures,
    masks: gridOverride ? undefined : getSampleMasks(logical),
    width: logical,
    height: logical,
    seed: effective.seed,
  };

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  renderStyleCanvas(styleId, ctx, input, effective);
  thumbnailCache.set(key, canvas);
  return canvas;
}
