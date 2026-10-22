import { test, expect } from "bun:test";
import { requireMapGeometry } from "./dataCompleteness.ts";
test("missing geometry is not mistaken for a complete map export", () => {
  expect(() => requireMapGeometry(undefined)).toThrow("Map data is incomplete");
  expect(() =>
    requireMapGeometry({ type: "FeatureCollection", features: [] }),
  ).not.toThrow();
});
