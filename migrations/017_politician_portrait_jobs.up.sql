-- 017_politician_portrait_jobs
--
-- Queue profile/portrait synchronization as durable low-priority IO work.
-- The trigger only inserts a job in the politician transaction; all external
-- Riksdagen and Bunny traffic remains in the Python worker.

create or replace function public.enqueue_politician_portrait_sync()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  politician_intressent_id text;
begin
  politician_intressent_id := nullif(btrim(new.intressent_id), '');
  if politician_intressent_id is null or new.avatar_sha256 is not null then
    return new;
  end if;

  insert into public.jobs (
    kind,
    entity_id,
    idempotency_key,
    state,
    pool,
    priority,
    payload
  ) values (
    'portrait_sync',
    politician_intressent_id,
    format('portrait_sync:%s:v1', politician_intressent_id),
    'queued',
    'io',
    -100,
    '{}'::jsonb
  )
  on conflict (idempotency_key) do nothing;

  return new;
end;
$$;

revoke all on function public.enqueue_politician_portrait_sync() from public, anon, authenticated;

drop trigger if exists politicians_enqueue_portrait_sync on public.politicians;
create trigger politicians_enqueue_portrait_sync
after insert on public.politicians
for each row
when (new.avatar_sha256 is null)
execute function public.enqueue_politician_portrait_sync();

-- Existing politicians predate the trigger. Offer every unverified portrait
-- once; the stable key makes reapplying the migration harmless.
insert into public.jobs (
  kind,
  entity_id,
  idempotency_key,
  state,
  pool,
  priority,
  payload
)
select
  'portrait_sync',
  btrim(intressent_id),
  format('portrait_sync:%s:v1', btrim(intressent_id)),
  'queued',
  'io',
  -100,
  '{}'::jsonb
from public.politicians
where nullif(btrim(intressent_id), '') is not null
  and avatar_sha256 is null
on conflict (idempotency_key) do nothing;
