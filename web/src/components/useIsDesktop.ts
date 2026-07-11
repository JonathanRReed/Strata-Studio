import { useEffect, useState } from "react";

/** Matches Tailwind's lg breakpoint (64rem = 1024px at the default root size). */
const DESKTOP_QUERY = "(min-width: 64rem)";

/**
 * True at ≥lg. App uses this to mount exactly one controls container —
 * the desktop rail (ControlsPanel) or the mobile bottom sheet (MobileSheet) —
 * so thumbnails and section state aren't paid for twice in a hidden copy.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia(DESKTOP_QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isDesktop;
}
