import type { OnboardingState, PartyCode } from "./types";

/**
 * Device-local, account-scoped storage for onboarding answers.
 *
 * This remains the device cache for presentation state. When the recommendation
 * rollout is enabled, the private
 * consent service is authoritative for personalisation and stores only the
 * explicitly selected parties plus followed parties/politicians after a grant.
 * The Clerk user id in this cache key keeps accounts separate on one device.
 */

const KEY_PREFIX = "riket.onboarding.v1";

// The old bare key is intentionally not adopted. It was written before
// onboarding required an account, so assigning it to whichever person signs in
// first could attach someone else's political choices to that account.

function keyFor(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export const EMPTY_ONBOARDING: OnboardingState = {
  parties: [],
  consent: { personal: false, analytics: false, email: false },
  acceptedTerms: false,
  completedAt: null
};

const VALID_PARTIES: PartyCode[] = ["S", "M", "SD", "C", "V", "KD", "MP", "L"];

export function readOnboarding(userId: string | null): OnboardingState {
  if (!userId) {
    return EMPTY_ONBOARDING;
  }
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) {
      return EMPTY_ONBOARDING;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return EMPTY_ONBOARDING;
    }
    const value = parsed as Partial<OnboardingState>;
    return {
      parties: Array.isArray(value.parties)
        ? value.parties.filter((p): p is PartyCode => VALID_PARTIES.includes(p as PartyCode))
        : [],
      consent: {
        personal: value.consent?.personal === true,
        // These purposes are not offered in the current product. Keep the
        // legacy fields off so an older localStorage value cannot re-enable
        // a consent that is no longer presented to the viewer.
        analytics: false,
        email: false
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

export function writeOnboarding(userId: string | null, state: OnboardingState): void {
  if (!userId) {
    return;
  }
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(state));
  } catch {
    // Non-fatal for the same reason.
  }
}

export function clearOnboarding(userId: string | null): void {
  if (!userId) {
    return;
  }
  try {
    window.localStorage.removeItem(keyFor(userId));
  } catch {
    // Non-fatal.
  }
}
