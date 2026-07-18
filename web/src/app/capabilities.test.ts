import { describe, expect, it } from "bun:test";
import {
  buildCapabilityMatrix,
  supportedAnimationFormats,
  supportedExportFormats,
  type CapabilityProbe,
} from "./capabilities.ts";
import { DEFAULT_FRAMES } from "../engine/animation.ts";

function probe(overrides: Partial<CapabilityProbe> = {}): CapabilityProbe {
  return {
    dialog: true,
    inert: true,
    createImageBitmap: true,
    canvasToBlob: true,
    captureStream: true,
    requestFrame: true,
    mediaRecorder: true,
    supportedMediaRecorderTypes: ["video/webm;codecs=vp9"],
    nativeShare: true,
    fileShare: true,
    clipboard: true,
    webgl: true,
    ...overrides,
  };
}

describe("capability matrix", () => {
  it("derives every optional browser capability without conflating them", () => {
    const matrix = buildCapabilityMatrix(probe({ dialog: false, inert: false, createImageBitmap: false }));
    expect(matrix.dialog).toBe(false);
    expect(matrix.inert).toBe(false);
    expect(matrix.createImageBitmap).toBe(false);
    expect(matrix.pngExport).toBe(true);
    expect(matrix.webmExport).toBe(true);
    expect(matrix.webmMimeType).toBe("video/webm;codecs=vp9");
  });

  it("hides unsupported PNG and WebM choices before export work starts", () => {
    const matrix = buildCapabilityMatrix(
      probe({
        canvasToBlob: false,
        requestFrame: false,
        supportedMediaRecorderTypes: [],
      }),
    );
    expect(supportedExportFormats(matrix)).toEqual(["svg", "animation"]);
    expect(supportedAnimationFormats(matrix)).toEqual(["gif", "apng"]);
  });

  it("uses the approved 24-frame GIF/APNG default", () => {
    expect(DEFAULT_FRAMES).toBe(24);
  });

  it("keeps GIF and APNG encoders behind dynamic import boundaries", async () => {
    const source = await Bun.file(new URL("../engine/animationExport.ts", import.meta.url)).text();
    expect(source).toContain('import("gifenc")');
    expect(source).toContain('import("upng-js")');
    expect(source).not.toMatch(/from\s+["']gifenc["']/);
    expect(source).not.toMatch(/from\s+["']upng-js["']/);
  });
});
