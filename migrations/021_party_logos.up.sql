-- 021_party_logos
--
-- Official party marks are mirrored to verified, immutable Bunny objects. The
-- Riksdagen URL is provenance only and is never a frontend fallback.

alter table public.party_profiles
  add column if not exists logo_url text,
  add column if not exists logo_source_url text,
  add column if not exists logo_sha256 text,
  add column if not exists logo_mirrored_at timestamptz;

update public.party_profiles as party
set logo_source_url = source.url
from (
  values
    ('S', 'https://bilder.riksdagen.se/publishedmedia/e9omiy7wkxkhts7ptwal/Symbol_Socialdemokraterna-_134px.png'),
    ('M', 'https://bilder.riksdagen.se/publishedmedia/p9df8v4c3f4fvupc7oqx/Symbol_Moderaterna_125px.png'),
    ('SD', 'https://bilder.riksdagen.se/publishedmedia/6gxtyz3j95i9xr0ejrbn/Sveriedemokraterna_132px.png'),
    ('C', 'https://bilder.riksdagen.se/publishedmedia/n8ppx8bt2189jfei9f7g/Symbol_Centern_125.png'),
    ('V', 'https://bilder.riksdagen.se/publishedmedia/4a9gkf3jqwprajbmcqt8/Symbol_Va-nsterpartiet_121px.png'),
    ('KD', 'https://bilder.riksdagen.se/publishedmedia/bnz3yl48fswzmc8cd4m8/KD_partilogga.png'),
    ('MP', 'https://bilder.riksdagen.se/publishedmedia/3sgk8lpoqlu2mht11nov/MP_partilogga.png'),
    ('L', 'https://bilder.riksdagen.se/publishedmedia/r0mdg32vrghp96agrxax/L_partilogga.png')
) as source(code, url)
where party.code = source.code;

alter table public.party_profiles
  alter column logo_source_url set not null;

alter table public.party_profiles
  drop constraint if exists party_profiles_logo_source,
  add constraint party_profiles_logo_source
    check (logo_source_url ~ '^https://bilder[.]riksdagen[.]se/'),
  drop constraint if exists party_profiles_logo_url,
  add constraint party_profiles_logo_url
    check (logo_url is null or logo_url ~ '^https://'),
  drop constraint if exists party_profiles_logo_sha256,
  add constraint party_profiles_logo_sha256
    check (logo_sha256 is null or logo_sha256 ~ '^[0-9a-f]{64}$'),
  drop constraint if exists party_profiles_logo_verified_pair,
  add constraint party_profiles_logo_verified_pair
    check ((logo_url is null) = (logo_sha256 is null));

revoke insert, update, delete, truncate, references, trigger
  on public.party_profiles from anon, authenticated;
grant select on public.party_profiles to anon, authenticated;
grant all on public.party_profiles to service_role;
