-- 008_job_skipped_state
--
-- Adds a `skipped` outcome for work that correctly determined there was nothing
-- to do.
--
-- A Riksdagen document can legitimately have no video and no speakers: an
-- interpellation answered in writing, a session during summer recess, a
-- procedural item. Measured on the live API, everything from 2026-06-18 onward
-- is in that category — the chamber had risen.
--
-- Before this, such a document ran three times and dead-lettered. That is wrong
-- twice over: it wastes two extra attempts on something that can never succeed,
-- and it fills the dead-letter list — the operator's first stop when something
-- is broken — with hundreds of entries that are not broken at all. During a
-- backfill across years of documents, that would make the list useless.
--
-- `skipped` is neither success nor failure. The job ran, reached a correct
-- conclusion, and the chain stops there.
--
-- Additive and idempotent: safe to re-apply.

alter table public.jobs drop constraint if exists jobs_state_check;
alter table public.jobs
  add constraint jobs_state_check
  check (state in ('queued', 'running', 'complete', 'dead', 'skipped'));

alter table public.job_runs drop constraint if exists job_runs_outcome_check;
alter table public.job_runs
  add constraint job_runs_outcome_check
  check (outcome in ('complete', 'retry', 'dead', 'reaped', 'skipped'));

-- The claim index is partial on `state = 'queued'`, so a skipped job leaves it
-- immediately. Nothing else to do.
