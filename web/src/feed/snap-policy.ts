export const FEED_SWIPE_AXIS_LOCK_PX = 8;
export const FEED_SWIPE_AXIS_RATIO = 1.2;
export const FEED_SWIPE_MIN_DISTANCE_PX = 48;
export const FEED_SWIPE_DISTANCE_FRACTION = 0.08;
export const FEED_SWIPE_MIN_VELOCITY_PX_MS = 0.35;
export const FEED_SNAP_DURATION_MS = 140;

export interface SnapDecisionInput {
  currentIndex: number;
  itemCount: number;
  itemHeight: number;
  /** Pointer end minus pointer start. Negative means an upward swipe. */
  dragDeltaY: number;
  /** Pointer velocity in CSS pixels per millisecond. */
  velocityY: number;
}

export interface DragPositionInput {
  currentIndex: number;
  itemCount: number;
  itemHeight: number;
  /** Pointer current minus pointer start. */
  dragDeltaY: number;
}

export function isVerticalSwipeIntent(deltaX: number, deltaY: number): boolean {
  const verticalDistance = Math.abs(deltaY);
  return (
    verticalDistance >= FEED_SWIPE_AXIS_LOCK_PX &&
    verticalDistance > Math.abs(deltaX) * FEED_SWIPE_AXIS_RATIO
  );
}

/** Choose the current or one adjacent item; a gesture can never skip a clip. */
export function decideSnapTarget({
  currentIndex,
  itemCount,
  itemHeight,
  dragDeltaY,
  velocityY
}: SnapDecisionInput): number {
  if (itemCount <= 0) {
    return 0;
  }
  const safeCurrentIndex = clamp(currentIndex, 0, itemCount - 1);
  if (itemHeight <= 0) {
    return safeCurrentIndex;
  }

  const distanceThreshold = Math.max(
    FEED_SWIPE_MIN_DISTANCE_PX,
    itemHeight * FEED_SWIPE_DISTANCE_FRACTION
  );
  const committedByDistance = Math.abs(dragDeltaY) >= distanceThreshold;
  const committedByVelocity = Math.abs(velocityY) >= FEED_SWIPE_MIN_VELOCITY_PX_MS;
  if (!committedByDistance && !committedByVelocity) {
    return safeCurrentIndex;
  }

  const directionSource = committedByDistance ? dragDeltaY : velocityY;
  if (directionSource === 0) {
    return safeCurrentIndex;
  }
  // Pointer movement is opposite scroll movement: up advances, down goes back.
  const direction = directionSource < 0 ? 1 : -1;
  return clamp(safeCurrentIndex + direction, 0, itemCount - 1);
}

/** Follow the pointer without allowing a drag to expose more than one neighbor. */
export function dragScrollTop({
  currentIndex,
  itemCount,
  itemHeight,
  dragDeltaY
}: DragPositionInput): number {
  if (itemCount <= 0 || itemHeight <= 0) {
    return 0;
  }
  const safeCurrentIndex = clamp(currentIndex, 0, itemCount - 1);
  const minimumIndex = Math.max(0, safeCurrentIndex - 1);
  const maximumIndex = Math.min(itemCount - 1, safeCurrentIndex + 1);
  return clamp(
    safeCurrentIndex * itemHeight - dragDeltaY,
    minimumIndex * itemHeight,
    maximumIndex * itemHeight
  );
}

export function snapScrollTop(index: number, itemCount: number, itemHeight: number): number {
  if (itemCount <= 0 || itemHeight <= 0) {
    return 0;
  }
  return clamp(index, 0, itemCount - 1) * itemHeight;
}

export function snapDuration(prefersReducedMotion: boolean): number {
  return prefersReducedMotion ? 0 : FEED_SNAP_DURATION_MS;
}

export function snapEaseOut(progress: number): number {
  const clampedProgress = clamp(progress, 0, 1);
  return 1 - (1 - clampedProgress) ** 3;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
