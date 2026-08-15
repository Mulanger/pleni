export type Tab = "hem" | "foljer" | "sok" | "profil";
export type FeedMode = "fordig" | "senaste";

export type PartyCode = "S" | "M" | "SD" | "C" | "V" | "KD" | "MP" | "L" | "NONE";

/** Consent purposes, kept separate because `C-4` requires it. */
export interface ConsentState {
  personal: boolean;
  analytics: boolean;
  email: boolean;
}

/**
 * Answers from the onboarding flow. The device cache retains this shape; an
 * enabled, consented rule feed sends only explicit parties and follows through
 * the private recommendation service.
 */
export interface OnboardingState {
  parties: PartyCode[];
  consent: ConsentState;
  acceptedTerms: boolean;
  completedAt: string | null;
}

/** Server-confirmed explicit-interest state. Absence always means denied. */
export interface RecommendationProfile {
  personalization: boolean;
  noticeVersion: string | null;
  explicitParties: PartyCode[];
  followedParties: PartyCode[];
  followedPoliticians: string[];
}

/**
 * A row from `public.politicians` — the app's canonical person record.
 *
 * `id` is the same stable uuid `ClipItem.politicianId` carries (`Q-2`).
 * `clipCount` is the exact published total from `Content-Range`, or `null`
 * when it has not been fetched; `null` renders as absent rather than as `0`,
 * because "we have not counted" and "they have no clips" are different facts.
 */
export interface Politician {
  id: string;
  name: string;
  party: PartyCode;
  role: string;
  constituency: string;
  /** Official Riksdagen portrait, or null when no image is published. */
  avatarUrl: string | null;
  clipCount: number | null;
}

/**
 * Everything the viewer has chosen to keep: follows, saves, likes.
 *
 * **Device-local library with a consented recommendation projection.** Saves
 * and likes never leave this store in rule V1. Followed party/politician IDs
 * are copied to the private recommendation service only while the viewer has
 * explicitly enabled personalisation.
 *
 * Politicians are keyed by `politicians.id` and never by a display name
 * (`Q-2`); clips by `clips.id`.
 */
export interface LibraryState {
  followedPoliticians: string[];
  followedParties: PartyCode[];
  savedClips: string[];
  likedClips: string[];
}

/** Small local presentation fallback used before a backend party row is loaded. */
export interface PartySummary {
  abbr: PartyCode;
  name: string;
  short: string;
  color: string;
}

/** A canonical row from `public.party_profiles`, enriched with live catalogue totals. */
export interface PartyProfile extends PartySummary {
  displayOrder: number;
  /** Exact published total, or null when the count request failed. */
  clipCount: number | null;
  /** Exact number of current politician records, or null when counting failed. */
  politicianCount: number | null;
}

export interface PersonProfile {
  id: string;
  name: string;
  party: PartyCode;
  role: string;
  constituency: string;
  clips: number;
  followers: number;
  speeches: number;
  bio: string;
  committees: string[];
}

export interface ClipItem {
  id: string;
  speechId: string;
  /**
   * Stable identity of the speaker — `public.politicians.id` (`Q-2`, a GATE).
   *
   * Everything that outlives a session keys on this and never on the display
   * name. The row is upserted `on conflict (intressent_id)`, so a minister who
   * changes portfolio keeps the same uuid while their name and role update in
   * place. The old name-slug scheme split the five most-clipped ministers into
   * two identities each — 380 clips, 21.6% of the catalogue, measured
   * 2026-08-04 — because it stripped only four hardcoded title prefixes.
   *
   * `null` when Riksdagen's `anforandelista` supplied no `intressent_id`,
   * which today means a minister who is not a sitting MP. A null speaker is
   * **not followable**: falling back to a name would record a follow that
   * silently detaches the day the id is recovered.
   */
  politicianId: string | null;
  /** Riksdagen's current display name for that politician; may carry a title. */
  politicianName: string | null;
  /** `ledamot`, `minister`, … from the politician row. Null when unlinked. */
  politicianRole: string | null;
  /** Official Riksdagen portrait carried with the embedded politician row. */
  politicianAvatarUrl: string | null;
  /** The name as printed on *this* speech. Display only — never an identity. */
  speakerName: string;
  party: PartyCode;
  anforandetyp: string;
  archetype: string;
  title: string;
  transcript: string;
  topic: string | null;
  durationS: number;
  videoUrl: string;
  thumbUrl: string;
  sourceTitle: string;
  sourceUrl: string;
  debateDate: string;
  publishedAt: string | null;
  rank: number;
  /**
   * True for the built-in demo clips in `data.ts`.
   *
   * Prerequisite FE-1: sample clips must never generate telemetry. Tagging them
   * on the item means a stray impression can be dropped at the source instead
   * of relying on every call site to remember which array it is looking at.
   *
   * `likes` and `comments` used to live here and were fabricated arithmetic
   * (`1200 + index * 143`). Invented popularity figures on political content are
   * a credibility problem before they are a data problem — FE-2. Reintroduce
   * them only when a real count exists behind them.
   */
  isSample: boolean;
  feedRequestId?: string;
  feedItemId?: string;
  feedPosition?: number;
}

/**
 * Where a rendered feed came from. The UI must be able to tell the difference:
 * substituting demo data for a failed request silently is exactly what FE-12
 * forbids.
 */
export type ClipSource = "supabase" | "sample";

export interface ClipFeed {
  clips: ClipItem[];
  source: ClipSource;
  /** Present when the Supabase read failed and the feed is empty. */
  error?: string;
}

export interface RecommendationFeedResponse {
  feedRequestId: string;
  algorithmVersion: string;
  items: Array<{
    feedItemId: string;
    position: number;
    pool: string;
    reasonCode: string;
    reason: string;
    score: number;
    scoreComponents: Record<string, unknown>;
    clip: ClipItem;
  }>;
}
