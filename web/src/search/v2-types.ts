import {
  parseClipSearchResponse, SearchContractError,
  type PartyCode, type SearchFacet, type SearchAmbiguity, type SearchClipResult,
} from "./types.ts";

export type SearchSort = "relevance" | "newest" | "oldest";
export interface SearchFilters {
  person?: string | null;
  party?: PartyCode | null;
  event?: string | null;
  date?: { from: string; to: string } | null;
  topic?: string | null;
}
export interface SearchV2Request {
  query: string;
  filters?: SearchFilters;
  sort?: SearchSort;
  cursor?: string;
  limit?: number;
}
export interface SearchV2Result extends SearchClipResult { matchSource: "clip" | "debate" }
export interface SearchV2Response {
  version: "clip-search-v2";
  searchVersion: string;
  indexVersion: string;
  mode: "hybrid" | "keyword_fallback" | "filtered";
  semanticCoverage: "complete" | "partial" | "none";
  interpretation: { facets: SearchFacet[]; ambiguity: SearchAmbiguity | null };
  results: SearchV2Result[];
  nextCursor: string | null;
  sort: SearchSort;
}
export interface SearchSuggestion {
  kind: "person" | "party" | "event" | "year";
  id: string;
  label: string;
  detail: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTIES = new Set(["S","M","SD","C","V","KD","MP","L","NONE"]);
const SORTS = new Set(["relevance","newest","oldest"]);
function reject(): never { throw new SearchContractError("Invalid search v2 payload"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject();
}
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0,10) === value;
}
export function parseSearchV2Request(value: unknown): SearchV2Request {
  const r = record(value);
  keys(r,["query","filters","sort","cursor","limit"]);
  if (typeof r.query !== "string" || r.query.length>300) reject();
  if (r.sort !== undefined && !SORTS.has(String(r.sort))) reject();
  if (r.limit !== undefined && (!Number.isInteger(r.limit) || Number(r.limit)<1 || Number(r.limit)>40)) reject();
  if (r.cursor !== undefined && (typeof r.cursor !== "string" || r.cursor.length>14000)) reject();
  if (r.filters !== undefined) {
    const f = record(r.filters);
    keys(f,["person","party","event","date","topic"]);
    for (const field of ["person","event"]) {
      if (f[field] !== undefined && f[field] !== null &&
        (typeof f[field] !== "string" || !UUID.test(String(f[field])))) reject();
    }
    if (f.party !== undefined && f.party !== null && !PARTIES.has(String(f.party))) reject();
    if (f.topic !== undefined && f.topic !== null && (typeof f.topic !== "string" || f.topic.length>300)) reject();
    if (f.date !== undefined && f.date !== null) {
      const d=record(f.date); keys(d,["from","to"]);
      if (!date(d.from) || !date(d.to) || d.from>d.to) reject();
    }
  }
  return r as unknown as SearchV2Request;
}
export function parseSearchV2Response(value: unknown): SearchV2Response {
  const r=record(value);
  keys(r,["version","searchVersion","indexVersion","mode","semanticCoverage","interpretation","results","nextCursor","sort"]);
  if (r.version !== "clip-search-v2" || !SORTS.has(String(r.sort)) ||
    !["complete","partial","none"].includes(String(r.semanticCoverage)) ||
    !(r.nextCursor === null || (typeof r.nextCursor === "string" && r.nextCursor.length<=14000)) ||
    !Array.isArray(r.results) || r.results.length>40) reject();
  const results=r.results.map((item: unknown) => {
    const result=record(item);
    if (result.matchSource !== "clip" && result.matchSource !== "debate") reject();
    const { matchSource: _, ...old }=result;
    return old;
  });
  parseClipSearchResponse({mode:r.mode,searchVersion:r.searchVersion,indexVersion:r.indexVersion,
    interpretation:r.interpretation,event:null,results});
  return r as unknown as SearchV2Response;
}
export function parseSearchSuggestions(value: unknown): SearchSuggestion[] {
  if (!Array.isArray(value) || value.length>12) reject();
  return value.map((item: unknown) => {
    const r=record(item); keys(r,["kind","id","label","detail"]);
    if (!["person","party","event","year"].includes(String(r.kind)) ||
      [r.id,r.label,r.detail].some(v=>typeof v!=="string") ||
      String(r.label).length>240 || String(r.detail).length>240) reject();
    return r as unknown as SearchSuggestion;
  });
}
