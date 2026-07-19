import { useCallback, useEffect, useRef, useState } from "react";
import type { CapabilityMatrix } from "./capabilities.ts";
import type { PngArtifact } from "./useExports.ts";
import { shareFileName } from "./shareSpec.ts";
export { SHARE_LONG_EDGE, shareFileName } from "./shareSpec.ts";

export type NativeShareMode = "copy" | "url" | "file";

export function resolveNativeShareMode(capabilities: CapabilityMatrix): NativeShareMode {
  if (!capabilities.nativeShare) return "copy";
  return capabilities.fileShare && capabilities.pngExport ? "file" : "url";
}

export type ShareStatus =
  | { phase: "idle" }
  | { phase: "preparing"; message: string }
  | { phase: "sharing"; message: string }
  | { phase: "cancelled"; message: string }
  | { phase: "error"; message: string };

function isShareCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Native share with a standard attributed export and URL/copy fallbacks. */
export function useShare({
  styleId,
  seed,
  label,
  capabilities,
  createSharePng,
  onFallbackCopy,
}: {
  styleId: string;
  seed: string;
  label: string;
  capabilities: CapabilityMatrix;
  createSharePng: (signal: AbortSignal) => Promise<PngArtifact>;
  onFallbackCopy: () => boolean | Promise<boolean>;
}) {
  const [status, setStatus] = useState<ShareStatus>({ phase: "idle" });
  const controllerRef = useRef<AbortController | null>(null);

  const cancelShare = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.abort(new DOMException("Share cancelled", "AbortError"));
    if (controllerRef.current === controller) {
      controllerRef.current = null;
      setStatus({ phase: "cancelled", message: "Share cancelled." });
    }
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const fallbackToCopy = useCallback(async (controller: AbortController): Promise<void> => {
    if (controllerRef.current !== controller) return;
    setStatus({ phase: "sharing", message: "Sharing unavailable; copying the composition link…" });
    let copied = false;
    try {
      copied = await onFallbackCopy();
    } catch {
      copied = false;
    }
    if (controllerRef.current !== controller) return;
    setStatus(
      copied
        ? { phase: "idle" }
        : {
            phase: "error",
            message: "Sharing failed and the link could not be copied. Copy it from the address bar.",
          },
    );
  }, [onFallbackCopy]);

  const share = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const title = label ? `Strata Studio — ${label}` : "Strata Studio";
    const url = window.location.href;

    try {
      const mode = resolveNativeShareMode(capabilities);
      if (mode === "copy" || typeof navigator.share !== "function") {
        await fallbackToCopy(controller);
        return;
      }

      if (mode === "url") {
        setStatus({ phase: "sharing", message: "Sharing composition link…" });
        await navigator.share({ title, url });
        if (controllerRef.current === controller) setStatus({ phase: "idle" });
        return;
      }

      setStatus({ phase: "preparing", message: "Preparing attributed 1024px image…" });
      const artifact = await createSharePng(controller.signal);
      if (controller.signal.aborted) throw new DOMException("Share cancelled", "AbortError");
      if (controllerRef.current !== controller) return;
      const file = new File(
        [artifact.blob],
        shareFileName(styleId, seed, artifact.width, artifact.height),
        { type: "image/png" },
      );

      if (typeof navigator.canShare !== "function" || !navigator.canShare({ files: [file] })) {
        setStatus({ phase: "sharing", message: "Image sharing unavailable; sharing link…" });
        await navigator.share({ title, url });
      } else {
        setStatus({
          phase: "sharing",
          message: `Sharing ${artifact.width}×${artifact.height} attributed image…`,
        });
        await navigator.share({ files: [file], title, url });
      }
      if (controllerRef.current === controller) setStatus({ phase: "idle" });
    } catch (error) {
      if (controllerRef.current !== controller) return;
      if (isShareCancellation(error) || controller.signal.aborted) {
        setStatus({ phase: "cancelled", message: "Share cancelled." });
        return;
      }
      await fallbackToCopy(controller);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [
    capabilities,
    createSharePng,
    fallbackToCopy,
    label,
    seed,
    styleId,
  ]);

  return {
    shareSupported: capabilities.nativeShare,
    share,
    shareStatus: status,
    isSharing: status.phase === "preparing" || status.phase === "sharing",
    cancelShare,
  };
}
