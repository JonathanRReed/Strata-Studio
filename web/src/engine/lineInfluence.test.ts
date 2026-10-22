import { expect, test } from "bun:test";
import { applyInfluenceToLine, glowRuns } from "../studios/common.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import type { FeatureMasks, MaskMode } from "./types.ts";
const zero = new Float32Array(4),
  full = new Float32Array(4).fill(1);
const masks: FeatureMasks = {
  width: 2,
  height: 2,
  building: full,
  road: zero,
  water: zero,
  ocean: zero,
  lake: zero,
  river: zero,
};
const points = [
  { x: 10, y: 10 },
  { x: 30, y: 10 },
  { x: 30, y: 30 },
];
const run = (mode: MaskMode, value: number, closed = false) =>
  applyInfluenceToLine(
    points,
    100,
    100,
    masks,
    { ...defaultStyleParams, buildingMode: mode, buildingInfluence: value },
    2,
    0.8,
    "foreground",
    closed,
    "building",
  );

test("line influence changes ink without moving geographic coordinates", () => {
  const amplified = run("amplify", 100);
  expect(amplified).toHaveLength(1);
  expect(amplified[0]!.width).toBe(3.5);
  expect(amplified[0]!.points).toEqual(points);
  expect(run("flatten", 50)[0]!.opacity).toBeCloseTo(0.4, 8);
  expect(run("flatten", 100)).toEqual([]);
  expect(run("invert", 50)).toEqual([]);
  expect(run("invert", 75)[0]!.role).toBe("background");
  expect(run("invert", 75)[0]!.opacity).toBeCloseTo(0.4, 8);
  expect(run("invert", 100)[0]!.width).toBe(2);
});
test("uniform closed geometry retains its closing edge", () => {
  const result = run("amplify", 100, true);
  expect(result).toHaveLength(1);
  expect(result[0]!.closed).toBe(true);
  expect(result[0]!.points.at(-1)).toEqual(points[0]);
});
test("irrelevant and zero influences retain the original path without copies", () => {
  expect(run("amplify", 0)[0]!.points).toBe(points);
  const result = applyInfluenceToLine(
    points,
    100,
    100,
    masks,
    {
      ...defaultStyleParams,
      buildingInfluence: 100,
      buildingMode: "flatten",
      roadInfluence: 0,
    },
    2,
    0.8,
    "foreground",
    false,
    "road",
  );
  expect(result[0]!.points).toBe(points);
});
test("an interrupted closed ring is never closed across the removed area", () => {
  const partial = { ...masks, building: new Float32Array([1, 0, 0, 0]) };
  const ring = [
    { x: 0, y: 0 },
    { x: 99, y: 0 },
    { x: 99, y: 99 },
    { x: 0, y: 99 },
  ];
  const result = applyInfluenceToLine(
    ring,
    100,
    100,
    partial,
    {
      ...defaultStyleParams,
      buildingInfluence: 100,
      buildingMode: "interrupt",
    },
    1,
    1,
    "foreground",
    true,
    "building",
  );
  expect(result).toHaveLength(1);
  expect(result[0]!.closed).not.toBe(true);
  expect(result[0]!.points).toEqual(ring.slice(1));
});
test("a signed influence crossing splits the edge instead of deleting both halves", () => {
  const partial = { ...masks, building: new Float32Array([0, 1, 0, 1]) };
  const result = applyInfluenceToLine(
    [
      { x: 0, y: 50 },
      { x: 99, y: 50 },
    ],
    100,
    100,
    partial,
    { ...defaultStyleParams, buildingInfluence: 100, buildingMode: "invert" },
    2,
    0.8,
    "foreground",
    false,
    "building",
  );
  expect(result).toHaveLength(2);
  expect(result[0]!.role).toBe("foreground");
  expect(result[1]!.role).toBe("background");
  expect(result[0]!.points.at(-1)).toEqual({ x: 49.5, y: 50 });
  expect(result[1]!.points[0]).toEqual({ x: 49.5, y: 50 });
});
test("a feathered opacity ramp remains one continuous stroke, without cap seams", () => {
  const ramp = { ...masks, building: new Float32Array([0.6, 0.4, 0.6, 0.4]) };
  const line = Array.from({ length: 1000 }, (_, i) => ({
    x: (99 * i) / 999,
    y: 50,
  }));
  const result = applyInfluenceToLine(
    line,
    100,
    100,
    ramp,
    { ...defaultStyleParams, buildingInfluence: 100, buildingMode: "flatten" },
    2,
    1,
    "foreground",
    false,
    "building",
  );
  expect(result).toHaveLength(1);
  expect(result[0]!.points).toHaveLength(1000);
  expect(result[0]!.opacity).toBeCloseTo(0.5, 6);
});
test("line ink averages are weighted by length rather than vertex density", () => {
  const ramp = { ...masks, building: new Float32Array([0, 1, 0, 1]) };
  const params = {
    ...defaultStyleParams,
    buildingInfluence: 100,
    buildingMode: "flatten" as const,
  };
  const sparse = applyInfluenceToLine(
    [
      { x: 0, y: 50 },
      { x: 99, y: 50 },
    ],
    100,
    100,
    ramp,
    params,
    2,
    1,
    "foreground",
    false,
    "building",
  );
  const uneven = applyInfluenceToLine(
    [
      { x: 0, y: 50 },
      { x: 1, y: 50 },
      { x: 2, y: 50 },
      { x: 99, y: 50 },
    ],
    100,
    100,
    ramp,
    params,
    2,
    1,
    "foreground",
    false,
    "building",
  );
  expect(uneven).toHaveLength(1);
  expect(uneven[0]!.opacity).toBeCloseTo(sparse[0]!.opacity!, 10);
});
test("closed-ring ink is invariant to its arbitrary starting vertex", () => {
  const ramp = { ...masks, building: new Float32Array([0, 1, 0, 1]) };
  const ring = [
    { x: 0, y: 0 },
    { x: 99, y: 0 },
    { x: 99, y: 99 },
    { x: 0, y: 99 },
  ];
  const params = {
    ...defaultStyleParams,
    buildingInfluence: 100,
    buildingMode: "invert" as const,
  };
  const render = (line: typeof ring) =>
    applyInfluenceToLine(
      line,
      100,
      100,
      ramp,
      params,
      2,
      1,
      "foreground",
      true,
      "building",
    );
  const expected = render(ring);
  expect(expected).toHaveLength(2);
  for (let shift = 1; shift < 4; shift++)
    expect(render([...ring.slice(shift), ...ring.slice(0, shift)])).toEqual(
      expected,
    );
  expect(expected.map((stroke) => stroke.opacity)).toEqual([0.75, 0.75]);
});

test("closed glow joins the seam without joining past an isolated start point", () => {
  const sample = (x: number, glow: boolean) => ({
    x,
    y: 0,
    glow,
    glowStrength: 0.5,
  });
  expect(
    glowRuns(
      [
        sample(0, true),
        sample(1, false),
        sample(2, true),
        sample(3, true),
        sample(4, false),
        sample(5, true),
        sample(0, true),
      ],
      true,
    ).map((run) => run.points.map((p) => p.x)),
  ).toEqual([
    [5, 0],
    [2, 3],
  ]);
  expect(
    glowRuns(
      [
        sample(0, true),
        sample(1, true),
        sample(2, false),
        sample(3, true),
        sample(0, true),
      ],
      true,
    ).map((run) => run.points.map((p) => p.x)),
  ).toEqual([[3, 0, 1]]);
});
