select cron.unschedule(jobid) from cron.job where jobname='search-fresh-index-v2';
drop function if exists private.dispatch_search_fresh_index_v2();
