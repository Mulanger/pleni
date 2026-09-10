import type { SearchV2Request } from "../search-v2-types.ts";
import type { SearchFacet } from "../search-types.ts";
import { interpretSearchQuery, DEFAULT_SEARCH_PARTIES } from "./interpret.ts";
import { normalizeSearchDisplay } from "./normalize.ts";
import type { SearchEntityCatalog, SearchInterpretationResult } from "./types.ts";

/** Interpret once, consume recognized spans, then apply explicit overrides. */
export function interpretV2(request: SearchV2Request, catalog: SearchEntityCatalog,
  year: number): SearchInterpretationResult {
  catalog={...catalog,people:catalog.people.map(person=>({...person,
    aliases:[...person.aliases,{value:person.label,verified:true}]}))};
  const display=normalizeSearchDisplay(request.query).replace(/[“”]/gu,'"');
  // Private-use characters preserve UTF-16 offsets without creating entity tokens.
  const masked=display.replace(/"[^"\n]*"/gu,(quote)=>"\uE000".repeat(quote.length));
  let result=interpretSearchQuery({query:masked},catalog,year);
  const f=request.filters ?? {};
  if (result.ambiguity?.kind === "person" && f.person) {
    result=interpretSearchQuery({query:masked},{...catalog,people:catalog.people.filter(p=>p.id===f.person)},year);
  }
  if (result.ambiguity?.kind === "event" && f.event) {
    result=interpretSearchQuery({query:masked},{...catalog,events:catalog.events.filter(e=>e.id===f.event)},year);
  }
  const plan={...result.plan,originalQuery:request.query,displayQuery:display};
  let remaining=display;
  for (const span of [...plan.consumedSpans].sort((a,b)=>b.start-a.start)) {
    remaining=remaining.slice(0,span.start)+" "+remaining.slice(span.end);
  }
  // V1 trims punctuation at both ends; that would remove an opening quote.
  plan.topic=f.topic !== undefined ? f.topic : remaining.replace(/\s+/gu," ").trim() || null;
  if (f.person !== undefined) plan.politicianId=f.person;
  if (f.party !== undefined) plan.party=f.party;
  if (f.event !== undefined) plan.eventId=f.event;
  if (f.date !== undefined) {plan.dateFrom=f.date?.from ?? null;plan.dateTo=f.date?.to ?? null;}
  const person=catalog.people.find(p=>p.id===plan.politicianId);
  const party=(catalog.parties ?? [...DEFAULT_SEARCH_PARTIES]).find(p=>p.party===plan.party);
  const event=catalog.events.find(e=>e.id===plan.eventId && e.verified);
  if ((plan.politicianId && !person) || (plan.eventId && !event)) throw new Error("unknown_search_entity");
  plan.sourceIds=event?.sourceIds ?? null;
  plan.hasRetrievalAnchor=Boolean(plan.topic || plan.politicianId || plan.party || plan.eventId || plan.dateFrom);
  const facets: SearchFacet[]=[];
  if (person) facets.push({kind:"person",key:"person",label:person.label,politicianId:person.id,removable:true});
  if (plan.party) facets.push({kind:"party",key:"party",label:party?.label ?? "Partilös",party:plan.party,removable:true});
  if (event) facets.push({kind:"event",key:"event",label:event.label,eventId:event.id,removable:true});
  if (plan.dateFrom && plan.dateTo) {
    const original=result.facets.find(facet=>facet.kind==="date");
    const label=f.date === undefined && original ? original.label :
      plan.dateFrom.endsWith("-01-01") && plan.dateTo===`${plan.dateFrom.slice(0,4)}-12-31`
        ? plan.dateFrom.slice(0,4) : `${plan.dateFrom}–${plan.dateTo}`;
    facets.push({kind:"date",key:"date",label,from:plan.dateFrom,to:plan.dateTo,removable:true});
  }
  if (plan.topic) facets.push({kind:"topic",key:"topic",label:plan.topic,removable:true});
  const ambiguity=result.ambiguity && f[result.ambiguity.kind]===undefined ? result.ambiguity : null;
  return {plan,facets,ambiguity};
}
