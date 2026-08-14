import type { PartyCode, RecommendationProfile } from "./types";

export const PERSONALIZATION_NOTICE_VERSION = "personalization-2026-08-14-v2";

export const EMPTY_RECOMMENDATION_PROFILE: RecommendationProfile = {
  personalization: false,
  noticeVersion: null,
  explicitParties: [],
  followedParties: [],
  followedPoliticians: []
};

const VALID_PARTIES = new Set<PartyCode>(["S", "M", "SD", "C", "V", "KD", "MP", "L"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function strings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.length > 0 && item.length <= 200) result.add(item);
    if (result.size >= limit) break;
  }
  return [...result];
}

function parties(value: unknown): PartyCode[] {
  return strings(value, 8).filter((value): value is PartyCode =>
    VALID_PARTIES.has(value as PartyCode)
  );
}

export function parseRecommendationProfile(value: unknown): RecommendationProfile {
  if (!value || typeof value !== "object") throw new Error("Ogiltigt rekommendationssvar");
  const profile = value as Record<string, unknown>;
  return {
    personalization: profile.personalization === true,
    noticeVersion: typeof profile.noticeVersion === "string" ? profile.noticeVersion : null,
    explicitParties: parties(profile.explicitParties),
    followedParties: parties(profile.followedParties),
    followedPoliticians: strings(profile.followedPoliticians, 500).filter((id) => UUID.test(id))
  };
}
