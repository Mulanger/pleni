import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { parseSearchV2Request, parseSearchV2Response } from "../src/search/v2-types.ts";
import { createSearchV2Client, SearchV2ApiError } from "../src/search/v2-api.ts";
import { changeSearchFilter, completeV2 } from "../src/search/v2-state.ts";
import { EMPTY_TOPIC_SEARCH_STATE } from "../src/search/state.ts";

const fixtures=JSON.parse(await readFile(new URL("./fixtures/search-contract/valid.json",import.meta.url),"utf8"));
const old=fixtures.responses.find(r=>r.results.length>0);
const response={version:"clip-search-v2",searchVersion:"pleni-search-v4",indexVersion:"v1",mode:"hybrid",
  semanticCoverage:"complete",interpretation:old.interpretation,results:old.results.map(r=>({...r,matchSource:"clip"})),nextCursor:"opaque-next-page",sort:"relevance"};

test("V2 browser and Edge contracts remain identical apart from their module path",async()=>{
  const web=await readFile(new URL("../src/search/v2-types.ts",import.meta.url),"utf8");
  const edge=await readFile(new URL("../../supabase/functions/_shared/search-v2-types.ts",import.meta.url),"utf8");
  assert.equal(web.replace('"./types.ts"','"./search-types.ts"'),edge);
  assert.deepEqual(parseSearchV2Request({query:"2023"}),{query:"2023"});
  assert.equal(parseSearchV2Response(response),response);
});
test("removing filters freezes other applied facets and never turns them into query text",()=>{
  const next=changeSearchFilter({query:"Magdalena Andersson skatter 2023"},response,"date",null);
  assert.equal(next.filters.date,null);
  assert.equal(next.filters.person,old.interpretation.facets.find(f=>f.kind==="person").politicianId);
  assert.equal(next.query,"Magdalena Andersson skatter 2023");
  assert.equal(next.cursor,undefined);
});
test("a fetched page appends unique clips, preserves scroll and retains the server cursor",()=>{
  const first=completeV2(EMPTY_TOPIC_SEARCH_STATE,{query:"2023"},response,false);
  const more={...response,results:[response.results[0],{...response.results[0],clip:{...response.results[0].clip,id:"new-page-id"}}],nextCursor:null};
  const next=completeV2({...first,scrollTop:418},{query:"2023",cursor:"previous"},more,true);
  assert.equal(next.response.results.length,first.response.results.length+1);
  assert.equal(next.scrollTop,418);assert.equal(next.v2Response.nextCursor,null);assert.equal(next.v2Request.cursor,undefined);
});
test("anonymous V2 client posts only to a fixed endpoint without cookies, referrers or cache",async()=>{
  const calls=[];const client=createSearchV2Client({supabaseUrl:"https://example.test",publishableKey:"public",fetcher:async(url,options)=>{
    calls.push({url,options});return Response.json(response);
  }});
  await client.search({query:"elsparkcykel",cursor:"opaque"});
  assert.equal(calls[0].url,"https://example.test/functions/v1/clip-search-v2");
  assert.equal(calls[0].options.method,"POST");assert.equal(calls[0].options.cache,"no-store");
  assert.equal(calls[0].options.credentials,"omit");assert.equal(calls[0].options.referrerPolicy,"no-referrer");
  assert.equal(JSON.parse(calls[0].options.body).cursor,"opaque");
});
test("client distinguishes network, request limit, expired page and service errors",async()=>{
  for (const [status,kind] of [[429,"rate_limited"],[409,"cursor_expired"],[503,"unavailable"]]) {
    const client=createSearchV2Client({supabaseUrl:"https://example.test",publishableKey:"public",fetcher:async()=>new Response(null,{status})});
    await assert.rejects(client.search({query:"2023"}),error=>error instanceof SearchV2ApiError && error.kind===kind);
  }
});
test("actual React results render page counts, debate context, empty dates and fallback accurately",async()=>{
  const server=await createServer({root:fileURLToPath(new URL("../",import.meta.url)),configFile:false,logLevel:"silent",server:{middlewareMode:true},appType:"custom"});
  try {
    const {SearchResults}=await server.ssrLoadModule("/src/search/SearchResults.tsx");
    const props={busy:false,onPlay(){},onMore(){},onAllYears(){},onSort(){},onAmbiguity(){}};
    const context={...response,interpretation:{facets:[],ambiguity:null},results:[{...response.results[0],matchSource:"debate"}]};
    const html=renderToStaticMarkup(createElement(SearchResults,{...props,response:context}));
    assert.match(html,/1 klipp hämtade/);assert.match(html,/fler finns/);assert.match(html,/Visa fler/);
    assert.match(html,/Träff i debattens rubrik/);assert.doesNotMatch(html,/“/);
    const empty={...response,results:[],nextCursor:null,mode:"keyword_fallback",interpretation:{ambiguity:null,facets:[{kind:"date",key:"date",label:"2023",from:"2023-01-01",to:"2023-12-31",removable:true}]}};
    const emptyHtml=renderToStaticMarkup(createElement(SearchResults,{...props,response:empty}));
    assert.match(emptyHtml,/Inga klipp hittades under 2023/);assert.match(emptyHtml,/Sök under alla år/);
    assert.match(emptyHtml,/Betydelsesökningen är tillfälligt otillgänglig/);assert.doesNotMatch(emptyHtml,/Visar relevanta klipp från andra datum/);
  } finally {await server.close();}
});

test("restored search landing keeps browsing content and hides years inside filters while results keep V2",async()=>{
  const server=await createServer({root:fileURLToPath(new URL("../",import.meta.url)),configFile:false,logLevel:"silent",server:{middlewareMode:true},appType:"custom"});
  try {
    const {SearchExperience}=await server.ssrLoadModule("/src/search/SearchExperience.tsx");
    const props={presentation:"desktop",query:"",setQuery(){},partyFilter:null,setPartyFilter(){},
      partyProfiles:[{abbr:"SD",name:"Sverigedemokraterna",color:"#123"}],partyProfilesLoading:false,
      topicState:EMPTY_TOPIC_SEARCH_STATE,setTopicState(){},topicSearchAvailable:true,
      onOpenPerson(){},onOpenParty(){},onOpenTopicFeed(){},
      browseContent:createElement("section",{"aria-label":"Original party directory"},"Browse parties")};
    const landing=renderToStaticMarkup(createElement(SearchExperience,props));
    assert.match(landing,/Browse parties/);
    assert.match(landing,/<details class="v2-filters">/);
    assert.match(landing,/Debattår/);
    assert.doesNotMatch(landing,/Utforska ett år|v2-years|Sök i klipparkivet/);
    const resultHtml=renderToStaticMarkup(createElement(SearchExperience,{...props,query:"2023",
      topicState:completeV2(EMPTY_TOPIC_SEARCH_STATE,{query:"2023"},response,false)}));
    assert.doesNotMatch(resultHtml,/Browse parties/);
    assert.match(resultHtml,/Filtrera på parti/);
    assert.match(resultHtml,/Visa fler/);
    assert.match(resultHtml,/Rensa sökningen/);
  } finally {await server.close();}
});
