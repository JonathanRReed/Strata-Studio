import { frameDelayMs } from "./animation.ts";
import { throwIfExportAborted } from "./export.ts";

export type ApngRequest = {
  frames: ArrayBuffer[];
  width: number;
  height: number;
  delays: number[];
};
export type ApngResponse =
  { ok: true; png: ArrayBuffer } | { ok: false; error: string };

/** Consumes frame buffers by transferring ownership. Never reuses them afterward. */
export async function encodeApngFrames(
  frames: ImageData[],
  fps: number,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    createWorker?: () => Worker;
  } = {},
): Promise<ArrayBuffer> {
  const { signal, timeoutMs = 60_000 } = options;
  throwIfExportAborted(signal);
  const width = frames[0]?.width,
    height = frames[0]?.height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    frames.length < 1 ||
    frames.length > 240 ||
    !Number.isFinite(fps) ||
    fps < 1 ||
    fps > 60 ||
    width * height * frames.length * 4 > 128 * 1024 * 1024 ||
    frames.some(
      (frame) =>
        frame.width !== width ||
        frame.height !== height ||
        frame.data.byteLength !== width * height * 4,
    )
  ) {
    throw new Error("Invalid or oversized APNG frame data");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid APNG deadline");
  const seen = new Set<ArrayBuffer>();
  const buffers = frames.map((frame) => {
    const data = frame.data;
    const buffer =
      data.buffer instanceof ArrayBuffer &&
      data.byteOffset === 0 &&
      data.byteLength === data.buffer.byteLength &&
      !seen.has(data.buffer)
        ? data.buffer
        : data.slice().buffer;
    seen.add(buffer);
    return buffer;
  });
  const worker = options.createWorker
    ? options.createWorker()
    : new Worker(new URL("./apng.worker.ts", import.meta.url), {
        type: "module",
      });
  return new Promise<ArrayBuffer>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, png?: ArrayBuffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
      worker.terminate();
      if (error) reject(error);
      else resolve(png!);
    };
    const onAbort = () =>
      finish(new DOMException("Export was cancelled", "AbortError"));
    const onError = (event: ErrorEvent) =>
      finish(new Error(event.message || "APNG worker failed"));
    const onMessageError = () =>
      finish(new Error("APNG worker returned unreadable data"));
    const onMessage = (event: MessageEvent<ApngResponse>) => {
      const data = event.data;
      if (
        data?.ok &&
        data.png instanceof ArrayBuffer &&
        data.png.byteLength >= 8 &&
        [137, 80, 78, 71, 13, 10, 26, 10].every(
          (byte, index) => new Uint8Array(data.png)[index] === byte,
        )
      )
        finish(undefined, data.png);
      else
        finish(
          new Error(
            data?.ok === false
              ? data.error
              : "APNG worker returned invalid data",
          ),
        );
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () =>
        finish(
          new Error(
            "APNG encoding timed out; reduce dimensions or frame count",
          ),
        ),
      timeoutMs,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      const request: ApngRequest = {
        frames: buffers,
        width,
        height,
        delays: frames.map((_, index) => frameDelayMs(index, fps)),
      };
      worker.postMessage(request, buffers);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
