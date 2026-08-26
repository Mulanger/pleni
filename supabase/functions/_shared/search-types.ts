/**
 * Public topic-search contract shared by the browser and Edge Functions.
 *
 * Keep both contract copies byte-identical. The dependency-free contract test
 * compares this file with `web/src/search/types.ts` and then runs the same
 * fixtures through each module, so browser/backend drift fails before deploy.
 */

export const SEARCH_CONTRACT_VERSION = "clip-search-v1" as const;

export type DisabledSearchFacet = "person" | "party" | "event" | "date";
export type PartyCode = "S" | "M" | "SD" | "C" | "V" | "KD" | "MP" | "L" | "NONE";
export type SearchMode = "hybrid" | "keyword_fallback" | "filtered";
export type SearchMatchKind = "keyword" | "context" | "both" | "filtered";

export interface ClipSearchRequest {
  query: string;
  limit?: number;
  disabledFacets?: DisabledSearchFacet[];
}

export type SearchFacet =
  | {
      kind: "person";
      key: "person";
      label: string;
      politicianId: string;
      removable: true;
    }
  | {
      kind: "party";
      key: "party";
      label: string;
      party: PartyCode;
      removable: true;
    }
  | {
      kind: "event";
      key: "event";
      label: string;
      eventId: string;
      removable: true;
    }
  | {
      kind: "date";
      key: "date";
      label: string;
      from: string;
      to: string;
      removable: true;
    }
  | {
      kind: "topic";
      key: "topic";
      label: string;
      removable: true;
    };

export interface SearchAmbiguityOption {
  id: string;
  label: string;
  detail: string;
}

export interface SearchAmbiguity {
  kind: "person" | "event";
  message: string;
  options: SearchAmbiguityOption[];
}

export interface SearchEventDestination {
  id: string;
  label: string;
  dateLabel: string;
  sourceUrl: string | null;
  clipCount: number;
}

export interface SearchDateBroadening {
  kind: "date";
  label: string;
  from: string;
  to: string;
}

/** Structurally mirrors the public `ClipItem` consumed by the existing feed. */
export interface SearchClipPayload {
  id: string;
  speechId: string;
  politicianId: string | null;
  politicianName: string | null;
  politicianRole: string | null;
  politicianAvatarUrl: string | null;
  speakerName: string;
  party: PartyCode;
  anforandetyp: string;
  archetype: string;
  title: string;
  transcript: string;
  topic: string | null;
  durationS: number;
  videoUrl: string;
  thumbUrl: string;
  sourceTitle: string;
  sourceUrl: string;
  debateDate: string;
  publishedAt: string | null;
  rank: number;
  isSample: boolean;
  recommendationReason?: string;
  recommendationReasonCode?: string;
  feedRequestId?: string;
  feedItemId?: string;
  feedPosition?: number;
}

export interface SearchClipResult {
  clip: SearchClipPayload;
  speakerNameAtSpeech: string;
  partyAtSpeech: PartyCode;
  matchExcerpt: string;
  matchKind: SearchMatchKind;
}

export interface ClipSearchResponse {
  mode: SearchMode;
  searchVersion: string;
  indexVersion: string;
  interpretation: {
    facets: SearchFacet[];
    ambiguity: SearchAmbiguity | null;
  };
  event: SearchEventDestination | null;
  results: SearchClipResult[];
  dateBroadening?: SearchDateBroadening | null;
}

type JsonObject = Record<string, unknown>;

const DISABLED_FACETS = new Set<DisabledSearchFacet>(["person", "party", "event", "date"]);
const PARTY_CODES = new Set<PartyCode>(["S", "M", "SD", "C", "V", "KD", "MP", "L", "NONE"]);
const SEARCH_MODES = new Set<SearchMode>(["hybrid", "keyword_fallback", "filtered"]);
const MATCH_KINDS = new Set<SearchMatchKind>(["keyword", "context", "both", "filtered"]);
const FACET_KINDS = new Set<SearchFacet["kind"]>(["person", "party", "event", "date", "topic"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HTML_TAG = /<\/?[a-z][^>]*>/i;

export class SearchContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchContractError";
  }
}

function fail(path: string, expectation: string): never {
  throw new SearchContractError(`${path} ${expectation}`);
}

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${path}.${key}`, "is required");
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${path}.${key}`, "is not part of the contract");
    }
  }
}

function stringAt(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(path, allowEmpty ? "must be a string" : "must be a non-empty string");
  }
  return value;
}

function nullableStringAt(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringAt(value, path);
}

function finiteNumberAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "must be a finite number");
  }
  return value;
}

function nonNegativeIntegerAt(value: unknown, path: string): number {
  const number = finiteNumberAt(value, path);
  if (!Number.isInteger(number) || number < 0) fail(path, "must be a non-negative integer");
  return number;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function partyAt(value: unknown, path: string): PartyCode {
  const party = stringAt(value, path) as PartyCode;
  if (!PARTY_CODES.has(party)) fail(path, "must be a supported party code");
  return party;
}

function isoDateAt(value: unknown, path: string): string {
  const date = stringAt(value, path);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !ISO_DATE.test(date) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    fail(path, "must be an ISO calendar date");
  }
  return date;
}

export function parseClipSearchRequest(value: unknown): ClipSearchRequest {
  const request = objectAt(value, "request");
  exactKeys(request, ["query"], ["limit", "disabledFacets"], "request");

  const query = stringAt(request.query, "request.query").trim();
  if (query.length < 2 || query.length > 120) {
    fail("request.query", "must contain 2–120 characters after trimming");
  }

  const parsed: ClipSearchRequest = { query };
  if (request.limit !== undefined) {
    const limit = finiteNumberAt(request.limit, "request.limit");
    if (!Number.isInteger(limit)) fail("request.limit", "must be an integer");
    parsed.limit = Math.min(60, Math.max(1, limit));
  }

  if (request.disabledFacets !== undefined) {
    const facets = arrayAt(request.disabledFacets, "request.disabledFacets");
    const unique = new Set<DisabledSearchFacet>();
    for (const [index, rawFacet] of facets.entries()) {
      const facet = stringAt(rawFacet, `request.disabledFacets[${index}]`) as DisabledSearchFacet;
      if (!DISABLED_FACETS.has(facet)) {
        fail(`request.disabledFacets[${index}]`, "must be person, party, event or date");
      }
      if (unique.has(facet)) fail("request.disabledFacets", "must not contain duplicates");
      unique.add(facet);
    }
    parsed.disabledFacets = [...unique];
  }

  return parsed;
}

function validateFacet(value: unknown, index: number): SearchFacet["kind"] {
  const path = `response.interpretation.facets[${index}]`;
  const facet = objectAt(value, path);
  const kind = stringAt(facet.kind, `${path}.kind`) as SearchFacet["kind"];
  if (!FACET_KINDS.has(kind)) fail(`${path}.kind`, "is unsupported");

  const common = ["kind", "key", "label", "removable"];
  const extra = kind === "person" ? "politicianId" : kind === "party" ? "party" : kind === "event" ? "eventId" : null;
  const dateKeys = kind === "date" ? ["from", "to"] : [];
  exactKeys(facet, [...common, ...(extra ? [extra] : []), ...dateKeys], [], path);
  if (facet.key !== kind) fail(`${path}.key`, "must equal kind");
  stringAt(facet.label, `${path}.label`);
  if (facet.removable !== true) fail(`${path}.removable`, "must be true");

  if (kind === "person") stringAt(facet.politicianId, `${path}.politicianId`);
  if (kind === "party") partyAt(facet.party, `${path}.party`);
  if (kind === "event") stringAt(facet.eventId, `${path}.eventId`);
  if (kind === "date") {
    const from = isoDateAt(facet.from, `${path}.from`);
    const to = isoDateAt(facet.to, `${path}.to`);
    if (from > to) fail(path, "must have from on or before to");
  }
  return kind;
}

function validateAmbiguity(value: unknown): void {
  if (value === null) return;
  const path = "response.interpretation.ambiguity";
  const ambiguity = objectAt(value, path);
  exactKeys(ambiguity, ["kind", "message", "options"], [], path);
  if (ambiguity.kind !== "person" && ambiguity.kind !== "event") {
    fail(`${path}.kind`, "must be person or event");
  }
  stringAt(ambiguity.message, `${path}.message`);
  const options = arrayAt(ambiguity.options, `${path}.options`);
  if (options.length < 2) fail(`${path}.options`, "must contain at least two choices");
  const ids = new Set<string>();
  for (const [index, rawOption] of options.entries()) {
    const optionPath = `${path}.options[${index}]`;
    const option = objectAt(rawOption, optionPath);
    exactKeys(option, ["id", "label", "detail"], [], optionPath);
    const id = stringAt(option.id, `${optionPath}.id`);
    if (ids.has(id)) fail(`${path}.options`, "must use unique ids");
    ids.add(id);
    stringAt(option.label, `${optionPath}.label`);
    stringAt(option.detail, `${optionPath}.detail`);
  }
}

function validateEvent(value: unknown): void {
  if (value === null) return;
  const path = "response.event";
  const event = objectAt(value, path);
  exactKeys(event, ["id", "label", "dateLabel", "sourceUrl", "clipCount"], [], path);
  stringAt(event.id, `${path}.id`);
  stringAt(event.label, `${path}.label`);
  stringAt(event.dateLabel, `${path}.dateLabel`);
  nullableStringAt(event.sourceUrl, `${path}.sourceUrl`);
  nonNegativeIntegerAt(event.clipCount, `${path}.clipCount`);
}

function validateDateBroadening(value: unknown): void {
  if (value === undefined || value === null) return;
  const path = "response.dateBroadening";
  const broadening = objectAt(value, path);
  exactKeys(broadening, ["kind", "label", "from", "to"], [], path);
  if (broadening.kind !== "date") fail(`${path}.kind`, "must be date");
  stringAt(broadening.label, `${path}.label`);
  const from = isoDateAt(broadening.from, `${path}.from`);
  const to = isoDateAt(broadening.to, `${path}.to`);
  if (from > to) fail(path, "must have from on or before to");
}

function validateClip(value: unknown, path: string): void {
  const clip = objectAt(value, path);
  const required = [
    "id", "speechId", "politicianId", "politicianName", "politicianRole",
    "politicianAvatarUrl", "speakerName", "party", "anforandetyp", "archetype",
    "title", "transcript", "topic", "durationS", "videoUrl", "thumbUrl",
    "sourceTitle", "sourceUrl", "debateDate", "publishedAt", "rank", "isSample",
  ];
  const optional = [
    "recommendationReason", "recommendationReasonCode", "feedRequestId",
    "feedItemId", "feedPosition",
  ];
  exactKeys(clip, required, optional, path);

  for (const key of ["id", "speechId", "speakerName", "anforandetyp", "archetype", "title", "transcript", "videoUrl", "thumbUrl", "sourceTitle", "sourceUrl"] as const) {
    stringAt(clip[key], `${path}.${key}`, key === "transcript");
  }
  for (const key of ["politicianId", "politicianName", "politicianRole", "politicianAvatarUrl", "topic", "publishedAt"] as const) {
    nullableStringAt(clip[key], `${path}.${key}`);
  }
  partyAt(clip.party, `${path}.party`);
  isoDateAt(clip.debateDate, `${path}.debateDate`);
  const duration = finiteNumberAt(clip.durationS, `${path}.durationS`);
  if (duration < 0) fail(`${path}.durationS`, "must not be negative");
  finiteNumberAt(clip.rank, `${path}.rank`);
  booleanAt(clip.isSample, `${path}.isSample`);
  for (const key of ["recommendationReason", "recommendationReasonCode", "feedRequestId", "feedItemId"] as const) {
    if (clip[key] !== undefined) stringAt(clip[key], `${path}.${key}`);
  }
  if (clip.feedPosition !== undefined) nonNegativeIntegerAt(clip.feedPosition, `${path}.feedPosition`);
}

function validateResult(value: unknown, index: number): void {
  const path = `response.results[${index}]`;
  const result = objectAt(value, path);
  exactKeys(result, ["clip", "speakerNameAtSpeech", "partyAtSpeech", "matchExcerpt", "matchKind"], [], path);
  validateClip(result.clip, `${path}.clip`);
  stringAt(result.speakerNameAtSpeech, `${path}.speakerNameAtSpeech`);
  partyAt(result.partyAtSpeech, `${path}.partyAtSpeech`);
  const excerpt = stringAt(result.matchExcerpt, `${path}.matchExcerpt`, true);
  if (excerpt.length > 220) fail(`${path}.matchExcerpt`, "must be at most 220 characters");
  if (HTML_TAG.test(excerpt)) fail(`${path}.matchExcerpt`, "must be plain text");
  const matchKind = stringAt(result.matchKind, `${path}.matchKind`) as SearchMatchKind;
  if (!MATCH_KINDS.has(matchKind)) fail(`${path}.matchKind`, "is unsupported");
}

export function parseClipSearchResponse(value: unknown): ClipSearchResponse {
  const response = objectAt(value, "response");
  exactKeys(response, ["mode", "searchVersion", "indexVersion", "interpretation", "event", "results"], ["dateBroadening"], "response");
  const mode = stringAt(response.mode, "response.mode") as SearchMode;
  if (!SEARCH_MODES.has(mode)) fail("response.mode", "is unsupported");
  stringAt(response.searchVersion, "response.searchVersion");
  stringAt(response.indexVersion, "response.indexVersion");

  const interpretation = objectAt(response.interpretation, "response.interpretation");
  exactKeys(interpretation, ["facets", "ambiguity"], [], "response.interpretation");
  const facets = arrayAt(interpretation.facets, "response.interpretation.facets");
  const kinds = new Set<SearchFacet["kind"]>();
  for (const [index, facet] of facets.entries()) {
    const kind = validateFacet(facet, index);
    if (kinds.has(kind)) fail("response.interpretation.facets", "must not repeat a facet kind");
    kinds.add(kind);
  }
  validateAmbiguity(interpretation.ambiguity);
  validateEvent(response.event);
  validateDateBroadening(response.dateBroadening);

  const results = arrayAt(response.results, "response.results");
  if (results.length > 60) fail("response.results", "must contain at most 60 clips");
  for (const [index, result] of results.entries()) validateResult(result, index);

  return response as unknown as ClipSearchResponse;
}
