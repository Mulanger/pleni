-- Reverse 006_job_queue.
--
-- Returns public.jobs to its migration 001 shape. Any queued or running work is
-- lost, which is the honest consequence of removing the columns that describe it.

drop index if exists public.jobs_claimable_idx;
drop index if exists public.jobs_lease_idx;
drop index if exists public.jobs_entity_idx;

alter table public.jobs drop constraint if exists jobs_state_check;
alter table public.jobs drop constraint if exists jobs_pool_check;

alter table public.jobs drop column if exists parent_id;
alter table public.jobs drop column if exists created_at;
alter table public.jobs drop column if exists max_attempts;
alter table public.jobs drop column if exists locked_by;
alter table public.jobs drop column if exists locked_at;
alter table public.jobs drop column if exists run_after;
alter table public.jobs drop column if exists priority;
alter table public.jobs drop column if exists pool;

alter table public.jobs alter column updated_at drop default;
