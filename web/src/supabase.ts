import { normalizeParty, SAMPLE_CLIPS } from "./data";
import type { ClipItem } from "./types";

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

export async function loadPublishedClips(limit = 60): Promise<ClipItem[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return SAMPLE_CLIPS;
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

  const response = await fetch(`${SUPABASE_URL}/rest/v1/clips?${query.toString()}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase clip read failed: ${response.status}`);
  }

  const rows = (await response.json()) as RawClip[];
  const clips = rows.map(mapClip).filter((clip) => clip.videoUrl.length > 0);
  return clips.length > 0 ? clips : SAMPLE_CLIPS;
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
    likes: 1200 + index * 143,
    comments: 64 + index * 17
  };
}

function first<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}
