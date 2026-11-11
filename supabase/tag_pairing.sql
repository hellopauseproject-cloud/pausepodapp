-- Pause Pod: registrering av NFC-taggar via QR-kod på boxen.
-- Bara nya tabeller. Rör inga befintliga tabeller.

-- Boxar. Varje box har en hemlig nyckel, här sparas bara dess SHA-256-hash.
create table if not exists public.boxes (
  id            text primary key,                 -- t.ex. 'BOX001'
  name          text not null default 'PausePod',
  key_hash      text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

-- Taggar (klistermärken på telefonen) kopplade till ett konto.
create table if not exists public.pause_tags (
  id              uuid primary key default gen_random_uuid(),
  tag_uid         text not null check (tag_uid ~ '^[0-9A-F]{8,20}$'),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  label           text check (label is null or char_length(label) <= 40),
  created_at      timestamptz not null default now(),
  deactivated_at  timestamptz
);
-- En tagg kan bara vara aktiv för ett konto åt gången.
create unique index if not exists pause_tags_active_uid
  on public.pause_tags (tag_uid) where deactivated_at is null;
create index if not exists pause_tags_user on public.pause_tags (user_id);

-- Engångskoder som visas som QR-kod på boxen. Gäller några minuter.
create table if not exists public.tag_pairing_codes (
  code        text primary key check (code ~ '^[A-Z0-9]{6,10}$'),
  box_id      text not null references public.boxes(id) on delete cascade,
  tag_uid     text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  claimed_at  timestamptz,
  claimed_by  uuid references public.profiles(id) on delete set null
);
create index if not exists tag_pairing_lookup
  on public.tag_pairing_codes (box_id, tag_uid) where claimed_at is null;
create index if not exists tag_pairing_claimed_by on public.tag_pairing_codes (claimed_by);

-- RLS: boxar och koder nås bara via edge functions (service role).
alter table public.boxes enable row level security;
alter table public.tag_pairing_codes enable row level security;
alter table public.pause_tags enable row level security;

-- Användare ser sina egna taggar och kan inaktivera eller döpa om dem.
drop policy if exists "users read own tags" on public.pause_tags;
create policy "users read own tags" on public.pause_tags
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "users update own tags" on public.pause_tags;
create policy "users update own tags" on public.pause_tags
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Bara label och deactivated_at får ändras av användaren.
revoke all on public.pause_tags from anon, authenticated;
grant select on public.pause_tags to authenticated;
grant update (label, deactivated_at) on public.pause_tags to authenticated;
revoke all on public.boxes, public.tag_pairing_codes from authenticated, anon;

-- Edge-funktionerna (service_role) får arbeta i de tre nya tabellerna. Den
-- riktiga databasen delar inte ut DML till service_role som förval, så utan
-- raden ser box-tag aldrig sina lådor och svarar invalid_box.
grant select, insert, update, delete on public.boxes, public.pause_tags, public.tag_pairing_codes to service_role;

-- Lådan behöver bara ägarens användarnamn, inte läsrätt på profiles.
create or replace function public.tag_owner_username(p_tag_uid text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.username
  from public.pause_tags t
  join public.profiles p on p.id = t.user_id
  where t.tag_uid = p_tag_uid and t.deactivated_at is null
  limit 1;
$$;
revoke execute on function public.tag_owner_username(text) from public, anon, authenticated;
grant execute on function public.tag_owner_username(text) to service_role;
