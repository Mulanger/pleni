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
  likes: number;
  comments: number;
}
