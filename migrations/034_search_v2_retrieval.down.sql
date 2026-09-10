drop function if exists public.search_clips_v2(text,text,integer,uuid,text,date,date,uuid[],text,jsonb,timestamptz);
drop function if exists private.search_v2_expanded_query(text);
drop function if exists private.search_v2_edit_distance(text,text);
drop trigger if exists search_v2_collect_words on private.clip_search_documents;
drop function if exists private.search_v2_collect_words();
drop table if exists private.search_v2_words;
alter table private.clip_search_documents drop column if exists context_vector;
drop function if exists private.search_v2_fold(text);
-- pg_trgm may have acquired other consumers; retain the shared extension.
