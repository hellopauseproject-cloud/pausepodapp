-- "Pausing now" som inte kan fastna — kör i Supabase SQL-editorn, efter
-- security_hardening.sql och FÖRE appen (klienten läser `pausing_until`, och
-- utan kolumnen faller Friends-pollen). Idempotent.
--
-- `profiles.is_pausing` sattes `true` när pausen började och `false` när den
-- slutade — av appen. Dog appen däremellan (batteriet, en tvångsstängning)
-- stod flaggan kvar tills appen öppnades igen, och vännen syntes som pausande
-- i timmar eller dagar. Ingen klient kan säga "nu dog jag", så flaggan får
-- ett utgångsdatum som servern sätter:
--
--   * **Klockan går:** till nästa lokala midnatt. En paus kan vara hur lång
--     som helst, så det finns inget kortare tak — men en dagpaus blir en natt
--     vid midnatt (app/pausing.tsx), och då är "pausing now" över ändå.
--   * **Klockan fryst** (telefonen lyft, locket öppet): tio minuter. Samma
--     tal som `BACKGROUND_RESTART_MAX_FROZEN_MS` — efter så lång tid kan
--     pausen inte gå igen utan att appen öppnas, och öppnas den skrivs ett
--     nytt läge. Frysningen upptäcks av appen, så appen lever alltid i
--     ögonblicket då det här skrivs.
--   * **Slut:** `false`, som förut.
--
-- "Pausing now" = `is_pausing and pausing_until > now()`. Gränsen skrivs med
-- serverns klocka, så en telefon vars klocka går fel kan inte flytta den.
-- Jämförelsen görs i appen (`isPausingNow` i lib/pausingFlag.ts), med
-- läsarens klocka — ett beräknat fält i PostgREST prövades och går inte:
-- det tar hela profilraden, och det kräver läsrätt på `push_token`.

alter table public.profiles add column if not exists pausing_until timestamptz;

-- Kolumnbehörigheterna i security_hardening.sql räknar upp varje läsbar
-- kolumn. Den här läggs till där också, så att en omkörning av den filen
-- inte tar bort den.
grant select (pausing_until) on public.profiles to authenticated;

-- ── Skrivningen ──────────────────────────────────────────────────────────────
--
-- `p_tz_offset_minutes` är `Date.getTimezoneOffset()` — UTC minus lokal tid,
-- alltså positiv väster om Greenwich. Svarar `true` när raden uppdaterades,
-- så att klienten kan försöka igen när en token inte hunnit förnyas.
create or replace function public.set_pausing_state(p_state text, p_tz_offset_minutes int default 0)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_local timestamp := (now() at time zone 'UTC') - make_interval(mins => coalesce(p_tz_offset_minutes, 0));
  v_midnight timestamptz :=
    ((date_trunc('day', v_local) + interval '1 day') + make_interval(mins => coalesce(p_tz_offset_minutes, 0)))
      at time zone 'UTC';
  v_count int;
begin
  if auth.uid() is null then return false; end if;
  if p_state not in ('running', 'frozen', 'off') then
    raise exception 'Unknown pausing state: %', p_state;
  end if;

  update public.profiles
     set is_pausing = (p_state <> 'off'),
         pausing_until = case p_state
           when 'running' then v_midnight
           when 'frozen'  then least(now() + interval '10 minutes', v_midnight)
           else null
         end
   where id = auth.uid();
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function public.set_pausing_state(text, int) from public, anon;
grant execute on function public.set_pausing_state(text, int) to authenticated;

-- ── Äldre appar ──────────────────────────────────────────────────────────────
--
-- En app från före den här filen skriver `is_pausing` direkt och vet inget om
-- `pausing_until`. Utan ett värde vore flaggan osynlig för de nya apparna
-- (`null > now()` är inte sant), så en `true` utan tid får 24 timmar — längre
-- än någon dagpaus kan pågå, och kortare än "för alltid". En `false` tömmer
-- tiden.
create or replace function public.profiles_pausing_until_default()
returns trigger
language plpgsql
as $$
begin
  if not new.is_pausing then
    new.pausing_until := null;
  elsif new.pausing_until is null then
    new.pausing_until := now() + interval '24 hours';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_pausing_until_default on public.profiles;
create trigger profiles_pausing_until_default
  before insert or update of is_pausing, pausing_until on public.profiles
  for each row execute function public.profiles_pausing_until_default();

-- Flaggor som står `true` just nu får samma 24 timmar. En del av dem har
-- fastnat, och de släcks i och med det.
update public.profiles
   set pausing_until = now() + interval '24 hours'
 where is_pausing and pausing_until is null;
