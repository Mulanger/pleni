-- UI21.5: keep profile catalogue reads index-backed as the clip table grows.

create index if not exists speeches_politician_source_idx
  on public.speeches (politician_id, source_id)
  where politician_id is not null;

create index if not exists speeches_party_source_idx
  on public.speeches (party, source_id)
  where party is not null;

create index if not exists sources_debate_date_id_idx
  on public.sources (debate_date desc, id);

create index if not exists clips_profile_catalogue_idx
  on public.clips (speech_id, published_at desc, id)
  where moderation <> 'rejected'
    and published_at is not null
    and url_540x960 <> '';
