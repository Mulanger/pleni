select cron.unschedule('search-index-health-v1');
drop function if exists private.sample_search_index_health();
drop function if exists public.search_index_health();
drop table if exists private.search_index_health_samples;
drop function if exists public.repair_search_index(text[]);
