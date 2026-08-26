import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EMPTY_TOPIC_SEARCH_STATE,
  TOPIC_SEARCH_REVEAL_SIZE,
  addDisabledFacet,
  beginTopicSearch,
  buildTopicRequestQuery,
  completeTopicSearch,
  identityQueryAfterTopicRemoval,
  partyAfterTopicRemoval,
  revealMoreTopicResults,
  sortedSearchFacets,
  topicResultHeading,
  topicSearchErrorMessage,
  visibleFacetLabel,
} from "../src/search/state.ts";

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/search-contract/valid.json", import.meta.url), "utf8"),
);

test("topic state starts loading without discarding the previous settled response", () => {
  const settled = completeTopicSearch(EMPTY_TOPIC_SEARCH_STATE, fixtures.responses[0]);
  const loading = beginTopicSearch(
    settled,
    "elsparkcyklar",
    "Socialdemokraterna elsparkcyklar",
    ["date", "person", "date"],
  );

  assert.equal(loading.phase, "loading");
  assert.equal(loading.submittedInput, "elsparkcyklar");
  assert.equal(loading.requestQuery, "Socialdemokraterna elsparkcyklar");
  assert.deepEqual(loading.disabledFacets, ["person", "date"]);
  assert.equal(loading.response, fixtures.responses[0]);
});

test("results reveal locally in 20/20/20 steps without changing the response", () => {
  const response = structuredClone(fixtures.responses[0]);
  response.results = Array.from({ length: 55 }, (_, index) => ({
    ...structuredClone(fixtures.responses[0].results[0]),
    clip: {
      ...structuredClone(fixtures.responses[0].results[0].clip),
      id: `clip-${index}`,
    },
  }));
  const settled = completeTopicSearch(EMPTY_TOPIC_SEARCH_STATE, response);
  const second = revealMoreTopicResults(settled);
  const third = revealMoreTopicResults(second);
  const exhausted = revealMoreTopicResults(third);

  assert.equal(TOPIC_SEARCH_REVEAL_SIZE, 20);
  assert.equal(settled.revealedCount, 20);
  assert.equal(second.revealedCount, 40);
  assert.equal(third.revealedCount, 55);
  assert.equal(exhausted.revealedCount, 55);
  assert.equal(exhausted.response, response);
});

test("facets render in the locked person party event topic date order", () => {
  const facets = [
    { kind: "date", key: "date", label: "2017", from: "2017-01-01", to: "2017-12-31", removable: true },
    { kind: "topic", key: "topic", label: "skatter", removable: true },
    { kind: "event", key: "event", label: "Budgetdebatt", eventId: "event-1", removable: true },
    { kind: "party", key: "party", label: "Socialdemokraterna", party: "S", removable: true },
    { kind: "person", key: "person", label: "Magdalena Andersson", politicianId: "person-1", removable: true },
  ];

  assert.deepEqual(sortedSearchFacets(facets).map((facet) => facet.kind), [
    "person",
    "party",
    "event",
    "topic",
    "date",
  ]);
  assert.equal(visibleFacetLabel(facets[4]), "Person · Magdalena Andersson");
  assert.equal(topicResultHeading(facets), "Klipp om skatter från 2017");
});

test("the selected party becomes an explicit transient query facet", () => {
  assert.equal(
    buildTopicRequestQuery("skatter", "S", "Socialdemokraterna"),
    "Socialdemokraterna skatter",
  );
  assert.equal(buildTopicRequestQuery("elsparkcyklar", null, null), "elsparkcyklar");
});

test("removing topic returns only server-confirmed identity state", () => {
  const facets = fixtures.responses[0].interpretation.facets;
  assert.equal(identityQueryAfterTopicRemoval(facets), "Magdalena Andersson");
  assert.equal(partyAfterTopicRemoval(facets), null);

  const partyFacets = fixtures.responses[2].interpretation.facets;
  assert.equal(identityQueryAfterTopicRemoval(partyFacets), "");
  assert.equal(partyAfterTopicRemoval(partyFacets), "S");
});

test("removable structured facets deduplicate and errors use viewer-facing language", () => {
  assert.deepEqual(addDisabledFacet(["date"], "person"), ["person", "date"]);
  assert.deepEqual(addDisabledFacet(["person", "date"], "person"), ["person", "date"]);
  assert.match(topicSearchErrorMessage("rate_limited"), /Många söker/u);
  assert.doesNotMatch(topicSearchErrorMessage("network"), /OpenAI|embedding|vektor/ui);
});
