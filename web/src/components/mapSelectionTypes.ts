import type { AspectRatio, GeoBounds } from "../engine/types.ts";
import type { CuratedPlace } from "../data/places.ts";

/** One imperative fly-to request; `key` distinguishes repeat requests. */
export type FlyToRequest = {
  /** [lng, lat] — MapLibre order. */
  center: [number, number];
  zoom: number;
  /** Exact validated bounds for composition imports; preferred over center/zoom fitting. */
  bounds?: GeoBounds;
  key: number;
};

export type MapSelectionCause =
  | "restore"
  | "manual"
  | "search"
  | "curated"
  | "aspect";

export type MapSelectionProps = {
  initialCenter?: [number, number];
  initialZoom?: number;
  /** Bounds the map must fit after loading; already active in the artwork. */
  initialBounds?: GeoBounds | null;
  aspectRatio: AspectRatio;
  onChange: (bounds: GeoBounds, zoom: number, cause: MapSelectionCause) => void;
  bounds: GeoBounds;
  zoom: number;
  expanded: boolean;
  onToggleExpand: (opener?: HTMLElement) => void;
  activePlaceId?: string | null;
  onSelectPlace?: (place: CuratedPlace) => void;
  flyTo?: FlyToRequest | null;
};
