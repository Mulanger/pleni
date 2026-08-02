import { normalizeParty, SAMPLE_CLIPS } from "./data";
import type { ClipFeed, ClipItem } from "./types";

interface RawSource {
  title: string | null;
  debate_date: string | null;
  source_url: string | null;
}

interface RawSpeech {
  speaker_name: string | null;
  party: string | null;
  anforandetyp: string | null;
  sources: RawSource | RawSource[] | null;
}

interface RawClip {
  id: string;
  speech_id: string;
  rank_in_speech: number | null;
  duration_s: number | string | null;
  title: string | null;
  transcript: string | null;
  topic: string | null;
  archetype: string | null;
  url_540x960: string;
  thumb_url: string;
  published_at: string | null;
  speeches: RawSpeech | RawSpeech[] | null;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, "") ?? "";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

export const supabaseConfigured = SUPABASE_URL.length > 0 && SUPABASE_KEY.length > 0;

/**
 * Whether the built-in demo clips may stand in for real data.
 *
 * Prerequisite FE-1 (GATE): `loadPublishedClips()` used to return `SAMPLE_CLIPS`
 * on missing env vars, on a failed request *and* on an empty result, with no way
 * for the caller to tell. Once telemetry exists those demo clips would emit
 * impressions against clip IDs that are not in the catalogue, poisoning the
 * dataset silently.
 *
 * Demo data is now opt-in and off unless `VITE_ALLOW_SAMPLE_CLIPS=true`. A
 * telemetry-bearing build simply never sets it, and the feed shows an honest
 * empty state instead.
 */
export const sampleClipsAllowed =
  (import.meta.env.VITE_ALLOW_SAMPLE_CLIPS ?? "").trim().toLowerCase() === "true";

/**
 * Fetch a Clerk session token, or `null` when signed out / Clerk not configured.
 * Matches the shape of Clerk's `session.getToken`.
 */
export type AccessTokenGetter = () => Promise<string | null>;

/**
 * One request against the Supabase REST API.
 *
 * `apikey` is always the publishable key — it identifies the project, not the
 * caller. `Authorization` carries the Clerk session token when the caller is
 * signed in, so Postgres RLS sees `auth.jwt()->>'sub'` as the Clerk user ID;
 * otherwise it falls back to the publishable key and the request is evaluated
 * as `anon`.
 *
 * This requires Clerk to be registered as a third-party auth provider on the
 * Supabase project. Until that is done, signed-in requests are rejected, which
 * is why callers that only need public data should pass no token at all.
 */
export async function supabaseRest(
  path: string,
  options: {
    accessToken?: string | null;
    signal?: AbortSignal;
    method?: "GET" | "POST";
    body?: unknown;
  } = {}
): Promise<Response> {
  if (!supabaseConfigured) {
    throw new Error("Supabase is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY");
  }

  const bearer = options.accessToken ?? SUPABASE_KEY;
  const method = options.method ?? "GET";

  return fetch(`${SUPABASE_URL}/rest/v1/${path.replace(/^\//, "")}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {})
    },
    body: method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
    signal: options.signal
  });
}

/** Claims `public.auth_probe()` reports back from the verified request context. */
export interface AuthProbeClaims {
  sub: string | null;
  role: string | null;
  iss: string | null;
  azp: string | null;
  exp: string | null;
  iat: string | null;
  claim_keys: string[];
  auth_jwt_sub: string | null;
  auth_uid: string | null;
  pg_role: string;
  pg_session_user: string;
  server_time: string;
}

export type ClerkSupabaseLinkStatus =
  | { state: "unconfigured" }
  | { state: "signed-out" }
  | { state: "ok"; claims: AuthProbeClaims; token: TokenSummary }
  | { state: "probe-missing"; detail: string; token: TokenSummary }
  | { state: "rejected"; status: number; detail: string; token: TokenSummary };

/**
 * Non-secret summary of the session token, for diagnostics.
 *
 * Deliberately never includes the token itself. The claims are what matter when
 * something goes wrong — a missing `role` claim and a wrong `iss` produce very
 * different failures, and guessing between them wastes a round trip through a
 * human.
 */
export interface TokenSummary {
  sub: string | null;
  role: string | null;
  iss: string | null;
  azp: string | null;
  expiresInS: number | null;
  claimKeys: string[];
  url: string;
}

function summarizeToken(token: string, url: string): TokenSummary {
  try {
    const [, payload] = token.split(".");
    const json = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
    ) as Record<string, unknown>;
    const exp = typeof json.exp === "number" ? json.exp : null;
    return {
      sub: (json.sub as string) ?? null,
      role: (json.role as string) ?? null,
      iss: (json.iss as string) ?? null,
      azp: (json.azp as string) ?? null,
      expiresInS: exp === null ? null : Math.round(exp - Date.now() / 1000),
      claimKeys: Object.keys(json).sort(),
      url
    };
  } catch {
    return { sub: null, role: null, iss: null, azp: null, expiresInS: null, claimKeys: [], url };
  }
}

/**
 * Diagnostic: does Supabase actually accept this Clerk session token, and does
 * Postgres see the Clerk user id?
 *
 * Prerequisite A-3 / A-4. Calls `public.auth_probe()`, which is granted to
 * `authenticated` and revoked from `anon`, so reaching it at all is already
 * evidence that PostgREST verified the RS256 signature against the Clerk JWKS
 * and switched roles on the strength of the `role: authenticated` claim that
 * Clerk's Supabase integration adds. The returned `sub` is the Clerk user id as
 * SQL sees it — which is what A-7's `clerk_user_id text` keys will compare
 * against.
 *
 * A 404 means migration 003 has not been applied yet. A 401/403 means Clerk is
 * not registered as a third-party auth provider on the Supabase project, or the
 * token carries no `role` claim.
 */
export async function checkClerkSupabaseLink(
  getToken: AccessTokenGetter
): Promise<ClerkSupabaseLinkStatus> {
  if (!supabaseConfigured) {
    return { state: "unconfigured" };
  }

  const token = await getToken();
  if (!token) {
    return { state: "signed-out" };
  }

  const path = "rpc/auth_probe";
  const summary = summarizeToken(token, `${SUPABASE_URL}/rest/v1/${path}`);
  const response = await supabaseRest(path, { accessToken: token, method: "POST" });

  if (response.ok) {
    return {
      state: "ok",
      claims: (await response.json()) as AuthProbeClaims,
      token: summary
    };
  }

  const detail = (await response.text()).slice(0, 300);
  if (response.status === 404) {
    return { state: "probe-missing", detail, token: summary };
  }
  return { state: "rejected", status: response.status, detail, token: summary };
}

/**
 * Read the published catalogue.
 *
 * Never silently substitutes demo data: the caller is told which source it got
 * (FE-1, FE-12). A failed request resolves to an empty `supabase` feed carrying
 * the error rather than rejecting, so the UI renders an honest empty state.
 */
export async function loadPublishedClips(limit = 60): Promise<ClipFeed> {
  if (!supabaseConfigured) {
    return sampleClipsAllowed
      ? { clips: SAMPLE_CLIPS, source: "sample" }
      : { clips: [], source: "supabase", error: "Supabase is not configured" };
  }

  const select = [
    "id",
    "speech_id",
    "rank_in_speech",
    "duration_s",
    "title",
    "transcript",
    "topic",
    "archetype",
    "url_540x960",
    "thumb_url",
    "published_at",
    "speeches(speaker_name,party,anforandetyp,sources(title,debate_date,source_url))"
  ].join(",");

  const query = new URLSearchParams({
    select,
    order: "published_at.desc",
    limit: String(limit),
    published_at: "not.is.null",
    moderation: "neq.rejected"
  });

  // Published clips are public data readable by `anon`, so this stays an
  // anonymous request whether or not a viewer is signed in.
  const response = await supabaseRest(`clips?${query.toString()}`);

  if (!response.ok) {
    return {
      clips: [],
      source: "supabase",
      error: `Supabase clip read failed: ${response.status}`
    };
  }

  const rows = (await response.json()) as RawClip[];
  const clips = rows.map(mapClip).filter((clip) => clip.videoUrl.length > 0);

  if (clips.length === 0 && sampleClipsAllowed) {
    return { clips: SAMPLE_CLIPS, source: "sample" };
  }
  return { clips, source: "supabase" };
}

function mapClip(row: RawClip, index: number): ClipItem {
  const speech = first(row.speeches);
  const source = first(speech?.sources ?? null);
  const speakerName = speech?.speaker_name?.trim() || "Riksdagen";
  const party = normalizeParty(speech?.party);

  return {
    id: row.id,
    speechId: row.speech_id,
    speakerName,
    party,
    anforandetyp: speech?.anforandetyp ?? "",
    archetype: row.archetype ?? "",
    title: row.title?.trim() || row.transcript?.trim().slice(0, 88) || "Riksdagsklipp",
    transcript: row.transcript ?? "",
    topic: row.topic,
    durationS: Number(row.duration_s ?? 0),
    videoUrl: row.url_540x960,
    thumbUrl: row.thumb_url,
    sourceTitle: source?.title ?? "Riksdagsdebatt",
    sourceUrl: source?.source_url ?? "https://www.riksdagen.se",
    debateDate: source?.debate_date ?? "",
    publishedAt: row.published_at,
    rank: row.rank_in_speech ?? index + 1,
    isSample: false
  };
}

function first<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}
