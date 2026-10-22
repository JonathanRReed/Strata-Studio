import { expect, test, spyOn } from "bun:test";
import { exportAnimation } from "./animationExport.ts";
import { getStyle } from "../studios/registry.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import { palettes } from "../presets/palettes.ts";
import type { ArtworkInput } from "./types.ts";

test("cancellation releases a recorder that becomes inactive without emitting stop", async () => {
  const oldDocument = globalThis.document,
    oldRecorder = globalThis.MediaRecorder;
  const controller = new AbortController();
  let tracksStopped = 0;
  const generation = spyOn(getStyle("ridge"), "generate").mockReturnValue({
    strokes: [],
  });
  const track = {
    requestFrame() {},
    stop() {
      tracksStopped++;
    },
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => ctx,
    captureStream: () => stream,
  };
  const ctx = {
    canvas,
    save() {},
    restore() {},
    setTransform() {},
    scale() {},
    fillRect() {},
    putImageData() {},
    getImageData: () => ({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray(4),
    }),
  };
  class SilentRecorder {
    state = "inactive";
    ondataavailable = null;
    onstop = null;
    onerror = null;
    start() {
      this.state = "recording";
      setTimeout(() => controller.abort(), 45);
    }
    stop() {
      this.state = "inactive";
    }
  }
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    writable: true,
    value: SilentRecorder,
  });
  const bounds = { west: 0, east: 1, north: 1, south: 0 };
  const input: ArtworkInput = {
    bounds,
    elevationGrid: { bounds, width: 1, height: 1, data: new Float32Array([0]) },
    width: 1,
    height: 1,
    seed: "cancel",
  };
  try {
    const outcome = await Promise.race([
      exportAnimation(
        "ridge",
        input,
        { ...defaultStyleParams, grain: 0, label: "" },
        palettes,
        "webm",
        {
          frames: 1,
          fps: 60,
          signal: controller.signal,
          webmMimeType: "video/webm",
        },
      ).then(
        () => "downloaded",
        (error) => error.name,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);
    expect(outcome).toBe("AbortError");
    expect(tracksStopped).toBe(1);
  } finally {
    controller.abort();
    generation.mockRestore();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: oldDocument,
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: oldRecorder,
    });
  }
});

test("all expensive drift frames are generated before recording starts", async () => {
  const oldDocument = globalThis.document,
    oldRecorder = globalThis.MediaRecorder;
  let rendered = 0,
    atStart = -1,
    tracksStopped = 0;
  const generation = spyOn(getStyle("ridge"), "generate").mockImplementation(
    () => {
      rendered++;
      return { strokes: [] };
    },
  );
  const track = {
    requestFrame() {},
    stop() {
      tracksStopped++;
    },
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => ctx,
    captureStream: () => stream,
  };
  const ctx = {
    canvas,
    save() {},
    restore() {},
    setTransform() {},
    scale() {},
    fillRect() {},
    putImageData() {},
    getImageData: () => ({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray(4),
    }),
  };
  class Recorder {
    state = "inactive";
    ondataavailable = null;
    onstop: null | (() => void) = null;
    onerror: null | (() => void) = null;
    start() {
      atStart = rendered;
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.onerror?.();
    }
  }
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    writable: true,
    value: Recorder,
  });
  const bounds = { west: 0, east: 1, north: 1, south: 0 };
  const input: ArtworkInput = {
    bounds,
    elevationGrid: { bounds, width: 1, height: 1, data: new Float32Array([0]) },
    width: 1,
    height: 1,
    seed: "timing",
  };
  try {
    await expect(
      exportAnimation(
        "ridge",
        input,
        { ...defaultStyleParams, animationMode: "drift", grain: 0, label: "" },
        palettes,
        "webm",
        { frames: 3, fps: 60, webmMimeType: "video/webm" },
      ),
    ).rejects.toThrow("WebM recording failed");
    expect(atStart).toBe(3);
    expect(rendered).toBe(3);
    expect(tracksStopped).toBe(1);
  } finally {
    generation.mockRestore();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: oldDocument,
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: oldRecorder,
    });
  }
});
