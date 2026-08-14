import {
  EMPTY_RECOMMENDATION_PROFILE,
  PERSONALIZATION_NOTICE_VERSION,
  parseRecommendationProfile
} from "./consent";
import type {
  ClipFeed,
  ClipItem,
  PartyCode,
  RecommendationFeedResponse,
  RecommendationProfile
} from "./types";

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

export const recommendationsEnabled =
  (import.meta.env.VITE_RECOMMENDATIONS_ENABLED ?? "").trim().toLowerCase() === "true";

export type AccessTokenGetter = () => Promise<string | null>;

export interface ExplicitPreferenceInput {
  parties: PartyCode[];
  followedParties: PartyCode[];
  followedPoliticians: string[];
}

export class RecommendationApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = "RecommendationApiError";
  }
}

async function functionRequest(
  path: string,
  getAccessToken: AccessTokenGetter,
  options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal }
): Promise<unknown> {
  if (!recommendationsEnabled || !SUPABASE_URL || !SUPABASE_KEY) {
    throw new RecommendationApiError("recommendations_not_configured", 503);
  }
  const attempt = async (): Promise<Response> => {
    const token = await getAccessToken();
    if (!token) throw new RecommendationApiError("sign_in_required", 401);
    return fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
      method: options.method ?? "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
  };

  let response = await attempt();
  // Clerk tokens live for 60 seconds. Ask Clerk for a fresh token and retry the
  // exact idempotent request once before surfacing a failure.
  if (response.status === 401 && !options.signal?.aborted) response = await attempt();
  if (!response.ok) {
    let code = `recommendation_http_${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") code = body.error;
    } catch {
      // The status still gives the caller a stable failure class.
    }
    throw new RecommendationApiError(code, response.status);
  }
  return response.json();
}

export async function loadRecommendationProfile(
  getAccessToken: AccessTokenGetter,
  signal?: AbortSignal
): Promise<RecommendationProfile> {
  if (!recommendationsEnabled) return EMPTY_RECOMMENDATION_PROFILE;
  return parseRecommendationProfile(
    await functionRequest("consent", getAccessToken, { method: "GET", signal })
  );
}

export async function setRecommendationConsent(
  granted: boolean,
  preferences: ExplicitPreferenceInput,
  uiSource: "onboarding" | "profile",
  getAccessToken: AccessTokenGetter,
  signal?: AbortSignal
): Promise<RecommendationProfile> {
  return parseRecommendationProfile(
    await functionRequest("consent", getAccessToken, {
      method: "POST",
      body: {
        action: "set",
        granted,
        noticeVersion: PERSONALIZATION_NOTICE_VERSION,
        uiSource,
        preferences
      },
      signal
    })
  );
}

export async function syncRecommendationPreferences(
  preferences: ExplicitPreferenceInput,
  getAccessToken: AccessTokenGetter,
  signal?: AbortSignal
): Promise<RecommendationProfile> {
  return parseRecommendationProfile(
    await functionRequest("consent", getAccessToken, {
      method: "POST",
      body: { action: "sync", preferences },
      signal
    })
  );
}

function parseFeedResponse(value: unknown): RecommendationFeedResponse {
  if (!value || typeof value !== "object") throw new Error("Ogiltigt flödessvar");
  const response = value as Partial<RecommendationFeedResponse>;
  if (
    typeof response.feedRequestId !== "string" ||
    typeof response.algorithmVersion !== "string" ||
    !Array.isArray(response.items)
  ) {
    throw new Error("Ogiltigt flödessvar");
  }
  return response as RecommendationFeedResponse;
}

export async function loadRuleBasedFeed(
  getAccessToken: AccessTokenGetter,
  options: { limit?: number; clientRequestId?: string; signal?: AbortSignal } = {}
): Promise<ClipFeed> {
  const clientRequestId = options.clientRequestId ?? crypto.randomUUID();
  const response = parseFeedResponse(
    await functionRequest("feed-requests", getAccessToken, {
      method: "POST",
      body: { clientRequestId, mode: "for_you", limit: options.limit ?? 60 },
      signal: options.signal
    })
  );
  const clips = response.items.map((item): ClipItem => ({
    ...item.clip,
    recommendationReason: item.reason,
    recommendationReasonCode: item.reasonCode,
    feedRequestId: response.feedRequestId,
    feedItemId: item.feedItemId,
    feedPosition: item.position
  }));
  return { clips, source: "supabase" };
}
