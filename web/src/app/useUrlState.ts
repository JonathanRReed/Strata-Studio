import { useCallback, useEffect, useRef, useState } from "react";
import { loadCustomPalettes } from "../presets/customPalettes.ts";
import { palettes } from "../presets/palettes.ts";
import { parseShareParams, serializeShareState, type ParsedShareState, type ShareState } from "./urlState.ts";

/** Reads and resolves the initial app state from the current URL. Call once. */
export function readInitialUrlState(): ParsedShareState {
  return parseShareParams(new URLSearchParams(window.location.search), {
    isKnownPalette: (id) => Boolean(palettes[id] || loadCustomPalettes()[id]),
  });
}

/** Mirrors app state into the URL (replaceState) and provides Copy URL. */
export function useUrlState({ params, styleId, bounds, mapZoom }: ShareState) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const query = serializeShareState({ params, styleId, bounds, mapZoom });
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
  }, [params, styleId, bounds, mapZoom]);

  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyError(null);
      setCopiedUrl(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      setCopyError("Failed to copy URL to clipboard");
    }
  }, []);

  const dismissCopyError = useCallback(() => setCopyError(null), []);

  return { copiedUrl, copyUrl, copyError, dismissCopyError };
}
