import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createSearchV2Handler, type SearchV2Dependencies } from "../_shared/search/api-v2.ts";
import { interpretV2 } from "../_shared/search/interpret-v2.ts";
import { parseSearchV2Request } from "../_shared/search-v2-types.ts";
import { OpenAIEmbeddingError } from "../_shared/search/openai.ts";
import type { SearchEntityCatalog } from "../_shared/search/types.ts";

const person="11111111-1111-4111-8111-111111111111";
const other="22222222-2222-4222-8222-222222222222";
const catalogue: SearchEntityCatalog={people:[
  {id:person,label:"Magdalena Andersson",party:"S",aliases:[{value:"Andersson",verified:true}]},
  {id:other,label:"Johan Andersson",party:"S",aliases:[{value:"Andersson",verified:true}]}
],events:[]};
const fixture=JSON.parse(readFileSync(new URL("../../../web/tests/fixtures/search-contract/valid.json",import.meta.url),"utf8"));
const result={...fixture.responses.find((r: {results: unknown[]})=>r.results.length).results[0],matchSource:"clip"};
const request=(value: unknown)=>new Request("https://test.invalid/clip-search-v2",{method:"POST",headers:{Origin:"https://pleni.se","Content-Type":"application/json"},body:JSON.stringify(value)});
function setup() {
  const searches: Record<string,unknown>[]=[], logs: unknown[]=[];
  let embeddings=0, date=new Date("2026-09-09T12:00:00Z");
  const deps: SearchV2Dependencies={
    prepare:async()=>({rateLimit:{allowed:true,reason:null,retryAfterSeconds:0},catalog:catalogue,indexVersion:"v1"}),
    reserveTokens:async()=>({allowed:true,reason:null,retryAfterSeconds:0}),
    embed:async()=>{embeddings++;return Array(1024).fill(0.125);},
    retrieve:async p=>{searches.push(p); return {indexVersion:"v1",semanticCoverage:"complete",results:
      [1,2,3].map(n=>({...result,clip:{...result.clip,id:`clip-${n}`},_cursor:{id:`clip-${n}`,score:-3+n,date:-1}}))};},
    suggest:async()=>[{kind:"year",id:"2023",label:"2023",detail:"Debattår"}],
    log:s=>logs.push(s),now:()=>date
  };
  const handler=createSearchV2Handler(deps,{allowedOrigins:new Set(["https://pleni.se"]),secret:"isolated-test-secret-32-characters-or-more"});
  return {deps,handler,searches,logs,get embeddings(){return embeddings;},advance:()=>{date=new Date(date.getTime()+31*60_000);}};
}
test("V2 accepts year-only and explicit filter-only searches, with debate dates and newest default",async()=>{
  for (const year of [2023,2024,2025,2026]) {
    const f=setup(); const response=await f.handler(request({query:String(year)}));
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.sort,"newest");assert.equal(f.embeddings,0);
    assert.equal(f.searches[0].p_from,`${year}-01-01`);assert.equal(f.searches[0].p_to,`${year}-12-31`);
    assert.equal(f.searches[0].p_topic,null);assert.equal(body.dateBroadening,undefined);
  }
  const f=setup();await f.handler(request({query:"",filters:{person,party:"M",date:{from:"2023-01-01",to:"2023-12-31"}}}));
  assert.equal(f.searches[0].p_person,person);assert.equal(f.searches[0].p_party,"M");
});
test("manual choice and removed filters preserve topic/date and consume recognized words",()=>{
  const selected=interpretV2({query:"Andersson skatter 2023",filters:{person}},catalogue,2026);
  assert.equal(selected.plan.topic,"skatter");assert.equal(selected.plan.dateFrom,"2023-01-01");assert.equal(selected.ambiguity,null);
  const cleared=interpretV2({query:"Magdalena Andersson skatter 2023",filters:{person:null,date:null}},catalogue,2026);
  assert.equal(cleared.plan.topic,"skatter");assert.equal(cleared.plan.politicianId,null);assert.equal(cleared.plan.dateFrom,null);
});
test("quotes protect dates and names, including curved quotation marks",()=>{
  for (const query of ['"Magdalena Andersson 2023" skatter','“Magdalena Andersson 2023” skatter']) {
    const {plan}=interpretV2({query},catalogue,2026);
    assert.equal(plan.politicianId,null);assert.equal(plan.dateFrom,null);
    assert.equal(plan.topic,'"Magdalena Andersson 2023" skatter');
  }
});
test("pagination uses encrypted bounded query-bound cursors and reuses the exact embedding",async()=>{
  const f=setup();const first=await f.handler(request({query:"elsparkcykel",limit:2}));
  assert.equal(first.status,200);const page=await first.json();assert.equal(page.results.length,2);
  assert.ok(page.nextCursor.length<14000);assert.equal(page.nextCursor.includes("elsparkcykel"),false);
  assert.equal(page.results[0]._cursor,undefined);
  const second=await f.handler(request({query:"elsparkcykel",limit:2,cursor:page.nextCursor}));
  assert.equal(second.status,200);assert.equal(f.embeddings,1);
  assert.deepEqual(f.searches[1].p_after,{id:"clip-2",score:-1,date:-1});
  assert.equal(f.searches[0].p_embedding,f.searches[1].p_embedding);
  for (const changed of [{query:"skatter"},{query:"elsparkcykel",sort:"oldest"},{query:"elsparkcykel",filters:{party:"M"}}]) {
    assert.equal((await f.handler(request({...changed,limit:2,cursor:page.nextCursor}))).status,409);
  }
  assert.equal((await f.handler(request({query:"elsparkcykel",limit:2,cursor:page.nextCursor.slice(0,-6)+"abcdef"}))).status,409);
  f.advance();assert.equal((await f.handler(request({query:"elsparkcykel",limit:2,cursor:page.nextCursor}))).status,409);
  assert.equal(JSON.stringify(f.logs).includes("elsparkcykel"),false);
});
test("provider outage and exhausted budget keep keyword retrieval; abuse limits still reject",async()=>{
  for (const failure of ["provider","budget"]) {
    const f=setup();
    if (failure==="provider") f.deps.embed=async()=>{throw new OpenAIEmbeddingError("provider_timeout",true);};
    else f.deps.reserveTokens=async()=>({allowed:false,reason:"budget",retryAfterSeconds:86400});
    const response=await f.handler(request({query:"elsparkcykel"}));const body=await response.json();
    assert.equal(response.status,200);assert.equal(body.mode,"keyword_fallback");assert.equal(f.searches[0].p_embedding,null);
  }
  const f=setup();f.deps.prepare=async()=>({rateLimit:{allowed:false,reason:"request",retryAfterSeconds:60}});
  const response=await f.handler(request({query:"2023"}));assert.equal(response.status,429);assert.equal(f.searches.length,0);
});
test("suggestions are catalogue-only and do not invoke retrieval or embeddings",async()=>{
  const f=setup();const r=await f.handler(request({operation:"suggest",query:"20",kind:"year"}));
  assert.equal(r.status,200);assert.equal((await r.json()).suggestions[0].id,"2023");assert.equal(f.searches.length,0);assert.equal(f.embeddings,0);
});
test("strict request validation rejects invalid dates, arbitrary fields and oversized cursors",()=>{
  for (const input of [{query:"2023",filters:{date:{from:"2023-02-30",to:"2023-03-01"}}},
    {query:"",filters:{person:"name"}},{query:"a",trackingId:"x"},{query:"a",cursor:"a".repeat(14001)}]) assert.throws(()=>parseSearchV2Request(input));
});
