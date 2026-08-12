-- Reverse 017_politician_portrait_jobs.
-- Stop creating work before removing any queued, running or completed portrait
-- jobs. Job-run history is retained with its nullable job_id cleared by the FK.

drop trigger if exists politicians_enqueue_portrait_sync on public.politicians;
drop function if exists public.enqueue_politician_portrait_sync();

delete from public.jobs
where kind = 'portrait_sync';
