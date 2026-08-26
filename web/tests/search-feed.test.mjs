import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createSearchFeedCollection,
  searchFeedHistoryId,
  withSearchFeedHistoryState,
} from "../src/search/route.ts";
import {
  EMPTY_TOPIC_SEARCH_STATE,
  beginTopicSearch,
  rememberTopicSearchScroll,
  revealMoreTopicResults,
} from "../src/search/state.ts";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

function result(id, speakerNameAtSpeech, partyAtSpeech, excerpt = "Matchande ord") {
  return {
    clip: {
      id,
      speechId: `speech-${id}`,
      politicianId: `person-${id}`,
      politicianName: `Nuvarande namn ${id}`,
      politicianRole: "ledamot",
      politicianAvatarUrl: null,
      speakerName: `Fel byline ${id}`,
      party: "M",
      anforandetyp: "Anförande",
      archetype: "explain",
      title: `Titel ${id}`,
      transcript: `Original transcript ${id}`,
      topic: null,
      durationS: 42,
      videoUrl: `https://cdn.example/${id}.mp4`,
      thumbUrl: `https://cdn.example/${id}.webp`,
      sourceTitle: "Debatt",
      sourceUrl: "https://www.riksdagen.se/",
      debateDate: "2017-04-05",
      publishedAt: "2026-08-25T00:00:00Z",
      rank: 1,
      isSample: false,
    },
    speakerNameAtSpeech,
    partyAtSpeech,
    matchExcerpt: excerpt,
    matchKind: "both",
  };
}

test("search feed keeps exact server order and historical bylines", () => {
  const results = [
    result("third-ranked-id", "Historisk trea", "S"),
    result("first-looking-id", "Historisk etta", "V"),
    result("second-looking-id", "Historisk tvåa", "MP"),
  ];
  const collection = createSearchFeedCollection(
    results,
    "Klipp om skatter från 2017",
    "first-looking-id",
    "history-1",
  );

  assert.deepEqual(collection.clips.map((clip) => clip.id), [
    "third-ranked-id",
    "first-looking-id",
    "second-looking-id",
  ]);
  assert.equal(collection.startId, "first-looking-id");
  assert.equal(collection.clips[0].speakerName, "Historisk trea");
  assert.equal(collection.clips[0].party, "S");
  assert.equal(collection.title, "Klipp om skatter från 2017");
  assert.equal(collection.subtitle, "Mest relevanta först · 3 träffar");
});

test("Spela alla starts at result one and an unknown start id safely falls back", () => {
  const results = [result("result-1", "Talare ett", "C"), result("result-2", "Talare två", "L")];
  const playAll = createSearchFeedCollection(results, "Relevanta klipp", null, "all");
  const staleRow = createSearchFeedCollection(results, "Relevanta klipp", "missing", "stale");

  assert.equal(playAll.startId, "result-1");
  assert.equal(staleRow.startId, "result-1");
});

test("matched excerpts never become feed transcripts or captions", () => {
  const source = result("result-1", "Talare", "KD", "Hemlig matchad passage");
  const collection = createSearchFeedCollection([source], "Relevanta klipp", null, "history");

  assert.equal(collection.clips[0].transcript, "Original transcript result-1");
  assert.equal(JSON.stringify(collection.clips).includes("Hemlig matchad passage"), false);
});

test("history stores only an opaque feed marker and preserves navigation state", () => {
  const state = withSearchFeedHistoryState(
    { pleniNavigation: { index: 4 } },
    "search-feed-7",
  );

  assert.equal(searchFeedHistoryId(state), "search-feed-7");
  assert.deepEqual(state.pleniNavigation, { index: 4 });
  assert.equal(JSON.stringify(state).includes("skatter"), false);
  assert.equal(searchFeedHistoryId(null), null);
  assert.equal(searchFeedHistoryId({ pleniSearchFeed: { historyId: "" } }), null);
});

test("search scroll is session-only, survives reveal, and resets for a new request", () => {
  const remembered = rememberTopicSearchScroll(EMPTY_TOPIC_SEARCH_STATE, 418.5);
  const revealed = revealMoreTopicResults(remembered);
  const newRequest = beginTopicSearch(revealed, "skatter", "skatter", []);

  assert.equal(remembered.scrollTop, 418.5);
  assert.equal(revealed.scrollTop, 418.5);
  assert.equal(newRequest.scrollTop, 0);
});

test("rows and Spela alla use the same scoped FeedScreen without a latest-feed refetch", () => {
  const openStart = app.indexOf("const openTopicSearchFeed");
  const openEnd = app.indexOf("const closeTopicSearchFeed", openStart);
  const openSource = app.slice(openStart, openEnd);
  const searchStart = app.indexOf("function SearchScreen");
  const searchEnd = app.indexOf("function LegalScreen", searchStart);
  const searchSource = app.slice(searchStart, searchEnd);

  assert.ok(app.includes("showingSearchFeed && searchFeedCollection !== null"));
  assert.ok(app.includes("collection={searchFeedCollection}"));
  assert.ok(app.includes("<CollectionScreen"));
  assert.ok(searchSource.includes("Spela alla"));
  assert.ok(searchSource.includes("onPlay(result.clip.id)"));
  assert.ok(searchSource.includes("pendingScrollRestoreRef"));
  assert.ok(openSource.includes("createSearchFeedCollection("));
  assert.equal(openSource.includes("loadPublishedClips"), false);
  assert.equal(openSource.includes("loadClipsByIds"), false);
  assert.equal((app.match(/<video\b/gu) ?? []).length, 1);
  assert.ok(app.includes("planMediaWindow({"));
});
