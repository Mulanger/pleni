-- 025_search_embeddings_runtime_fix rollback
--
-- Restores the exact runtime expressions from applied migration 024. This is a
-- faithful rollback even though those expressions fail when the functions run.

do $restore$
declare
  claim_definition text;
  fail_definition text;
begin
  claim_definition := pg_catalog.pg_get_functiondef(
    'public.claim_search_embedding_jobs(integer,integer)'::regprocedure
  );
  fail_definition := pg_catalog.pg_get_functiondef(
    'public.fail_search_embedding_job(bigint,text,text,text,text,boolean)'::regprocedure
  );

  if claim_definition like '%pg_catalog.greatest%'
    or claim_definition like '%pg_catalog.least%'
    or fail_definition like '%pg_catalog.greatest%'
    or fail_definition like '%pg_catalog.least%' then
    raise exception 'migration 025 runtime definitions differ from the expected rollback input';
  end if;

  claim_definition := pg_catalog.replace(
    pg_catalog.replace(claim_definition, 'greatest', 'pg_catalog.greatest'),
    'least',
    'pg_catalog.least'
  );
  fail_definition := pg_catalog.replace(
    pg_catalog.replace(fail_definition, 'greatest', 'pg_catalog.greatest'),
    'least',
    'pg_catalog.least'
  );

  execute claim_definition;
  execute fail_definition;
end;
$restore$;
