-- Roll back only the automatic entity projections and synchronisation added by
-- 023. Curated/manual event and alias rows remain intact.

drop trigger if exists sources_sync_search_event on public.sources;
drop trigger if exists clips_sync_search_event on public.clips;
drop trigger if exists speeches_sync_search_entities on public.speeches;
drop trigger if exists politicians_sync_search_aliases on public.politicians;

delete from private.search_person_aliases
where provenance like 'automatic:%';

delete from private.search_events
where event_kind = 'source'
  and provenance = 'automatic:public.sources'
  and event_key like 'source:%';

drop function if exists private.sync_source_search_event_trigger();
drop function if exists private.sync_clip_search_event_trigger();
drop function if exists private.sync_speech_search_entities_trigger();
drop function if exists private.sync_politician_search_aliases_trigger();
drop function if exists private.refresh_source_search_event(uuid);
drop function if exists private.refresh_search_person_aliases(uuid);
drop function if exists private.strip_search_person_title(text);
drop function if exists private.normalize_search_entity(text);
