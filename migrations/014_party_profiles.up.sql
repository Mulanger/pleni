-- 014_party_profiles
--
-- Canonical public metadata for the eight parties represented in the Riksdag.
-- Membership and clip totals remain relational queries over politicians,
-- speeches and clips; storing those changing numbers here would make them stale.

create table if not exists public.party_profiles (
  code text primary key,
  name text not null,
  short_name text not null,
  color text not null,
  display_order smallint not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint party_profiles_code
    check (code in ('S', 'M', 'SD', 'C', 'V', 'KD', 'MP', 'L')),
  constraint party_profiles_color
    check (color ~ '^#[0-9A-Fa-f]{6}$')
);

insert into public.party_profiles (code, name, short_name, color, display_order)
values
  ('S', 'Socialdemokraterna', 'Socialdemokraterna', '#E8112D', 1),
  ('M', 'Moderaterna', 'Moderaterna', '#3E9FD1', 2),
  ('SD', 'Sverigedemokraterna', 'Sverigedemokr.', '#B99A00', 3),
  ('C', 'Centerpartiet', 'Centerpartiet', '#009933', 4),
  ('V', 'Vänsterpartiet', 'Vänsterpartiet', '#AF0000', 5),
  ('KD', 'Kristdemokraterna', 'Kristdemokr.', '#005CA9', 6),
  ('MP', 'Miljöpartiet', 'Miljöpartiet', '#4F9B2E', 7),
  ('L', 'Liberalerna', 'Liberalerna', '#006AB3', 8)
on conflict (code) do update set
  name = excluded.name,
  short_name = excluded.short_name,
  color = excluded.color,
  display_order = excluded.display_order,
  updated_at = now();

create index if not exists politicians_party_idx on public.politicians (party);

alter table public.party_profiles enable row level security;

drop policy if exists party_profiles_public_read on public.party_profiles;
create policy party_profiles_public_read
  on public.party_profiles for select to anon, authenticated
  using (true);

grant select on public.party_profiles to anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.party_profiles from anon, authenticated;
grant all on public.party_profiles to service_role;
