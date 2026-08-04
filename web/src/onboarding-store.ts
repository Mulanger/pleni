import type { OnboardingState, PartyCode } from "./types";

/**
 * Device-local storage for onboarding answers.
 *
 * This module is deliberately the *only* place onboarding state is written, so
 * "does any of this leave the device?" is answerable by reading one file. The
 * answer is no: `localStorage` and nothing else.
 *
 * That is not a placeholder for a server call. Political leaning and party
 * preferences are special-category data under GDPR Article 9, and the schema
 * that could lawfully hold them does not exist yet — `C-1` (private schema),
 * `C-2` (append-only consent ledger with Article 6 basis, Article 9 condition
 * and notice version) and `C-6` (server-side enforcement) are all open GATE
 * items, as are the F0 documents that decide retention. Sending any of this to
 * Supabase before those exist would be collection without a lawful basis and
 * without a record of what was agreed.
 *
 * When `F1` lands, this becomes the local half of a sync: the ledger is the
 * source of truth and this cache follows it.
 */

const KEY = "riket.onboarding.v1";

export const EMPTY_ONBOARDING: OnboardingState = {
  leaning: 50,
  parties: [],
  consent: { personal: false, analytics: false, email: false },
  acceptedTerms: false,
  completedAt: null
};

const VALID_PARTIES: PartyCode[] = ["S", "M", "SD", "C", "V", "KD", "MP", "L"];

export function readOnboarding(): OnboardingState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      return EMPTY_ONBOARDING;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return EMPTY_ONBOARDING;
    }
    const value = parsed as Partial<OnboardingState>;
    const leaning = typeof value.leaning === "number" ? value.leaning : 50;
    return {
      // Clamp rather than trust: this is user-writable storage, and a value
      // outside 0-100 would render the slider off its track.
      leaning: Math.min(100, Math.max(0, leaning)),
      parties: Array.isArray(value.parties)
        ? value.parties.filter((p): p is PartyCode => VALID_PARTIES.includes(p as PartyCode))
        : [],
      consent: {
        personal: value.consent?.personal === true,
        analytics: value.consent?.analytics === true,
        email: value.consent?.email === true
      },
      acceptedTerms: value.acceptedTerms === true,
      completedAt: typeof value.completedAt === "string" ? value.completedAt : null
    };
  } catch {
    // Private browsing, a full quota or hand-edited JSON. Falling back to the
    // empty state re-shows onboarding, which is recoverable; throwing here
    // would take down the whole feed for a preference.
    return EMPTY_ONBOARDING;
  }
}

export function writeOnboarding(state: OnboardingState): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Non-fatal for the same reason.
  }
}

export function clearOnboarding(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Non-fatal.
  }
}
