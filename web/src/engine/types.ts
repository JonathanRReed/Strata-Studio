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
};

export type MaskMode = "interrupt" | "amplify" | "flatten" | "glow";

export type AspectRatio = "square" | "16:9" | "9:16" | "12:18";

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
  buildingMode: MaskMode;
  roadMode: MaskMode;
  waterMode: MaskMode;
  grain: number;
  rotation: number;
  label: string;
  aspectRatio: AspectRatio;
  occlusion: number;
};

export type FeatureMasks = {
  width: number;
  height: number;
  building: Float32Array;
  road: Float32Array;
  water: Float32Array;
};

export type GeoFeature = {
  type: "Feature";
  geometry: GeoGeometry;
  properties: { strataType: "building" | "road" | "water"; [k: string]: unknown };
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
  | "aspectRatio"
  | "seed"
  | "palette"
  | "buildingInfluence"
  | "roadInfluence"
  | "waterInfluence";

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
