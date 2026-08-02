-- 006_job_queue
--
-- Turns `public.jobs` into a real work queue for C12 orchestration.
-- See docs/adr/009-python-native-job-queue.md.
--
-- Migration 001 created the table with kind, entity_id, idempotency_key, state,
-- attempts, last_error, payload and updated_at, and nothing has ever read or
-- written it. This adds what a queue actually needs: a lease so a crashed
-- worker's job comes back, a scheduling time so backoff is expressible, a pool
-- so GPU work does not land on an IO worker, and the index the claim query
-- depends on.
--
-- Additive and idempotent: safe to re-apply. No existing rows to migrate --
-- the table is empty.

-- 1. Scheduling and lease columns.
alter table public.jobs add column if not exists pool text not null default 'cpu';
alter table public.jobs add column if not exists priority int not null default 0;
alter table public.jobs add column if not exists run_after timestamptz not null default now();
alter table public.jobs add column if not exists locked_at timestamptz;
alter table public.jobs add column if not exists locked_by text;
alter table public.jobs add column if not exists max_attempts int not null default 3;
alter table public.jobs add column if not exists created_at timestamptz not null default now();
alter table public.jobs add column if not exists parent_id bigint references public.jobs(id) on delete set null;

-- `updated_at` exists but had no default and nothing maintained it.
alter table public.jobs alter column updated_at set default now();

-- 2. Constrain the state machine.
--
--    queued   -> claimable
--    running  -> leased to a worker; reaped back to queued when the lease expires
--    complete -> terminal, success
--    dead     -> terminal, gave up after max_attempts; last_error explains why
--
--    There is deliberately no `failed` state. A failure is either retryable (back
--    to `queued` with a later run_after) or final (`dead`). A third resting state
--    would be a place for jobs to be forgotten in.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'jobs_state_check'
  ) then
    alter table public.jobs
      add constraint jobs_state_check
      check (state in ('queued', 'running', 'complete', 'dead'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'jobs_pool_check'
  ) then
    alter table public.jobs
      add constraint jobs_pool_check
      check (pool in ('gpu', 'cpu', 'io'));
  end if;
end;
$$;

-- 3. The claim index.
--
--    Matches `where state = 'queued' and run_after <= now() and pool = $1
--    order by priority desc, id`. Partial on the claimable state so it stays
--    small no matter how much completed history accumulates -- the table is
--    append-mostly and completed rows are the overwhelming majority.
create index if not exists jobs_claimable_idx
  on public.jobs (pool, priority desc, id)
  where state = 'queued';

-- Reaper: find leases that have expired.
create index if not exists jobs_lease_idx
  on public.jobs (locked_at)
  where state = 'running';

-- Operational queries: "what happened to this debate?"
create index if not exists jobs_entity_idx on public.jobs (entity_id, kind);

-- 4. Privileges. Operational data, service_role only.
--    Migration 004 already revoked the default anon/authenticated grants and
--    stopped new objects inheriting them; this is belt and braces for the
--    columns added above and re-asserts the intent next to the schema it
--    protects.
revoke all on public.jobs from public, anon, authenticated;
grant all on public.jobs to service_role;
