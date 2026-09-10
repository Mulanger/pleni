-- Executed by verify_search_v2_database.py inside a transaction that is rolled back.
create temporary table search_v2_evidence(test text primary key,details jsonb);
insert into search_v2_evidence values('initial_health',public.search_index_health());
do $test$
declare y integer; page jsonb; item jsonb; cursor_value jsonb; seen text[]; expected integer;
  clip text; target constant text:='HD10552_cabb9ba6-5d6e-f111-bf27-6805cafeabf9_c02';
  q text; position integer; source record; old_publication timestamptz; started timestamptz;
begin
  for y in 2023..2026 loop
    seen:='{}';cursor_value:=null;started:=clock_timestamp();
    loop
      page:=public.search_clips_v2(p_from=>make_date(y,1,1),p_to=>make_date(y,12,31),
        p_sort=>'newest',p_limit=>40,p_after=>cursor_value);
      for item in select value from jsonb_array_elements(page->'results') with ordinality where ordinality<=40 loop
        clip:=item->'clip'->>'id';
        if clip=any(seen) then raise exception 'duplicate in year %: %',y,clip; end if;
        if (item->'clip'->>'debateDate')::date not between make_date(y,1,1) and make_date(y,12,31) then raise exception 'year filter leaked'; end if;
        seen:=array_append(seen,clip);cursor_value:=item->'_cursor';
      end loop;
      exit when jsonb_array_length(page->'results')<=40;
    end loop;
    select count(*) into expected from public.feed_clip_catalogue where debate_date between make_date(y,1,1) and make_date(y,12,31);
    if cardinality(seen)<>expected then raise exception 'missing year results: %, got %, expected %',y,cardinality(seen),expected; end if;
    insert into search_v2_evidence values('year_'||y,jsonb_build_object('count',expected,'durationMs',extract(epoch from clock_timestamp()-started)*1000));
    select d.* into source from private.clip_search_documents d where extract(year from d.debate_date)=y and length(d.title)>35 order by length(d.title) desc,d.clip_id limit 1;
    page:=public.search_clips_v2(p_topic=>'"'||source.title||'"',p_limit=>5);
    if not exists(select 1 from jsonb_array_elements(page->'results') r where r->'clip'->>'id'=source.clip_id) then raise exception 'known year title missing: %',source.clip_id; end if;
    insert into search_v2_evidence values('title_'||y,jsonb_build_object('id',source.clip_id,'title',source.title));
  end loop;
  foreach q in array array['elsparkcykel','elsparkcyklar','elsparcykel','el sparkcyklar'] loop
    page:=public.search_clips_v2(p_topic=>q,p_limit=>5);
    select ordinality::integer into position from jsonb_array_elements(page->'results') with ordinality where value->'clip'->>'id'=target;
    if position is null or position>5 then raise exception 'known scooter clip not in top five for %',q; end if;
    insert into search_v2_evidence values(q,jsonb_build_object('rank',position));
  end loop;
  foreach q in array array['bananministeriet på månen','kvantdatorer på varje förskola'] loop
    if jsonb_array_length(public.search_clips_v2(p_topic=>q)->'results')<>0 then raise exception 'nonsense keyword match'; end if;
  end loop;
  select * into source from private.clip_search_documents where clip_id=target;
  page:=public.search_clips_v2(p_person=>source.politician_id,p_party=>source.party_at_speech,
    p_sources=>array[source.source_id],p_from=>source.debate_date,p_to=>source.debate_date,p_sort=>'oldest');
  for item in select value from jsonb_array_elements(page->'results') loop
    if item->'clip'->>'politicianId'<>source.politician_id::text or item->>'partyAtSpeech'<>source.party_at_speech
      or item->'clip'->>'debateDate'<>source.debate_date::text then raise exception 'combined filters leaked'; end if;
  end loop;
  if public.repair_search_index(array[target])<>0 or public.repair_search_index(array[target])<>0 then raise exception 'repair of a current document was not idempotent'; end if;
  -- Simulate unpublishing between pages. The transaction never commits this change.
  page:=public.search_clips_v2(p_topic=>'elsparkcykel',p_limit=>1);
  cursor_value:=page->'results'->0->'_cursor';
  select published_at into old_publication from public.clips where id=target;
  update public.clips set published_at=null where id=target;
  page:=public.search_clips_v2(p_topic=>'elsparkcykel',p_limit=>40,p_after=>cursor_value);
  if exists(select 1 from jsonb_array_elements(page->'results') r where r->'clip'->>'id'=target)
    or exists(select 1 from private.clip_search_documents where clip_id=target) then raise exception 'unpublished clip remains searchable'; end if;
  update public.clips set published_at=old_publication where id=target;
  if not exists(select 1 from private.clip_search_documents where clip_id=target) then raise exception 'publishing did not create immediate keyword document'; end if;
  insert into search_v2_evidence values('filters_unpublish_publish_repair','true'::jsonb);
  if not (public.prepare_search_v2(repeat('a',64),false)->'rateLimit'->>'allowed')::boolean then raise exception 'gateway unavailable'; end if;
  if not exists(select 1 from jsonb_array_elements(public.search_suggestions_v2('20','year')) r where r->>'id'='2023') then raise exception 'real year suggestion missing'; end if;
  if has_function_privilege('anon','public.search_clips_v2(text,text,integer,uuid,text,date,date,uuid[],text,jsonb,timestamptz)','execute') then raise exception 'anonymous database bypass'; end if;
end;
$test$;
