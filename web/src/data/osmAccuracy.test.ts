import { expect, test } from "bun:test";
import { overpassToGeoJSON } from "./osmOverpass.ts";
test("recursive untagged ways do not become invented buildings", () => {
  const result = overpassToGeoJSON({
    elements: [
      { type: "node", id: 1, lat: 40, lon: -74 },
      { type: "node", id: 2, lat: 40.001, lon: -74 },
      { type: "way", id: 3, nodes: [1, 2] },
    ],
  });
  expect(result.features).toEqual([]);
});
test("a nested water hole belongs only to its smallest enclosing outer ring", () => {
  type Element = Parameters<typeof overpassToGeoJSON>[0]["elements"][number];
  const elements: Element[] = [];
  let id = 0;
  const ring = (a: number, b: number, ref: number, role: "outer" | "inner") => {
    const nodes: number[] = [];
    for (const [lon, lat] of [
      [a, a],
      [b, a],
      [b, b],
      [a, b],
    ]) {
      elements.push({ type: "node", id: ++id, lat, lon });
      nodes.push(id);
    }
    nodes.push(nodes[0]!);
    elements.push({ type: "way", id: ref, nodes });
    return { type: "way" as const, ref, role };
  };
  const members = [
    ring(0, 10, 101, "outer"),
    ring(2, 8, 102, "inner"),
    ring(3, 7, 103, "outer"),
    ring(4, 6, 104, "inner"),
  ];
  elements.push({
    type: "relation",
    id: 201,
    tags: { type: "multipolygon", natural: "water" },
    members,
  });
  const geometry = overpassToGeoJSON({ elements }).features[0]!.geometry;
  expect(geometry.type).toBe("MultiPolygon");
  if (geometry.type !== "MultiPolygon")
    throw new Error("Expected nested water polygons");
  expect(geometry.coordinates.map((p) => p.length)).toEqual([2, 2]);
  expect(geometry.coordinates[0]![1]![0]).toEqual([2, 2]);
  expect(geometry.coordinates[1]![1]![0]).toEqual([4, 4]);
});
