drop function if exists public.search_suggestions_v2(text,text);
drop function if exists public.prepare_search_v2(text,boolean,text);
drop function if exists public.load_search_v2_catalog();
drop function if exists private.consume_search_v2_limit(text,text);
drop table if exists private.search_v2_request_buckets;
