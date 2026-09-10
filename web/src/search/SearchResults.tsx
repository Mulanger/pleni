import { Play } from "lucide-react";
import { PARTIES } from "../data";
import { topicResultHeading } from "./state";
import type { SearchSort, SearchV2Response, SearchV2Result } from "./v2-types";
export function SearchResults({response,busy,onPlay,onMore,onAllYears,onSort,onAmbiguity}:{response:SearchV2Response;busy:boolean;
  onPlay:(id:string|null)=>void;onMore:()=>void;onAllYears:()=>void;onSort:(sort:SearchSort)=>void;onAmbiguity:(id:string)=>void}) {
  const ambiguity=response.interpretation.ambiguity;
  const date=response.interpretation.facets.find(f=>f.kind==="date");
  if (ambiguity) return <section className="search-ambiguity" aria-labelledby="search-ambiguity-title"><h2 id="search-ambiguity-title">{ambiguity.message}</h2>
    <div>{ambiguity.options.map(option=><button type="button" key={option.id} onClick={()=>onAmbiguity(option.id)}><span>{option.label}</span><small>{option.detail}</small></button>)}</div></section>;
  return <section className="topic-clip-section" aria-labelledby="v2-result-heading">
    {response.mode==="keyword_fallback" && <p className="topic-search-fallback" role="status">Visar ordträffar just nu. Betydelsesökningen är tillfälligt otillgänglig.</p>}
    {response.mode==="hybrid" && response.semanticCoverage!=="complete" && <p className="topic-search-fallback" role="status">Ordträffar finns i hela arkivet. Betydelsesökningen håller på att uppdateras.</p>}
    <div className="topic-result-heading"><div><h2 id="v2-result-heading">{topicResultHeading(response.interpretation.facets)}</h2>
      <p>{response.results.length} klipp hämtade{response.nextCursor ? " · fler finns" : ""}</p></div>
      <label className="v2-sort">Sortering<select value={response.sort} onChange={e=>onSort(e.target.value as SearchSort)}>
        <option value="relevance">Relevans</option><option value="newest">Nyast</option><option value="oldest">Äldst</option>
      </select></label></div>
    {response.results.length>0 ? <><button className="v2-play-all" type="button" onClick={()=>onPlay(null)}><Play size={14}/> Spela resultaten i ordning</button>
      <div className="topic-result-list">{response.results.map(result=><SearchResultRow key={result.clip.id} result={result} onPlay={()=>onPlay(result.clip.id)}/>)}</div>
    </> : <div className="topic-search-empty" role="status"><strong>Inga klipp hittades{date ? ` under ${date.label}` : ""}</strong><span>Prova en annan formulering eller ändra ett filter.</span>
      {date && <button type="button" className="topic-show-more" onClick={onAllYears}>Sök under alla år</button>}</div>}
    {response.nextCursor && <button type="button" className="topic-show-more" disabled={busy} onClick={onMore}>{busy ? "Hämtar fler…" : "Visa fler"}</button>}
  </section>;
}
export function SearchResultRow({result,onPlay}:{result:SearchV2Result;onPlay:()=>void}) {
  const seconds=Math.max(0,Math.round(result.clip.durationS));
  return <button type="button" className="topic-result-row v2-result-row" onClick={onPlay}>
    <span className="topic-result-thumb"><img src={result.clip.thumbUrl} alt="" loading="lazy"/><span>{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,"0")}</span></span>
    <span className="topic-result-copy"><strong className="v2-result-title">{result.clip.title}</strong>
      <span className="topic-result-byline"><i style={{background:PARTIES[result.partyAtSpeech].color}}/><span>{result.speakerNameAtSpeech}</span><b>· {result.partyAtSpeech==="NONE" ? "Partilös" : result.partyAtSpeech}</b></span>
      <span className="topic-result-source">{new Date(`${result.clip.debateDate}T12:00:00`).toLocaleDateString("sv-SE",{year:"numeric",month:"short",day:"numeric"})} · {result.clip.sourceTitle}</span>
      {result.matchSource==="debate" && <small className="v2-context-label">Träff i debattens rubrik</small>}
      <span className="v2-excerpt">{result.matchExcerpt}</span>
    </span>
  </button>;
}
