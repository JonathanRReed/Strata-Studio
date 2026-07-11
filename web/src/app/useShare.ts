import { useCallback, useState, type RefObject } from "react";

/** Filename for the shared artwork PNG. */
export function shareFileName(styleId: string, seed: string): string {
  return `strata-${styleId}-${seed}.png`;
}

/**
 * navigator.share flow with graceful degradation:
 *
 *   1. Canvas → PNG File share when navigator.canShare({ files }) allows it.
 *   2. Plain navigator.share({ title, url }) otherwise.
 *   3. The caller's copy-link fallback when share() itself fails
 *      (user cancellations are not failures and are swallowed).
 *
 * `shareSupported` is false where navigator.share doesn't exist (e.g. Chrome
 * desktop) — callers hide the button entirely rather than show a dead one.
 */
export function useShare({
  canvasRef,
  styleId,
  seed,
  label,
  onFallbackCopy,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  styleId: string;
  seed: string;
  label: string;
  /** Last-resort fallback (the existing copy-link flow). */
  onFallbackCopy: () => void;
}) {
  // Feature-detected once; navigator.share never appears mid-session.
  const [shareSupported] = useState(
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
  );

  const share = useCallback(async () => {
    if (!shareSupported) {
      onFallbackCopy();
      return;
    }
    const title = label ? `Strata Studio — ${label}` : "Strata Studio";
    const url = window.location.href;
    try {
      const canvas = canvasRef.current;
      if (canvas && typeof navigator.canShare === "function") {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (blob) {
          const file = new File([blob], shareFileName(styleId, seed), { type: "image/png" });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title, url });
            return;
          }
        }
      }
      await navigator.share({ title, url });
    } catch (err) {
      // The user closing the share sheet is not an error.
      if (err instanceof DOMException && err.name === "AbortError") return;
      onFallbackCopy();
    }
  }, [shareSupported, canvasRef, styleId, seed, label, onFallbackCopy]);

  return { shareSupported, share };
}
