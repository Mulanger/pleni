import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { SearchFacet } from "../_shared/search-types.ts";
import { interpretSearchQuery } from "../_shared/search/interpret.ts";
import {
  foldSearchLookup,
  normalizeSearchDisplay,
  normalizeSearchLookup,
  stripSearchPersonDecorations,
  subtractSearchSpans,
  tokenizeSearchText,
} from "../_shared/search/normalize.ts";
import type {
  SearchEntityCatalog,
  SearchInterpretationRequest,
  SearchInterpretationResult,
} from "../_shared/search/types.ts";

interface FixtureCase {
  label: string;
  request: SearchInterpretationRequest;
  forceFailure?: boolean;
  expect: unknown;
}

interface InterpretationFixture {
  catalog: SearchEntityCatalog;
  cases: FixtureCase[];
}

const FIXTURE_URL = new URL(
  "../../../tests/fixtures/search/interpretation_cases.json",
  import.meta.url,
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as InterpretationFixture;

for (const scenario of FIXTURE.cases) {
  test(`interprets: ${scenario.label}`, () => {
    const catalog = scenario.forceFailure
      ? new Proxy(FIXTURE.catalog, {
          get() {
            throw new Error("forced fixture failure");
          },
        })
      : FIXTURE.catalog;
    const result = interpretSearchQuery(scenario.request, catalog, 2026);
    assert.deepEqual(summarize(result), scenario.expect);
  });
}

test("normalization preserves Swedish display text and exposes an unaccented lookup form", () => {
  assert.equal(normalizeSearchDisplay("  Åsa\t\nRomson  "), "Åsa Romson");
  assert.equal(normalizeSearchLookup("ÅSA—Romson"), "åsa romson");
  assert.equal(foldSearchLookup("Åsa Romson"), "asa romson");
});

test("token offsets and subtraction refer to the normalized display string", () => {
  const display = normalizeSearchDisplay("  Magdalena   Andersson — skatter  ");
  const tokens = tokenizeSearchText(display);
  assert.deepEqual(
    tokens.map((token) => [token.text, token.start, token.end]),
    [
      ["Magdalena", 0, 9],
      ["Andersson", 10, 19],
      ["skatter", 22, 29],
    ],
  );
  assert.equal(subtractSearchSpans(display, [{ start: 0, end: 19 }]), "skatter");

  const emojiDisplay = "🔎 Magdalena Andersson skatter";
  const personStart = emojiDisplay.indexOf("Magdalena");
  assert.equal(
    subtractSearchSpans(emojiDisplay, [
      { start: personStart, end: personStart + "Magdalena Andersson".length },
    ]),
    "skatter",
  );
});

test("official titles and party suffixes produce a person lookup form, never a title alias", () => {
  assert.equal(
    stripSearchPersonDecorations(
      "Arbetsmarknadsminister och vikarierande klimat- och miljöministern Johan Britz (L)",
    ),
    "Johan Britz",
  );
  assert.equal(stripSearchPersonDecorations("Finansminister"), "Finansminister");
});

test("ambiguous output is independent of catalogue row order", () => {
  const reversed: SearchEntityCatalog = {
    ...FIXTURE.catalog,
    people: [...FIXTURE.catalog.people].reverse(),
    events: [...FIXTURE.catalog.events].reverse(),
  };
  for (const query of ["Andersson", "budgetdebatten"]) {
    assert.deepEqual(
      interpretSearchQuery({ query }, FIXTURE.catalog),
      interpretSearchQuery({ query }, reversed),
    );
  }
});

test("an invalid Swedish calendar date remains searchable topic text", () => {
  const result = interpretSearchQuery(
    { query: "elsparkcyklar 31 februari" },
    FIXTURE.catalog,
    2026,
  );
  assert.deepEqual(result.facets, [
    { kind: "topic", key: "topic", label: "elsparkcyklar 31 februari", removable: true },
  ]);
  assert.equal(result.plan.dateFrom, null);
  assert.equal(result.plan.dateTo, null);
});

test("migration 023 derives only verified official aliases and preserves curated rollback data", () => {
  const up = readFileSync(new URL("../../../migrations/023_search_entities.up.sql", import.meta.url), "utf8");
  const down = readFileSync(
    new URL("../../../migrations/023_search_entities.down.sql", import.meta.url),
    "utf8",
  );

  assert.match(up, /create or replace function private\.normalize_search_entity/iu);
  assert.match(up, /automatic:politicians\.name/iu);
  assert.match(up, /automatic:speeches\.speaker_name/iu);
  assert.match(up, /automatic:public\.sources/iu);
  assert.match(up, /clip\.published_at is not null/iu);
  assert.match(up, /clip\.moderation <> 'rejected'/iu);
  assert.match(up, /source\.title, 'automatic:sources\.title'/iu);
  assert.match(up, /source\.dokid, 'automatic:sources\.dokid'/iu);
  assert.match(up, /verified,\s*provenance/iu);
  assert.match(up, /after insert or delete or update of speech_id, moderation, published_at/iu);
  assert.match(up, /after insert or delete or update of politician_id, speaker_name, source_id/iu);
  assert.doesNotMatch(up, /grant\s+(?:select|insert|update|delete|execute)[\s\S]{0,80}\b(?:anon|authenticated)\b/iu);

  assert.match(down, /where provenance like 'automatic:%'/iu);
  assert.match(down, /provenance = 'automatic:public\.sources'/iu);
  assert.doesNotMatch(down, /delete from private\.search_events\s*;/iu);
});

function summarize(result: SearchInterpretationResult): unknown {
  const plan = result.plan;
  return {
    facets: result.facets.map(summarizeFacet),
    ambiguity: result.ambiguity
      ? {
          kind: result.ambiguity.kind,
          ids: result.ambiguity.options.map((option) => option.id),
        }
      : null,
    consumed: plan.consumedSpans.map((span) => span.text),
    plan: {
      topic: plan.topic,
      politicianId: plan.politicianId,
      party: plan.party,
      eventId: plan.eventId,
      sourceIds: plan.sourceIds,
      dateFrom: plan.dateFrom,
      dateTo: plan.dateTo,
      hasRetrievalAnchor: plan.hasRetrievalAnchor,
      fallback: plan.fallback,
    },
  };
}

function summarizeFacet(facet: SearchFacet): Record<string, unknown> {
  if (facet.kind === "person") {
    return { kind: facet.kind, label: facet.label, id: facet.politicianId };
  }
  if (facet.kind === "party") {
    return { kind: facet.kind, label: facet.label, party: facet.party };
  }
  if (facet.kind === "event") {
    return { kind: facet.kind, label: facet.label, id: facet.eventId };
  }
  if (facet.kind === "date") {
    return {
      kind: facet.kind,
      label: facet.label,
      from: facet.from,
      to: facet.to,
    };
  }
  return { kind: facet.kind, label: facet.label };
}
