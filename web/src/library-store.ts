import type { LibraryState, PartyCode } from "./types";

/**
 * Device-local storage for follows, saves and likes.
 *
 * Like `onboarding-store.ts`, this module is deliberately the *only* place the
 * viewer's library is written, so "does any of this leave the device?" is
 * answerable by reading one file. The answer is no: `localStorage` and nothing
 * else.
 *
 * That is not a placeholder for a missing fetch call. **A list of politicians
 * someone follows reveals political opinion**, which makes it special-category
 * data under GDPR Article 9 exactly as the onboarding leaning slider is. The
 * schema that could lawfully hold it does not exist yet: `C-1` (private
 * schema), `C-2` (append-only consent ledger carrying the Article 6 basis,
 * Article 9 condition and notice version) and `C-6` (server-side enforcement)
 * are all open GATE items, as are the F0 documents that decide retention.
 *
 * `C-9` asks for these to persist server-side. That is `F1`, and when it lands
 * the ledger becomes the source of truth and this store becomes its cache.
 *
 * Politicians are keyed by `public.politicians.id` and never by a display-name
 * slug (`Q-2`).
 */

const KEY = "riket.library.v1";

export const EMPTY_LIBRARY: LibraryState = {
  followedPoliticians: [],
  followedParties: [],
  savedClips: [],
  likedClips: []
};

const VALID_PARTIES: PartyCode[] = ["S", "M", "SD", "C", "V", "KD", "MP", "L"];

/** Keep only strings, drop duplicates, and cap the list. */
function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.length > 0 && item.length <= 200) {
      seen.add(item);
    }
    if (seen.size >= limit) {
      break;
    }
  }
  return [...seen];
}

export function readLibrary(): LibraryState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      return EMPTY_LIBRARY;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return EMPTY_LIBRARY;
    }
    const value = parsed as Partial<LibraryState>;
    return {
      // Caps are not arbitrary tidiness: this is user-writable storage, and the
      // saved list is turned into an `id=in.(…)` query string. An unbounded
      // array would build a URL long enough to be rejected by the gateway,
      // which would break the archive rather than one row in it.
      followedPoliticians: stringList(value.followedPoliticians, 500),
      followedParties: Array.isArray(value.followedParties)
        ? value.followedParties.filter((p): p is PartyCode =>
            VALID_PARTIES.includes(p as PartyCode)
          )
        : [],
      savedClips: stringList(value.savedClips, 500),
      likedClips: stringList(value.likedClips, 2000)
    };
  } catch {
    // Private browsing, a full quota or hand-edited JSON. An empty library is
    // recoverable — the viewer re-follows — where throwing would take down
    // every tab for a preference.
    return EMPTY_LIBRARY;
  }
}

export function writeLibrary(state: LibraryState): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Non-fatal for the same reason.
  }
}

export function clearLibrary(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Non-fatal.
  }
}

/** Add `id` if absent, remove it if present. Order is insertion order. */
export function toggleInList<T>(list: readonly T[], id: T): T[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}
