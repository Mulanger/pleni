import {
  parseClipSearchRequest,
  parseClipSearchResponse,
  SearchContractError,
  type ClipSearchRequest,
  type ClipSearchResponse,
  type SearchEventDestination,
} from "../search-types.ts";
import { jsonResponse } from "../cors.ts";
import { OpenAIEmbeddingError } from "./openai.ts";
import { interpretSearchQuery } from "./interpret.ts";
import {
  embeddingToHalfvec,
  providerTokenReservation,
  SEARCH_RANKING_VERSION,
} from "./ranking.ts";
import {
  dailySearchClientKey,
  parseSearchRateLimitDecision,
  searchClientAddress,
  type SearchRateLimitDecision,
} from "./rate-limit.ts";
import type { SearchEntityCatalog } from "./types.ts";

export const MAX_CLIP_SEARCH_BODY_BYTES = 4096;
export const SEARCH_CATALOG_CACHE_TTL_MS = 60_000;

export interface SearchCandidateRequest {
  topic: string | null;
  queryEmbedding: string | null;
  limit: number;
  politicianId: string | null;
  party: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  sourceIds: string[] | null;
}

export interface ClipSearchDependencies {
  prepareRequest(keyHash: string): Promise<unknown>;
  consumeRequestLimit(keyHash: string): Promise<unknown>;
  reserveProviderTokens(tokenCount: number): Promise<unknown>;
  embedTopic(topic: string): Promise<readonly number[]>;
  searchCandidates(request: SearchCandidateRequest): Promise<unknown>;
  loadEventDestination(eventId: string): Promise<unknown>;
  log(summary: SearchLogSummary): void;
  now?: () => Date;
}

export interface ClipSearchHandlerOptions {
  allowedOrigins: ReadonlySet<string>;
  rateLimitSecret: string;
  maxBodyBytes?: number;
  catalogCacheTtlMs?: number;
}

export interface SearchLogSummary {
  event: "clip_search_request";
  status: number;
  mode: ClipSearchResponse["mode"] | "none";
  resultCount: number;
  rateLimited: boolean;
  durationMs: number;
  catalogCacheHit: boolean;
  phaseMs: {
    preflight: number;
    providerBudget: number;
    embedding: number;
    retrieval: number;
  };
}

interface SearchCandidateEnvelope {
  indexVersion: string;
  semanticAvailable: boolean;
  results: unknown[];
}

interface PreparedSearchRequestEnvelope {
  rateLimit: unknown;
  catalog: unknown;
}

class SearchHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number;

  constructor(
    status: number,
    code: string,
    retryAfterSeconds = 0,
  ) {
    super(code);
    this.name = "SearchHttpError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function createClipSearchHandler(
  dependencies: ClipSearchDependencies,
  options: ClipSearchHandlerOptions,
): (request: Request) => Promise<Response> {
  const catalogCacheTtlMs = Math.max(
    0,
    options.catalogCacheTtlMs ?? SEARCH_CATALOG_CACHE_TTL_MS,
  );
  let cachedCatalog: SearchEntityCatalog | null = null;
  let catalogExpiresAtMs = 0;

  return async (request) => {
    const started = performance.now();
    let mode: SearchLogSummary["mode"] = "none";
    let resultCount = 0;
    let rateLimited = false;
    let status = 500;
    let catalogCacheHit = false;
    let preflightMs = 0;
    let providerBudgetMs = 0;
    let embeddingMs = 0;
    let retrievalMs = 0;
    const origin = request.headers.get("Origin");
    const normalizedOrigin = origin?.replace(/\/$/u, "") ?? "";
    if (!origin || !options.allowedOrigins.has(normalizedOrigin)) {
      return new Response("Origin not allowed", { status: 403 });
    }
    const cors = new Headers({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return jsonResponse(
        { error: "method_not_allowed" },
        405,
        cors,
        { Allow: "POST, OPTIONS" },
      );
    }

    try {
      const body = await readBoundedJson(request, options.maxBodyBytes);
      const searchRequest = parseClipSearchRequest(body);
      const requestNow = dependencies.now?.() ?? new Date();
      const clientKey = await dailySearchClientKey(
        searchClientAddress(request),
        options.rateLimitSecret,
        requestNow,
      );
      const preflightStarted = performance.now();
      let catalog: SearchEntityCatalog;
      if (cachedCatalog && requestNow.getTime() < catalogExpiresAtMs) {
        catalogCacheHit = true;
        enforceRateLimit(
          parseSearchRateLimitDecision(
            await dependencies.consumeRequestLimit(clientKey),
          ),
        );
        catalog = cachedCatalog;
      } else {
        const prepared = parsePreparedRequest(
          await dependencies.prepareRequest(clientKey),
        );
        enforceRateLimit(parseSearchRateLimitDecision(prepared.rateLimit));
        catalog = parseEntityCatalog(prepared.catalog);
        cachedCatalog = catalog;
        catalogExpiresAtMs = requestNow.getTime() + catalogCacheTtlMs;
      }
      preflightMs = elapsedMs(preflightStarted);
      const interpretation = interpretSearchQuery(searchRequest, catalog);
      const limit = searchRequest.limit ?? 20;

      if (!interpretation.plan.hasRetrievalAnchor) {
        mode = "filtered";
        const response = parseClipSearchResponse({
          mode,
          searchVersion: SEARCH_RANKING_VERSION,
          indexVersion: "semantic-index-not-used",
          interpretation: {
            facets: interpretation.facets,
            ambiguity: interpretation.ambiguity,
          },
          event: null,
          results: [],
        });
        status = 200;
        return jsonResponse(response, status, cors);
      }

      let queryEmbedding: string | null = null;
      let providerFallback = false;
      if (interpretation.plan.topic) {
        const providerBudgetStarted = performance.now();
        enforceRateLimit(
          parseSearchRateLimitDecision(
            await dependencies.reserveProviderTokens(
              providerTokenReservation(interpretation.plan.topic),
            ),
          ),
        );
        providerBudgetMs = elapsedMs(providerBudgetStarted);
        const embeddingStarted = performance.now();
        try {
          queryEmbedding = embeddingToHalfvec(
            await dependencies.embedTopic(interpretation.plan.topic),
          );
        } catch (error) {
          if (!(error instanceof OpenAIEmbeddingError)) throw error;
          providerFallback = true;
        } finally {
          embeddingMs = elapsedMs(embeddingStarted);
        }
      }

      const retrievalStarted = performance.now();
      const [candidateValue, eventValue] = await Promise.all([
        dependencies.searchCandidates({
          topic: interpretation.plan.topic,
          queryEmbedding,
          limit,
          politicianId: interpretation.plan.politicianId,
          party: interpretation.plan.party,
          dateFrom: interpretation.plan.dateFrom,
          dateTo: interpretation.plan.dateTo,
          sourceIds: interpretation.plan.sourceIds,
        }),
        interpretation.plan.eventId
          ? dependencies.loadEventDestination(interpretation.plan.eventId)
          : Promise.resolve(null),
      ]);
      retrievalMs = elapsedMs(retrievalStarted);
      const candidates = parseCandidateEnvelope(candidateValue);
      mode = interpretation.plan.topic
        ? providerFallback || !candidates.semanticAvailable
          ? "keyword_fallback"
          : "hybrid"
        : "filtered";

      const response = parseClipSearchResponse({
        mode,
        searchVersion: SEARCH_RANKING_VERSION,
        indexVersion: candidates.indexVersion,
        interpretation: {
          facets: interpretation.facets,
          ambiguity: interpretation.ambiguity,
        },
        event: parseEventDestination(eventValue),
        results: candidates.results,
      });
      resultCount = response.results.length;
      status = 200;
      return jsonResponse(response, status, cors);
    } catch (error) {
      const handled = searchError(error);
      status = handled.status;
      rateLimited = status === 429;
      const headers = handled.retryAfterSeconds > 0
        ? { "Retry-After": String(handled.retryAfterSeconds) }
        : undefined;
      return jsonResponse({ error: handled.code }, status, cors, headers);
    } finally {
      dependencies.log({
        event: "clip_search_request",
        status,
        mode,
        resultCount,
        rateLimited,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        catalogCacheHit,
        phaseMs: {
          preflight: preflightMs,
          providerBudget: providerBudgetMs,
          embedding: embeddingMs,
          retrieval: retrievalMs,
        },
      });
    }
  };
}

function parsePreparedRequest(value: unknown): PreparedSearchRequestEnvelope {
  if (!isRecord(value) || !("rateLimit" in value) || !("catalog" in value)) {
    throw new Error("invalid_search_preflight");
  }
  return { rateLimit: value.rateLimit, catalog: value.catalog };
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function enforceRateLimit(decision: SearchRateLimitDecision): void {
  if (!decision.allowed) {
    throw new SearchHttpError(429, "rate_limited", decision.retryAfterSeconds);
  }
}

async function readBoundedJson(
  request: Request,
  configuredMax: number | undefined,
): Promise<unknown> {
  const maxBytes = configuredMax ?? MAX_CLIP_SEARCH_BODY_BYTES;
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new SearchHttpError(413, "request_too_large");
  }
  if (!request.body) throw new SearchHttpError(400, "invalid_json");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SearchHttpError(413, "request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SearchHttpError(400, "invalid_json");
  }
}

function parseEntityCatalog(value: unknown): SearchEntityCatalog {
  if (!isRecord(value) || !Array.isArray(value.people) || !Array.isArray(value.events)) {
    throw new Error("invalid_search_catalog");
  }
  return value as unknown as SearchEntityCatalog;
}

function parseCandidateEnvelope(value: unknown): SearchCandidateEnvelope {
  if (
    !isRecord(value) ||
    typeof value.indexVersion !== "string" ||
    value.indexVersion.length === 0 ||
    typeof value.semanticAvailable !== "boolean" ||
    !Array.isArray(value.results)
  ) {
    throw new Error("invalid_search_candidates");
  }
  return {
    indexVersion: value.indexVersion,
    semanticAvailable: value.semanticAvailable,
    results: value.results,
  };
}

function parseEventDestination(value: unknown): SearchEventDestination | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("invalid_search_event");
  return value as unknown as SearchEventDestination;
}

function searchError(error: unknown): SearchHttpError {
  if (error instanceof SearchHttpError) return error;
  if (error instanceof SearchContractError) {
    return new SearchHttpError(400, "invalid_request");
  }
  return new SearchHttpError(503, "search_unavailable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
