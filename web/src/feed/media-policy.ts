export type FeedDirection = 1 | -1;
export type MediaPreload = "auto" | "metadata";

export interface MediaConnectionHint {
  saveData?: boolean;
  effectiveType?: string;
}

export interface MediaWindowPlan {
  sourceIndices: readonly number[];
  immediateIndex: number | null;
  stagedIndex: number | null;
}

export interface MediaWindowInput {
  activeIndex: number;
  itemCount: number;
  direction: FeedDirection;
  immediatePlayable: boolean;
  allowSecondLookahead: boolean;
}

export interface ManagedMediaElement {
  preload: string;
  pause(): void;
  load(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Missing network information is normal on Samsung Internet, Safari and many
 * WebViews. Only an explicit constrained-network signal disables the second
 * look-ahead; lack of a hint must not quietly turn fast Wi-Fi into metadata-only.
 */
export function allowsSecondLookahead(
  connection: MediaConnectionHint | null | undefined
): boolean {
  if (connection?.saveData === true) {
    return false;
  }
  const effectiveType = connection?.effectiveType?.trim().toLowerCase();
  return effectiveType !== "2g" && effectiveType !== "slow-2g";
}

/**
 * At most four sources: one behind, the active clip, the immediate destination,
 * and (once that destination is playable) one staged clip beyond it.
 */
export function planMediaWindow({
  activeIndex,
  itemCount,
  direction,
  immediatePlayable,
  allowSecondLookahead
}: MediaWindowInput): MediaWindowPlan {
  if (itemCount <= 0 || activeIndex < 0 || activeIndex >= itemCount) {
    return { sourceIndices: [], immediateIndex: null, stagedIndex: null };
  }

  const immediateIndex = inRange(activeIndex + direction, itemCount)
    ? activeIndex + direction
    : null;
  const behindIndex = inRange(activeIndex - direction, itemCount)
    ? activeIndex - direction
    : null;
  const stagedCandidate = activeIndex + direction * 2;
  const stagedIndex =
    immediateIndex !== null &&
    immediatePlayable &&
    allowSecondLookahead &&
    inRange(stagedCandidate, itemCount)
      ? stagedCandidate
      : null;

  const sourceIndices = [behindIndex, activeIndex, immediateIndex, stagedIndex]
    .filter((index): index is number => index !== null)
    .sort((first, second) => first - second);

  return { sourceIndices, immediateIndex, stagedIndex };
}

/** Apply dynamic media changes deterministically instead of relying on JSX hints. */
export function attachMediaSource(
  media: ManagedMediaElement,
  src: string,
  preload: MediaPreload
): void {
  const sourceChanged = media.getAttribute("src") !== src;
  const preloadChanged = media.preload !== preload;
  if (!sourceChanged && !preloadChanged) {
    return;
  }
  media.preload = preload;
  media.setAttribute("preload", preload);
  if (sourceChanged) {
    media.setAttribute("src", src);
    media.load();
  }
}

/** Abort obsolete work and release the decoder/buffer owned by this element. */
export function releaseMediaSource(media: ManagedMediaElement): void {
  if (media.getAttribute("src") === null) {
    return;
  }
  media.pause();
  media.removeAttribute("src");
  media.load();
}

function inRange(index: number, itemCount: number): boolean {
  return index >= 0 && index < itemCount;
}
