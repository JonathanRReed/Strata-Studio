/**
 * Animation export: GIF, APNG, and WebM encoding from canvas frame sequences.
 *
 * Uses gifenc for GIF, upng-js for APNG, and MediaRecorder for WebM.
 * All formats support transparent backgrounds when the canvas is rendered
 * without a background fill.
 */

// @ts-expect-error: gifenc has no bundled types
import { GIFEncoder, quantize, applyPalette } from "gifenc";
// @ts-expect-error: upng-js has no bundled types
import UPNG from "upng-js";
import type { StyleParams, ArtworkInput, Palette, ArtStyle } from "./types.ts";
import { renderSceneCanvas } from "./scene.ts";
import { getStyle } from "../studios/registry.ts";
import { animateScene, paramsForFrame, DEFAULT_FRAMES, DEFAULT_FPS, needsRegeneration } from "./animation.ts";
import { createOffscreenCanvas } from "./export.ts";

export type AnimationFormat = "gif" | "apng" | "webm";

export type ExportProgress = (progress: number, status: string) => void;

/**
 * Builds a per-frame renderer for an animation export. Drift regenerates the
 * scene each frame (its phase changes the geometry); draw-in and parallax
 * generate the static scene exactly ONCE here and only post-process it per
 * frame. Exported for tests.
 */
export function createFrameRenderer({
  style,
  input,
  params: baseParams,
  paletteMap,
  totalFrames,
  transparent,
}: {
  style: ArtStyle;
  input: ArtworkInput;
  params: StyleParams;
  paletteMap: Record<string, Palette>;
  totalFrames: number;
  transparent: boolean;
}): (ctx: CanvasRenderingContext2D, frame: number) => void {
  const palette = paletteMap[baseParams.palette] ?? paletteMap.monochrome;
  const regenerate = needsRegeneration(baseParams.animationMode);
  const staticScene = regenerate ? null : style.generate(input, { ...baseParams, phase: 0 });

  return (ctx, frame) => {
    const params = paramsForFrame(baseParams, frame, totalFrames);
    const scene = regenerate
      ? style.generate(input, params)
      : animateScene(staticScene!, params, frame, totalFrames, input.width, input.height);
    renderSceneCanvas(ctx, scene, params, palette, input.width, input.height, transparent, input.masks);
  };
}

/** Captures all frames as ImageData arrays. */
async function captureFrames(
  styleId: string,
  input: ArtworkInput,
  params: StyleParams,
  paletteMap: Record<string, Palette>,
  totalFrames: number,
  transparent: boolean,
  onProgress?: ExportProgress,
): Promise<ImageData[]> {
  const { width, height } = input;
  const { ctx } = createOffscreenCanvas(width, height);
  const frames: ImageData[] = [];
  const renderFrame = createFrameRenderer({
    style: getStyle(styleId),
    input,
    params,
    paletteMap,
    totalFrames,
    transparent,
  });

  for (let f = 0; f < totalFrames; f++) {
    renderFrame(ctx, f);
    frames.push(ctx.getImageData(0, 0, width, height));
    if (onProgress) {
      onProgress(f / totalFrames, `Rendering frame ${f + 1}/${totalFrames}`);
    }
    // Yield to the event loop so the UI stays responsive
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return frames;
}

/**
 * Finds the palette index that gifenc's quantizer assigned to the fully
 * transparent color. gifenc does NOT guarantee it lands at index 0, so the
 * GIF frame's `transparentIndex` must be located after quantization.
 * Returns -1 when the palette has no transparent entry.
 */
export function findTransparentIndex(palette: number[][]): number {
  return palette.findIndex((color) => color.length >= 4 && color[3] === 0);
}

/** Exports frames as a GIF using gifenc. */
async function exportGif(
  frames: ImageData[],
  fps: number,
  filename: string,
  transparent: boolean,
): Promise<void> {
  if (frames.length === 0) throw new Error("No frames to export");
  const width = frames[0].width;
  const height = frames[0].height;
  const delay = Math.round(1000 / fps);

  // gifenc's quantize/applyPalette require RGBA Uint8Array data (reads .buffer as Uint32Array).
  // Build a global palette from a sample of frames for consistent colors.
  // Sample up to 8 frames spread across the animation to keep quantization fast.
  const sampleCount = Math.min(frames.length, 8);
  const sampleSize = width * height * 4 * sampleCount;
  const sampleData = new Uint8Array(sampleSize);
  for (let i = 0; i < sampleCount; i++) {
    const frameIdx = Math.floor((i / sampleCount) * frames.length);
    const src = frames[frameIdx].data;
    sampleData.set(src, i * width * height * 4);
  }

  const format = transparent ? "rgba4444" : "rgb565";
  const palette = quantize(sampleData, 256, {
    format,
    oneBitAlpha: transparent,
    clearAlpha: transparent,
    clearAlphaThreshold: transparent ? 128 : 0,
  });

  // With oneBitAlpha, quantized colors have alpha 0x00 or 0xFF; locate the
  // transparent entry (it is not guaranteed to be index 0). If the sampled
  // frames had no transparent pixels, encode without transparency.
  const transparentIndex = transparent ? findTransparentIndex(palette) : -1;
  const useTransparency = transparentIndex >= 0;

  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    // frame.data is Uint8ClampedArray (RGBA) — pass directly to applyPalette
    const indexed = applyPalette(frames[i].data, palette, format);
    gif.writeFrame(indexed, width, height, {
      delay,
      transparent: useTransparency,
      transparentIndex: useTransparency ? transparentIndex : 0,
      dispose: 2,
      // First frame must include the palette (gifenc requirement)
      palette: i === 0 ? palette : undefined,
      repeat: 0,
    });
  }
  gif.finish();

  const bytes = gif.bytes();
  const blob = new Blob([bytes], { type: "image/gif" });
  triggerDownload(blob, filename);
}

/** Exports frames as an APNG using upng-js. */
async function exportApng(
  frames: ImageData[],
  fps: number,
  filename: string,
): Promise<void> {
  const width = frames[0].width;
  const height = frames[0].height;
  const delay = Math.round(1000 / fps);

  // UPNG.encode expects an array of ArrayBuffers (one per frame)
  const frameBuffers: ArrayBuffer[] = frames.map((frame) => {
    return frame.data.buffer.slice(frame.data.byteOffset, frame.data.byteOffset + frame.data.byteLength) as ArrayBuffer;
  });

  const png = UPNG.encode(frameBuffers, width, height, 0, new Array(frames.length).fill(delay));
  const blob = new Blob([png], { type: "image/png" });
  triggerDownload(blob, filename);
}

/** Exports frames as a WebM video using MediaRecorder. */
async function exportWebm(
  styleId: string,
  input: ArtworkInput,
  params: StyleParams,
  paletteMap: Record<string, Palette>,
  totalFrames: number,
  fps: number,
  filename: string,
  onProgress?: ExportProgress,
): Promise<void> {
  const { width, height } = input;
  const { canvas, ctx } = createOffscreenCanvas(width, height);

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;

  // Try to pick the best available codec
  const mimeTypes = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  let mimeType = "";
  for (const mt of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mt)) {
      mimeType = mt;
      break;
    }
  }
  if (!mimeType) {
    throw new Error("WebM recording is not supported in this browser");
  }

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const done = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (e) => reject(new Error(`WebM recording failed: ${e}`));
  });

  // WebM doesn't support alpha — fill background even when transparent is requested
  const renderFrame = createFrameRenderer({
    style: getStyle(styleId),
    input,
    params,
    paletteMap,
    totalFrames,
    transparent: false,
  });

  recorder.start();

  for (let f = 0; f < totalFrames; f++) {
    renderFrame(ctx, f);
    track.requestFrame();
    if (onProgress) {
      onProgress(f / totalFrames, `Recording frame ${f + 1}/${totalFrames}`);
    }
    // Wait one frame interval so the recorder captures this frame
    await new Promise((resolve) => setTimeout(resolve, 1000 / fps));
  }

  recorder.stop();
  await done;

  const blob = new Blob(chunks, { type: "video/webm" });
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Main animation export entry point.
 * Renders all frames, then encodes in the requested format.
 */
export async function exportAnimation(
  styleId: string,
  input: ArtworkInput,
  params: StyleParams,
  paletteMap: Record<string, Palette>,
  format: AnimationFormat,
  options: {
    frames?: number;
    fps?: number;
    transparent?: boolean;
    onProgress?: ExportProgress;
  } = {},
): Promise<void> {
  const totalFrames = Math.max(1, options.frames ?? DEFAULT_FRAMES);
  const fps = Math.max(1, options.fps ?? DEFAULT_FPS);
  const transparent = options.transparent ?? params.transparent ?? false;
  const onProgress = options.onProgress;
  const baseName = `strata-${styleId}-${params.seed}-${input.width}x${input.height}`;

  if (format === "webm") {
    // WebM records in real-time, so we don't pre-capture frames
    onProgress?.(0, "Starting WebM recording...");
    await exportWebm(styleId, input, params, paletteMap, totalFrames, fps, `${baseName}.webm`, onProgress);
    onProgress?.(1, "WebM export complete");
    return;
  }

  onProgress?.(0, "Rendering frames...");
  const frames = await captureFrames(styleId, input, params, paletteMap, totalFrames, transparent, onProgress);

  onProgress?.(0.9, `Encoding ${format.toUpperCase()}...`);
  if (format === "gif") {
    await exportGif(frames, fps, `${baseName}.gif`, transparent);
  } else if (format === "apng") {
    await exportApng(frames, fps, `${baseName}.png`);
  }
  onProgress?.(1, "Export complete");
}
