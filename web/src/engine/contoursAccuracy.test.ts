import { expect, test } from "bun:test";
import fc from "fast-check";
import { marchingSquares } from "./contours.ts";
const run = (values: number[], n: number) =>
  marchingSquares((x, y) => values[y * n + x]!, n, 0);
const pointKey = (p: { x: number; y: number }) =>
  `${p.x.toFixed(10)},${p.y.toFixed(10)}`;
function edges(lines: ReturnType<typeof run>) {
  return lines
    .flatMap((line) =>
      line
        .slice(1)
        .map((p, i) => [pointKey(line[i]!), pointKey(p)].sort().join("|")),
    )
    .sort();
}
test("asymptotic saddle topology is invariant to negating the scalar field", () => {
  const a = [2, -1, -1, 2];
  expect(edges(run(a, 2))).toEqual(
    edges(
      run(
        a.map((v) => -v),
        2,
      ),
    ),
  );
  const result = run(a, 2);
  expect(
    result.some(
      (line) => line.some((p) => p.y === 0) && line.some((p) => p.x === 1),
    ),
  ).toBe(true);
});
test("tiny closed contours do not alias distinct lattice edges", () => {
  const values = [1, 1, 1, 1, -0.0001, 1, 1, 1, 1];
  const lines = run(values, 3);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toHaveLength(5);
  expect(lines[0]![0]).toEqual(lines[0]!.at(-1)!);
  expect(new Set(lines[0]!.map(pointKey)).size).toBe(4);
  expect(edges(lines)).toEqual(
    edges(
      run(
        values.map((v) => -v),
        3,
      ),
    ),
  );
});
test("a critical saddle retains its actual four-way junction", () => {
  const lines = run([1, -1, -1, 1], 2);
  expect(lines).toHaveLength(4);
  for (const line of lines)
    expect(line.some((p) => p.x === 0.5 && p.y === 0.5)).toBe(true);
});
test("exact-zero edges retain L and T topology rather than diagonal shortcuts", () => {
  expect(edges(run([0, 0, 0, 1], 2))).toEqual(
    edges([
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
      ],
    ]),
  );
  expect(edges(run([0, 0, -1, 1], 2))).toEqual(
    edges([
      [
        { x: 0, y: 0 },
        { x: 0.5, y: 0 },
      ],
      [
        { x: 0.5, y: 0 },
        { x: 1, y: 0 },
      ],
      [
        { x: 0.5, y: 0 },
        { x: 0.5, y: 1 },
      ],
    ]),
  );
});
test("isolated exact-zero points and constant plateaus do not invent lines", () => {
  expect(run([0, 1, 1, 0], 2)).toEqual([]);
  expect(run(new Array(9).fill(0), 3)).toEqual([]);
  expect(run([1, 1, 1, 1, 0, 1, 1, 1, 1], 3)).toEqual([]);
  expect(edges(run([0, 1, -1, 0], 2))).toEqual(
    edges([
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    ]),
  );
  expect(edges(run([0, 1, 1, -1], 2))).toEqual(
    edges([
      [
        { x: 1, y: 0.5 },
        { x: 0.5, y: 1 },
      ],
    ]),
  );
});
test("shared zero edges are split consistently at neighboring branch junctions", () => {
  const lines = run([-1, 1, 1, 0, 0, 0, -3, 1, 1], 3);
  const all = edges(lines);
  expect(new Set(all).size).toBe(all.length);
  expect(all).toContain(
    [pointKey({ x: 0.5, y: 1 }), pointKey({ x: 0.75, y: 1 })].sort().join("|"),
  );
});
test("each lattice sample is evaluated only once", () => {
  let calls = 0;
  marchingSquares(
    (x, y) => {
      calls++;
      return x - y;
    },
    16,
    0,
  );
  expect(calls).toBe(256);
});

test("replayable random fields preserve contours under sign and positive affine transforms", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: -4, max: 4 }), { minLength: 9, maxLength: 9 }),
      fc.integer({ min: 1, max: 9 }),
      fc.integer({ min: -1000, max: 1000 }),
      (values, scale, shift) => {
        const expected = edges(run(values, 3));
        expect(
          edges(
            run(
              values.map((value) => -value),
              3,
            ),
          ),
        ).toEqual(expected);
        expect(
          edges(
            marchingSquares(
              (x, y) => values[y * 3 + x]! * scale + shift,
              3,
              shift,
            ),
          ),
        ).toEqual(expected);
      },
    ),
    { seed: 20261022, numRuns: 600 },
  );
});
test("critical saddles survive non-power-of-two corner ratios and extreme binary scaling", () => {
  for (const scale of [1, 2 ** 900, 2 ** -900]) {
    const lines = run(
      [1, -5, -5, 25].map((v) => v * scale),
      2,
    );
    expect(lines).toHaveLength(4);
    for (const line of lines)
      expect(
        line.some(
          (p) => Math.abs(p.x - 1 / 6) < 1e-14 && Math.abs(p.y - 1 / 6) < 1e-14,
        ),
      ).toBe(true);
  }
  // A genuine near-critical determinant must NOT be rounded into a cross.
  expect(run([1, -5, -5, 25 + 2 ** -48], 2)).toHaveLength(2);
  expect(run([1, -5, -5, 25 - 2 ** -48], 2)).toHaveLength(2);
});
