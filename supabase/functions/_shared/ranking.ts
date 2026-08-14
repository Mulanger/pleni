import type { PartyCode, RecommendationProfile } from "./consent.ts";
import { RULES_ALGORITHM_VERSION } from "./consent.ts";

export type CandidatePool =
  | "fresh_interest"
  | "fresh_general"
  | "back_catalog_interest"
  | "adjacent_interest";

export interface CandidateClip {
  id: string;
  speechId: string;
  politicianId: string | null;
  politicianName: string | null;
  speakerName: string;
  party: PartyCode | "NONE";
  debateDate: string;
  publishedAt: string | null;
  rankInSpeech: number;
  clip: Record<string, unknown>;
}

export interface ScoreComponents {
  explicitInterest: number;
  freshness: number;
  quality: number;
}

export interface RankedFeedItem {
  clipId: string;
  position: number;
  pool: CandidatePool;
  reasonCode: string;
  reason: string;
  score: number;
  scoreComponents: ScoreComponents & { constraintRelaxations: string[] };
  clip: Record<string, unknown>;
}

interface ScoredCandidate extends CandidateClip {
  pool: CandidatePool;
  reasonCode: string;
  reason: string;
  score: number;
  scoreComponents: ScoreComponents;
}

export const RANKING_POLICY = {
  algorithmVersion: RULES_ALGORITHM_VERSION,
  freshDays: 45,
  freshnessHalfLifeDays: 30,
  interestWeight: 0.58,
  freshnessWeight: 0.24,
  qualityWeight: 0.18,
  poolSchedule: [
    "fresh_interest",
    "fresh_interest",
    "fresh_general",
    "fresh_interest",
    "back_catalog_interest",
    "fresh_interest",
    "fresh_general",
    "fresh_interest",
    "back_catalog_interest",
    "adjacent_interest"
  ] as CandidatePool[]
} as const;

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function ageDays(date: string, nowMs: number): number {
  const parsed = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(parsed) ? Math.max(0, (nowMs - parsed) / 86_400_000) : 3650;
}

function reasonFor(
  candidate: CandidateClip,
  profile: RecommendationProfile
): { interest: number; code: string; label: string } {
  if (candidate.politicianId && profile.followedPoliticians.includes(candidate.politicianId)) {
    return {
      interest: 1,
      code: "followed_politician",
      label: candidate.politicianName
        ? `Eftersom du följer ${candidate.politicianName}`
        : "Eftersom du följer talaren"
    };
  }
  if (candidate.party !== "NONE" && profile.followedParties.includes(candidate.party)) {
    return {
      interest: 0.9,
      code: "followed_party",
      label: `Eftersom du följer ${candidate.party}`
    };
  }
  if (candidate.party !== "NONE" && profile.explicitParties.includes(candidate.party)) {
    return {
      interest: 0.75,
      code: "selected_party",
      label: `Eftersom du valde ${candidate.party}`
    };
  }
  return { interest: 0, code: "fresh_general", label: "Nytt från riksdagen" };
}

function scoreCandidate(
  candidate: CandidateClip,
  profile: RecommendationProfile,
  nowMs: number
): ScoredCandidate {
  const days = ageDays(candidate.debateDate, nowMs);
  const interestReason = reasonFor(candidate, profile);
  const freshness = clamp(Math.exp((-Math.LN2 * days) / RANKING_POLICY.freshnessHalfLifeDays));
  const rank = Math.min(10, Math.max(1, Math.trunc(candidate.rankInSpeech || 10)));
  const quality = clamp(1 - (rank - 1) / 9);
  const fresh = days <= RANKING_POLICY.freshDays;
  const hasInterest = interestReason.interest > 0;
  const pool: CandidatePool = fresh
    ? hasInterest
      ? "fresh_interest"
      : "fresh_general"
    : hasInterest
      ? "back_catalog_interest"
      : "adjacent_interest";
  const reasonCode =
    pool === "back_catalog_interest" ? `older_${interestReason.code}` : interestReason.code;
  const reason =
    pool === "back_catalog_interest"
      ? `${interestReason.label} · äldre klipp`
      : pool === "adjacent_interest"
        ? "För variation i ditt flöde"
        : interestReason.label;
  const scoreComponents = {
    explicitInterest: interestReason.interest,
    freshness,
    quality
  };
  const score =
    RANKING_POLICY.interestWeight * scoreComponents.explicitInterest +
    RANKING_POLICY.freshnessWeight * scoreComponents.freshness +
    RANKING_POLICY.qualityWeight * scoreComponents.quality;
  return { ...candidate, pool, reasonCode, reason, score, scoreComponents };
}

function compareCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  return (
    right.score - left.score ||
    right.debateDate.localeCompare(left.debateDate) ||
    (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") ||
    left.id.localeCompare(right.id)
  );
}

function relaxationFor(
  candidate: ScoredCandidate,
  selected: ScoredCandidate[],
  profile: RecommendationProfile,
  level: number
): string[] | null {
  const block = selected.slice(Math.floor(selected.length / 10) * 10);
  const previous = selected.at(-1);
  const sameSpeakerAdjacent =
    previous !== undefined &&
    ((candidate.politicianId && candidate.politicianId === previous.politicianId) ||
      candidate.speakerName === previous.speakerName);
  const speechCount = block.filter((item) => item.speechId === candidate.speechId).length;
  const speakerCount = block.filter(
    (item) =>
      (candidate.politicianId && item.politicianId === candidate.politicianId) ||
      item.speakerName === candidate.speakerName
  ).length;
  const partyCount = block.filter((item) => item.party === candidate.party).length;
  const preferredParty =
    candidate.party !== "NONE" &&
    (profile.explicitParties.includes(candidate.party) ||
      profile.followedParties.includes(candidate.party));
  const partyCap = preferredParty ? 5 : 3;
  const relaxations: string[] = [];

  if (speechCount >= 1) {
    if (level < 1 || speechCount >= 2) return null;
    relaxations.push("speech_repeat");
  }
  if (partyCount >= partyCap) {
    if (level < 2) return null;
    relaxations.push("party_cap");
  }
  if (speakerCount >= 2) {
    if (level < 3) return null;
    relaxations.push("speaker_cap");
  }
  if (sameSpeakerAdjacent) {
    if (level < 4) return null;
    relaxations.push("adjacent_speaker");
  }
  return relaxations;
}

function choose(
  candidates: ScoredCandidate[],
  selected: ScoredCandidate[],
  used: ReadonlySet<string>,
  profile: RecommendationProfile
): { candidate: ScoredCandidate; relaxations: string[] } | null {
  for (let level = 0; level <= 4; level += 1) {
    for (const candidate of candidates) {
      if (used.has(candidate.id)) continue;
      const relaxations = relaxationFor(candidate, selected, profile, level);
      if (relaxations) return { candidate, relaxations };
    }
  }
  return null;
}

export function rankFeed(
  candidates: CandidateClip[],
  profile: RecommendationProfile,
  limit = 60,
  nowMs = Date.now()
): RankedFeedItem[] {
  const boundedLimit = Math.min(60, Math.max(1, Math.trunc(limit)));
  const seen = new Set(profile.recentClipIds ?? []);
  const unique = new Map<string, CandidateClip>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.id)) unique.set(candidate.id, candidate);
  }
  const allScored = [...unique.values()]
    .map((candidate) => scoreCandidate(candidate, profile, nowMs))
    // V1 has no reviewed topic/ideology adjacency mapping and exploration is
    // disabled. An old unrelated clip is not "adjacent" merely because it is
    // old; excluding it also keeps back-catalogue content to the two planned
    // interest slots in the first ten.
    .filter((candidate) => candidate.pool !== "adjacent_interest");
  const unseen = allScored.filter((candidate) => !seen.has(candidate.id)).sort(compareCandidates);
  const seenFallback = allScored.filter((candidate) => seen.has(candidate.id)).sort(compareCandidates);
  const ranked = unseen.length >= boundedLimit ? unseen : [...unseen, ...seenFallback];
  const pools = new Map<CandidatePool, ScoredCandidate[]>();
  for (const pool of RANKING_POLICY.poolSchedule) pools.set(pool, []);
  for (const candidate of ranked) pools.get(candidate.pool)?.push(candidate);

  const selected: ScoredCandidate[] = [];
  const output: RankedFeedItem[] = [];
  const used = new Set<string>();
  while (output.length < boundedLimit && used.size < ranked.length) {
    const targetPool = RANKING_POLICY.poolSchedule[output.length % 10];
    const preferred = choose(pools.get(targetPool) ?? [], selected, used, profile);
    const selection = preferred ?? choose(ranked, selected, used, profile);
    if (!selection) break;
    const { candidate } = selection;
    const relaxations = preferred
      ? selection.relaxations
      : [...selection.relaxations, `pool_fallback:${targetPool}`];
    used.add(candidate.id);
    selected.push(candidate);
    output.push({
      clipId: candidate.id,
      position: output.length + 1,
      pool: candidate.pool,
      reasonCode: candidate.reasonCode,
      reason: candidate.reason,
      score: Number(candidate.score.toFixed(6)),
      scoreComponents: { ...candidate.scoreComponents, constraintRelaxations: relaxations },
      clip: candidate.clip
    });
  }
  return output;
}
