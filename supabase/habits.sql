-- Vanorna — kör den här i Supabase SQL-editorn EFTER supabase/sleep.sql.
-- Samma konvention som resten av mappen: schemat bor här och appliceras för
-- hand. Idempotent rakt igenom.
--
-- ── Vad en vana är ──────────────────────────────────────────────────────────
--
-- Ett vanemål är en intention och ett antal dagar i veckan: *📖 Reading ·
-- 3× a week*. Det är INTE en ny sorts registrering — en vana räknas ur de
-- pauser som redan bär intentionen (`pause_sessions.intention`), vald före
-- pausen eller taggad efteråt. Pausen förblir appens enda handling.
--
-- Fyra regler, alla i `get_habit_progress` nedan:
--
--   * **Dagar, inte pauser.** Två läspauser samma dag är en läsdag. Annars
--     går veckans mål att klara på en eftermiddag, och då är det ingen vana.
--   * **Veckan, inte dagen.** Måndag 00:00 i användarens EGEN tid. Den är
--     personlig och jämförs inte med någon, så den behöver ingen delad gräns
--     (samma resonemang som `daily_goal_achievements`). Ett dagligt vanemål
--     hade blivit ännu ett "missat idag" — skuld är fel motor i den här appen.
--   * **Ett golv:** pauser kortare än fem minuter räknas inte, så att en tagg
--     på en paus på 40 sekunder inte bockar av något.
--   * **Bara pauser** (`kind = 'pause'`), aldrig en natt.
--
-- Högst två vanor per person. Två går att hålla i huvudet; fler är en
-- vanetracker, och det är en annan app. Taket sitter i `set_habit_goals`.
--
-- ── Etikett eller id ────────────────────────────────────────────────────────
--
-- `pause_sessions.intention` bär ibland etiketten (`READING`, som pausskärmen
-- och taggkortet skriver) och ibland id:t (`read`, som lådflödets kö skriver).
-- Egna intentioner finns bara i klienten, så servern kan inte slå upp en
-- etikett ur ett id. Därför sparas BÅDA på målraden (`label` är en kopia vid
-- sparningen) och räkningen matchar på endera, skiftlägesokänsligt.

create table if not exists habit_goals (
  user_id        uuid not null references auth.users(id) on delete cascade,
  category_id    text not null,
  label          text not null,
  times_per_week int  not null check (times_per_week between 1 and 7),
  created_at     timestamptz not null default now(),
  primary key (user_id, category_id)
);

alter table habit_goals enable row level security;

-- Läsning av de egna raderna. Skrivning bara genom `set_habit_goals`, där
-- taket sitter — samma uppdelning som kretsarnas tabeller.
drop policy if exists habit_goals_select_own on habit_goals;
create policy habit_goals_select_own on habit_goals
  for select using (user_id = auth.uid());

revoke all on habit_goals from anon, authenticated;
grant select on habit_goals to authenticated;

-- ── Sparningen ──────────────────────────────────────────────────────────────
--
-- Ersätter hela uppsättningen i en transaktion: rutan på Hem visar alla
-- vanor på en gång och sparar dem med samma knapp som dagsmålet, så det
-- finns inget "lägg till en" att göra separat. `p_goals` är
-- `[{category_id, label, times_per_week}]`; en tom lista tar bort alla.
--
-- `created_at` behålls för en vana som redan fanns, så att en ändring av
-- antalet inte ser ut som en ny vana.
create or replace function set_habit_goals(p_goals jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  if jsonb_typeof(coalesce(p_goals, '[]'::jsonb)) <> 'array' then
    raise exception 'Habits must be a list.';
  end if;
  if jsonb_array_length(coalesce(p_goals, '[]'::jsonb)) > 2 then
    raise exception 'You can have at most two habits.';
  end if;

  delete from habit_goals
   where user_id = v_uid
     and category_id not in (
       select g->>'category_id' from jsonb_array_elements(coalesce(p_goals, '[]'::jsonb)) g
     );

  insert into habit_goals (user_id, category_id, label, times_per_week)
  select v_uid,
         left(trim(g->>'category_id'), 64),
         left(trim(g->>'label'), 64),
         greatest(1, least(7, (g->>'times_per_week')::int))
    from jsonb_array_elements(coalesce(p_goals, '[]'::jsonb)) g
   where coalesce(trim(g->>'category_id'), '') <> ''
     and coalesce(trim(g->>'label'), '') <> ''
  on conflict (user_id, category_id) do update
     set label = excluded.label,
         times_per_week = excluded.times_per_week;
end;
$$;

revoke all on function set_habit_goals(jsonb) from public, anon;
grant execute on function set_habit_goals(jsonb) to authenticated;

-- ── Läsningen ───────────────────────────────────────────────────────────────
--
-- Inte `security definer`: den läser bara anroparens egna rader, och det
-- släpper RLS redan igenom — samma skäl som `get_daily_goal_progress`.
-- `p_tz_offset_minutes` är `Date.getTimezoneOffset()`, och dygnsuttrycket är
-- detsamma som där, så att Hem och vanorna menar samma sak med "idag".
create or replace function get_habit_progress(p_tz_offset_minutes int default 0)
returns jsonb
language sql
stable
set search_path = public
as $$
  with bounds as (
    select date_trunc('week', now() - make_interval(mins => p_tz_offset_minutes))
           + make_interval(mins => p_tz_offset_minutes) as week_start
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'category_id', h.category_id,
           'label', h.label,
           'times_per_week', h.times_per_week,
           'done_this_week', (
             select count(distinct date_trunc('day', s.ended_at - make_interval(mins => p_tz_offset_minutes)))
               from pause_sessions s, bounds b
              where s.user_id = auth.uid()
                and s.kind = 'pause'
                and s.ended_at is not null
                and s.ended_at >= b.week_start
                and s.duration_seconds >= 300
                and lower(s.intention) in (lower(h.category_id), lower(h.label))
           )
         ) order by h.created_at), '[]'::jsonb)
    from habit_goals h
   where h.user_id = auth.uid();
$$;

grant execute on function get_habit_progress(int) to authenticated;
