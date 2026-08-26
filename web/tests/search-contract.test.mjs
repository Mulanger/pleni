import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SEARCH_CONTRACT_VERSION as edgeVersion,
  parseClipSearchRequest as parseEdgeRequest,
  parseClipSearchResponse as parseEdgeResponse,
} from "../../supabase/functions/_shared/search-types.ts";
import { topicSearchEnabled, topicSearchEnabledFrom } from "../src/search/feature.ts";
import {
  SEARCH_CONTRACT_VERSION as webVersion,
  parseClipSearchRequest as parseWebRequest,
  parseClipSearchResponse as parseWebResponse,
} from "../src/search/types.ts";

const fixtureUrl = new URL("./fixtures/search-contract/valid.json", import.meta.url);
const invalidFixtureUrl = new URL("./fixtures/search-contract/invalid.json", import.meta.url);
const webContractUrl = new URL("../src/search/types.ts", import.meta.url);
const edgeContractUrl = new URL("../../supabase/functions/_shared/search-types.ts", import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8"));
const invalidFixtures = JSON.parse(await readFile(invalidFixtureUrl, "utf8"));

test("browser and Edge contract source stays byte-identical", async () => {
  const [webSource, edgeSource] = await Promise.all([
    readFile(webContractUrl, "utf8"),
    readFile(edgeContractUrl, "utf8"),
  ]);
  assert.equal(webSource, edgeSource);
});

test("browser and Edge copies expose the same contract version", () => {
  assert.equal(webVersion, "clip-search-v1");
  assert.equal(edgeVersion, webVersion);
});

test("valid request fixtures round-trip through both contract copies", () => {
  for (const request of fixtures.requests) {
    assert.deepEqual(parseWebRequest(request), request);
    assert.deepEqual(parseEdgeRequest(request), request);
  }
});

test("valid response fixtures cover every mode and round-trip through both copies", () => {
  const modes = new Set();
  const facetKinds = new Set();

  for (const response of fixtures.responses) {
    assert.deepEqual(parseWebResponse(response), response);
    assert.deepEqual(parseEdgeResponse(response), response);
    modes.add(response.mode);
    for (const facet of response.interpretation.facets) facetKinds.add(facet.kind);
  }

  assert.deepEqual([...modes].sort(), ["filtered", "hybrid", "keyword_fallback"]);
  assert.deepEqual([...facetKinds].sort(), ["date", "event", "party", "person", "topic"]);
  assert.ok(fixtures.responses.some((response) => response.interpretation.ambiguity !== null));
});

test("both contract copies reject every malformed request fixture", () => {
  for (const fixture of invalidFixtures.requests) {
    assert.throws(() => parseWebRequest(fixture.value), { name: "SearchContractError" }, fixture.label);
    assert.throws(() => parseEdgeRequest(fixture.value), { name: "SearchContractError" }, fixture.label);
  }
});

test("both contract copies reject every malformed response fixture", () => {
  for (const fixture of invalidFixtures.responses) {
    assert.throws(() => parseWebResponse(fixture.value), { name: "SearchContractError" }, fixture.label);
    assert.throws(() => parseEdgeResponse(fixture.value), { name: "SearchContractError" }, fixture.label);
  }
});

test("request parsing trims queries and clamps the public result limit", () => {
  const request = { query: "  skatter  ", limit: 500, disabledFacets: ["date"] };
  const expected = { query: "skatter", limit: 60, disabledFacets: ["date"] };
  assert.deepEqual(parseWebRequest(request), expected);
  assert.deepEqual(parseEdgeRequest(request), expected);
});

test("an HTML excerpt is rejected by both response parsers", () => {
  const response = structuredClone(fixtures.responses[0]);
  response.results[0].matchExcerpt = "<strong>Skatter</strong>";
  assert.throws(() => parseWebResponse(response), { name: "SearchContractError" });
  assert.throws(() => parseEdgeResponse(response), { name: "SearchContractError" });
});

test("topic search is production-on and keeps an explicit kill switch", () => {
  assert.equal(topicSearchEnabled, false);
  assert.equal(topicSearchEnabledFrom(undefined), false);
  assert.equal(topicSearchEnabledFrom(undefined, true), true);
  assert.equal(topicSearchEnabledFrom("false"), false);
  assert.equal(topicSearchEnabledFrom("false", true), false);
  assert.equal(topicSearchEnabledFrom("1"), false);
  assert.equal(topicSearchEnabledFrom(" TRUE "), true);
});
