export const PERSONALIZATION_NOTICE_VERSION = "personalization-2026-08-14-v2";
export const RULES_ALGORITHM_VERSION = "explicit-rules-v1";
export const PARTY_CODES = ["S", "M", "SD", "C", "V", "KD", "MP", "L"] as const;
export type PartyCode = (typeof PARTY_CODES)[number];

export interface RecommendationProfile {
  personalization: boolean;
  noticeVersion: string | null;
  explicitParties: PartyCode[];
  followedParties: PartyCode[];
  followedPoliticians: string[];
  recentClipIds?: string[];
}

export interface PreferenceInput {
  parties: PartyCode[];
  followedParties: PartyCode[];
  followedPoliticians: string[];
}

const PARTY_SET = new Set<string>(PARTY_CODES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uniqueStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.length > 0 && item.length <= 200) {
      result.add(item);
    }
    if (result.size >= limit) {
      break;
    }
  }
  return [...result];
}

function parties(value: unknown): PartyCode[] {
  return uniqueStrings(value, 8).filter((value): value is PartyCode => PARTY_SET.has(value));
}

export function parsePreferenceInput(value: unknown): PreferenceInput {
  if (!value || typeof value !== "object") {
    return { parties: [], followedParties: [], followedPoliticians: [] };
  }
  const input = value as Record<string, unknown>;
  const politicianIds = uniqueStrings(input.followedPoliticians, 500);
  if (politicianIds.some((id) => !UUID.test(id))) {
    throw new Error("invalid_politician_id");
  }
  return {
    parties: parties(input.parties),
    followedParties: parties(input.followedParties),
    followedPoliticians: politicianIds
  };
}

export function parseRecommendationProfile(value: unknown): RecommendationProfile {
  if (!value || typeof value !== "object") {
    throw new Error("invalid_recommendation_profile");
  }
  const profile = value as Record<string, unknown>;
  return {
    personalization: profile.personalization === true,
    noticeVersion: typeof profile.noticeVersion === "string" ? profile.noticeVersion : null,
    explicitParties: parties(profile.explicitParties),
    followedParties: parties(profile.followedParties),
    followedPoliticians: uniqueStrings(profile.followedPoliticians, 500).filter((id) => UUID.test(id)),
    recentClipIds: uniqueStrings(profile.recentClipIds, 500)
  };
}
