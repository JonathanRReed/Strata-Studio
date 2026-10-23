import { test, expect } from "bun:test";
import { mapDataNotice, requireMapGeometry } from "./dataCompleteness.ts";
import { deriveSelectionBounds } from "./stateSafety.ts";
import { CURATED_PLACES } from "../data/places.ts";
test("missing geometry is not mistaken for a complete map export", () => {
  expect(() => requireMapGeometry(undefined)).toThrow("Map data is incomplete");
  expect(() =>
    requireMapGeometry({ type: "FeatureCollection", features: [] }),
  ).not.toThrow();
});

test("oversized Yosemite selection is not reported as an in-progress download", () => {
  const place = CURATED_PLACES.find((p) => p.id === "yosemite")!;
  const bounds = deriveSelectionBounds(place.center, place.zoom, "square");
  expect(mapDataNotice(bounds, { phase: "idle" }, undefined)).toContain("Zoom in");
  expect(mapDataNotice(bounds, { phase: "idle" }, undefined)).not.toContain("Loading");
  const recovered = deriveSelectionBounds(place.center, place.zoom + 1, "square");
  expect(mapDataNotice(recovered, { phase: "fetching" }, undefined)).toContain("Loading");
  expect(mapDataNotice(recovered, { phase: "done" }, { type: "FeatureCollection", features: [] })).toBeNull();
  expect(mapDataNotice(recovered, { phase: "done" }, undefined)).not.toBeNull();
  expect(mapDataNotice(recovered, { phase: "error", error: { kind: "network", message: "Fetch failed" } }, undefined)).toContain("could not be loaded");
});
