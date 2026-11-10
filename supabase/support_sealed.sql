-- Stöd som öppnas efter en paus.
-- Körs för hand i Supabase SQL-editorn, efter support_photo.sql och
-- sleep.sql (samma konvention som resten av mappen). Allt är idempotent.
-- Kör om social_notify.sql efteråt: notisen säger *Take a pause to open.*
-- för ett förseglat svar.
--
-- ─── Vad det är ───────────────────────────────────────────────────────────
-- Den som skickar stöd väljer *Opens: Now / After a pause*
-- (components/opens-picker.tsx). Ett förseglat svar ligger som ett kuvert
-- med pausens sigill i mottagarens Support-flik (*Take a pause to open*) och
-- låses upp när mottagaren gjort en riktig paus efter att det skickades.
-- Belöningen kommer alltså efter pausen, och stödet blir ett skäl att ta den.
--
-- **Spärren sitter här, inte i appen.** En restriktiv SELECT-policy gör att
-- mottagaren inte kan läsa ett förseglat svar alls — varken text eller länk
-- — förrän det låsts upp. Inkorgen, brickan och kuvertet räknar därför bara
-- upplåsta svar av sig själva. Det förseglade visas genom
-- `get_sealed_support()`, som bara lämnar ut vem och när.
--
-- **Upplåsningen sker när pausen sparas**, av en trigger på pause_sessions:
-- minst `support_unlock_min_seconds()` (2 min, var 3 och sänktes på begäran i november 2026), `kind = 'pause'` (en natt
-- räknas inte), och slutad efter att svaret skickades. Ingen notis när det
-- låses upp: den som just pausat står redan i appen, och Hem säger
-- *Your envelope is ready*.
--
-- Det finns ingen tidsgräns och ingen ångra: kuvertet väntar tills pausen
-- faktiskt blir av, som ett brev man postat.

alter table public.support_responses
  add column if not exists opens_after_pause boolean not null default false,
  add column if not exists unlocked_at timestamptz;

create or replace function public.support_unlock_min_seconds()
returns int language sql immutable as $$ select 120 $$;

-- Restriktiv: läggs med AND ovanpå den befintliga SELECT-policyn (som
-- skapades utanför repot) utan att någon behöver veta hur den ser ut.
-- Avsändaren ser alltid sitt eget svar.
drop policy if exists support_responses_sealed on public.support_responses;
create policy support_responses_sealed on public.support_responses
  as restrictive
  for select
  to authenticated
  using (
    sender_id = auth.uid()
    or opens_after_pause = false
    or unlocked_at is not null
  );

-- Förseglade svar som väntar på mig: vem, och när. Inget innehåll.
create or replace function public.get_sealed_support()
returns table (
  response_id uuid,
  created_at timestamptz,
  sender_id uuid,
  username text,
  avatar_url text
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.created_at, p.id, p.username, p.avatar_url
    from support_responses r
    join support_stories s on s.id = r.story_id
    join profiles p on p.id = r.sender_id
   where s.user_id = auth.uid()
     and r.opens_after_pause
     and r.unlocked_at is null
     and r.delivered_at is null
   order by r.created_at asc;
$$;

revoke all on function public.get_sealed_support() from public, anon;
grant execute on function public.get_sealed_support() to authenticated;

create or replace function public.unlock_support_after_pause()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind is distinct from 'pause'
     or coalesce(new.duration_seconds, 0) < support_unlock_min_seconds()
     or new.ended_at is null then
    return new;
  end if;

  update support_responses r
     set unlocked_at = now()
    from support_stories s
   where s.id = r.story_id
     and s.user_id = new.user_id
     and r.opens_after_pause
     and r.unlocked_at is null
     and r.created_at < new.ended_at;

  return new;
exception when others then
  -- Ett kuvert som inte gick att låsa upp får aldrig fälla pausen.
  raise warning 'unlock_support_after_pause: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists pause_sessions_unlock_support on public.pause_sessions;
create trigger pause_sessions_unlock_support
  after insert or update of ended_at, duration_seconds on public.pause_sessions
  for each row execute function public.unlock_support_after_pause();
