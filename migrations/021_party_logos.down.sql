alter table public.party_profiles
  drop column if exists logo_mirrored_at,
  drop column if exists logo_sha256,
  drop column if exists logo_source_url,
  drop column if exists logo_url;
