import type { GeoFeatureCollection } from "../engine/types.ts";
export const MAP_DATA_REQUIRED_MESSAGE =
  "Map data is incomplete. Load streets, buildings and water before exporting.";
/** A complete empty collection is valid (for example, an unbuilt desert). Missing data is not. */
export function requireMapGeometry(
  features: GeoFeatureCollection | undefined,
): asserts features is GeoFeatureCollection {
  if (!features) throw new Error(MAP_DATA_REQUIRED_MESSAGE);
}
