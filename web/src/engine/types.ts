export type GeoBounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

export type ElevationGrid = {
  width: number;
  height: number;
  bounds: GeoBounds;
  data: Float32Array;
};

export type Palette = {
  background: string;
  foreground: string;
  accent: string;
  /** Generic water color; falls back to accent when missing. */
  water?: string;
  ocean?: string;
  lake?: string;
  river?: string;
};

export type WaterType = "ocean" | "lake" | "river";

export type MaskMode =
  | "interrupt"
  | "amplify"
  | "flatten"
  | "glow"
  | "outline"
  | "invert";

export type AspectRatio = "square" | "16:9" | "9:16" | "12:18";

/**
 * How the artwork label renders: "plain" is the single dim caption line,
 * "poster" is the letterspaced-caps title block with rule + coordinates.
 */
export type LabelStyle = "plain" | "poster";

/**
 * Geographic/elevation metadata about the rendered artwork, used by the
 * poster title block (coordinates + elevation range). Computed once in
 * buildArtworkInput from the cropped elevation grid.
 */
export type ArtworkMeta = {
  bounds: GeoBounds;
  /** Elevation range of the cropped grid, in the grid's units (meters). */
  elevation: { min: number; max: number };
};

export type AnimationMode = "none" | "drift" | "draw" | "parallax";

export type StyleParams = {
  amplitude: number;
  spacing: number;
  lineWidth: number;
  noise: number;
  detail: number;
  compression: number;
  seed: string;
  palette: string;
  buildingInfluence: number;
  roadInfluence: number;
  waterInfluence: number;
  oceanInfluence: number;
  lakeInfluence: number;
  riverInfluence: number;
  buildingMode: MaskMode;
  roadMode: MaskMode;
  waterMode: MaskMode;
  oceanMode: MaskMode;
  lakeMode: MaskMode;
  riverMode: MaskMode;
  grain: number;
  rotation: number;
  label: string;
  /** Label treatment: plain caption (default) or poster title block. */
  labelStyle: LabelStyle;
  aspectRatio: AspectRatio;
  occlusion: number;
  /** Animation phase in [0, 1). 0 = static. */
  phase: number;
  /** Animation style: drift, draw-in, parallax, or none. */
  animationMode: AnimationMode;
  /** Animation speed in loops per second (for live preview). */
  animationSpeed: number;
  /** Whether to export with a transparent background. */
  transparent: boolean;
};

export type FeatureMasks = {
  width: number;
  height: number;
  building: Float32Array;
  road: Float32Array;
  /** Combined water mask (max of ocean/lake/river). */
  water: Float32Array;
  ocean: Float32Array;
  lake: Float32Array;
  river: Float32Array;
  /**
   * Artwork geo metadata for the renderer. It rides on the masks object
   * because renderSceneCanvas/sceneToSvg receive the masks but not the full
   * ArtworkInput; buildArtworkInput attaches it (fabricating a zero-mask
   * carrier when no OSM features are loaded).
   */
  meta?: ArtworkMeta;
};

export type GeoFeature = {
  type: "Feature";
  geometry: GeoGeometry;
  properties: {
    strataType: "building" | "road" | "water";
    waterType?: WaterType;
    [k: string]: unknown;
  };
};

export type GeoFeatureCollection = {
  type: "FeatureCollection";
  features: GeoFeature[];
};

export type GeoGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiLineString"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

export type ArtworkInput = {
  bounds: GeoBounds;
  elevationGrid: ElevationGrid;
  features?: GeoFeatureCollection;
  masks?: FeatureMasks;
  width: number;
  height: number;
  seed: string;
};

export type Studio = "classic" | "experimental";

export type ControlKey =
  | "amplitude"
  | "spacing"
  | "lineWidth"
  | "noise"
  | "detail"
  | "compression"
  | "occlusion"
  | "grain"
  | "rotation"
  | "label"
  | "labelStyle"
  | "aspectRatio"
  | "seed"
  | "palette"
  | "buildingInfluence"
  | "roadInfluence"
  | "waterInfluence"
  | "oceanInfluence"
  | "lakeInfluence"
  | "riverInfluence";

export type ArtStyle = {
  id: string;
  name: string;
  studio: Studio;
  description: string;
  defaultParams: Partial<StyleParams>;
  controls?: ControlKey[];
  generate: (
    input: ArtworkInput,
    params: StyleParams,
  ) => import("./scene.ts").Scene;
};
