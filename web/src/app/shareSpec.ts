export const SHARE_LONG_EDGE = 1024;

export function shareFileName(
  styleId: string,
  seed: string,
  width = SHARE_LONG_EDGE,
  height = SHARE_LONG_EDGE,
): string {
  return `strata-${styleId}-${seed}-${width}x${height}.png`;
}
