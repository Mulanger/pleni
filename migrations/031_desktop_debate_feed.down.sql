-- UI17 rollback: restore the UI16-compatible catalogue projection.

drop view if exists public.feed_clip_catalogue;

create view public.feed_clip_catalogue
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
  c.rank_in_speech
from public.clips c
join public.speeches s on s.id = c.speech_id
join public.sources src on src.id = s.source_id
left join public.politicians p on p.id = s.politician_id
where c.moderation <> 'rejected'
  and c.published_at is not null
  and c.url_540x960 <> '';

revoke all on public.feed_clip_catalogue from public;
grant select on public.feed_clip_catalogue to anon, authenticated, service_role;
