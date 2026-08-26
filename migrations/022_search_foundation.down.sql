-- 022_search_foundation rollback
--
-- Removes only the derived topic-search projection. Public clip, speech, source
-- and politician rows remain untouched.

drop trigger if exists sources_sync_search_documents on public.sources;
drop trigger if exists speeches_sync_search_documents on public.speeches;
drop trigger if exists clips_sync_search_document on public.clips;

drop function if exists public.search_clip_keywords(
  text, integer, uuid, text, date, date, uuid[]
);
drop function if exists private.sync_source_search_documents_trigger();
drop function if exists private.sync_speech_search_documents_trigger();
drop function if exists private.sync_clip_search_document_trigger();
drop function if exists private.refresh_clip_search_document(text);
drop function if exists private.clip_search_document_input(text);

drop table if exists private.search_system_state;
drop table if exists private.search_rate_limit_buckets;
drop table if exists private.search_person_aliases;
drop table if exists private.search_event_aliases;
drop table if exists private.search_event_sources;
drop table if exists private.search_events;
drop table if exists private.clip_search_documents;
