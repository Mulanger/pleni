import type { LibraryState, PartyCode } from "./types";

/**
 * Device-local storage for follows, saves and likes.
 *
 * Like `onboarding-store.ts`, this module is deliberately the *only* place the
 * viewer's library is written. Likes and saves remain device-local. After the
 * viewer gives explicit recommendation consent, followed party and politician
 * IDs are projected into the private recommendation service.
 *
 * That is not a placeholder for a missing fetch call. **A list of politicians
 * someone follows reveals political opinion**, which makes it special-category
 * data under GDPR Article 9. The private schema, append-only consent ledger and
 * server-side enforcement now own that projection; this store remains the UI's
 * per-account cache and the source for likes and saves.
 *
 * Politicians are keyed by `public.politicians.id` and never by a display-name
 * slug (`Q-2`).
 */

/**
 * Storage key for one account's library.
 *
 * Scoped by Clerk user id, never a bare shared key. Two people using the same
 * phone must not see each other's follows and saves, and a follow list reveals
 * political opinion — leaking it to whoever signs in next is the same Article 9
 * problem as sending it to a server without a lawful basis, just closer to home.
 *
 * The bare `riket.library.v1` is deliberately no longer written. It may still
 * exist from before library actions required an account; nothing reads it, so
 * an anonymous library cannot be silently adopted by the first account that
 * signs in. Attributing follows to a person who never made them is worse than
 * losing them.
 */
const KEY_PREFIX = "riket.library.v1";

function keyFor(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

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

export function readLibrary(userId: string | null): LibraryState {
  if (!userId) {
    return EMPTY_LIBRARY;
  }
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
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

export function writeLibrary(userId: string | null, state: LibraryState): void {
  // No account, no write. This is the storage-level half of the gate: even if a
  // caller forgot to check, an anonymous library cannot come into existence.
  if (!userId) {
    return;
  }
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(state));
  } catch {
    // Non-fatal for the same reason.
  }
}

export function clearLibrary(userId: string | null): void {
  if (!userId) {
    return;
  }
  try {
    window.localStorage.removeItem(keyFor(userId));
  } catch {
    // Non-fatal.
  }
}

/** Add `id` if absent, remove it if present. Order is insertion order. */
export function toggleInList<T>(list: readonly T[], id: T): T[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}
