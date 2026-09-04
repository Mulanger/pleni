import type { ClipItem, PartyCode } from "./types";

const PARTY_CODES = new Set<PartyCode>(["S", "M", "SD", "C", "V", "KD", "MP", "L", "NONE"]);

/**
 * Read the clip embedded in a prerendered watch page before React replaces it.
 *
 * The payload is only a first-paint optimization. The route id remains
 * authoritative, and malformed or stale markup falls back to the public
 * single-clip request instead of being trusted by the player.
 */
export function parseClipBootstrap(
  text: string | null | undefined,
  requestedClipId: string
): ClipItem | null {
  if (!text || !requestedClipId) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.id !== requestedClipId) {
    return null;
  }

  const party = value.party;
  if (typeof party !== "string" || !PARTY_CODES.has(party as PartyCode)) {
    return null;
  }

  const requiredStrings = [
    "id",
    "speechId",
    "speakerName",
    "anforandetyp",
    "archetype",
    "title",
    "transcript",
    "videoUrl",
    "thumbUrl",
    "sourceTitle",
    "sourceUrl",
    "debateDate"
  ] as const;
  if (requiredStrings.some((key) => typeof value[key] !== "string")) {
    return null;
  }
  if (!isNullableString(value.sourceId) ||
      !isNullableString(value.politicianId) ||
      !isNullableString(value.politicianName) ||
      !isNullableString(value.politicianRole) ||
      !isNullableString(value.politicianAvatarUrl) ||
      !isNullableString(value.topic) ||
      !isNullableString(value.publishedAt) ||
      typeof value.durationS !== "number" ||
      !Number.isFinite(value.durationS) ||
      value.durationS < 0 ||
      typeof value.rank !== "number" ||
      !Number.isInteger(value.rank) ||
      value.rank < 1 ||
      value.isSample !== false) {
    return null;
  }

  return {
    id: value.id as string,
    speechId: value.speechId as string,
    sourceId: value.sourceId as string | null,
    politicianId: value.politicianId as string | null,
    politicianName: value.politicianName as string | null,
    politicianRole: value.politicianRole as string | null,
    politicianAvatarUrl: value.politicianAvatarUrl as string | null,
    speakerName: value.speakerName as string,
    party: party as PartyCode,
    anforandetyp: value.anforandetyp as string,
    archetype: value.archetype as string,
    title: value.title as string,
    transcript: value.transcript as string,
    topic: value.topic as string | null,
    durationS: value.durationS,
    videoUrl: value.videoUrl as string,
    thumbUrl: value.thumbUrl as string,
    sourceTitle: value.sourceTitle as string,
    sourceUrl: value.sourceUrl as string,
    debateDate: value.debateDate as string,
    publishedAt: value.publishedAt as string | null,
    rank: value.rank,
    isSample: false
  };
}

/** Put the Google-selected clip first, then continue through the normal feed. */
export function clipEntryFeed(entry: ClipItem | null, continuation: ClipItem[]): ClipItem[] {
  if (entry === null) {
    return [];
  }
  return [entry, ...continuation.filter((clip) => clip.id !== entry.id)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
