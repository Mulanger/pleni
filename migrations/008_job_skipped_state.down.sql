-- Reverse 008_job_skipped_state.
--
-- Any job already in `skipped` must move somewhere the old constraint allows.
-- `dead` is the honest choice: under the old model that is exactly where these
-- ended up.

update public.jobs set state = 'dead' where state = 'skipped';
update public.job_runs set outcome = 'dead' where outcome = 'skipped';

alter table public.jobs drop constraint if exists jobs_state_check;
alter table public.jobs
  add constraint jobs_state_check
  check (state in ('queued', 'running', 'complete', 'dead'));

alter table public.job_runs drop constraint if exists job_runs_outcome_check;
alter table public.job_runs
  add constraint job_runs_outcome_check
  check (outcome in ('complete', 'retry', 'dead', 'reaped'));
