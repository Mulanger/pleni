import type {
  ClipSearchResponse,
  DisabledSearchFacet,
  PartyCode,
  SearchDateBroadening,
  SearchFacet
} from "./types";

export const TOPIC_SEARCH_RESULT_LIMIT = 60;
export const TOPIC_SEARCH_REVEAL_SIZE = 20;

export type TopicSearchPhase = "idle" | "loading" | "success" | "error";

export interface TopicSearchState {
  phase: TopicSearchPhase;
  submittedInput: string;
  requestQuery: string;
  disabledFacets: DisabledSearchFacet[];
  response: ClipSearchResponse | null;
  revealedCount: number;
  scrollTop: number;
  errorKind: string | null;
}

export const EMPTY_TOPIC_SEARCH_STATE: TopicSearchState = {
  phase: "idle",
  submittedInput: "",
  requestQuery: "",
  disabledFacets: [],
  response: null,
  revealedCount: TOPIC_SEARCH_REVEAL_SIZE,
  scrollTop: 0,
  errorKind: null
};

const FACET_ORDER: Record<SearchFacet["kind"], number> = {
  person: 0,
  party: 1,
  event: 2,
  topic: 3,
  date: 4
};

const FACET_PREFIX: Record<SearchFacet["kind"], string> = {
  person: "Person",
  party: "Parti",
  event: "Händelse",
  topic: "Ämne",
  date: "Datum"
};

export function beginTopicSearch(
  previous: TopicSearchState,
  submittedInput: string,
  requestQuery: string,
  disabledFacets: readonly DisabledSearchFacet[]
): TopicSearchState {
  return {
    ...previous,
    phase: "loading",
    submittedInput: submittedInput.trim(),
    requestQuery: requestQuery.trim(),
    disabledFacets: uniqueDisabledFacets(disabledFacets),
    scrollTop: 0,
    errorKind: null
  };
}

export function completeTopicSearch(
  previous: TopicSearchState,
  response: ClipSearchResponse
): TopicSearchState {
  return {
    ...previous,
    phase: "success",
    response,
    revealedCount: TOPIC_SEARCH_REVEAL_SIZE,
    errorKind: null
  };
}

export function failTopicSearch(
  previous: TopicSearchState,
  errorKind: string
): TopicSearchState {
  return {
    ...previous,
    phase: "error",
    errorKind
  };
}

export function revealMoreTopicResults(previous: TopicSearchState): TopicSearchState {
  const total = previous.response?.results.length ?? 0;
  return {
    ...previous,
    revealedCount: Math.min(total, previous.revealedCount + TOPIC_SEARCH_REVEAL_SIZE)
  };
}

export function rememberTopicSearchScroll(
  previous: TopicSearchState,
  scrollTop: number
): TopicSearchState {
  return {
    ...previous,
    scrollTop: Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0
  };
}

export function sortedSearchFacets(facets: readonly SearchFacet[]): SearchFacet[] {
  return [...facets].sort((left, right) => FACET_ORDER[left.kind] - FACET_ORDER[right.kind]);
}

export function visibleFacetLabel(facet: SearchFacet): string {
  return `${FACET_PREFIX[facet.kind]} · ${facet.label}`;
}

export function addDisabledFacet(
  current: readonly DisabledSearchFacet[],
  facet: Exclude<SearchFacet["kind"], "topic">
): DisabledSearchFacet[] {
  return uniqueDisabledFacets([...current, facet]);
}

export function buildTopicRequestQuery(
  input: string,
  party: PartyCode | null,
  partyLabel: string | null
): string {
  const normalizedInput = input.trim();
  if (party === null || party === "NONE") {
    return normalizedInput;
  }
  const normalizedParty = (partyLabel || party).trim();
  return [normalizedParty, normalizedInput].filter(Boolean).join(" ");
}

export function identityQueryAfterTopicRemoval(facets: readonly SearchFacet[]): string {
  return sortedSearchFacets(facets)
    .filter((facet) => facet.kind === "person")
    .map((facet) => facet.label)
    .join(" ");
}

export function partyAfterTopicRemoval(facets: readonly SearchFacet[]): PartyCode | null {
  const party = facets.find((facet): facet is Extract<SearchFacet, { kind: "party" }> =>
    facet.kind === "party"
  );
  return party?.party ?? null;
}

export function topicResultHeading(facets: readonly SearchFacet[]): string {
  const sorted = sortedSearchFacets(facets);
  const topic = sorted.find((facet) => facet.kind === "topic");
  const date = sorted.find((facet) => facet.kind === "date");
  if (topic && date) {
    return `Klipp om ${topic.label} från ${date.label}`;
  }
  if (topic) {
    return `Klipp om ${topic.label}`;
  }
  if (date) {
    return `Klipp från ${date.label}`;
  }
  return "Relevanta klipp";
}

export function dateBroadeningNotice(broadening: SearchDateBroadening): string {
  const requestedPeriod = broadening.from === broadening.to
    ? `den ${broadening.label}`
    : `under ${broadening.label}`;
  return `Inga relevanta klipp hittades ${requestedPeriod}. Visar relevanta klipp från andra datum.`;
}

export function topicSearchErrorMessage(kind: string | null): string {
  if (kind === "rate_limited") {
    return "Många söker samtidigt. Vänta en kort stund och försök igen.";
  }
  if (kind === "not_configured") {
    return "Ämnessökningen är inte tillgänglig i den här versionen.";
  }
  return "Ämnessökningen kunde inte slutföras. Politiker och partier fungerar fortfarande.";
}

function uniqueDisabledFacets(
  facets: readonly DisabledSearchFacet[]
): DisabledSearchFacet[] {
  const order: DisabledSearchFacet[] = ["person", "party", "event", "date"];
  const values = new Set(facets);
  return order.filter((facet) => values.has(facet));
}
