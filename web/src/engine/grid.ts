export function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function sampleGrid(
  grid: Float32Array,
  gridSize: number,
  u: number,
  v: number,
): number {
  const x = clamp(u, 0, 1) * (gridSize - 1);
  const y = clamp(v, 0, 1) * (gridSize - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, gridSize - 1);
  const y1 = Math.min(y0 + 1, gridSize - 1);
  const fx = x - x0;
  const fy = y - y0;

  const i00 = y0 * gridSize + x0;
  const i10 = y0 * gridSize + x1;
  const i01 = y1 * gridSize + x0;
  const i11 = y1 * gridSize + x1;

  return (
    grid[i00] * (1 - fx) * (1 - fy) +
    grid[i10] * fx * (1 - fy) +
    grid[i01] * (1 - fx) * fy +
    grid[i11] * fx * fy
  );
}

export function sampleMask(
  mask: Float32Array,
  width: number,
  height: number,
  u: number,
  v: number,
): number {
  const x = clamp(u, 0, 1) * (width - 1);
  const y = clamp(v, 0, 1) * (height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;

  const i00 = y0 * width + x0;
  const i10 = y0 * width + x1;
  const i01 = y1 * width + x0;
  const i11 = y1 * width + x1;

  return (
    mask[i00] * (1 - fx) * (1 - fy) +
    mask[i10] * fx * (1 - fy) +
    mask[i01] * (1 - fx) * fy +
    mask[i11] * fx * fy
  );
}

export function normalizeGrid(grid: Float32Array): {
  min: number;
  max: number;
  range: number;
} {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  return { min, max, range };
}

/**
 * Center-crops a square elevation grid to the given aspect ratio so
 * non-square exports crop the geography instead of stretching it.
 */
export function cropGridToAspect(
  grid: ElevationGrid,
  targetW: number,
  targetH: number,
): ElevationGrid {
  if (targetW === targetH || grid.width !== grid.height) return grid;
  const size = grid.width;
  let cropW = size;
  let cropH = size;
  if (targetW > targetH) {
    cropH = Math.max(2, Math.round((size * targetH) / targetW));
  } else {
    cropW = Math.max(2, Math.round((size * targetW) / targetH));
  }
  const offX = Math.floor((size - cropW) / 2);
  const offY = Math.floor((size - cropH) / 2);
  const data = new Float32Array(cropW * cropH);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      data[y * cropW + x] = grid.data[(y + offY) * size + (x + offX)];
    }
  }
  const { north, south, east, west } = grid.bounds;
  const u0 = offX / (size - 1);
  const u1 = (offX + cropW - 1) / (size - 1);
  const v0 = offY / (size - 1);
  const v1 = (offY + cropH - 1) / (size - 1);
  return {
    width: cropW,
    height: cropH,
    bounds: {
      west: west + (east - west) * u0,
      east: west + (east - west) * u1,
      north: north + (south - north) * v0,
      south: north + (south - north) * v1,
    },
    data,
  };
}

export function projectGeoPoint(
  lng: number,
  lat: number,
  bounds: GeoBounds,
  width: number,
  height: number,
): { x: number; y: number } {
  const u = (lng - bounds.west) / (bounds.east - bounds.west || 1);
  const v = (lat - bounds.south) / (bounds.north - bounds.south || 1);
  return { x: u * width, y: (1 - v) * height };
}

type GeoBounds = import("./types.ts").GeoBounds;
type ElevationGrid = import("./types.ts").ElevationGrid;
