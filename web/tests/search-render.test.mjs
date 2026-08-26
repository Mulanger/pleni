import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const api = await readFile(new URL("../src/search/api.ts", import.meta.url), "utf8");
const state = await readFile(new URL("../src/search/state.ts", import.meta.url), "utf8");

const searchStart = app.indexOf("function SearchScreen");
const searchEnd = app.indexOf("function LegalScreen", searchStart);
const searchSource = app.slice(searchStart, searchEnd);

test("submitted topic search is available in the normal public Search tab", () => {
  assert.ok(app.includes("const topicSearchAvailable = topicSearchEnabled;"));
  assert.equal(app.includes("topicSearchEnabled && viewer.signedIn"), false);
  assert.ok(searchSource.includes("topicSearchAvailable"));
  assert.ok(searchSource.includes("searchPublishedTopics"));
  assert.ok(searchSource.includes('className="search-submit"'));
  assert.ok(searchSource.includes('aria-label="Sök i klippen"'));
  assert.equal(searchSource.includes("window.confirm"), false);
  assert.ok(searchSource.includes("onSubmit"));
});

test("identity lookup remains independent from submitted topic loading and errors", () => {
  const identityPosition = searchSource.indexOf("searchPoliticians(");
  const topicPosition = searchSource.indexOf("searchPublishedTopics(");
  assert.ok(identityPosition > 0);
  assert.ok(topicPosition > 0);
  assert.ok(searchSource.includes('topicState.phase === "loading"'));
  assert.ok(searchSource.includes('topicState.phase === "error"'));
  assert.ok(state.includes("Politiker och partier fungerar fortfarande"));
});

test("topic loading uses a visible restrained spinner with reduced-motion support", () => {
  assert.ok(searchSource.includes('className="topic-search-loading"'));
  assert.ok(searchSource.includes('className="topic-search-spinner"'));
  assert.ok(searchSource.includes("Söker efter relevanta klipp…"));
  assert.match(styles, /\.topic-search-spinner\s*\{[\s\S]*animation:\s*topic-search-spin 780ms linear infinite/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.topic-search-spinner/u);
});

test("interpretation chips and ambiguity choices have complete accessible labels", () => {
  assert.ok(searchSource.includes('aria-label="Tolkat som"'));
  assert.ok(searchSource.includes("Ta bort ${visibleFacetLabel(facet)} och bredda sökningen"));
  assert.ok(searchSource.includes('aria-labelledby="search-ambiguity-title"'));
  assert.ok(searchSource.includes("onChooseAmbiguity(option)"));
});

test("clip results are semantic, cardless rows without technical ranking labels", () => {
  assert.ok(searchSource.includes('<article className="topic-result-row"'));
  assert.ok(searchSource.includes("speakerNameAtSpeech"));
  assert.ok(searchSource.includes("partyAtSpeech"));
  assert.ok(searchSource.includes("matchExcerpt"));
  assert.equal(searchSource.includes("result.matchKind"), false);
  assert.match(styles, /\.topic-result-row\s*\{[\s\S]*grid-template-columns:\s*84px/u);
  assert.match(styles, /\.topic-result-thumb\s*\{[\s\S]*height:\s*112px/u);
});

test("topic modules contain no query persistence, URL encoding, analytics, or logging", () => {
  const modules = `${api}\n${state}`;
  for (const forbidden of [
    "localStorage",
    "sessionStorage",
    "URLSearchParams",
    "history.pushState",
    "history.replaceState",
    "Clerk",
    "analytics",
    "console.",
  ]) {
    assert.equal(modules.includes(forbidden), false, forbidden);
  }
});

test("rendering includes fallback, empty, retry, and 20-result reveal states", () => {
  assert.ok(searchSource.includes("keyword_fallback"));
  assert.ok(searchSource.includes("dateBroadening"));
  assert.ok(searchSource.includes("Inga klipp hittades den"));
  assert.ok(searchSource.includes("från andra datum"));
  assert.ok(searchSource.includes("Inga relevanta klipp hittades"));
  assert.ok(searchSource.includes("Försök igen"));
  assert.ok(searchSource.includes("Visa {Math.min(20, remaining)} till"));
});
