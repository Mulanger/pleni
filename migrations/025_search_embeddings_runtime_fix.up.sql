-- 025_search_embeddings_runtime_fix
--
-- Migration 024 schema-qualified PostgreSQL's special LEAST/GREATEST syntax
-- inside two PL/pgSQL bodies. Those bodies are parsed only when invoked, so the
-- DDL applied successfully but claim/failure execution raised 42883. Applied
-- migrations are immutable: repair the two exact 024 definitions in place.

do $preflight$
begin
  if not exists (
    select 1
    from public.schema_migrations migration
    where migration.filename = '024_search_embeddings.up.sql'
      and migration.checksum =
        '82eddffc99a29f8fe81858c13d910f0c138a9f3a590cf0d4d0ce38e55fc5aa58'
  ) then
    raise exception 'checksum-matching migration 024 must be applied before 025';
  end if;
end;
$preflight$;

do $repair$
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

  if claim_definition not like '%pg_catalog.greatest%'
    or claim_definition not like '%pg_catalog.least%'
    or fail_definition not like '%pg_catalog.greatest%'
    or fail_definition not like '%pg_catalog.least%' then
    raise exception 'migration 024 runtime definitions differ from the expected repair input';
  end if;

  claim_definition := pg_catalog.replace(
    pg_catalog.replace(
      claim_definition,
      'pg_catalog.greatest',
      'greatest'
    ),
    'pg_catalog.least',
    'least'
  );
  fail_definition := pg_catalog.replace(
    pg_catalog.replace(
      fail_definition,
      'pg_catalog.greatest',
      'greatest'
    ),
    'pg_catalog.least',
    'least'
  );

  execute claim_definition;
  execute fail_definition;
end;
$repair$;

do $runtime_check$
begin
  if (select pg_catalog.count(*) from public.claim_search_embedding_jobs(1, 30)) <> 0 then
    raise exception 'provider-off claim runtime check unexpectedly returned work';
  end if;
end;
$runtime_check$;
