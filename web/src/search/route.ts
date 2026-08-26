import type { ClipItem } from "../types";
import type { SearchClipResult } from "./types";

const SEARCH_FEED_HISTORY_KEY = "pleniSearchFeed";

export interface SearchFeedCollection {
  historyId: string;
  title: string;
  subtitle: string;
  clips: ClipItem[];
  startId: string | null;
}

/**
 * Build the scoped player directly from the search response.
 *
 * Mapping is deliberately order-preserving: search rank is the array order,
 * and the ordinary latest-feed loader must never participate in this handoff.
 */
export function createSearchFeedCollection(
  results: readonly SearchClipResult[],
  title: string,
  requestedStartId: string | null,
  historyId: string
): SearchFeedCollection {
  const clips = results.map(({ clip, speakerNameAtSpeech, partyAtSpeech }) => ({
    ...clip,
    // Search carries explicit historical byline fields. Keep them authoritative
    // inside this collection without changing current politician destinations.
    speakerName: speakerNameAtSpeech,
    party: partyAtSpeech
  }));
  const startId =
    requestedStartId !== null && clips.some((clip) => clip.id === requestedStartId)
      ? requestedStartId
      : clips[0]?.id ?? null;

  return {
    historyId,
    title,
    subtitle: `Mest relevanta först · ${clips.length} ${clips.length === 1 ? "träff" : "träffar"}`,
    clips,
    startId
  };
}

/** Add only an opaque page-session marker; query text and results stay in React memory. */
export function withSearchFeedHistoryState(
  state: unknown,
  historyId: string
): Record<string, unknown> {
  return {
    ...historyRecord(state),
    [SEARCH_FEED_HISTORY_KEY]: { historyId }
  };
}

export function searchFeedHistoryId(state: unknown): string | null {
  if (state === null || typeof state !== "object") {
    return null;
  }
  const marker = (state as Record<string, unknown>)[SEARCH_FEED_HISTORY_KEY];
  if (marker === null || typeof marker !== "object") {
    return null;
  }
  const historyId = (marker as Record<string, unknown>).historyId;
  return typeof historyId === "string" && historyId.length > 0 ? historyId : null;
}

function historyRecord(state: unknown): Record<string, unknown> {
  return state !== null && typeof state === "object"
    ? { ...(state as Record<string, unknown>) }
    : {};
}
