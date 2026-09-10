-- Compare filtered iterative HNSW with exact distances on the same current catalogue.
-- Document embeddings remain inside this rollback-only transaction.
create temp table vector_evidence(year integer, candidates integer, within_exact_top20 integer);
do $test$
declare y integer; v extensions.halfvec(1024); cutoff double precision; found integer; correct integer;
begin
  for y in 2023..2026 loop
    select ch.embedding into v from private.clip_search_chunks ch
      join private.clip_search_documents d using(clip_id)
      where extract(year from d.debate_date)=y order by ch.clip_id,ch.chunk_no limit 1;
    perform set_config('hnsw.iterative_scan','strict_order',true);
    perform set_config('hnsw.ef_search','240',true);
    select max(distance) into cutoff from (
      select ch.embedding operator(extensions.<=>) v as distance
      from private.clip_search_chunks ch join private.clip_search_documents d using(clip_id)
      join public.clips c on c.id=d.clip_id
      where extract(year from d.debate_date)=y and c.published_at is not null
        and c.moderation<>'rejected' and c.url_540x960<>''
        and d.semantic_state='current' and ch.source_hash=d.source_hash
        and ch.index_version=d.completed_index_version
      order by (ch.embedding operator(extensions.<=>) v)+0 limit 20
    ) exact;
    select count(*),count(*) filter(where distance<=cutoff+0.000001) into found,correct from (
      select ch.embedding operator(extensions.<=>) v as distance
      from private.clip_search_chunks ch
      where (select true from private.clip_search_documents d join public.clips c on c.id=d.clip_id
        where d.clip_id=ch.clip_id and extract(year from d.debate_date)=y
          and c.published_at is not null and c.moderation<>'rejected' and c.url_540x960<>''
          and d.semantic_state='current' and ch.source_hash=d.source_hash
          and ch.index_version=d.completed_index_version limit 1)
      order by ch.embedding operator(extensions.<=>) v limit 20
    ) approximate;
    if found<>20 or correct<19 then raise exception 'filtered vector recall regression for %: %/%',y,correct,found; end if;
    insert into vector_evidence values(y,found,correct);
  end loop;
end;
$test$;
select * from vector_evidence order by year;
