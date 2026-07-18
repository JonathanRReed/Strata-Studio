export const ORIENTATION_DISMISSED_KEY = "strata.orientation.dismissed";

type DismissalStorage = Pick<Storage, "getItem" | "setItem">;

/** Safe first-session read: unavailable/blocked storage simply shows the guide. */
export function readOrientationDismissed(storage?: DismissalStorage): boolean {
  try {
    const target = storage ?? window.localStorage;
    return target.getItem(ORIENTATION_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** The only persisted onboarding value is the one-bit dismissal flag. */
export function writeOrientationDismissed(storage?: DismissalStorage): void {
  try {
    const target = storage ?? window.localStorage;
    target.setItem(ORIENTATION_DISMISSED_KEY, "1");
  } catch {
    // Storage is optional; dismissal still applies for the current session.
  }
}
