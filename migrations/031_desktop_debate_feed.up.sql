-- UI17: expose stable debate identity and chronology to the public feed view.

create or replace view public.feed_clip_catalogue
with (security_invoker = true)
as
select
  c.id,
  c.speech_id,
  s.politician_id,
  p.name as politician_name,
  p.role as politician_role,
  p.avatar_url as politician_avatar_url,
  s.speaker_name,
  coalesce(p.party, s.party) as party,
  s.anforandetyp,
  c.archetype,
  c.title,
  c.transcript,
  c.topic,
  c.duration_s,
  c.url_540x960,
  c.thumb_url,
  src.title as source_title,
  src.source_url,
  src.debate_date,
  c.published_at,
  c.rank_in_speech,
  src.id as source_id,
  s.start_s as speech_start_s,
  c.start_s as clip_start_s
from public.clips c
join public.speeches s on s.id = c.speech_id
join public.sources src on src.id = s.source_id
left join public.politicians p on p.id = s.politician_id
where c.moderation <> 'rejected'
  and c.published_at is not null
  and c.url_540x960 <> '';

revoke all on public.feed_clip_catalogue from public;
grant select on public.feed_clip_catalogue to anon, authenticated, service_role;

comment on view public.feed_clip_catalogue
  is 'Published clip catalogue with UI17 debate identity and master-video chronology';
