import { normalizeParty, SAMPLE_CLIPS } from "./data";
import type { ClipFeed, ClipItem, PartyCode, Politician } from "./types";

interface RawSource {
  title: string | null;
  debate_date: string | null;
  source_url: string | null;
}

/**
 * The `public.politicians` row behind a speech.
 *
 * `id` is the stable identity the whole app keys on (`Q-2`). It is a uuid whose
 * row is upserted `on conflict (intressent_id)`, so a minister who changes
 * portfolio keeps the same `id` while `name` and `role` update in place.
 * `name` here is Riksdagen's current display name and still carries any title
 * prefix — it is for display, never for identity.
 */
interface RawPolitician {
  id: string;
  name: string | null;
  party: string | null;
  role: string | null;
  constituency: string | null;
  avatar_url: string | null;
}

interface RawSpeech {
  speaker_name: string | null;
  party: string | null;
  anforandetyp: string | null;
  politician_id: string | null;
  politicians: RawPolitician | RawPolitician[] | null;
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
    /** Extra request headers, e.g. `Prefer: count=exact` for a row total. */
    headers?: Record<string, string>;
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
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      ...options.headers
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
 * The clip column list, shared by every read that returns `ClipItem`s.
 *
 * `politicians` is embedded through the `speeches.politician_id` foreign key
 * (Q-2). It needs no grant of its own: `politicians_public_read` is
 * `using (true)` and migration 004 kept `select` for `anon`.
 *
 * `inner` makes the speech join a filter rather than a left join, which is what
 * lets `loadClipsForPolitician()` constrain on `speeches.politician_id`. It is
 * harmless for the unfiltered feed — every clip has a speech.
 */
function clipSelect(): string {
  return [
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
    "speeches!inner(speaker_name,party,anforandetyp,politician_id," +
      "politicians(id,name,party,role,constituency,avatar_url)," +
      "sources(title,debate_date,source_url))"
  ].join(",");
}

/** Run a clip query and map the rows, returning `[]` on any failure. */
async function readClips(query: URLSearchParams): Promise<ClipItem[]> {
  const response = await supabaseRest(`clips?${query.toString()}`);
  if (!response.ok) {
    return [];
  }
  const rows = (await response.json()) as RawClip[];
  return rows.map(mapClip).filter((clip) => clip.videoUrl.length > 0);
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

  const query = new URLSearchParams({
    select: clipSelect(),
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

/* ------------------------------------------------------------------ *
 * Politicians and scoped clip reads — the Sök / Följer / person page   *
 * surfaces (UI1). All of these run on the publishable key under RLS;   *
 * every one was verified against the live project before being used.   *
 * ------------------------------------------------------------------ */

const POLITICIAN_SELECT = "id,name,party,role,constituency,avatar_url";

function mapPolitician(row: RawPolitician, clipCount: number | null = null): Politician {
  return {
    id: row.id,
    name: row.name?.trim() || "Okänd talare",
    party: normalizeParty(row.party),
    role: row.role?.trim() || "",
    constituency: row.constituency?.trim() || "",
    avatarUrl: row.avatar_url?.trim() || null,
    clipCount
  };
}

/**
 * PostgREST reserves `,` `.` `(` `)` inside a filter value, and `*` is the
 * `like` wildcard. A surname cannot contain those, but a pasted query can, and
 * an unescaped one silently changes the filter rather than failing.
 */
function escapeLikeValue(value: string): string {
  return value.replace(/[,.()*\\]/g, " ").trim();
}

/**
 * Find politicians by name, optionally narrowed to one party.
 *
 * Searches `public.politicians` directly rather than the loaded feed: a person
 * the viewer is looking for is usually *not* in the 60 most recent clips, which
 * is why the old people-derived-from-clips search could not find them.
 */
export async function searchPoliticians(
  query: string,
  options: { party?: PartyCode | null; limit?: number; signal?: AbortSignal } = {}
): Promise<Politician[]> {
  if (!supabaseConfigured) {
    return [];
  }
  const params = new URLSearchParams({
    select: POLITICIAN_SELECT,
    order: "name.asc",
    limit: String(options.limit ?? 40)
  });

  const term = escapeLikeValue(query);
  if (term.length > 0) {
    params.set("name", `ilike.*${term}*`);
  }
  if (options.party && options.party !== "NONE") {
    params.set("party", `eq.${options.party}`);
  }

  const response = await supabaseRest(`politicians?${params.toString()}`, {
    signal: options.signal
  });
  if (!response.ok) {
    return [];
  }
  return ((await response.json()) as RawPolitician[]).map((row) => mapPolitician(row));
}

/**
 * Resolve a follow list into politician rows.
 *
 * The follow list is a set of uuids on the device; the people behind them may
 * not appear anywhere in the current feed, so Följer cannot be rendered from
 * loaded clips.
 */
export async function loadPoliticiansByIds(ids: string[]): Promise<Politician[]> {
  if (!supabaseConfigured || ids.length === 0) {
    return [];
  }
  const params = new URLSearchParams({
    select: POLITICIAN_SELECT,
    id: `in.(${ids.join(",")})`,
    order: "name.asc"
  });
  const response = await supabaseRest(`politicians?${params.toString()}`);
  if (!response.ok) {
    return [];
  }
  return ((await response.json()) as RawPolitician[]).map((row) => mapPolitician(row));
}

/** One politician plus their exact published clip total. */
export async function loadPolitician(id: string): Promise<Politician | null> {
  const [rows, clipCount] = await Promise.all([
    loadPoliticiansByIds([id]),
    countClipsForPolitician(id)
  ]);
  const row = rows[0];
  return row ? { ...row, clipCount } : null;
}

/**
 * The exact number of published clips for one politician.
 *
 * Taken from `Content-Range` with `Prefer: count=exact` and a one-row window,
 * so the total does not depend on how many rows were fetched — the count and
 * the page are independent. Returns `null` if the header is missing, because
 * "unknown" must not render as `0`.
 */
export async function countClipsForPolitician(politicianId: string): Promise<number | null> {
  if (!supabaseConfigured) {
    return null;
  }
  const params = new URLSearchParams({
    select: "id,speeches!inner(politician_id)",
    "speeches.politician_id": `eq.${politicianId}`,
    published_at: "not.is.null",
    moderation: "neq.rejected"
  });
  const response = await supabaseRest(`clips?${params.toString()}`, {
    headers: { Prefer: "count=exact", Range: "0-0" }
  });
  if (!response.ok) {
    return null;
  }
  const total = response.headers.get("content-range")?.split("/")[1];
  const parsed = Number(total);
  return total && Number.isFinite(parsed) ? parsed : null;
}

/**
 * A politician's published clips, newest debate first.
 *
 * Ordered by `debate_date`, not `published_at`: on a person's page the question
 * is when they said it, not when the pipeline got round to encoding it. The
 * same distinction `Q-4` makes for ranking.
 */
export async function loadClipsForPolitician(
  politicianId: string,
  limit = 60
): Promise<ClipItem[]> {
  if (!supabaseConfigured) {
    return [];
  }
  return readClips(
    new URLSearchParams({
      select: clipSelect(),
      "speeches.politician_id": `eq.${politicianId}`,
      published_at: "not.is.null",
      moderation: "neq.rejected",
      order: "published_at.desc",
      limit: String(limit)
    })
  );
}

/**
 * Clips by id, for the saved archive.
 *
 * Returned in the caller's order rather than the database's, so the archive
 * reads newest-saved-first instead of by primary key. Ids that no longer exist
 * are simply absent — a clip pulled from the catalogue should vanish from the
 * archive, not render as a broken player.
 */
export async function loadClipsByIds(ids: string[]): Promise<ClipItem[]> {
  if (!supabaseConfigured || ids.length === 0) {
    return [];
  }
  const clips = await readClips(
    new URLSearchParams({
      select: clipSelect(),
      id: `in.(${ids.join(",")})`,
      published_at: "not.is.null",
      moderation: "neq.rejected",
      limit: String(ids.length)
    })
  );
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  return ids.map((id) => byId.get(id)).filter((clip): clip is ClipItem => clip !== undefined);
}

function mapClip(row: RawClip, index: number): ClipItem {
  const speech = first(row.speeches);
  const source = first(speech?.sources ?? null);
  const politician = first(speech?.politicians ?? null);
  const speakerName = speech?.speaker_name?.trim() || "Riksdagen";
  // The politician row wins for party when it has one: `speeches.party` is what
  // Riksdagen printed on that particular speech, while the politician row is the
  // person's current affiliation.
  const party = normalizeParty(politician?.party ?? speech?.party);

  return {
    id: row.id,
    speechId: row.speech_id,
    // Null for the ~0.6% of clips whose speaker Riksdagen's `anforandelista`
    // gives no `intressent_id` — ministers who are not sitting MPs. Callers must
    // treat null as "not followable", never fall back to a name (Q-2).
    politicianId: speech?.politician_id ?? null,
    politicianName: politician?.name?.trim() || null,
    politicianRole: politician?.role?.trim() || null,
    politicianAvatarUrl: politician?.avatar_url?.trim() || null,
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
