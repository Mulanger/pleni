import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { SearchClipResult } from "../_shared/search-types.ts";
import {
  createClipSearchHandler,
  type ClipSearchDependencies,
  type SearchCandidateRequest,
  type SearchLogSummary,
} from "../_shared/search/api.ts";
import { SEARCH_EMBEDDING_DIMENSIONS } from "../_shared/search/chunks.ts";
import { OpenAIEmbeddingError } from "../_shared/search/openai.ts";
import {
  admitsSemanticCandidate,
  SEARCH_CANDIDATE_ADMISSION_LEXICAL_COVERAGE,
  SEARCH_CANDIDATE_ADMISSION_SIMILARITY,
  SEARCH_RANKING_ROLLBACK_VERSION,
  SEARCH_RANKING_VERSION,
  SEARCH_SEMANTIC_ADMISSION_LEXICAL_COVERAGE,
  SEARCH_SEMANTIC_ADMISSION_SIMILARITY,
} from "../_shared/search/ranking.ts";
import {
  dailySearchClientKey,
  parseSearchRateLimitDecision,
} from "../_shared/search/rate-limit.ts";

const ORIGIN = "https://pleni.se";
const RATE_SECRET = "test-search-rate-secret-that-is-at-least-32-bytes";
const MAGDALENA_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const VECTOR = Array.from({ length: SEARCH_EMBEDDING_DIMENSIONS }, () => 0.125);

const CATALOG = {
  people: [
    {
      id: MAGDALENA_ID,
      label: "Magdalena Andersson",
      party: "S",
      aliases: [
        { value: "Magdalena Andersson", verified: true },
        { value: "Andersson", verified: true },
      ],
    },
  ],
  events: [
    {
      id: EVENT_ID,
      label: "Budgetdebatten 2022",
      dateFrom: "2022-11-08",
      dateTo: "2022-11-08",
      dateLabel: "8 november 2022",
      verified: true,
      aliases: [{ value: "budgetdebatten", verified: true }],
      sourceIds: [SOURCE_ID],
    },
  ],
};

test("runs a contextual query as hybrid search and returns the exact public contract", async () => {
  const fake = fakeDependencies();
  const response = await handler(fake.dependencies)(request("elsparkcyklar"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "hybrid");
  assert.equal(body.searchVersion, "pleni-search-v3");
  assert.equal(body.results[0].matchKind, "both");
  assert.equal(fake.searches.length, 1);
  assert.equal(fake.searches[0].topic, "elsparkcyklar");
  assert.match(String(fake.searches[0].queryEmbedding), /^\[[\d.,-]+\]$/u);
  assert.equal(fake.reservations.length, 1);
  assert.equal(fake.logs[0].resultCount, 1);
});

test("uses the request year for an unqualified Swedish day-month filter", async () => {
  const fake = fakeDependencies({ candidate: envelope(resultAt("exact", "2026-03-30"), true) });
  const dependencies: ClipSearchDependencies = {
    ...fake.dependencies,
    now: () => new Date("2026-08-26T12:00:00Z"),
  };
  const response = await handler(dependencies)(request("elsparkcyklar 30 mars"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.dateBroadening, null);
  assert.deepEqual(
    body.interpretation.facets.map((facet: { kind: string; label: string }) => [
      facet.kind,
      facet.label,
    ]),
    [
      ["date", "30 mars 2026"],
      ["topic", "elsparkcyklar"],
    ],
  );
  assert.equal(fake.searches[0].topic, "elsparkcyklar");
  assert.equal(fake.searches[0].dateFrom, "2026-03-30");
  assert.equal(fake.searches[0].dateTo, "2026-03-30");
});

test("automatically broadens an empty date filter without re-embedding", async () => {
  const june = resultAt("june", "2026-06-22");
  const march = resultAt("march", "2026-03-30");
  const may = resultAt("may", "2026-05-08");
  const july = resultAt("july", "2026-07-01");
  const fake = fakeDependencies({
    candidateFor: (search) =>
      search.dateFrom === "2026-03-30"
        ? envelope(null, true)
        : envelope([march, june, may, july], true),
  });
  const dependencies: ClipSearchDependencies = {
    ...fake.dependencies,
    now: () => new Date("2026-08-26T12:00:00Z"),
  };
  const response = await handler(dependencies)(requestWithLimit("elsparkcyklar 30 mars", 2));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.results.map((result: SearchClipResult) => result.clip.id),
    [june.clip.id, may.clip.id],
  );
  assert.deepEqual(body.interpretation.facets.map((facet: { kind: string }) => facet.kind), ["topic"]);
  assert.deepEqual(body.dateBroadening, {
    kind: "date",
    label: "30 mars 2026",
    from: "2026-03-30",
    to: "2026-03-30",
  });
  assert.equal(fake.searches.length, 2);
  assert.equal(fake.searches[0].dateFrom, "2026-03-30");
  assert.equal(fake.searches[1].dateFrom, null);
  assert.equal(fake.searches[1].dateTo, null);
  assert.equal(fake.searches[1].limit, 60);
  assert.equal(fake.searches[1].politicianId, null);
  assert.equal(fake.embeddedTopics.length, 1);
});

test("same-date-only fallback remains empty with its original date facet", async () => {
  const sameDate = resultAt("same-date", "2026-03-30");
  const fake = fakeDependencies({
    candidateFor: (search) =>
      search.dateFrom === "2026-03-30" ? envelope(null, true) : envelope(sameDate, true),
  });
  const dependencies: ClipSearchDependencies = {
    ...fake.dependencies,
    now: () => new Date("2026-08-26T12:00:00Z"),
  };
  const response = await handler(dependencies)(request("elsparkcyklar 30 mars"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, []);
  assert.equal(body.dateBroadening, null);
  assert.deepEqual(
    body.interpretation.facets.map((facet: { kind: string }) => facet.kind),
    ["date", "topic"],
  );
  assert.equal(fake.searches.length, 2);
});

test("date-range broadening excludes the entire original interval", async () => {
  const in2022 = resultAt("in-2022", "2022-03-01");
  const in2023 = resultAt("in-2023", "2023-09-15");
  const in2024 = resultAt("in-2024", "2024-01-12");
  const fake = fakeDependencies({
    candidateFor: (search) =>
      search.dateFrom === "2022-01-01"
        ? envelope(null, true)
        : envelope([in2022, in2023, in2024], true),
  });
  const response = await handler(fake.dependencies)(request("elsparkcyklar 2022-2023"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results.map((result: SearchClipResult) => result.clip.id), [in2024.clip.id]);
  assert.deepEqual(body.dateBroadening, {
    kind: "date",
    label: "2022–2023",
    from: "2022-01-01",
    to: "2023-12-31",
  });
});

test("date fallback preserves person, party and verified event constraints", async () => {
  const fake = fakeDependencies({
    candidateFor: (search) =>
      search.dateFrom === "2022-01-01" ? envelope(null, true) : envelope(RESULT, true),
  });
  const response = await handler(fake.dependencies)(
    request("Magdalena Andersson S budgetdebatten elsparkcyklar 2022"),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, []);
  assert.equal(body.dateBroadening, null);
  assert.deepEqual(body.interpretation.facets.map((facet: { kind: string }) => facet.kind), ["person", "party", "event", "date", "topic"]);
  assert.equal(fake.searches.length, 2);
  assert.equal(fake.searches[0].sourceIds?.[0], SOURCE_ID);
  assert.equal(fake.searches[1].sourceIds?.[0], SOURCE_ID);
  assert.equal(fake.searches[0].politicianId, MAGDALENA_ID);
  assert.equal(fake.searches[1].politicianId, MAGDALENA_ID);
  assert.equal(fake.searches[0].party, "S");
  assert.equal(fake.searches[1].party, "S");
  assert.equal(fake.searches[1].dateFrom, null);
  assert.equal(fake.searches[1].dateTo, null);
});

test("disabled date facets never trigger automatic broadening", async () => {
  const fake = fakeDependencies({ candidate: envelope(null, true) });
  const response = await handler(fake.dependencies)(requestWithFacets("elsparkcyklar 30 mars", ["date"]));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, []);
  assert.equal(body.dateBroadening, null);
  assert.equal(fake.searches.length, 1);
  assert.equal(fake.searches[0].dateFrom, null);
});

test("provider failure still broadens with one keyword-only embedding attempt", async () => {
  const fake = fakeDependencies({
    embedError: new OpenAIEmbeddingError("provider_timeout", true),
    candidateFor: (search) =>
      search.dateFrom === "2026-03-30"
        ? envelope(null, false)
        : envelope({ ...RESULT, matchKind: "keyword" }, false),
  });
  const response = await handler(fake.dependencies)(request("elsparkcyklar 30 mars"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.mode, "keyword_fallback");
  assert.equal(body.results[0].matchKind, "keyword");
  assert.equal(body.dateBroadening.label, "30 mars 2026");
  assert.equal(fake.embeddedTopics.length, 1);
  assert.equal(fake.searches.length, 2);
});

test("person-only search uses filtered mode without calling OpenAI", async () => {
  const fake = fakeDependencies();
  const response = await handler(fake.dependencies)(request("Magdalena Andersson"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, "filtered");
  assert.deepEqual(
    body.interpretation.facets.map((facet: { kind: string }) => facet.kind),
    ["person"],
  );
  assert.equal(fake.embeddedTopics.length, 0);
  assert.equal(fake.reservations.length, 0);
  assert.equal(fake.searches[0].politicianId, MAGDALENA_ID);
  assert.equal(fake.searches[0].topic, null);
});

for (const [label, code, retryable] of [
  ["timeout", "provider_timeout", true],
  ["rate limit", "provider_rate_limited", true],
  ["malformed provider response", "invalid_response", true],
] as const) {
  test(`uses keyword fallback after provider ${label}`, async () => {
    const fake = fakeDependencies({
      embedError: new OpenAIEmbeddingError(code, retryable),
      candidate: envelope({ ...RESULT, matchKind: "keyword" }, true),
    });
    const response = await handler(fake.dependencies)(request("elsparkcyklar"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.mode, "keyword_fallback");
    assert.equal(body.results[0].matchKind, "keyword");
    assert.equal(fake.searches[0].queryEmbedding, null);
  });
}

test("never uses stale semantic coverage and reports keyword fallback", async () => {
  const fake = fakeDependencies({
    candidate: envelope({ ...RESULT, matchKind: "keyword" }, false),
  });
  const response = await handler(fake.dependencies)(request("elsparkcyklar"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, "keyword_fallback");
  assert.equal(body.results[0].matchKind, "keyword");
});

test("returns a verified event destination and exact source filters", async () => {
  const fake = fakeDependencies();
  const response = await handler(fake.dependencies)(request("budgetdebatten 2022"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, "filtered");
  assert.equal(body.event.id, EVENT_ID);
  assert.deepEqual(fake.searches[0].sourceIds, [SOURCE_ID]);
  assert.equal(fake.searches[0].dateFrom, "2022-01-01");
  assert.equal(fake.searches[0].dateTo, "2022-12-31");
  assert.equal(fake.eventIds[0], EVENT_ID);
  assert.equal(fake.embeddedTopics.length, 0);
});

test("date-only query is honestly empty and does not run retrieval", async () => {
  const fake = fakeDependencies();
  const response = await handler(fake.dependencies)(request("2017"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, "filtered");
  assert.deepEqual(body.results, []);
  assert.deepEqual(
    body.interpretation.facets.map((facet: { kind: string }) => facet.kind),
    ["date"],
  );
  assert.equal(fake.searches.length, 0);
  assert.equal(fake.embeddedTopics.length, 0);
});

test("returns ambiguity choices while continuing the unconsumed surname as topic", async () => {
  const fake = fakeDependencies({
    catalog: {
      ...CATALOG,
      people: [
        ...CATALOG.people,
        {
          id: "44444444-4444-4444-8444-444444444444",
          label: "Karin Andersson",
          party: "M",
          aliases: [
            { value: "Karin Andersson", verified: true },
            { value: "Andersson", verified: true },
          ],
        },
      ],
    },
  });
  const response = await handler(fake.dependencies)(request("Andersson"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.interpretation.ambiguity.kind, "person");
  assert.equal(body.interpretation.ambiguity.options.length, 2);
  assert.equal(fake.searches[0].politicianId, null);
  assert.equal(fake.searches[0].topic, "Andersson");
});

test("preserves an empty result set", async () => {
  const fake = fakeDependencies({ candidate: envelope(null, true) });
  const response = await handler(fake.dependencies)(request("elsparkcyklar"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, "hybrid");
  assert.deepEqual(body.results, []);
});

test("enforces request budgets before loading the catalogue", async () => {
  const fake = fakeDependencies({
    requestDecision: { allowed: false, reason: "client_minute", retryAfterSeconds: 60 },
  });
  const response = await handler(fake.dependencies)(request("elsparkcyklar"));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.deepEqual(await response.json(), { error: "rate_limited" });
  assert.equal(fake.catalogLoads, 0);
  assert.equal(fake.searches.length, 0);
});

test("reuses a valid catalogue for one minute without bypassing request budgets", async () => {
  const fake = fakeDependencies();
  const search = handler(fake.dependencies);

  assert.equal((await search(request("elsparkcyklar"))).status, 200);
  assert.equal((await search(request("järnvägsunderhåll"))).status, 200);
  assert.equal(fake.catalogLoads, 1);
  assert.equal(fake.rateKeys.length, 2);
  assert.equal(fake.logs[0].catalogCacheHit, false);
  assert.equal(fake.logs[1].catalogCacheHit, true);
  assert.ok(fake.logs.every((log) => Object.values(log.phaseMs).every(Number.isFinite)));
});

test("browser preflight permits the public Supabase apikey header", async () => {
  const response = await handler(fakeDependencies().dependencies)(
    new Request("https://example.test/clip-search", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "apikey,content-type",
      },
    }),
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const allowedHeaders = new Set(
    (response.headers.get("Access-Control-Allow-Headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase()),
  );
  assert.equal(allowedHeaders.has("apikey"), true);
  assert.equal(allowedHeaders.has("content-type"), true);
});

test("rejects invalid, oversized, non-POST and cross-origin requests", async () => {
  const fake = fakeDependencies();
  const search = handler(fake.dependencies);
  const invalid = await search(request("x"));
  assert.equal(invalid.status, 400);

  const oversized = await search(new Request("https://example.test/clip-search", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "z".repeat(5000) }),
  }));
  assert.equal(oversized.status, 413);

  const get = await search(new Request("https://example.test/clip-search", {
    method: "GET",
    headers: { Origin: ORIGIN },
  }));
  assert.equal(get.status, 405);

  const crossOrigin = await search(new Request("https://example.test/clip-search", {
    method: "POST",
    headers: { Origin: "https://attacker.invalid" },
    body: JSON.stringify({ query: "elsparkcyklar" }),
  }));
  assert.equal(crossOrigin.status, 403);
});

test("HMACs the daily client identity and never logs query or address", async () => {
  const fake = fakeDependencies();
  const submittedQuery = "hemligt sökämne";
  const submittedAddress = "203.0.113.42";
  const response = await handler(fake.dependencies)(request(submittedQuery, submittedAddress));
  assert.equal(response.status, 200);
  assert.equal(fake.rateKeys.length, 1);
  assert.match(fake.rateKeys[0], /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(fake.logs), new RegExp(submittedQuery, "u"));
  assert.doesNotMatch(JSON.stringify(fake.logs), new RegExp(submittedAddress.replaceAll(".", "\\."), "u"));
  assert.notEqual(fake.rateKeys[0], submittedAddress);

  const sameDay = await dailySearchClientKey(
    submittedAddress,
    RATE_SECRET,
    new Date("2026-08-25T23:59:59Z"),
  );
  const nextDay = await dailySearchClientKey(
    submittedAddress,
    RATE_SECRET,
    new Date("2026-08-26T00:00:00Z"),
  );
  assert.notEqual(sameDay, nextDay);
});

test("migration 026 locks hybrid ranking, stale-index filtering and private budgets", () => {
  const up = readFileSync(
    new URL("../../../migrations/026_hybrid_clip_search.up.sql", import.meta.url),
    "utf8",
  );
  const down = readFileSync(
    new URL("../../../migrations/026_hybrid_clip_search.down.sql", import.meta.url),
    "utf8",
  );

  assert.match(up, /limit 120/iu);
  assert.match(up, /operator\(extensions\.<=>\)/iu);
  assert.match(up, />= 0\.35/iu);
  assert.match(up, /1\.5 \/ \(50 \+ keyword\.retrieval_rank\)/iu);
  assert.match(up, /1\.0 \/ \(50 \+ semantic\.retrieval_rank\)/iu);
  assert.match(up, /chunk\.source_hash = document\.source_hash/iu);
  assert.match(up, /document\.completed_index_version = target_index_version/iu);
  assert.match(up, /client_minute <= 10/iu);
  assert.match(up, /client_day <= 200/iu);
  assert.match(up, /global_tokens <= 1000000/iu);
  assert.match(up, /expires_at <= now\(\)/iu);
  assert.match(up, /revoke all on function public\.search_clip_candidates[\s\S]+from public, anon, authenticated/iu);
  assert.doesNotMatch(up, /grant execute[\s\S]{0,100}\b(?:anon|authenticated)\b/iu);
  assert.match(down, /drop function if exists public\.search_clip_candidates/iu);
  assert.doesNotMatch(down, /drop table/iu);
});

test("migration 027 adds calibrated admission and an additive rollback path", () => {
  const up = readFileSync(
    new URL("../../../migrations/027_search_relevance_latency.up.sql", import.meta.url),
    "utf8",
  );
  const down = readFileSync(
    new URL("../../../migrations/027_search_relevance_latency.down.sql", import.meta.url),
    "utf8",
  );

  assert.equal(SEARCH_RANKING_ROLLBACK_VERSION, "pleni-search-v2");
  assert.equal(SEARCH_SEMANTIC_ADMISSION_SIMILARITY, 0.53);
  assert.equal(SEARCH_SEMANTIC_ADMISSION_LEXICAL_COVERAGE, 0.67);
  assert.match(up, /top_similarity >= 0\.53/iu);
  assert.match(up, /top_lexical_coverage >= 0\.67/iu);
  assert.match(up, /create or replace function public\.prepare_clip_search_request/iu);
  assert.match(up, /from public, anon, authenticated/iu);
  assert.match(up, /to service_role/iu);
  assert.match(down, /drop function if exists public\.search_clip_candidates_v2/iu);
  assert.doesNotMatch(down, /drop function if exists public\.search_clip_candidates\(/iu);
  assert.doesNotMatch(down, /drop table/iu);
});

test("migration 028 materializes the catalogue and preserves rate limits", () => {
  const up = readFileSync(
    new URL("../../../migrations/028_search_catalog_cache.up.sql", import.meta.url),
    "utf8",
  );
  const down = readFileSync(
    new URL("../../../migrations/028_search_catalog_cache.down.sql", import.meta.url),
    "utf8",
  );

  assert.match(up, /add column if not exists entity_catalog jsonb/iu);
  assert.match(up, /load_search_entity_catalog_cached/iu);
  assert.match(up, /decision := public\.consume_search_request_limit/iu);
  assert.match(up, /for each statement execute function/iu);
  assert.match(up, /from public, anon, authenticated/iu);
  assert.match(down, /catalog := public\.load_search_entity_catalog\(\)/iu);
  assert.match(down, /drop column if exists entity_catalog/iu);
  assert.doesNotMatch(down, /drop table/iu);
});

test("rejects malformed rate-limit RPC output", () => {
  assert.throws(
    () => parseSearchRateLimitDecision({ allowed: true, reason: null, retryAfterSeconds: -1 }),
    /invalid_rate_limit_response/u,
  );
});

function handler(dependencies: ClipSearchDependencies) {
  return createClipSearchHandler(dependencies, {
    allowedOrigins: new Set([ORIGIN]),
    rateLimitSecret: RATE_SECRET,
  });
}

function request(query: string, address = "198.51.100.10"): Request {
  return requestWithFacets(query, [], address);
}

function requestWithLimit(query: string, limit: number): Request {
  return new Request("https://example.test/clip-search", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "X-Forwarded-For": "198.51.100.10",
    },
    body: JSON.stringify({ query, limit }),
  });
}

function requestWithFacets(
  query: string,
  disabledFacets: string[],
  address = "198.51.100.10",
): Request {
  return new Request("https://example.test/clip-search", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "X-Forwarded-For": address,
    },
    body: JSON.stringify({ query, ...(disabledFacets.length > 0 ? { disabledFacets } : {}) }),
  });
}

function fakeDependencies(options: {
  catalog?: unknown;
  candidate?: unknown;
  candidateFor?: (search: SearchCandidateRequest) => unknown;
  embedError?: OpenAIEmbeddingError;
  requestDecision?: unknown;
} = {}) {
  const searches: SearchCandidateRequest[] = [];
  const embeddedTopics: string[] = [];
  const reservations: number[] = [];
  const rateKeys: string[] = [];
  const eventIds: string[] = [];
  const logs: SearchLogSummary[] = [];
  let catalogLoads = 0;
  const dependencies: ClipSearchDependencies = {
    async prepareRequest(keyHash) {
      rateKeys.push(keyHash);
      const decision = options.requestDecision ?? {
        allowed: true,
        reason: null,
        retryAfterSeconds: 0,
      };
      const allowed = Boolean(
        typeof decision === "object" && decision !== null &&
          "allowed" in decision && decision.allowed,
      );
      if (allowed) catalogLoads += 1;
      return {
        rateLimit: decision,
        catalog: allowed ? options.catalog ?? CATALOG : null,
      };
    },
    async consumeRequestLimit(keyHash) {
      rateKeys.push(keyHash);
      return options.requestDecision ?? {
        allowed: true,
        reason: null,
        retryAfterSeconds: 0,
      };
    },
    async reserveProviderTokens(count) {
      reservations.push(count);
      return { allowed: true, reason: null, retryAfterSeconds: 0 };
    },
    async embedTopic(topic) {
      embeddedTopics.push(topic);
      if (options.embedError) throw options.embedError;
      return VECTOR;
    },
    async searchCandidates(search) {
      searches.push(search);
      return options.candidateFor?.(search) ?? options.candidate ?? envelope(RESULT, true);
    },
    async loadEventDestination(eventId) {
      eventIds.push(eventId);
      return {
        id: EVENT_ID,
        label: "Budgetdebatten 2022",
        dateLabel: "8 november 2022",
        sourceUrl: "https://example.test/debate",
        clipCount: 1,
      };
    },
    log(summary) {
      logs.push(summary);
    },
    now: () => new Date("2026-08-25T12:00:00Z"),
  };
  return {
    dependencies,
    searches,
    embeddedTopics,
    reservations,
    rateKeys,
    eventIds,
    logs,
    get catalogLoads() {
      return catalogLoads;
    },
  };
}

function envelope(
  result: SearchClipResult | readonly SearchClipResult[] | null,
  semanticAvailable: boolean,
) {
  return {
    indexVersion: "openai:text-embedding-3-large:1024:v1",
    semanticAvailable,
    results: Array.isArray(result) ? result : result ? [result] : [],
  };
}

function resultAt(id: string, debateDate: string): SearchClipResult {
  return {
    ...RESULT,
    clip: {
      ...RESULT.clip,
      id: `HD10135_35_c02_${id}`,
      debateDate,
    },
  };
}

const RESULT: SearchClipResult = {
  clip: {
    id: "HD10135_35_c02",
    speechId: "HD10135_35",
    politicianId: MAGDALENA_ID,
    politicianName: "Magdalena Andersson",
    politicianRole: "Ledamot",
    politicianAvatarUrl: "https://example.test/magdalena.webp",
    speakerName: "Magdalena Andersson",
    party: "S",
    anforandetyp: "Anförande",
    archetype: "argument",
    title: "Skatter och trafik",
    transcript: "Ett tal om elsparkcyklar och skatter.",
    topic: "Trafik",
    durationS: 45,
    videoUrl: "https://example.test/clip.mp4",
    thumbUrl: "https://example.test/clip.webp",
    sourceTitle: "Debatt",
    sourceUrl: "https://example.test/debate",
    debateDate: "2022-11-08",
    publishedAt: "2022-11-08T12:00:00Z",
    rank: 2,
    isSample: false,
  },
  speakerNameAtSpeech: "Magdalena Andersson",
  partyAtSpeech: "S",
  matchExcerpt: "Ett tal om elsparkcyklar och skatter.",
  matchKind: "both",
};

// --- OPT2 candidate-level admission ------------------------------------------

// The captured scores of the three elflyg rows that entered a scooter search as
// context-only filler. They are the known weak-filler failure class OPT2 owns.
const ELFLYG_FALSE_POSITIVES = [
  "HD10398_27_c02",
  "HD10401_27_c02",
  "HD10406_27_c02",
] as const;
const ELFLYG_SIMILARITY = 0.416605;
const ELFLYG_LEXICAL_COVERAGE = 0;

test("a keyword-matched candidate is never subject to candidate admission", () => {
  // Keyword matches survive on their own evidence, whatever the semantic side
  // says, so an exact Swedish match can never be filtered out.
  assert.equal(
    admitsSemanticCandidate({
      keywordMatched: true,
      similarity: 0,
      lexicalCoverage: 0,
    }),
    true,
  );
  assert.equal(
    admitsSemanticCandidate({
      keywordMatched: true,
      similarity: null,
      lexicalCoverage: null,
    }),
    true,
  );
});

test("a semantic-only candidate must clear its own similarity or coverage bar", () => {
  const weak = {
    keywordMatched: false,
    similarity: SEARCH_CANDIDATE_ADMISSION_SIMILARITY - 0.01,
    lexicalCoverage: SEARCH_CANDIDATE_ADMISSION_LEXICAL_COVERAGE - 0.01,
  };
  assert.equal(admitsSemanticCandidate(weak), false);
  assert.equal(
    admitsSemanticCandidate({ ...weak, similarity: SEARCH_CANDIDATE_ADMISSION_SIMILARITY }),
    true,
  );
  assert.equal(
    admitsSemanticCandidate({
      ...weak,
      lexicalCoverage: SEARCH_CANDIDATE_ADMISSION_LEXICAL_COVERAGE,
    }),
    true,
  );
});

test("a strong candidate never admits a weaker candidate in the same query", () => {
  const strong = { keywordMatched: false, similarity: 0.95, lexicalCoverage: 1 };
  const weak = { keywordMatched: false, similarity: 0.2, lexicalCoverage: 0 };

  // Admission reads one candidate at a time. The query-level gate is what the
  // strong candidate can open; it cannot carry the weak one past its own bar.
  assert.equal(admitsSemanticCandidate(strong), true);
  assert.equal(admitsSemanticCandidate(weak), false);
  assert.deepEqual(
    [strong, weak].filter((candidate) => admitsSemanticCandidate(candidate)),
    [strong],
  );
});

test("the three known elflyg context rows fail candidate admission", () => {
  for (const clipId of ELFLYG_FALSE_POSITIVES) {
    assert.equal(
      admitsSemanticCandidate({
        keywordMatched: false,
        similarity: ELFLYG_SIMILARITY,
        lexicalCoverage: ELFLYG_LEXICAL_COVERAGE,
      }),
      false,
      clipId,
    );
  }
  // They still cleared v2's query-level gate, which is why v2 served them: the
  // scooter query had a keyword anchor elsewhere in the result list.
  assert.ok(ELFLYG_SIMILARITY < SEARCH_CANDIDATE_ADMISSION_SIMILARITY);
  assert.ok(ELFLYG_LEXICAL_COVERAGE < SEARCH_CANDIDATE_ADMISSION_LEXICAL_COVERAGE);
});

test("candidate admission keeps the query-level gate rather than replacing it", () => {
  // The query-level floors are unchanged; the candidate floors are additional.
  assert.equal(SEARCH_SEMANTIC_ADMISSION_SIMILARITY, 0.53);
  assert.equal(SEARCH_SEMANTIC_ADMISSION_LEXICAL_COVERAGE, 0.67);
  assert.equal(SEARCH_CANDIDATE_ADMISSION_SIMILARITY, 0.5);
  assert.equal(SEARCH_CANDIDATE_ADMISSION_LEXICAL_COVERAGE, 0.67);
});

test("a shorter result list is served as-is and no quota is filled", async () => {
  const three = [resultAt("a", "2026-05-01"), resultAt("b", "2026-05-02"), resultAt(
    "c",
    "2026-05-03",
  )];
  const fake = fakeDependencies({ candidate: envelope(three, true) });
  const response = await handler(fake.dependencies)(
    requestWithLimit("elsparkcyklar", 20),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(fake.searches[0].limit, 20);
  assert.equal(body.results.length, 3);
  assert.equal(fake.logs[0].resultCount, 3);
  assert.equal(fake.searches.length, 1);
});

test("server order is handed to the client unchanged", async () => {
  // Ties are broken in SQL and the Edge Function must not re-sort. Dates here
  // ascend so any client-side recency sort would be visible.
  const ordered = [
    resultAt("first", "2026-01-01"),
    resultAt("second", "2026-06-01"),
    resultAt("third", "2026-12-01"),
  ];
  const fake = fakeDependencies({ candidate: envelope(ordered, true) });
  const response = await handler(fake.dependencies)(request("elsparkcyklar"));
  const body = await response.json();

  assert.deepEqual(
    body.results.map((result: SearchClipResult) => result.clip.id),
    ordered.map((result) => result.clip.id),
  );
});

test("no ranking score reaches the public response", async () => {
  const fake = fakeDependencies();
  const response = await handler(fake.dependencies)(request("elsparkcyklar"));
  const body = await response.json();

  const rendered = JSON.stringify(body);
  for (const leak of ["similarity", "lexicalCoverage", "fusionScore", "fusion_score", "strength"]) {
    assert.equal(rendered.includes(leak), false, leak);
  }
});

test("the v2 rollback envelope still parses unchanged", async () => {
  // v3 returns the same envelope as v2, so redeploying the previous Edge commit
  // is a pure rollback with no SQL change.
  const v2Envelope = {
    indexVersion: "openai:text-embedding-3-large:1024:v1",
    semanticAvailable: true,
    results: [RESULT],
  };
  const fake = fakeDependencies({ candidate: v2Envelope });
  const response = await handler(fake.dependencies)(request("elsparkcyklar"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.mode, "hybrid");
  assert.equal(body.indexVersion, v2Envelope.indexVersion);
  assert.equal(body.results.length, 1);
});

test("rejects a malformed v3 candidate envelope", async () => {
  for (
    const malformed of [
      { indexVersion: "", semanticAvailable: true, results: [] },
      { indexVersion: "v1", semanticAvailable: "yes", results: [] },
      { indexVersion: "v1", semanticAvailable: true, results: {} },
      { indexVersion: "v1", semanticAvailable: true },
      { results: [] },
    ]
  ) {
    const fake = fakeDependencies({ candidate: malformed });
    const response = await handler(fake.dependencies)(request("elsparkcyklar"));
    assert.equal(response.status, 503, JSON.stringify(malformed));
    assert.deepEqual(await response.json(), { error: "search_unavailable" });
  }
});

test("rejects a missing v3 candidate envelope", async () => {
  // Injected directly: the fake's `??` default would swallow a null here.
  const fake = fakeDependencies();
  const dependencies: ClipSearchDependencies = {
    ...fake.dependencies,
    searchCandidates: async (search) => {
      fake.searches.push(search);
      return null;
    },
  };
  const response = await handler(dependencies)(request("elsparkcyklar"));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "search_unavailable" });
  assert.equal(fake.logs[0].resultCount, 0);
});

test("migration 029 adds candidate-level admission with an additive rollback path", () => {
  const up = readFileSync(
    new URL("../../../migrations/029_search_candidate_admission.up.sql", import.meta.url),
    "utf8",
  );
  const down = readFileSync(
    new URL("../../../migrations/029_search_candidate_admission.down.sql", import.meta.url),
    "utf8",
  );

  // The selected constants must not drift between SQL and TypeScript.
  assert.equal(SEARCH_CANDIDATE_ADMISSION_SIMILARITY, 0.5);
  assert.equal(SEARCH_CANDIDATE_ADMISSION_LEXICAL_COVERAGE, 0.67);
  assert.match(up, /candidate\.similarity >= 0\.50/iu);
  assert.match(up, /candidate\.lexical_coverage >= 0\.67/iu);
  // The v2 query-level gate is kept, not replaced.
  assert.match(up, /top_similarity >= 0\.53/iu);
  assert.match(up, /top_lexical_coverage >= 0\.67/iu);
  // Keyword-matched candidates are exempt from candidate admission.
  assert.match(up, /exists \(\s*select 1\s*from keyword_ranked keyword/iu);
  // Structured filters stay in `eligible`, ahead of retrieval.
  assert.match(up, /with eligible as \([\s\S]{0,900}p_politician_id is null/iu);
  assert.match(up, /eligible[\s\S]{0,4000}keyword_candidates as \(/iu);
  // Unchanged retrieval and fusion: no recency boost, same weights and floor.
  assert.match(up, /1\.5 \/ \(50 \+ keyword\.retrieval_rank\)/iu);
  assert.match(up, /1\.0 \/ \(50 \+ semantic\.retrieval_rank\)/iu);
  assert.match(up, />= 0\.35/iu);
  assert.match(up, /limit 120/iu);
  assert.doesNotMatch(up, /published_at/iu);
  // Date stays a filter and a deterministic tie break only.
  assert.match(up, /order by\s+fused\.fusion_score desc,\s+fused\.debate_date desc,/iu);
  // Additive: v3 is created, nothing earlier is dropped or rewritten.
  assert.match(up, /create or replace function public\.search_clip_candidates_v3\(/iu);
  assert.doesNotMatch(up, /drop function/iu);
  assert.doesNotMatch(up, /alter table/iu);
  assert.doesNotMatch(up, /drop table/iu);
  assert.match(up, /revoke all on function public\.search_clip_candidates_v3[\s\S]+from public, anon, authenticated/iu);
  assert.doesNotMatch(up, /grant execute[\s\S]{0,120}\b(?:anon|authenticated)\b/iu);
  assert.match(up, /to service_role/iu);
  // The down path removes v3 only; v2 stays deployed for rollback.
  assert.match(down, /drop function if exists public\.search_clip_candidates_v3\(/iu);
  assert.doesNotMatch(down, /search_clip_candidates_v2/iu);
  assert.doesNotMatch(down, /drop table/iu);
});

test("the Edge Function calls the RPC version its constants name", () => {
  const edgeFunction = readFileSync(
    new URL("../clip-search/index.ts", import.meta.url),
    "utf8",
  );

  assert.equal(SEARCH_RANKING_VERSION, "pleni-search-v3");
  assert.equal(SEARCH_RANKING_ROLLBACK_VERSION, "pleni-search-v2");
  assert.match(edgeFunction, /search_clip_candidates_v3/u);
  assert.doesNotMatch(edgeFunction, /search_clip_candidates_v2/u);
});
