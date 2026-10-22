import { awaitExportTask, throwIfExportAborted } from "../engine/export.ts";

/** Convert decoded scalar samples, never resample RGB-encoded heights. */
export function normalizeTerrainSamples(
  values: ArrayLike<number>,
  width: number,
  height: number,
  noData: number | null,
): Float32Array {
  if (
    width !== height ||
    (width !== 256 && width !== 512) ||
    values.length !== width * height
  )
    throw new Error("Unexpected terrain raster dimensions");
  const result = new Float32Array(width * height);
  const missing = noData === null ? null : Math.fround(noData);
  for (let i = 0; i < result.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value) || value === missing)
      throw new Error("Terrain source contains missing elevation samples");
    result[i] = value;
    if (!Number.isFinite(result[i]))
      throw new Error("Terrain elevation cannot be represented safely");
  }
  return result;
}

export async function decodeTerrainGeoTiff(
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<Float32Array> {
  throwIfExportAborted(signal);
  if (bytes.byteLength < 8 || bytes.byteLength > 2 * 1024 * 1024)
    throw new Error("Invalid terrain raster size");
  const { fromArrayBuffer } = await awaitExportTask(
    import("geotiff"),
    signal,
    8000,
  );
  const tiff = await awaitExportTask(fromArrayBuffer(bytes), signal);
  const image = await awaitExportTask(tiff.getImage(), signal);
  if (
    image.getWidth() !== 512 ||
    image.getHeight() !== 512 ||
    image.getSamplesPerPixel() !== 1
  )
    throw new Error("Unexpected terrain GeoTIFF layout");
  const values = await awaitExportTask(
    image.readRasters({ samples: [0], interleave: true, signal }),
    signal,
  );
  throwIfExportAborted(signal);
  return normalizeTerrainSamples(
    values as ArrayLike<number>,
    512,
    512,
    image.getGDALNoData(),
  );
}
