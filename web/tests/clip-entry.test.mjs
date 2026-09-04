import assert from "node:assert/strict";
import test from "node:test";

import { clipEntryFeed, parseClipBootstrap } from "../src/clip-entry.ts";

const CLIP = {
  id: "HD1_speech_c01",
  speechId: "HD1_speech",
  sourceId: "source-1",
  politicianId: null,
  politicianName: null,
  politicianRole: null,
  politicianAvatarUrl: null,
  speakerName: "Statsradet Exempel (S)",
  party: "S",
  anforandetyp: "Anforande",
  archetype: "explain",
  title: "Ett tydligt besked",
  transcript: "Det har ar vad som sags.",
  topic: null,
  durationS: 44.9,
  videoUrl: "https://cdn.example/clip.mp4",
  thumbUrl: "https://cdn.example/clip.webp",
  sourceTitle: "En riksdagsdebatt",
  sourceUrl: "https://www.riksdagen.se/example",
  debateDate: "2026-09-04",
  publishedAt: "2026-09-04T10:00:00Z",
  rank: 1,
  isSample: false
};

test("a prerendered clip bootstrap is accepted only for the requested route", () => {
  assert.deepEqual(parseClipBootstrap(JSON.stringify(CLIP), CLIP.id), CLIP);
  assert.equal(parseClipBootstrap(JSON.stringify(CLIP), "another-clip"), null);
  assert.equal(parseClipBootstrap("not json", CLIP.id), null);
  assert.equal(parseClipBootstrap(JSON.stringify({ ...CLIP, party: "X" }), CLIP.id), null);
});

test("the SEO entry clip leads a deduplicated normal feed", () => {
  const second = { ...CLIP, id: "HD1_speech_c02" };
  assert.deepEqual(
    clipEntryFeed(CLIP, [second, CLIP, { ...second, id: "HD1_speech_c03" }]).map(
      (clip) => clip.id
    ),
    [CLIP.id, second.id, "HD1_speech_c03"]
  );
  assert.deepEqual(clipEntryFeed(null, [second]), []);
});
