import type { AnimationFormat } from "../engine/animationExport.ts";

export type CapabilityProbe = {
  dialog: boolean;
  inert: boolean;
  createImageBitmap: boolean;
  canvasToBlob: boolean;
  captureStream: boolean;
  requestFrame: boolean;
  mediaRecorder: boolean;
  supportedMediaRecorderTypes: readonly string[];
  nativeShare: boolean;
  fileShare: boolean;
  clipboard: boolean;
  webgl: boolean;
};

export type CapabilityMatrix = CapabilityProbe & {
  webmMimeType: string | null;
  pngExport: boolean;
  svgExport: boolean;
  gifExport: boolean;
  apngExport: boolean;
  webmExport: boolean;
};

const WEBM_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/** Pure derivation used by UI and tests; environment probing lives separately. */
export function buildCapabilityMatrix(probe: CapabilityProbe): CapabilityMatrix {
  const webmMimeType =
    WEBM_TYPES.find((type) => probe.supportedMediaRecorderTypes.includes(type)) ?? null;
  const webmExport = Boolean(
    probe.captureStream &&
      probe.requestFrame &&
      probe.mediaRecorder &&
      webmMimeType,
  );
  return {
    ...probe,
    webmMimeType,
    pngExport: probe.canvasToBlob,
    svgExport: true,
    // GIF/APNG use ImageData and dynamically loaded encoders, not toBlob.
    gifExport: true,
    apngExport: true,
    webmExport,
  };
}

function probeWebGl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function probeFileShare(): boolean {
  try {
    if (typeof navigator.canShare !== "function" || typeof File !== "function") return false;
    const file = new File([new Uint8Array([0])], "capability.png", { type: "image/png" });
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function detectCapabilities(): CapabilityMatrix {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return buildCapabilityMatrix({
      dialog: false,
      inert: false,
      createImageBitmap: false,
      canvasToBlob: false,
      captureStream: false,
      requestFrame: false,
      mediaRecorder: false,
      supportedMediaRecorderTypes: [],
      nativeShare: false,
      fileShare: false,
      clipboard: false,
      webgl: false,
    });
  }

  const canvas = document.createElement("canvas");
  const mediaRecorder = typeof MediaRecorder === "function";
  const supportedMediaRecorderTypes = mediaRecorder && typeof MediaRecorder.isTypeSupported === "function"
    ? WEBM_TYPES.filter((type) => MediaRecorder.isTypeSupported(type))
    : [];
  const trackPrototype = globalThis.CanvasCaptureMediaStreamTrack?.prototype;

  return buildCapabilityMatrix({
    dialog:
      typeof HTMLDialogElement === "function" &&
      typeof HTMLDialogElement.prototype.showModal === "function",
    inert: typeof HTMLElement === "function" && "inert" in HTMLElement.prototype,
    createImageBitmap: typeof globalThis.createImageBitmap === "function",
    canvasToBlob: typeof canvas.toBlob === "function",
    captureStream: typeof canvas.captureStream === "function",
    requestFrame: Boolean(trackPrototype && typeof trackPrototype.requestFrame === "function"),
    mediaRecorder,
    supportedMediaRecorderTypes,
    nativeShare: typeof navigator.share === "function",
    fileShare: probeFileShare(),
    clipboard: typeof navigator.clipboard?.writeText === "function",
    webgl: probeWebGl(),
  });
}

export type SupportedExportFormat = "png" | "svg" | "animation";

export function supportedExportFormats(
  capabilities: CapabilityMatrix,
): SupportedExportFormat[] {
  const formats: SupportedExportFormat[] = [];
  if (capabilities.pngExport) formats.push("png");
  if (capabilities.svgExport) formats.push("svg");
  if (supportedAnimationFormats(capabilities).length > 0) formats.push("animation");
  return formats;
}

export function supportedAnimationFormats(
  capabilities: CapabilityMatrix,
): AnimationFormat[] {
  const formats: AnimationFormat[] = [];
  if (capabilities.gifExport) formats.push("gif");
  if (capabilities.apngExport) formats.push("apng");
  if (capabilities.webmExport) formats.push("webm");
  return formats;
}
