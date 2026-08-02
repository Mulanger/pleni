export type Tab = "hem" | "foljer" | "sok" | "profil";
export type FeedMode = "fordig" | "senaste";

export type PartyCode = "S" | "M" | "SD" | "C" | "V" | "KD" | "MP" | "L" | "NONE";

export interface PartyProfile {
  abbr: PartyCode;
  name: string;
  short: string;
  color: string;
  clips: number;
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
