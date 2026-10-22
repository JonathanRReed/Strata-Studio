import type { ScenePoint } from "./scene.ts";

type Node = { id: number; point: ScenePoint };
type Edge = { id: number; a: Node; b: Node; av: number; bv: number };

const floatBits = new DataView(new ArrayBuffer(8));
/** Exact sign of a*c-b*d for finite binary64 inputs, with a fast safe filter. */
function saddleSign(a: number, b: number, c: number, d: number): number {
  const p = a * c,
    q = b * d,
    determinant = p - q;
  if (
    Number.isFinite(determinant) &&
    Math.abs(determinant) > (Math.abs(p) + Math.abs(q)) * Number.EPSILON * 4
  ) {
    return Math.sign(determinant);
  }
  // Only uncertain/overflowed products take this path. Decode exact dyadic
  // values instead of using an epsilon that would invent critical junctions.
  const binary = (value: number): [bigint, number] => {
    floatBits.setFloat64(0, value);
    const bits = floatBits.getBigUint64(0);
    const exponent = Number((bits >> 52n) & 2047n);
    let coefficient = bits & ((1n << 52n) - 1n);
    if (exponent !== 0) coefficient |= 1n << 52n;
    if (bits >> 63n) coefficient = -coefficient;
    return [coefficient, exponent === 0 ? -1074 : exponent - 1075];
  };
  const [am, ae] = binary(a),
    [bm, be] = binary(b);
  const [cm, ce] = binary(c),
    [dm, de] = binary(d);
  const offset = Math.min(ae + ce, be + de);
  const exact =
    ((am * cm) << BigInt(ae + ce - offset)) -
    ((bm * dm) << BigInt(be + de - offset));
  return exact > 0n ? 1 : exact < 0n ? -1 : 0;
}

/**
 * Piecewise-linear isolines of the bilinear lattice field. Shared edge/vertex
 * identities preserve tiny contours; asymptotic saddle decisions preserve
 * topology. Exact plateaus contribute their boundary, not an interior grid.
 */
export function marchingSquares(
  field: (ix: number, iy: number) => number,
  n: number,
  level: number,
): ScenePoint[][] {
  if (!Number.isInteger(n) || n < 2 || !Number.isFinite(level)) return [];
  const values = new Float64Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) values[y * n + x] = field(x, y) - level;
  const nodes = new Map<number, Node>();
  const horizontalBase = n * n,
    verticalBase = horizontalBase + n * (n - 1);
  const saddleBase = verticalBase + n * (n - 1);
  let nextSplitId = saddleBase + (n - 1) * (n - 1);
  // At most two junctions per zero edge; reserve ample room for pair keys.
  const stride = 16 * n * n,
    numericKeys = Number.isSafeInteger(stride * stride);
  const segments: { a: Node; b: Node }[] = [];
  const segmentKeys = new Set<number | string>();
  const zeroEdges = new Map<number, Map<number, Node>>();
  const node = (id: number, x: number, y: number): Node => {
    let result = nodes.get(id);
    if (!result) {
      result = { id, point: { x, y } };
      nodes.set(id, result);
    }
    return result;
  };
  const vertex = (x: number, y: number) => node(y * n + x, x, y);
  const add = (a: Node, b: Node) => {
    if (a.id === b.id || (a.point.x === b.point.x && a.point.y === b.point.y))
      return;
    const low = Math.min(a.id, b.id),
      high = Math.max(a.id, b.id);
    const key = numericKeys ? low * stride + high : `${low}|${high}`;
    if (segmentKeys.has(key)) return;
    segmentKeys.add(key);
    segments.push({ a, b });
  };
  const at = (edge: Edge, t: number, zero = false) => {
    if (t === 0) return edge.a;
    if (t === 1) return edge.b;
    const existing = zero ? zeroEdges.get(edge.id)?.get(t) : undefined;
    return (
      existing ??
      node(
        zero ? nextSplitId++ : edge.id,
        edge.a.point.x + (edge.b.point.x - edge.a.point.x) * t,
        edge.a.point.y + (edge.b.point.y - edge.a.point.y) * t,
      )
    );
  };
  const fraction = (a: number, b: number) => {
    const scale = Math.max(Math.abs(a), Math.abs(b));
    return a / scale / (a / scale - b / scale);
  };
  const root = (edge: Edge) => at(edge, fraction(edge.av, edge.bv));
  const registerZero = (edge: Edge) => {
    let splits = zeroEdges.get(edge.id);
    if (!splits) {
      splits = new Map([
        [0, edge.a],
        [1, edge.b],
      ]);
      zeroEdges.set(edge.id, splits);
    }
    return splits;
  };
  const opposite = (a: number, b: number) =>
    a !== 0 && b !== 0 && a < 0 !== b < 0;

  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const a = values[y * n + x],
        b = values[y * n + x + 1];
      const c = values[(y + 1) * n + x + 1],
        d = values[(y + 1) * n + x];
      // Most smooth-field cells miss this level. Reject them before allocating.
      if (
        (a > 0 && b > 0 && c > 0 && d > 0) ||
        (a < 0 && b < 0 && c < 0 && d < 0) ||
        (a === 0 && b === 0 && c === 0 && d === 0)
      )
        continue;
      if (
        !Number.isFinite(a) ||
        !Number.isFinite(b) ||
        !Number.isFinite(c) ||
        !Number.isFinite(d)
      )
        continue;
      const v = [a, b, c, d];
      const corners = [
        vertex(x, y),
        vertex(x + 1, y),
        vertex(x + 1, y + 1),
        vertex(x, y + 1),
      ];
      // Horizontal edges always run left to right; vertical edges top to bottom.
      const edges: Edge[] = [
        {
          id: horizontalBase + y * (n - 1) + x,
          a: corners[0],
          b: corners[1],
          av: v[0],
          bv: v[1],
        },
        {
          id: verticalBase + y * n + x + 1,
          a: corners[1],
          b: corners[2],
          av: v[1],
          bv: v[2],
        },
        {
          id: horizontalBase + (y + 1) * (n - 1) + x,
          a: corners[3],
          b: corners[2],
          av: v[3],
          bv: v[2],
        },
        {
          id: verticalBase + y * n + x,
          a: corners[0],
          b: corners[3],
          av: v[0],
          bv: v[3],
        },
      ];
      const zero: number[] = [];
      for (let i = 0; i < 4; i++)
        if (edges[i].av === 0 && edges[i].bv === 0) zero.push(i);
      if (zero.length) {
        for (const i of zero) registerZero(edges[i]);
        if (zero.length === 1) {
          const e = edges[zero[0]],
            other = edges[(zero[0] + 2) % 4];
          if (opposite(other.av, other.bv)) {
            const t = fraction(other.av, other.bv),
              junction = at(e, t, true);
            registerZero(e).set(t, junction);
            add(root(other), junction);
          }
        }
        continue;
      }
      const roots: Node[] = [];
      for (const edge of edges)
        if (opposite(edge.av, edge.bv)) roots.push(root(edge));
      if (roots.length === 4) {
        const q = saddleSign(v[0], v[1], v[2], v[3]);
        const [top, right, bottom, left] = roots;
        if (q > 0) {
          add(top, right);
          add(bottom, left);
        } else if (q < 0) {
          add(top, left);
          add(right, bottom);
        } else {
          const junction = node(
            saddleBase + y * (n - 1) + x,
            top.point.x,
            left.point.y,
          );
          for (const endpoint of roots) add(endpoint, junction);
        }
        continue;
      }
      for (let i = 0; i < 4; i++) {
        if (v[i] === 0 && opposite(v[(i + 3) % 4], v[(i + 1) % 4]))
          roots.push(corners[i]);
      }
      if (roots.length === 2) add(roots[0], roots[1]);
    }
  // Adjacent cells may introduce different junctions on the same zero edge.
  // Split once, globally, so there are neither duplicate edges nor T gaps.
  for (const splits of zeroEdges.values()) {
    const points = [...splits]
      .sort((a, b) => a[0] - b[0])
      .map(([, point]) => point);
    for (let i = 1; i < points.length; i++) add(points[i - 1], points[i]);
  }
  const adjacent = new Map<number, number[]>();
  segments.forEach((segment, i) => {
    for (const endpoint of [segment.a, segment.b]) {
      const list = adjacent.get(endpoint.id);
      if (list) list.push(i);
      else adjacent.set(endpoint.id, [i]);
    }
  });
  const used = new Uint8Array(segments.length),
    lines: ScenePoint[][] = [];
  const walk = (start: Node, first: number) => {
    const line = [start.point];
    let current = start,
      index = first;
    while (!used[index]) {
      used[index] = 1;
      const segment = segments[index];
      current = segment.a.id === current.id ? segment.b : segment.a;
      line.push(current.point);
      const next = adjacent.get(current.id)!;
      if (next.length !== 2) break;
      const unused = next.find((i) => !used[i]);
      if (unused === undefined) break;
      index = unused;
    }
    lines.push(line);
  };
  // Stop at true junctions instead of inventing a pairing. Then collect cycles.
  for (const [id, list] of adjacent)
    if (list.length !== 2) {
      for (const index of list) if (!used[index]) walk(nodes.get(id)!, index);
    }
  for (let i = 0; i < segments.length; i++)
    if (!used[i]) walk(segments[i].a, i);
  return lines;
}

/** Simple Chaikin smoothing pass to soften marching-squares jaggies. */
export function smoothLine(points: ScenePoint[], iterations = 1): ScenePoint[] {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) return pts;
    const out: ScenePoint[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
