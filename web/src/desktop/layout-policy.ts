export type ViewportSurface = "mobile" | "tablet-gate" | "desktop";

export const MOBILE_MAX_WIDTH = 699;
export const DESKTOP_MIN_WIDTH = 1100;

/** The three product surfaces selected by viewport width. */
export function viewportSurface(width: number): ViewportSurface {
  if (width <= MOBILE_MAX_WIDTH) return "mobile";
  if (width < DESKTOP_MIN_WIDTH) return "tablet-gate";
  return "desktop";
}

/** Move exactly one clip and clamp at the beginning/end of a feed. */
export function adjacentClipIndex(
  activeIndex: number,
  itemCount: number,
  direction: -1 | 1
): number {
  if (itemCount <= 0) return 0;
  return Math.min(Math.max(activeIndex + direction, 0), itemCount - 1);
}
