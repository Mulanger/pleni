import { SearchResults } from "./SearchResults";
import { useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Search, X, SlidersHorizontal, LoaderCircle, Play } from "lucide-react";
import { archiveSearch } from "../supabase";
import { PARTIES } from "../data";
import type { PartyCode, PartyProfile } from "../types";
import type { TopicSearchState } from "./state";
import { topicResultHeading, visibleFacetLabel } from "./state";
import { SearchV2ApiError } from "./v2-api";
import { changeSearchFilter, completeV2, searchErrorText } from "./v2-state";
import type { SearchFilters, SearchSort, SearchSuggestion, SearchV2Request, SearchV2Response, SearchV2Result } from "./v2-types";
import "./search-v2.css";

export interface SearchExperienceProps {
  presentation?: "mobile" | "desktop";
  query: string; setQuery: (value: string)=>void;
  partyFilter: PartyCode|null; setPartyFilter: (value: PartyCode|null)=>void;
  partyProfiles: PartyProfile[]; partyProfilesLoading: boolean;
  topicState: TopicSearchState; setTopicState: Dispatch<SetStateAction<TopicSearchState>>;
  topicSearchAvailable: boolean;
  onOpenPerson: (id: string)=>void; onOpenParty: (party: PartyCode)=>void;
  onOpenTopicFeed: (id: string|null, scrollTop: number)=>void;
}

/** One mounted search surface; the submitted state stays in App during playback. */
export function SearchExperience({presentation="mobile",query,setQuery,partyFilter,setPartyFilter,
  partyProfiles,topicState,setTopicState,onOpenTopicFeed}: SearchExperienceProps) {
  const request=topicState.v2Request ?? {query:"",filters:partyFilter ? {party:partyFilter} : {}};
  const response=topicState.v2Response ?? null;
  const [busy,setBusy]=useState(false);
  const [moreBusy,setMoreBusy]=useState(false);
  const [focused,setFocused]=useState(false);
  const [suggestions,setSuggestions]=useState<SearchSuggestion[]>([]);
  const [suggestionError,setSuggestionError]=useState(false);
  const [selected,setSelected]=useState(-1);
  const [years,setYears]=useState<SearchSuggestion[]>([]);
  const [filtersOpen,setFiltersOpen]=useState(false);
  const controller=useRef<AbortController|null>(null);
  const sequence=useRef(0);
  const scroll=useRef<HTMLDivElement|null>(null);
  const input=useRef<HTMLInputElement|null>(null);
  const listId=useId();
  const facets=response?.interpretation.facets ?? [];
  const visibleResponse=topicState.phase==="success" ? response : null;
  const showSuggestions=focused && suggestions.length>0 && query.trim().length>0;

  useLayoutEffect(()=>{if (scroll.current) scroll.current.scrollTop=topicState.scrollTop;},[]);
  useEffect(()=>()=>{controller.current?.abort();},[]);
  useEffect(()=>{
    const pending=new AbortController();
    archiveSearch.suggest("","year",pending.signal).then(setYears).catch(()=>{});
    return ()=>pending.abort();
  },[]);
  useEffect(()=>{
    setSelected(-1);setSuggestions([]);setSuggestionError(false);
    if (!focused || !query.trim()) return;
    const pending=new AbortController();
    const timer=window.setTimeout(()=>{
      archiveSearch.suggest(query,undefined,pending.signal).then(rows=>{
        if (!pending.signal.aborted) setSuggestions(rows);
      }).catch(()=>{if (!pending.signal.aborted) setSuggestionError(true);});
    },200);
    return ()=>{window.clearTimeout(timer);pending.abort();};
  },[query,focused]);

  function submit(next: SearchV2Request, append=false) {
    controller.current?.abort();const pending=new AbortController();controller.current=pending;
    const id=++sequence.current;
    setBusy(!append);setMoreBusy(append);setFocused(false);setSuggestions([]);
    if (!append) scroll.current?.scrollTo({top:0});
    setTopicState(current=>({...current,phase:append ? "success" : "loading",v2Request:{...next,cursor:undefined},
      submittedInput:next.query,errorKind:null,scrollTop:append ? current.scrollTop : 0}));
    archiveSearch.search(next,pending.signal).then(page=>{
      if (!pending.signal.aborted && id===sequence.current) setTopicState(current=>completeV2(current,next,page,append));
    }).catch((error: unknown)=>{
      if (!pending.signal.aborted && id===sequence.current) setTopicState(current=>({...current,
        phase:append ? "success" : "error",errorKind:error instanceof SearchV2ApiError ? error.kind : "network"}));
    }).finally(()=>{if (id===sequence.current) {setBusy(false);setMoreBusy(false);}});
  }
  function submitInput() {
    const filters={...request.filters};
    if (query!==request.query) {
      // A newly typed query resets removed automatic interpretations. Positive manual choices remain.
      for (const key of Object.keys(filters) as (keyof SearchFilters)[]) if (filters[key]===null) delete filters[key];
      delete filters.topic;
    }
    submit({...request,query,cursor:undefined,filters});
  }
  function change(kind: keyof SearchFilters,value: SearchFilters[keyof SearchFilters]) {
    const sameInput=request.query===query;
    const base=sameInput ? request : {...request,query,filters:{...request.filters,topic:undefined}};
    const next=changeSearchFilter(base,sameInput ? response : null,kind,value);
    if (kind==="party") setPartyFilter(value as PartyCode|null);
    submit(next);
  }
  function choose(suggestion: SearchSuggestion,fromMain=false) {
    const kind=suggestion.kind==="year" ? "date" : suggestion.kind;
    const value=suggestion.kind==="year" ? {from:`${suggestion.id}-01-01`,to:`${suggestion.id}-12-31`} : suggestion.id;
    if (fromMain) {
      // The whole typed suggestion prefix is consumed; it must not become an extra topic.
      setQuery("");
      submit({query:"",filters:{...request.filters,topic:undefined,[kind]:value},sort:request.sort});
    } else change(kind,value as SearchFilters[keyof SearchFilters]);
  }
  function play(id: string|null) {onOpenTopicFeed(id,scroll.current?.scrollTop ?? 0);}

  return <section className={`panel-screen search-screen search-v2 ${presentation} ${presentation==="desktop" ? "search-screen--desktop" : ""} ${response ? "has-results" : ""}`}>
    <header className="search-header"><h1>Sök i klipparkivet</h1><p>Hitta orden, personen eller debatten du minns.</p></header>
    <form className="search-form" role="search" onSubmit={event=>{event.preventDefault();submitInput();}}>
      <div className="v2-input-wrap">
        <div className="search-box"><Search size={19} aria-hidden="true" />
          <input ref={input} value={query} maxLength={300} autoComplete="off" spellCheck={false}
            aria-label="Sök i klippen" placeholder="Namn, ämne, citat eller år" role="combobox"
            aria-autocomplete="list" aria-expanded={showSuggestions} aria-controls={listId}
            aria-activedescendant={showSuggestions && selected>=0 ? `${listId}-${selected}` : undefined}
            onChange={event=>{setQuery(event.target.value);setFocused(true);}}
            onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
            onKeyDown={event=>{
              if (event.key==="Escape") {setFocused(false);setSelected(-1);}
              if (showSuggestions && ["ArrowDown","ArrowUp"].includes(event.key)) {
                event.preventDefault();setSelected(current=>(current+(event.key==="ArrowDown" ? 1 : -1)+suggestions.length)%suggestions.length);
              }
              if (showSuggestions && event.key==="Enter" && selected>=0) {event.preventDefault();choose(suggestions[selected],true);}
            }} />
          {query && <button className="search-clear" type="button" aria-label="Rensa söktexten" onClick={()=>{setQuery("");input.current?.focus();}}><X size={16}/></button>}
          <button className="search-submit" type="submit" disabled={busy}>Sök</button>
        </div>
        {showSuggestions && <ul id={listId} className="v2-suggestions" role="listbox" aria-label="Sökförslag">
          {suggestions.map((row,index)=><li key={`${row.kind}-${row.id}`} role="option" aria-selected={index===selected} id={`${listId}-${index}`}>
            <button type="button" tabIndex={-1} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(row,true)}>
              <span>{row.label}</span><small>{row.detail}</small>
            </button>
          </li>)}
        </ul>}
        {focused && suggestionError && <p className="v2-hint">Förslagen kunde inte hämtas. Du kan fortfarande trycka Sök.</p>}
      </div>
    </form>
    <div className="panel-scroll v2-scroll" ref={scroll} onScroll={event=>{
      const top=event.currentTarget.scrollTop;setTopicState(current=>({...current,scrollTop:top}));
    }}>
      <div className="v2-layout">
        <details className="v2-filters" open={presentation==="desktop" || filtersOpen} onToggle={event=>setFiltersOpen(event.currentTarget.open)}>
          <summary><SlidersHorizontal size={16} aria-hidden="true"/> Filter {facets.filter(f=>f.kind!=="topic").length || ""}</summary>
          <FilterControls response={response} request={request} years={years} partyProfiles={partyProfiles} onChange={change} onChoose={choose}/>
        </details>
        <main className="v2-main">
          {facets.length>0 && <div className="search-interpretation" aria-label="Tolkat som"><div>{facets.map(facet=>
            <span className="search-facet" key={facet.kind}>{visibleFacetLabel(facet)}
              <button type="button" aria-label={`Ta bort ${visibleFacetLabel(facet)}`} onClick={()=>change(facet.kind,null)}><X size={12}/></button>
            </span>)}</div></div>}
          {!response && topicState.phase==="idle" && <div className="v2-intro"><h2>Utforska ett år</h2><p>Se klippen från årets debatter, senast först.</p>
            <div className="v2-years">{years.map(year=><button key={year.id} onClick={()=>choose(year)}>{year.label}</button>)}</div>
            <p className="v2-hint">Skriv flera ord för att kombinera ämne, person och år. Sätt citat inom citationstecken.</p>
          </div>}
          {busy && <div className="topic-search-loading" role="status"><LoaderCircle size={18} className="topic-search-spinner"/> Söker i klippen…</div>}
          {topicState.errorKind && <div className="v2-error" role="alert"><p>{searchErrorText(topicState.errorKind)}</p>
            <button type="button" className="topic-show-more" onClick={()=>submit(request)}>Sök igen</button></div>}
          {visibleResponse && <SearchResults response={visibleResponse} busy={moreBusy} onPlay={play}
            onMore={()=>submit({...request,cursor:visibleResponse.nextCursor!},true)}
            onAllYears={()=>change("date",null)}
            onSort={sort=>submit({...request,sort})}
            onAmbiguity={id=>change(visibleResponse.interpretation.ambiguity!.kind,id)}/>}
        </main>
      </div>
    </div>
  </section>;
}

function FilterControls({response,request,years,partyProfiles,onChange,onChoose}:{
  response: SearchV2Response|null;request: SearchV2Request;years: SearchSuggestion[];partyProfiles: PartyProfile[];
  onChange: (kind: keyof SearchFilters,value: SearchFilters[keyof SearchFilters])=>void;
  onChoose: (suggestion: SearchSuggestion)=>void;
}) {
  const date=response?.interpretation.facets.find(f=>f.kind==="date");
  const party=response?.interpretation.facets.find(f=>f.kind==="party");
  const [from,setFrom]=useState(date?.from ?? ""),[to,setTo]=useState(date?.to ?? "");
  useEffect(()=>{setFrom(date?.from ?? "");setTo(date?.to ?? "");},[date?.from,date?.to]);
  const activeYear=date?.from.endsWith("-01-01") && date.to===`${date.from.slice(0,4)}-12-31` ? date.from.slice(0,4) : "";
  return <div className="v2-filter-controls">
    <label>Debattår<select value={activeYear} onChange={event=>onChange("date",event.target.value ? {from:`${event.target.value}-01-01`,to:`${event.target.value}-12-31`} : null)}>
      <option value="">Alla år</option>{years.map(y=><option key={y.id} value={y.id}>{y.label}</option>)}
    </select></label>
    <details className="v2-date-range"><summary>Välj datumintervall</summary>
      <label>Från<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
      <label>Till<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
      <button type="button" disabled={!from || !to || from>to} onClick={()=>onChange("date",{from,to})}>Använd datum</button>
    </details>
    <label>Parti vid debatten<select value={party?.party ?? request.filters?.party ?? ""} onChange={e=>onChange("party",(e.target.value || null) as PartyCode|null)}>
      <option value="">Alla partier</option>{partyProfiles.filter(p=>p.abbr!=="NONE").map(p=><option key={p.abbr} value={p.abbr}>{p.name}</option>)}<option value="NONE">Partilös</option>
    </select></label>
    <CatalogPicker kind="person" label="Person" onChoose={onChoose}/>
    <CatalogPicker kind="event" label="Debatt" onChoose={onChoose}/>
  </div>;
}

function CatalogPicker({kind,label,onChoose}:{kind:"person"|"event";label:string;onChoose:(s:SearchSuggestion)=>void}) {
  const [query,setQuery]=useState("");const [rows,setRows]=useState<SearchSuggestion[]>([]);const [failed,setFailed]=useState(false);
  useEffect(()=>{
    setRows([]);setFailed(false);if (query.trim().length<2) return;
    const pending=new AbortController();const timer=window.setTimeout(()=>{
      archiveSearch.suggest(query,kind,pending.signal).then(r=>{if (!pending.signal.aborted) setRows(r);})
        .catch(()=>{if (!pending.signal.aborted) setFailed(true);});
    },200);
    return ()=>{clearTimeout(timer);pending.abort();};
  },[query,kind]);
  return <div className="v2-picker"><label>{label}<input value={query} placeholder={`Sök ${label.toLowerCase()}`} onChange={e=>setQuery(e.target.value)}/></label>
    {rows.length>0 && <ul aria-label={`Välj ${label.toLowerCase()}`}>{rows.map(row=><li key={row.id}><button type="button" onClick={()=>{onChoose(row);setQuery("");}}>{row.label}<small>{row.detail}</small></button></li>)}</ul>}
    {failed && <small>Förslagen kunde inte hämtas.</small>}
  </div>;
}
