import type {
  ClipSearchRequest,
  PartyCode,
  SearchAmbiguity,
  SearchFacet,
} from "../search-types.ts";

export const SEARCH_INTERPRETER_VERSION = "search-interpret-v2" as const;
export const PERSON_FUZZY_MIN_SCORE = 0.88;
export const PERSON_FUZZY_MIN_MARGIN = 0.08;

export interface SearchEntityAlias {
  value: string;
  verified: boolean;
  provenance?: string;
}

export interface SearchPersonEntity {
  id: string;
  label: string;
  party: PartyCode;
  partyLabel?: string;
  aliases: SearchEntityAlias[];
}

export interface SearchPartyEntity {
  party: Exclude<PartyCode, "NONE">;
  label: string;
  aliases: string[];
}

export interface SearchEventEntity {
  id: string;
  label: string;
  dateFrom: string | null;
  dateTo: string | null;
  dateLabel?: string;
  verified: boolean;
  aliases: SearchEntityAlias[];
  sourceIds: string[];
}

export interface SearchEntityCatalog {
  people: SearchPersonEntity[];
  events: SearchEventEntity[];
  parties?: SearchPartyEntity[];
}

export type ConsumedFacetKind = "person" | "party" | "event" | "date";

export interface ConsumedSearchSpan {
  kind: ConsumedFacetKind;
  start: number;
  end: number;
  text: string;
}

export interface InterpretedSearchPlan {
  version: typeof SEARCH_INTERPRETER_VERSION;
  originalQuery: string;
  displayQuery: string;
  topic: string | null;
  politicianId: string | null;
  party: PartyCode | null;
  eventId: string | null;
  sourceIds: string[] | null;
  dateFrom: string | null;
  dateTo: string | null;
  hasRetrievalAnchor: boolean;
  fallback: boolean;
  consumedSpans: ConsumedSearchSpan[];
}

export interface SearchInterpretationResult {
  facets: SearchFacet[];
  ambiguity: SearchAmbiguity | null;
  plan: InterpretedSearchPlan;
}

export type SearchInterpretationRequest = Pick<
  ClipSearchRequest,
  "query" | "disabledFacets"
>;

export interface TextSpan {
  start: number;
  end: number;
}

export interface SearchToken extends TextSpan {
  text: string;
  normalized: string;
  folded: string;
  index: number;
}

export interface DateInterpretation extends TextSpan {
  label: string;
  from: string;
  to: string;
}
