import assert from "node:assert/strict";
import test from "node:test";

import type { RecommendationProfile } from "../_shared/consent.ts";
import { rankFeed, type CandidateClip, type CandidatePool } from "../_shared/ranking.ts";

const NOW = Date.parse("2026-08-14T12:00:00Z");

const EMPTY_PROFILE: RecommendationProfile = {
  personalization: true,
  noticeVersion: "personalization-2026-08-14-v1",
  explicitParties: [],
  followedParties: [],
  followedPoliticians: [],
  recentClipIds: []
};

function candidate(
  id: string,
  options: Partial<CandidateClip> & { party?: CandidateClip["party"] } = {}
): CandidateClip {
  const party = options.party ?? "M";
  return {
    id,
    speechId: options.speechId ?? `speech-${id}`,
    politicianId: options.politicianId ?? `politician-${id}`,
    politicianName: options.politicianName ?? `Person ${id}`,
    speakerName: options.speakerName ?? `Speaker ${id}`,
    party,
    debateDate: options.debateDate ?? "2026-08-10",
    publishedAt: options.publishedAt ?? "2026-08-10T12:00:00Z",
    rankInSpeech: options.rankInSpeech ?? 1,
    clip: options.clip ?? { id, party },
    ...options
  };
}

test("mixes explicit V1 as 5/2/2 plus one catalogue-variety slot", () => {
  const profile = { ...EMPTY_PROFILE, explicitParties: ["S"] as const };
  const candidates = [
    ...Array.from({ length: 8 }, (_, index) => candidate(`fi-${index}`, { party: "S" })),
    ...Array.from({ length: 8 }, (_, index) => candidate(`fg-${index}`, { party: "M" })),
    ...Array.from({ length: 8 }, (_, index) =>
      candidate(`bi-${index}`, { party: "S", debateDate: "2026-01-10" })
    ),
    ...Array.from({ length: 8 }, (_, index) =>
      candidate(`unrelated-old-${index}`, { party: "M", debateDate: "2026-01-10" })
    )
  ];
  const pools = rankFeed(candidates, profile, 10, NOW).map((item) => item.pool);
  const counts = Object.fromEntries(
    (["fresh_interest", "fresh_general", "back_catalog_interest", "adjacent_interest"] as CandidatePool[])
      .map((pool) => [pool, pools.filter((value) => value === pool).length])
  );
  assert.equal(counts.fresh_interest, 5);
  assert.equal(counts.fresh_general, 2);
  assert.equal(counts.back_catalog_interest, 2);
  assert.equal(counts.adjacent_interest, 1);
});

test("followed politician is the strongest explicit reason", () => {
  const profile = {
    ...EMPTY_PROFILE,
    explicitParties: ["S"] as const,
    followedPoliticians: ["pol-1"]
  };
  const result = rankFeed(
    [
      candidate("party", { party: "S", politicianId: "pol-2" }),
      candidate("person", { party: "M", politicianId: "pol-1", politicianName: "Ada" })
    ],
    profile,
    2,
    NOW
  );
  assert.equal(result[0].clipId, "person");
  assert.equal(result[0].reasonCode, "followed_politician");
  assert.match(result[0].reason, /Ada/);
});

test("uses debate date rather than recent publication time for backfills", () => {
  const profile = { ...EMPTY_PROFILE, explicitParties: ["S"] as const };
  const result = rankFeed(
    [
      candidate("backfill", {
        party: "S",
        debateDate: "2024-01-01",
        publishedAt: "2026-08-14T11:59:00Z"
      })
    ],
    profile,
    1,
    NOW
  );
  assert.equal(result[0].pool, "back_catalog_interest");
  assert.match(result[0].reasonCode, /^older_/);
  assert.equal(result[0].reason, "Eftersom du valde S");
});

test("uses older general material for neutral catalogue variety", () => {
  const result = rankFeed(
    [candidate("unrelated", { party: "M", debateDate: "2024-01-01" })],
    { ...EMPTY_PROFILE, explicitParties: ["S"] },
    1,
    NOW
  );
  assert.equal(result[0].pool, "adjacent_interest");
  assert.equal(result[0].reasonCode, "catalogue_variety");
  assert.equal(result[0].reason, "För variation i ditt flöde");
});

test("suppresses recently served clips when unseen inventory is sufficient", () => {
  const candidates = Array.from({ length: 12 }, (_, index) => candidate(`clip-${index}`));
  const profile = { ...EMPTY_PROFILE, recentClipIds: ["clip-0", "clip-1"] };
  const result = rankFeed(candidates, profile, 10, NOW);
  assert.equal(result.some((item) => profile.recentClipIds.includes(item.clipId)), false);
});

test("uses an unseen general clip before replaying a recent perfect match", () => {
  const profile = {
    ...EMPTY_PROFILE,
    followedPoliticians: ["followed"],
    recentClipIds: ["recent-perfect-match"]
  };
  const result = rankFeed(
    [
      candidate("recent-perfect-match", { politicianId: "followed", politicianName: "Ada" }),
      candidate("unseen-general", {
        politicianId: "someone-else",
        debateDate: "2024-01-01"
      })
    ],
    profile,
    2,
    NOW
  );
  assert.deepEqual(
    result.map((item) => item.clipId),
    ["unseen-general", "recent-perfect-match"]
  );
  assert.ok(result[1].scoreComponents.constraintRelaxations.includes("recent_clip_fallback"));
});

test("records which planned pool was unavailable when the mixer falls back", () => {
  const result = rankFeed(
    Array.from({ length: 3 }, (_, index) => candidate(`general-${index}`)),
    EMPTY_PROFILE,
    3,
    NOW
  );
  assert.ok(
    result[0].scoreComponents.constraintRelaxations.includes("pool_fallback:fresh_interest")
  );
});

test("avoids adjacent repeats when another speaker is available", () => {
  const candidates = [
    candidate("a1", { politicianId: "a", speakerName: "A", speechId: "speech-a1" }),
    candidate("a2", { politicianId: "a", speakerName: "A", speechId: "speech-a2" }),
    candidate("b1", { politicianId: "b", speakerName: "B", speechId: "speech-b1" }),
    candidate("c1", { politicianId: "c", speakerName: "C", speechId: "speech-c1" })
  ];
  const result = rankFeed(candidates, EMPTY_PROFILE, 4, NOW);
  for (let index = 1; index < result.length; index += 1) {
    const previous = candidates.find((item) => item.id === result[index - 1].clipId);
    const current = candidates.find((item) => item.id === result[index].clipId);
    assert.notEqual(previous?.politicianId, current?.politicianId);
  }
});

test("is deterministic and keeps the hard two-clips-per-speech ceiling", () => {
  const candidates = [
    candidate("one", { speechId: "same", politicianId: "same" }),
    candidate("two", { speechId: "same", politicianId: "same" }),
    candidate("three", { speechId: "same", politicianId: "same" })
  ];
  const first = rankFeed(candidates, EMPTY_PROFILE, 10, NOW);
  const second = rankFeed([...candidates].reverse(), EMPTY_PROFILE, 10, NOW);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((item) => item.position), [1, 2]);
  assert.equal(new Set(first.map((item) => item.clipId)).size, 2);
  assert.ok(first.some((item) => item.scoreComponents.constraintRelaxations.length > 0));
});

test("relaxes soft speaker caps deterministically when inventory is sparse", () => {
  const candidates = [
    candidate("one", { speechId: "speech-1", politicianId: "same" }),
    candidate("two", { speechId: "speech-2", politicianId: "same" }),
    candidate("three", { speechId: "speech-3", politicianId: "same" })
  ];
  const result = rankFeed(candidates, EMPTY_PROFILE, 10, NOW);
  assert.deepEqual(result.map((item) => item.position), [1, 2, 3]);
  assert.ok(result.some((item) => item.scoreComponents.constraintRelaxations.includes("speaker_cap")));
  assert.ok(
    result.some((item) => item.scoreComponents.constraintRelaxations.includes("adjacent_speaker"))
  );
});

test("rank_in_speech is the quality prior, not raw final score", () => {
  const result = rankFeed(
    [candidate("rank-10", { rankInSpeech: 10 }), candidate("rank-1", { rankInSpeech: 1 })],
    EMPTY_PROFILE,
    2,
    NOW
  );
  assert.equal(result[0].clipId, "rank-1");
  assert.equal(result[0].scoreComponents.quality, 1);
});
