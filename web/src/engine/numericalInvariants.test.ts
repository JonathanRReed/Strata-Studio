import { expect, test } from "bun:test";
import fc from "fast-check";
import { projectGeoPoint, cropGridToAspect } from "./grid.ts";
import { latToPixelY, pixelYToLat } from "./projection.ts";
import { sceneWithDrawProgress } from "./animation.ts";
import {
  elevationGradient,
  generateRowSegments,
  MAX_ROWS,
} from "../studios/common.ts";
import { magneticField } from "../studios/experimental/experimentalStyles.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";

test("feature projection uses the same Mercator row coordinates as terrain", () => {
  const bounds = { west: 0, east: 1, north: 80, south: 70 };
  const middle = pixelYToLat((latToPixelY(80, 0) + latToPixelY(70, 0)) / 2, 0);
  expect(projectGeoPoint(0.5, middle, bounds, 1000, 1000).y).toBeCloseTo(
    500,
    9,
  );
});
test("cropping a Mercator-sampled grid retains the real geographic row bounds", () => {
  const bounds = { west: 0, east: 1, north: 80, south: 70 };
  const result = cropGridToAspect(
    { width: 101, height: 101, bounds, data: new Float32Array(101 * 101) },
    2,
    1,
  );
  const north = latToPixelY(80, 0),
    south = latToPixelY(70, 0);
  expect(result.bounds.north).toBeCloseTo(
    pixelYToLat(north + (south - north) * 0.25, 0),
    10,
  );
  expect(result.bounds.south).toBeCloseTo(
    pixelYToLat(north + (south - north) * 0.75, 0),
    10,
  );
});
test("the row budget reduces density rather than truncating the lower artwork", () => {
  const rows = generateRowSegments(
    16,
    512,
    { ...defaultStyleParams, spacing: 1, compression: 2 },
    (_u, _v, _x, y) => ({ y, glow: false, glowStrength: 0, break_: false }),
  );
  expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);
  expect(rows.at(-1)!.baseY).toBeGreaterThanOrEqual(
    512 - 512 / MAX_ROWS - 1e-8,
  );
});
test("edge gradients use one-sided distances instead of halving the slope", () => {
  for (const [u, v] of [
    [0, 0],
    [1, 1],
    [0.5, 0.5],
  ]) {
    const gradient = elevationGradient((x, y) => 2 * x + 3 * y, u!, v!);
    expect(gradient.dx).toBeCloseTo(2, 10);
    expect(gradient.dy).toBeCloseTo(3, 10);
  }
});
test("a two-point draw stroke reveals a partial endpoint instead of popping in", () => {
  const scene = {
    strokes: [
      {
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
    ],
  };
  const result = sceneWithDrawProgress(scene, 0.001);
  expect(result.strokes[0]!.points.at(-1)!.x).toBeGreaterThan(0);
  expect(result.strokes[0]!.points.at(-1)!.x).toBeLessThan(1);
});
test("draw progress follows geometric length, not uneven point counts", () => {
  const scene = {
    strokes: [
      {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 100, y: 0 },
        ],
        closed: false,
      },
    ],
  };
  expect(
    sceneWithDrawProgress(scene, 0.35).strokes[0]!.points.at(-1)!.x,
  ).toBeCloseTo(87.5, 10);
});
test("a partial closed outline does not draw its closing edge prematurely", () => {
  const scene = {
    strokes: [
      {
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        closed: true,
      },
    ],
  };
  expect(sceneWithDrawProgress(scene, 0.1).strokes[0]!.closed).toBe(false);
  expect(sceneWithDrawProgress(scene, 1).strokes[0]).toBe(scene.strokes[0]);
});
test("rectangular magnetic flow remains tangent to an analytic terrain plane", () => {
  for (const [width, height] of [
    [128, 64],
    [64, 128],
  ]) {
    const bounds = { west: 0, east: 1, north: 1, south: 0 };
    const scene = magneticField.generate(
      {
        width: width!,
        height: height!,
        bounds,
        seed: "plane",
        elevationGrid: {
          width: 17,
          height: 17,
          bounds,
          data: Float32Array.from(
            { length: 289 },
            (_, i) => (2 * (i % 17)) / 16 + (3 * Math.floor(i / 17)) / 16,
          ),
        },
      },
      {
        ...defaultStyleParams,
        ...magneticField.defaultParams,
        seed: "plane",
        noise: 0,
        amplitude: 20,
        spacing: 60,
      },
    );
    expect(scene.strokes.length).toBeGreaterThan(0);
    for (const stroke of scene.strokes) {
      const first = stroke.points[0]!;
      const elevation =
        (2 * first.x) / (width! - 1) + (3 * first.y) / (height! - 1);
      for (const point of stroke.points)
        expect(
          (2 * point.x) / (width! - 1) + (3 * point.y) / (height! - 1),
        ).toBeCloseTo(elevation, 5);
    }
  }
});

test("Mercator projection round trips across hemispheres and export resolutions", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -70000, max: 70000 }),
      fc.integer({ min: 100, max: 100000 }),
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 64, max: 4096 }),
      (center, span, step, height) => {
        const bounds = {
          west: -1,
          east: 1,
          north: center / 1000 + span / 20000,
          south: center / 1000 - span / 20000,
        };
        const north = latToPixelY(bounds.north, 0),
          south = latToPixelY(bounds.south, 0);
        const latitude = pixelYToLat(
          north + ((south - north) * step) / 1000,
          0,
        );
        expect(
          Math.abs(
            projectGeoPoint(0, latitude, bounds, 512, height).y -
              (height * step) / 1000,
          ),
        ).toBeLessThan(0.00001);
      },
    ),
    { seed: 20261022, numRuns: 300 },
  );
});
test("inserting collinear vertices cannot change draw-animation speed", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 1, max: 1000 }), {
        minLength: 2,
        maxLength: 20,
      }),
      fc.integer({ min: 1, max: 699 }),
      (steps, time) => {
        let x = 0;
        const points = [{ x: 0, y: 0 }];
        for (const step of steps) {
          x += step;
          points.push({ x, y: 0 });
        }
        const dense = sceneWithDrawProgress(
          { strokes: [{ points }] },
          time / 1000,
        ).strokes[0]!.points.at(-1)!;
        const sparse = sceneWithDrawProgress(
          { strokes: [{ points: [points[0]!, points.at(-1)!] }] },
          time / 1000,
        ).strokes[0]!.points.at(-1)!;
        expect(dense.x).toBeCloseTo(sparse.x, 8);
      },
    ),
    { seed: 20261022, numRuns: 300 },
  );
});
