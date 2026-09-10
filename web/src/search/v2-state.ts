import type { TopicSearchState } from "./state";
import type { SearchFilters, SearchV2Request, SearchV2Response } from "./v2-types";
import type { SearchFacet } from "./types";

/** Canonicalize the applied interpretation before changing/removing one filter. */
export function appliedFilters(response: SearchV2Response): SearchFilters {
  const filters: SearchFilters={person:null,party:null,event:null,date:null,topic:null};
  for (const facet of response.interpretation.facets) {
    if (facet.kind==="person") filters.person=facet.politicianId;
    if (facet.kind==="party") filters.party=facet.party;
    if (facet.kind==="event") filters.event=facet.eventId;
    if (facet.kind==="date") filters.date={from:facet.from,to:facet.to};
    if (facet.kind==="topic") filters.topic=facet.label;
  }
  return filters;
}
export function changeSearchFilter(request: SearchV2Request,response: SearchV2Response|null,
  kind: SearchFacet["kind"],value: SearchFilters[SearchFacet["kind"]]): SearchV2Request {
  const filters=response && !response.interpretation.ambiguity ? appliedFilters(response) : {...request.filters};
  return {...request,cursor:undefined,filters:{...filters,[kind]:value}};
}
export function completeV2(previous: TopicSearchState,request: SearchV2Request,response: SearchV2Response,
  append: boolean): TopicSearchState {
  const results=append ? [...(previous.v2Response?.results ?? [])] : [];
  const ids=new Set(results.map(r=>r.clip.id));
  for (const result of response.results) if (!ids.has(result.clip.id)) {results.push(result);ids.add(result.clip.id);}
  const merged={...response,results};
  return {...previous,phase:"success",submittedInput:request.query,requestQuery:request.query,
    v2Request:{...request,cursor:undefined},v2Response:merged,
    response:{...merged,event:null,dateBroadening:null},revealedCount:results.length,errorKind:null,
    scrollTop:append ? previous.scrollTop : 0};
}
export function searchErrorText(kind: string|null): string {
  if (kind==="network") return "Det går inte att nå sökningen. Kontrollera anslutningen och försök igen.";
  if (kind==="rate_limited") return "Många söker samtidigt. Vänta en kort stund och försök igen.";
  if (kind==="cursor_expired") return "Resultatlistan behöver uppdateras. Gör sökningen igen för att fortsätta.";
  return "Sökningen är tillfälligt otillgänglig. Försök igen om en stund.";
}
