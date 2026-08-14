import { allowedOrigins, corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  PARTY_CODES,
  PERSONALIZATION_NOTICE_VERSION,
  parsePreferenceInput,
  parseRecommendationProfile
} from "../_shared/consent.ts";
import { callServiceRpc, ServiceDatabaseError } from "../_shared/db.ts";
import { bearerToken, ClerkAuthError, verifyClerkJwt } from "../_shared/jwt.ts";

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

function errorResponse(error: unknown, cors: Headers): Response {
  if (error instanceof ClerkAuthError) {
    return jsonResponse({ error: error.code }, 401, cors);
  }
  if (error instanceof ServiceDatabaseError) {
    const consentRequired = error.detail.includes("personalization_consent_required");
    return jsonResponse(
      { error: consentRequired ? "personalization_consent_required" : "recommendation_store_failed" },
      consentRequired ? 403 : error.status >= 500 ? 503 : 400,
      cors
    );
  }
  const code = error instanceof Error ? error.message : "invalid_request";
  return jsonResponse({ error: code }, 400, cors);
}

Deno.serve(async (request) => {
  const allowed = allowedOrigins(Deno.env.get("ALLOWED_ORIGINS"));
  const cors = corsHeaders(request.headers.get("Origin"), allowed);
  if (!cors) return new Response("Origin not allowed", { status: 403 });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, cors, { Allow: "GET, POST, OPTIONS" });
  }

  try {
    const claims = await verifyClerkJwt(bearerToken(request), {
      issuers: issuers(),
      authorizedParties: allowed
    });
    if (claims.role !== "authenticated") throw new ClerkAuthError("wrong_role");

    if (request.method === "GET") {
      const raw = await callServiceRpc<unknown>("get_recommendation_profile", {
        p_subject: claims.sub
      });
      return jsonResponse(parseRecommendationProfile(raw), 200, cors);
    }

    const body = (await request.json()) as Record<string, unknown>;
    const action = body.action;
    if (action === "set") {
      if (typeof body.granted !== "boolean") throw new Error("invalid_consent_state");
      if (body.noticeVersion !== PERSONALIZATION_NOTICE_VERSION) {
        throw new Error("unknown_notice_version");
      }
      const uiSource = body.uiSource === "profile" ? "profile" : "onboarding";
      const preferences = body.granted
        ? parsePreferenceInput(body.preferences)
        : { parties: [], followedParties: [], followedPoliticians: [] };
      const raw = await callServiceRpc<unknown>("set_recommendation_consent", {
        p_subject: claims.sub,
        p_granted: body.granted,
        p_notice_version: PERSONALIZATION_NOTICE_VERSION,
        p_ui_source: uiSource,
        p_explicit_parties: preferences.parties,
        p_followed_parties: preferences.followedParties,
        p_followed_politicians: preferences.followedPoliticians
      });
      return jsonResponse(parseRecommendationProfile(raw), 200, cors);
    }
    if (action === "sync") {
      const preferences = parsePreferenceInput(body.preferences);
      const raw = await callServiceRpc<unknown>("sync_recommendation_preferences", {
        p_subject: claims.sub,
        p_explicit_parties: preferences.parties,
        p_followed_parties: preferences.followedParties,
        p_followed_politicians: preferences.followedPoliticians
      });
      return jsonResponse(parseRecommendationProfile(raw), 200, cors);
    }
    if (action === "metadata") {
      return jsonResponse(
        { noticeVersion: PERSONALIZATION_NOTICE_VERSION, parties: PARTY_CODES },
        200,
        cors
      );
    }
    throw new Error("unknown_action");
  } catch (error) {
    return errorResponse(error, cors);
  }
});
