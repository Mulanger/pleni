-- 007_job_runs
--
-- C13 observability substrate. Prerequisites P1-3 and P1-5.
--
-- `public.jobs` is mutated in place: a claim overwrites `locked_at`, a retry
-- overwrites `last_error`, and completion overwrites both. Once a job reaches
-- `complete` the only surviving evidence of a rocky path is `attempts = 3`.
-- That is enough to know something went wrong and useless for every question
-- worth asking:
--
--   How long does `render` actually take, and is it getting slower?
--   Which stage fails most often, and with what error?
--   Did last Tuesday's debate day process cleanly?
--
-- One append-only row per attempt answers all three. The cost is one INSERT per
-- job transition, which at one debate every few hours is nothing.
--
-- Deliberately NOT reusing `public.pipeline_runs`: that table is C11's publish
-- idempotency ledger keyed on `idempotency_key`, with one row per *debate*, and
-- overloading it would make both meanings unreliable.
--
-- Additive and idempotent: safe to re-apply.

create table if not exists public.job_runs (
  id bigserial primary key,
  job_id bigint references public.jobs(id) on delete set null,
  kind text not null,
  entity_id text not null,
  pool text not null,
  attempt int not null,
  worker_id text,
  started_at timestamptz,
  finished_at timestamptz not null default now(),
  duration_ms bigint,
  -- 'complete' | 'retry' | 'dead'. A crashed worker writes nothing at all,
  -- which is why `reaped` exists as a fourth value written by the reaper.
  outcome text not null,
  error text
);

-- `job_id` is nullable on purpose: a job row can be deleted during cleanup and
-- its history should outlive it. That is the entire point of a history table.

create index if not exists job_runs_kind_finished_idx
  on public.job_runs (kind, finished_at desc);

create index if not exists job_runs_entity_idx
  on public.job_runs (entity_id, finished_at desc);

create index if not exists job_runs_outcome_idx
  on public.job_runs (outcome, finished_at desc)
  where outcome <> 'complete';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'job_runs_outcome_check') then
    alter table public.job_runs
      add constraint job_runs_outcome_check
      check (outcome in ('complete', 'retry', 'dead', 'reaped'));
  end if;
end;
$$;

-- Operational data. Migration 004 already stopped new tables inheriting the
-- anon/authenticated grants; this is explicit next to the schema it protects.
alter table public.job_runs enable row level security;
revoke all on public.job_runs from public, anon, authenticated;
grant all on public.job_runs to service_role;
grant usage, select on sequence public.job_runs_id_seq to service_role;
