import { allowedOrigins, corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  RULES_ALGORITHM_VERSION,
  parseRecommendationProfile,
  type PartyCode
} from "../_shared/consent.ts";
import {
  callServiceRpc,
  loadFeedCatalogue,
  loadInterestCatalogue,
  ServiceDatabaseError
} from "../_shared/db.ts";
import { bearerToken, ClerkAuthError, verifyClerkJwt } from "../_shared/jwt.ts";
import { rankFeed, type CandidateClip } from "../_shared/ranking.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PARTIES = new Set(["S", "M", "SD", "C", "V", "KD", "MP", "L"]);

function issuers(): Set<string> {
  const configured = Deno.env.get("CLERK_ISSUERS")
    ?.split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return new Set(
    configured?.length
      ? configured
      : ["https://clerk.pleni.se", "https://leading-seasnail-33.clerk.accounts.dev"]
  );
}

function text(row: Record<string, unknown>, key: string): string {
  return typeof row[key] === "string" ? row[key] : "";
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

function mapCandidate(value: unknown): CandidateClip | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = text(row, "id");
  const videoUrl = text(row, "url_540x960");
  const debateDate = text(row, "debate_date");
  if (!id || !videoUrl || !/^\d{4}-\d{2}-\d{2}$/.test(debateDate)) return null;
  const rawParty = text(row, "party").toUpperCase();
  const party = (PARTIES.has(rawParty) ? rawParty : "NONE") as PartyCode | "NONE";
  const politicianId = nullableText(row, "politician_id");
  const clip = {
    id,
    speechId: text(row, "speech_id"),
    politicianId,
    politicianName: nullableText(row, "politician_name"),
    politicianRole: nullableText(row, "politician_role"),
    politicianAvatarUrl: nullableText(row, "politician_avatar_url"),
    speakerName: text(row, "speaker_name") || "Riksdagen",
    party,
    anforandetyp: text(row, "anforandetyp"),
    archetype: text(row, "archetype"),
    title: text(row, "title") || "Anförande i riksdagen",
    transcript: text(row, "transcript"),
    topic: nullableText(row, "topic"),
    durationS: numberValue(row, "duration_s"),
    videoUrl,
    thumbUrl: text(row, "thumb_url"),
    sourceTitle: text(row, "source_title"),
    sourceUrl: text(row, "source_url"),
    debateDate,
    publishedAt: nullableText(row, "published_at"),
    rank: numberValue(row, "rank_in_speech"),
    isSample: false
  };
  return {
    id,
    speechId: clip.speechId,
    politicianId,
    politicianName: clip.politicianName,
    speakerName: clip.speakerName,
    party,
    debateDate,
    publishedAt: clip.publishedAt,
    rankInSpeech: clip.rank,
    clip
  };
}

function errorResponse(error: unknown, cors: Headers): Response {
  if (error instanceof ClerkAuthError) return jsonResponse({ error: error.code }, 401, cors);
  if (error instanceof ServiceDatabaseError) {
    const consentRequired = error.detail.includes("personalization_consent_required");
    return jsonResponse(
      {
        error: consentRequired ? "personalization_consent_required" : "feed_service_unavailable",
        fallbackMode: "latest"
      },
      consentRequired ? 403 : 503,
      cors
    );
  }
  const code = error instanceof Error ? error.message : "invalid_request";
  return jsonResponse({ error: code, fallbackMode: "latest" }, 400, cors);
}

Deno.serve(async (request) => {
  const allowed = allowedOrigins(Deno.env.get("ALLOWED_ORIGINS"));
  const cors = corsHeaders(request.headers.get("Origin"), allowed);
  if (!cors) return new Response("Origin not allowed", { status: 403 });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, cors, { Allow: "POST, OPTIONS" });
  }

  try {
    const claims = await verifyClerkJwt(bearerToken(request), {
      issuers: issuers(),
      authorizedParties: allowed
    });
    if (claims.role !== "authenticated") throw new ClerkAuthError("wrong_role");
    const body = (await request.json()) as Record<string, unknown>;
    if (body.mode !== "for_you") throw new Error("invalid_feed_mode");
    const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId : "";
    if (!UUID.test(clientRequestId)) throw new Error("invalid_client_request_id");
    const limit = Math.min(60, Math.max(1, Math.trunc(Number(body.limit) || 20)));

    const rawContext = await callServiceRpc<unknown>("get_recommendation_context", {
      p_subject: claims.sub
    });
    const profile = parseRecommendationProfile(rawContext);
    if (!profile.personalization) {
      return jsonResponse(
        { error: "personalization_consent_required", fallbackMode: "latest" },
        403,
        cors
      );
    }

    const interestParties = [...new Set([...profile.explicitParties, ...profile.followedParties])];
    const [recentRows, interestRows] = await Promise.all([
      loadFeedCatalogue(700),
      loadInterestCatalogue(interestParties, profile.followedPoliticians, 500)
    ]);
    const candidates = [...recentRows, ...interestRows]
      .map(mapCandidate)
      .filter((candidate): candidate is CandidateClip => candidate !== null);
    const ranked = rankFeed(candidates, profile, limit);
    const recorded = await callServiceRpc<unknown>("record_recommendation_slate", {
      p_subject: claims.sub,
      p_client_request_id: clientRequestId,
      p_algorithm_version: RULES_ALGORITHM_VERSION,
      p_items: ranked.map((item) => ({
        clip_id: item.clipId,
        position: item.position,
        pool: item.pool,
        reason_code: item.reasonCode,
        reason_label: item.reason,
        score: item.score,
        score_components: item.scoreComponents,
        clip_payload: item.clip
      }))
    });
    return jsonResponse(recorded, 200, cors, { "X-Request-Id": clientRequestId });
  } catch (error) {
    return errorResponse(error, cors);
  }
});
