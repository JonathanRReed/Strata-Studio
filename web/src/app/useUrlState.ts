import { useCallback, useEffect, useRef, useState } from "react";
import { loadCustomPalettes } from "../presets/customPalettes.ts";
import { palettes } from "../presets/palettes.ts";
import { parseShareParams, serializeShareState, type ParsedShareState, type ShareState } from "./urlState.ts";

/** Clipboard API first, then the legacy selection command for older/denied contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // A denied async clipboard write can still succeed through a user-gesture
    // selection copy in browsers that retain document.execCommand.
  }

  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  const active =
    typeof HTMLElement === "function" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed",
    left: "-9999px",
    top: "0",
    opacity: "0",
  });
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    active?.focus({ preventScroll: true });
  }
}

/** Reads and resolves the initial app state from the current URL. Call once. */
export function readInitialUrlState(): ParsedShareState {
  return parseShareParams(new URLSearchParams(window.location.search), {
    isKnownPalette: (id) => Boolean(palettes[id] || loadCustomPalettes()[id]),
  });
}

/** Mirrors app state into the URL (replaceState) and provides Copy URL. */
export function useUrlState({
  params,
  styleId,
  bounds,
  mapZoom,
  selectedCustomPalette,
}: ShareState) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const query = serializeShareState({ params, styleId, bounds, mapZoom, selectedCustomPalette });
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
  }, [params, styleId, bounds, mapZoom, selectedCustomPalette]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const copyUrl = useCallback(async (): Promise<boolean> => {
    const copied = await copyText(window.location.href);
    if (copied) {
      setCopyError(null);
      setCopiedUrl(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedUrl(false), 2000);
      return true;
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;
    setCopiedUrl(false);
    setCopyError("This browser could not copy the link. Select the address bar and copy it manually.");
    return false;
  }, []);

  const dismissCopyError = useCallback(() => setCopyError(null), []);

  return { copiedUrl, copyUrl, copyError, dismissCopyError };
}
