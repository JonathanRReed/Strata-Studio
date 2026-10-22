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
  const result = new Float32Array(256 * 256),
    factor = width / 256;
  const missing = noData === null ? null : Math.fround(noData);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++)
        for (let dx = 0; dx < factor; dx++) {
          const value = values[(y * factor + dy) * width + x * factor + dx];
          if (!Number.isFinite(value) || value === missing)
            throw new Error(
              "Terrain source contains missing elevation samples",
            );
          sum += value;
        }
      const value = Math.fround(sum / (factor * factor));
      if (!Number.isFinite(value))
        throw new Error("Terrain elevation cannot be represented safely");
      result[y * 256 + x] = value;
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
