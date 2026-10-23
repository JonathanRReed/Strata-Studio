import type { GeoBounds, GeoFeatureCollection } from "../engine/types.ts";
import { isBboxSmallEnough, MAX_BBOX_KM2 } from "../data/osmOverpass.ts";
import type { OsmStatus } from "./status.ts";
export const MAP_DATA_REQUIRED_MESSAGE =
  "Map data is incomplete. Load streets, buildings and water before exporting.";

/** Ineligible areas do not start downloads, so never present them as loading. */
export function mapDataNotice(
  bounds: GeoBounds,
  status: OsmStatus,
  features: GeoFeatureCollection | undefined,
): string | null {
  if (!isBboxSmallEnough(bounds)) {
    return `Incomplete preview: selected area is too large for streets, buildings and water. Zoom in to under ${MAX_BBOX_KM2} km².`;
  }
  if (status.phase === "done" && features) return null;
  if (status.phase === "error") {
    return "Incomplete preview: streets, buildings and water could not be loaded.";
  }
  return "Loading required streets, buildings and water…";
}
/** A complete empty collection is valid (for example, an unbuilt desert). Missing data is not. */
export function requireMapGeometry(
  features: GeoFeatureCollection | undefined,
): asserts features is GeoFeatureCollection {
  if (!features) throw new Error(MAP_DATA_REQUIRED_MESSAGE);
}
