import type { ScenePoint } from "./scene.ts";

/**
 * Extracts iso-lines from a scalar field using marching squares, chaining
 * cell segments into polylines. `field(ix, iy)` is sampled on an
 * `n x n` lattice; output coordinates are in lattice units [0, n-1].
 */
export function marchingSquares(
  field: (ix: number, iy: number) => number,
  n: number,
  level: number,
): ScenePoint[][] {
  type Seg = { a: ScenePoint; b: ScenePoint };
  const segs: Seg[] = [];

  const interp = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    v0: number,
    v1: number,
  ): ScenePoint => {
    const t = v1 === v0 ? 0.5 : (level - v0) / (v1 - v0);
    return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
  };

  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v00 = field(x, y);
      const v10 = field(x + 1, y);
      const v01 = field(x, y + 1);
      const v11 = field(x + 1, y + 1);

      let idx = 0;
      if (v00 >= level) idx |= 1;
      if (v10 >= level) idx |= 2;
      if (v11 >= level) idx |= 4;
      if (v01 >= level) idx |= 8;
      if (idx === 0 || idx === 15) continue;

      const top = () => interp(x, y, x + 1, y, v00, v10);
      const right = () => interp(x + 1, y, x + 1, y + 1, v10, v11);
      const bottom = () => interp(x, y + 1, x + 1, y + 1, v01, v11);
      const left = () => interp(x, y, x, y + 1, v00, v01);

      switch (idx) {
        case 1: case 14: segs.push({ a: left(), b: top() }); break;
        case 2: case 13: segs.push({ a: top(), b: right() }); break;
        case 3: case 12: segs.push({ a: left(), b: right() }); break;
        case 4: case 11: segs.push({ a: right(), b: bottom() }); break;
        case 6: case 9: segs.push({ a: top(), b: bottom() }); break;
        case 7: case 8: segs.push({ a: left(), b: bottom() }); break;
        case 5:
          segs.push({ a: left(), b: top() });
          segs.push({ a: right(), b: bottom() });
          break;
        case 10:
          segs.push({ a: top(), b: right() });
          segs.push({ a: left(), b: bottom() });
          break;
      }
    }
  }

  return chainSegments(segs);
}

function key(p: ScenePoint): string {
  return `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
}

function chainSegments(segs: { a: ScenePoint; b: ScenePoint }[]): ScenePoint[][] {
  const byEndpoint = new Map<string, number[]>();
  segs.forEach((seg, i) => {
    for (const p of [seg.a, seg.b]) {
      const k = key(p);
      const list = byEndpoint.get(k);
      if (list) list.push(i);
      else byEndpoint.set(k, [i]);
    }
  });

  const used = new Array<boolean>(segs.length).fill(false);
  const lines: ScenePoint[][] = [];

  const takeNext = (p: ScenePoint): { seg: number; next: ScenePoint } | null => {
    const candidates = byEndpoint.get(key(p));
    if (!candidates) return null;
    for (const i of candidates) {
      if (used[i]) continue;
      used[i] = true;
      const s = segs[i];
      return { seg: i, next: key(s.a) === key(p) ? s.b : s.a };
    }
    return null;
  };

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const line: ScenePoint[] = [segs[i].a, segs[i].b];
    // Extend forward
    for (;;) {
      const hit = takeNext(line[line.length - 1]);
      if (!hit) break;
      line.push(hit.next);
    }
    // Extend backward
    for (;;) {
      const hit = takeNext(line[0]);
      if (!hit) break;
      line.unshift(hit.next);
    }
    if (line.length > 1) lines.push(line);
  }

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
