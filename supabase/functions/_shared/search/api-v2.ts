import { jsonResponse } from "../cors.ts";
import { SearchContractError } from "../search-types.ts";
import { parseSearchV2Request, parseSearchV2Response, parseSearchSuggestions,
  type SearchV2Response } from "../search-v2-types.ts";
import { readBoundedJson, parseEntityCatalog, SearchHttpError } from "./api.ts";
import { interpretV2 } from "./interpret-v2.ts";
import { OpenAIEmbeddingError } from "./openai.ts";
import { embeddingToHalfvec, providerTokenReservation } from "./ranking.ts";
import { dailySearchClientKey, searchClientAddress, parseSearchRateLimitDecision } from "./rate-limit.ts";
import { CURSOR_TTL_MS, V2_RANKING_VERSION, InvalidSearchCursor, openCursor, sealCursor,
  searchBinding, packVector, unpackVector, type SearchCursor } from "./cursor-v2.ts";
import type { SearchEntityCatalog } from "./types.ts";

export interface SearchV2Dependencies {
  prepare(key: string, catalog: boolean, purpose: "search" | "suggest"): Promise<unknown>;
  reserveTokens(tokens: number): Promise<unknown>;
  embed(topic: string): Promise<readonly number[]>;
  retrieve(parameters: Record<string, unknown>): Promise<unknown>;
  suggest(query: string, kind: string | null): Promise<unknown>;
  log(summary: {event: "search_v2"; status: number; durationMs: number;
    mode: string; hasMore: boolean; operation: "search" | "suggest"}): void;
  now?: () => Date;
}
export function createSearchV2Handler(deps: SearchV2Dependencies, options: {
  allowedOrigins: ReadonlySet<string>; secret: string;
}): (request: Request) => Promise<Response> {
  let cached: SearchEntityCatalog | null=null;
  let expires=0;
  return async request => {
    const start=performance.now();
    const origin=request.headers.get("Origin");
    if (!origin || !options.allowedOrigins.has(origin.replace(/\/$/u,""))) return new Response("Origin not allowed",{status:403});
    const headers=new Headers({"Access-Control-Allow-Origin":origin,"Vary":"Origin",
      "Access-Control-Allow-Headers":"apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Max-Age":"86400",
      "Access-Control-Expose-Headers":"Server-Timing","Cache-Control":"no-store"});
    if (request.method==="OPTIONS") return new Response(null,{status:204,headers});
    let status=503, mode="none", hasMore=false, operation:"search"|"suggest"="search";
    const reply=(body: unknown, code=200) => {
      status=code; headers.set("Server-Timing",`search;dur=${Math.round(performance.now()-start)}`);
      return jsonResponse(body,code,headers);
    };
    try {
      if (request.method!=="POST") throw new SearchHttpError(405,"method_not_allowed");
      const body=await readBoundedJson(request,16384) as Record<string,unknown>;
      const now=deps.now?.() ?? new Date();
      operation=body?.operation==="suggest" ? "suggest" : "search";
      let suggestionQuery="", suggestionKind: string|null=null;
      let input;
      if (operation==="suggest") {
        if (typeof body.query!=="string" || body.query.length>300 ||
          Object.keys(body).some(k=>!["operation","query","kind"].includes(k)) ||
          (body.kind!==undefined && !["person","party","event","year"].includes(String(body.kind)))) {
          throw new SearchContractError("invalid_suggestion_request");
        }
        suggestionQuery=body.query; suggestionKind=body.kind as string ?? null;
      } else input=parseSearchV2Request(body);
      const client=await dailySearchClientKey(searchClientAddress(request),options.secret,now);
      const needsCatalog=operation==="search" && (!cached || expires<=now.getTime());
      const prepared=await deps.prepare(client,needsCatalog,operation) as {
        rateLimit: unknown; catalog: unknown; indexVersion: string;
      };
      const rate=parseSearchRateLimitDecision(prepared.rateLimit);
      if (!rate.allowed) {headers.set("Retry-After",String(rate.retryAfterSeconds));throw new SearchHttpError(429,"rate_limited");}
      if (typeof prepared.indexVersion!=="string") throw new Error("invalid_index_version");
      if (operation==="suggest") return reply({suggestions:parseSearchSuggestions(await deps.suggest(suggestionQuery,suggestionKind))});
      if (!input) throw new Error("missing_request");
      if (needsCatalog) {cached=parseEntityCatalog(prepared.catalog);expires=now.getTime()+60_000;}
      if (!cached) throw new Error("missing_catalog");
      const interpreted=interpretV2(input,cached,now.getUTCFullYear());
      const {plan,facets,ambiguity}=interpreted;
      const sort=input.sort ?? (plan.topic ? "relevance" : "newest");
      const binding=await searchBinding(input,plan);
      const previous=input.cursor ? await openCursor(input.cursor,options.secret,binding,prepared.indexVersion,now.getTime()) : null;
      const snapshot=previous?.snapshot ?? now.toISOString();
      let packed=previous?.vector ?? null;
      mode=plan.topic ? "hybrid" : "filtered";
      if (plan.topic && !/["“”]/u.test(plan.topic) && !ambiguity) {
        if (!previous) {
          // An exhausted provider budget degrades only semantic retrieval. Abuse limits above still apply.
          const budget=parseSearchRateLimitDecision(await deps.reserveTokens(providerTokenReservation(plan.topic)));
          if (budget.allowed) {
            try {packed=packVector(await deps.embed(plan.topic));}
            catch (error) {if (!(error instanceof OpenAIEmbeddingError)) throw error;}
          }
        }
        if (!packed) mode="keyword_fallback";
      }
      const limit=input.limit ?? 20;
      const raw=ambiguity ? {results:[],indexVersion:prepared.indexVersion,semanticCoverage:"complete"} :
        await deps.retrieve({p_topic:plan.topic,p_embedding:packed ? embeddingToHalfvec(unpackVector(packed)) : null,
          p_limit:limit,p_person:plan.politicianId,p_party:plan.party,p_from:plan.dateFrom,p_to:plan.dateTo,
          p_sources:plan.sourceIds,p_sort:sort,p_after:previous?.after ?? null,p_snapshot:snapshot}) as {
          results: (Record<string,unknown> & {_cursor: SearchCursor["after"]})[];
          indexVersion: string; semanticCoverage: SearchV2Response["semanticCoverage"];
        };
      if (!raw || !Array.isArray(raw.results) || raw.indexVersion!==prepared.indexVersion) throw new Error("invalid_retrieval");
      hasMore=raw.results.length>limit;
      const page=raw.results.slice(0,limit);
      const nextCursor=hasMore ? await sealCursor({binding,indexVersion:raw.indexVersion,
        rankingVersion:V2_RANKING_VERSION,snapshot,expires:previous?.expires ?? now.getTime()+CURSOR_TTL_MS,
        after:page.at(-1)!._cursor,vector:packed},options.secret) : null;
      const payload={version:"clip-search-v2",searchVersion:V2_RANKING_VERSION,indexVersion:raw.indexVersion,
        mode,semanticCoverage:raw.semanticCoverage,interpretation:{facets,ambiguity},
        results:page.map(({_cursor,...result})=>result),nextCursor,sort};
      // A malformed database result is a service failure, not the viewer's request error.
      let response: SearchV2Response;
      try {response=parseSearchV2Response(payload);} catch {throw new Error("invalid_search_response");}
      return reply(response);
    } catch (error) {
      if (error instanceof InvalidSearchCursor) return reply({error:"search_cursor_expired"},409);
      if (error instanceof SearchContractError || (error instanceof Error && error.message==="unknown_search_entity")) return reply({error:"invalid_request"},400);
      if (error instanceof SearchHttpError) return reply({error:error.code},error.status);
      return reply({error:"search_unavailable"},503);
    } finally {
      // Never log exception objects, request bodies, cursors, vectors, or viewer identities.
      deps.log({event:"search_v2",status,durationMs:Math.round(performance.now()-start),mode,hasMore,operation});
    }
  };
}
