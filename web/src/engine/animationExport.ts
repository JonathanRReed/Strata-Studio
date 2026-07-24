import type { StyleParams, ArtworkInput, Palette, ArtStyle } from "./types.ts";
import { renderSceneCanvas } from "./scene.ts";
import { ensurePosterFonts } from "./posterFonts.ts";
import { getStyle } from "../studios/registry.ts";
import {
  animateScene,
  paramsForFrame,
  DEFAULT_FRAMES,
  DEFAULT_FPS,
  needsRegeneration,
} from "./animation.ts";
import {
  createOffscreenCanvas,
  startBlobDownload,
  throwIfExportAborted,
  type DownloadReceipt,
} from "./export.ts";

export type AnimationFormat = "gif" | "apng" | "webm";
export type ExportProgress = (progress: number, status: string) => void;
export type AnimationExportResult = {
  filename: string;
  width: number;
  height: number;
  receipt: DownloadReceipt;
};

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfExportAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Export was cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Builds a per-frame renderer for an animation export. Drift regenerates the
 * scene each frame; draw-in and parallax generate the static scene once.
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
    renderSceneCanvas(
      ctx,
      scene,
      params,
      palette,
      input.width,
      input.height,
      transparent,
      input.masks,
    );
  };
}

/** Captures all frames as ImageData arrays with a cancellation yield per frame. */
async function captureFrames(
  styleId: string,
  input: ArtworkInput,
  params: StyleParams,
  paletteMap: Record<string, Palette>,
  totalFrames: number,
  transparent: boolean,
  onProgress?: ExportProgress,
  signal?: AbortSignal,
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

  for (let frame = 0; frame < totalFrames; frame++) {
    throwIfExportAborted(signal);
    renderFrame(ctx, frame);
    throwIfExportAborted(signal);
    frames.push(ctx.getImageData(0, 0, width, height));
    onProgress?.((frame + 1) / totalFrames * 0.88, `Rendering frame ${frame + 1}/${totalFrames}`);
    await waitWithAbort(0, signal);
  }
  return frames;
}

export function findTransparentIndex(palette: number[][]): number {
  return palette.findIndex((color) => color.length >= 4 && color[3] === 0);
}

type GifencModule = {
  GIFEncoder: () => {
    writeFrame: (pixels: Uint8Array, width: number, height: number, options: Record<string, unknown>) => void;
    finish: () => void;
    bytes: () => Uint8Array;
  };
  quantize: (
    data: Uint8Array,
    colors: number,
    options: Record<string, unknown>,
  ) => number[][];
  applyPalette: (
    data: Uint8ClampedArray,
    palette: number[][],
    format: string,
  ) => Uint8Array;
};

async function loadGifEncoder(): Promise<GifencModule> {
  // @ts-expect-error gifenc does not publish TypeScript declarations.
  return import("gifenc") as Promise<GifencModule>;
}

type UpngModule = {
  default: {
    encode: (
      frames: ArrayBuffer[],
      width: number,
      height: number,
      colors: number,
      delays: number[],
    ) => ArrayBuffer;
  };
};

async function loadApngEncoder(): Promise<UpngModule> {
  // @ts-expect-error upng-js does not publish TypeScript declarations.
  return import("upng-js") as Promise<UpngModule>;
}

async function exportGif(
  frames: ImageData[],
  fps: number,
  filename: string,
  transparent: boolean,
  encoder: GifencModule,
  onProgress?: ExportProgress,
  signal?: AbortSignal,
): Promise<DownloadReceipt> {
  if (frames.length === 0) throw new Error("No frames to export");
  throwIfExportAborted(signal);
  const { GIFEncoder, quantize, applyPalette } = encoder;

  const width = frames[0].width;
  const height = frames[0].height;
  const delay = Math.round(1000 / fps);
  const sampleCount = Math.min(frames.length, 8);
  const sampleData = new Uint8Array(width * height * 4 * sampleCount);
  for (let index = 0; index < sampleCount; index++) {
    throwIfExportAborted(signal);
    const frameIndex = Math.floor((index / sampleCount) * frames.length);
    sampleData.set(frames[frameIndex].data, index * width * height * 4);
  }

  const format = transparent ? "rgba4444" : "rgb565";
  onProgress?.(0.91, "Quantizing GIF colors…");
  const palette = quantize(sampleData, 256, {
    format,
    oneBitAlpha: transparent,
    clearAlpha: transparent,
    clearAlphaThreshold: transparent ? 128 : 0,
  });
  throwIfExportAborted(signal);
  const transparentIndex = transparent ? findTransparentIndex(palette) : -1;
  const useTransparency = transparentIndex >= 0;

  const gif = GIFEncoder();
  for (let index = 0; index < frames.length; index++) {
    throwIfExportAborted(signal);
    const indexed = applyPalette(frames[index].data, palette, format);
    gif.writeFrame(indexed, width, height, {
      delay,
      transparent: useTransparency,
      transparentIndex: useTransparency ? transparentIndex : 0,
      dispose: 2,
      palette: index === 0 ? palette : undefined,
      repeat: 0,
    });
    onProgress?.(0.92 + ((index + 1) / frames.length) * 0.07, `Encoding GIF frame ${index + 1}/${frames.length}`);
    if (index % 2 === 1) await waitWithAbort(0, signal);
  }
  throwIfExportAborted(signal);
  gif.finish();
  throwIfExportAborted(signal);
  const encoded = gif.bytes();
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return startBlobDownload(new Blob([bytes.buffer], { type: "image/gif" }), filename);
}

async function exportApng(
  frames: ImageData[],
  fps: number,
  filename: string,
  UPNG: UpngModule["default"],
  onProgress?: ExportProgress,
  signal?: AbortSignal,
): Promise<DownloadReceipt> {
  if (frames.length === 0) throw new Error("No frames to export");
  throwIfExportAborted(signal);

  const width = frames[0].width;
  const height = frames[0].height;
  const delay = Math.round(1000 / fps);
  const frameBuffers: ArrayBuffer[] = [];
  for (let index = 0; index < frames.length; index++) {
    throwIfExportAborted(signal);
    const frame = frames[index];
    frameBuffers.push(
      frame.data.buffer.slice(
        frame.data.byteOffset,
        frame.data.byteOffset + frame.data.byteLength,
      ) as ArrayBuffer,
    );
    if (index % 2 === 1) await waitWithAbort(0, signal);
  }
  onProgress?.(0.96, "Encoding APNG…");
  throwIfExportAborted(signal);
  const png = UPNG.encode(
    frameBuffers,
    width,
    height,
    0,
    new Array(frames.length).fill(delay),
  );
  throwIfExportAborted(signal);
  return startBlobDownload(new Blob([png], { type: "image/png" }), filename);
}

async function exportWebm(
  styleId: string,
  input: ArtworkInput,
  params: StyleParams,
  paletteMap: Record<string, Palette>,
  totalFrames: number,
  fps: number,
  filename: string,
  mimeType: string,
  onProgress?: ExportProgress,
  signal?: AbortSignal,
): Promise<DownloadReceipt> {
  throwIfExportAborted(signal);
  const { width, height } = input;
  const { canvas, ctx } = createOffscreenCanvas(width, height);
  if (typeof canvas.captureStream !== "function") {
    throw new Error("WebM canvas capture is not supported in this browser");
  }
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (!track || typeof track.requestFrame !== "function") {
    stream.getTracks().forEach((item) => item.stop());
    throw new Error("WebM frame capture is not supported in this browser");
  }

  let recorder: MediaRecorder | null = null;
  try {
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    const done = new Promise<void>((resolve, reject) => {
      recorder!.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder!.onstop = () => resolve();
      recorder!.onerror = () => reject(new Error("WebM recording failed"));
    });
    const onAbort = () => {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const renderFrame = createFrameRenderer({
      style: getStyle(styleId),
      input,
      params,
      paletteMap,
      totalFrames,
      transparent: false,
    });

    try {
      recorder.start();
      for (let frame = 0; frame < totalFrames; frame++) {
        throwIfExportAborted(signal);
        renderFrame(ctx, frame);
        track.requestFrame();
        onProgress?.((frame + 1) / totalFrames * 0.98, `Recording frame ${frame + 1}/${totalFrames}`);
        await waitWithAbort(1000 / fps, signal);
      }
      throwIfExportAborted(signal);
      recorder.stop();
      await done;
      throwIfExportAborted(signal);
      return startBlobDownload(new Blob(chunks, { type: mimeType }), filename);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
    }
  } finally {
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Recorder may have transitioned between the state check and stop().
      }
    }
    stream.getTracks().forEach((item) => item.stop());
  }
}

/** Renders and downloads one animation, with lazy encoders and stage cancellation. */
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
    signal?: AbortSignal;
    webmMimeType?: string | null;
  } = {},
): Promise<AnimationExportResult> {
  const totalFrames = Math.max(1, options.frames ?? DEFAULT_FRAMES);
  const fps = Math.max(1, options.fps ?? DEFAULT_FPS);
  const transparent = options.transparent ?? params.transparent ?? false;
  const { signal, onProgress } = options;
  const baseName = `strata-${styleId}-${params.seed}-${input.width}x${input.height}`;
  throwIfExportAborted(signal);
  await ensurePosterFonts();
  throwIfExportAborted(signal);

  let filename: string;
  let receipt: DownloadReceipt;
  if (format === "webm") {
    const mimeType = options.webmMimeType;
    if (!mimeType) throw new Error("WebM recording is not supported in this browser");
    filename = `${baseName}.webm`;
    onProgress?.(0, "Starting WebM recording…");
    receipt = await exportWebm(
      styleId,
      input,
      params,
      paletteMap,
      totalFrames,
      fps,
      filename,
      mimeType,
      onProgress,
      signal,
    );
  } else {
    let gifEncoder: GifencModule | null = null;
    let apngEncoder: UpngModule["default"] | null = null;
    if (format === "gif") {
      onProgress?.(0, "Loading GIF encoder…");
      gifEncoder = await loadGifEncoder();
    } else {
      onProgress?.(0, "Loading APNG encoder…");
      apngEncoder = (await loadApngEncoder()).default;
    }
    throwIfExportAborted(signal);
    onProgress?.(0, "Rendering frames…");
    const frames = await captureFrames(
      styleId,
      input,
      params,
      paletteMap,
      totalFrames,
      transparent,
      onProgress,
      signal,
    );
    throwIfExportAborted(signal);
    if (format === "gif") {
      filename = `${baseName}.gif`;
      receipt = await exportGif(
        frames,
        fps,
        filename,
        transparent,
        gifEncoder!,
        onProgress,
        signal,
      );
    } else {
      filename = `${baseName}.png`;
      receipt = await exportApng(
        frames,
        fps,
        filename,
        apngEncoder!,
        onProgress,
        signal,
      );
    }
  }

  onProgress?.(1, `Download started: ${filename}`);
  return { filename, width: input.width, height: input.height, receipt };
}
