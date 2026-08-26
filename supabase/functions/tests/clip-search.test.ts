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
  assert.equal(body.searchVersion, "pleni-search-v2");
  assert.equal(body.results[0].matchKind, "both");
  assert.equal(fake.searches.length, 1);
  assert.equal(fake.searches[0].topic, "elsparkcyklar");
  assert.match(String(fake.searches[0].queryEmbedding), /^\[[\d.,-]+\]$/u);
  assert.equal(fake.reservations.length, 1);
  assert.equal(fake.logs[0].resultCount, 1);
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

  assert.equal(SEARCH_RANKING_VERSION, "pleni-search-v2");
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
  return new Request("https://example.test/clip-search", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "X-Forwarded-For": address,
    },
    body: JSON.stringify({ query }),
  });
}

function fakeDependencies(options: {
  catalog?: unknown;
  candidate?: unknown;
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
      return options.candidate ?? envelope(RESULT, true);
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

function envelope(result: SearchClipResult | null, semanticAvailable: boolean) {
  return {
    indexVersion: "openai:text-embedding-3-large:1024:v1",
    semanticAvailable,
    results: result ? [result] : [],
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
