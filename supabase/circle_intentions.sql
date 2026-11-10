-- ── Kretsens intentioner ────────────────────────────────────────────────────
-- Körs för hand i SQL-editorn efter circles.sql (som skriver `session_id` i
-- flödets pausrader). Går att köra om.
--
-- Två läsningar, båda `security definer` av samma skäl som
-- get_circle_progress: kretsmedlemmar kan inte läsa varandras
-- pause_sessions, och ska inte kunna. Därför lämnas bara intentionens
-- nyckel ut, aldrig en rad.
--
--   * get_circle_intentions — tiden per medlem och intention för en vecka
--     eller dag, ur ledgern. Samma räknade sekunder som potten, så
--     fördelningen kan aldrig säga mer än ringen.
--   * get_circle_activity_tags — intentionen för flödets pausrader, läst ur
--     pausen NU, så att en tagg som sätts efteråt (på Hem eller i
--     statistiken) syns i flödet.
--
-- **Taggarna är inte hemliga i en krets** (november 2026, på begäran), men
-- **egna intentioner lämnas aldrig ut med namn**: de blir 'other'. En egen
-- intention är fritext och kan säga mer än man tänkt — och den är också
-- vägen för den som vill hålla det för sig själv. Samma regel som
-- Global Pause, där en egen intention står som *is pausing*.

-- De inbyggda intentionerna (DEFAULT_CATEGORIES i app/pauseLogger.ts), som
-- etikett eller id → id. Allt annat som inte är tomt är 'other'. Ändras
-- listan i appen ska den ändras här.
create or replace function circle_intention_key(p_intention text)
returns text
language sql
immutable
as $$
  select case
    when p_intention is null or btrim(p_intention) = '' then null
    else case upper(btrim(p_intention))
      when 'FOCUS' then 'focus'
      when 'WALK' then 'walk'
      when 'WORKOUT' then 'workout'
      when 'SOCIAL' then 'social'
      when 'CLEAN' then 'clean'
      when 'MEDITATION' then 'meditate'
      when 'MEDITATE' then 'meditate'
      when 'READING' then 'read'
      when 'READ' then 'read'
      when 'STUDY' then 'study'
      when 'REST' then 'rest'
      when 'CREATE' then 'create'
      when 'MUSIC' then 'music'
      when 'NATURE' then 'nature'
      else 'other'
    end
  end;
$$;

-- Flödets äldre pausrader saknar `session_id`. Den letas upp en gång ur
-- ledgern: samma krets, samma person, skrivna i samma anrop (inom några
-- sekunder). Rör bara rader som saknar den.
update circle_activity a
   set metadata = a.metadata || jsonb_build_object('session_id', l.session_id)
  from circle_pause_ledger l
 where a.type = 'pause_completed'
   and a.metadata->>'session_id' is null
   and l.circle_id = a.circle_id
   and l.user_id = a.actor_id
   and l.session_id is not null
   and abs(extract(epoch from (a.created_at - l.created_at))) < 5;

-- Tiden per medlem och intention. `p_mode` 'week' med `p_date` = veckans
-- måndag (kretsens vecka, som ledgerns `week_start`), eller 'day' med
-- `p_date` = tittarens lokala datum. Otaggade pauser står som 'untagged' —
-- också en raderad paus, vars ledgerrad står kvar utan session — så att
-- raderna tillsammans blir samma tal som potten.
create or replace function get_circle_intentions(
  p_circle_id uuid, p_mode text, p_date date, p_tz_offset_minutes int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from timestamptz;
begin
  if not exists (
    select 1 from circle_members where circle_id = p_circle_id and user_id = auth.uid()
  ) then
    raise exception 'You are not in this circle.';
  end if;

  v_from := (p_date::timestamp + make_interval(mins => coalesce(p_tz_offset_minutes, 0))) at time zone 'UTC';

  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', t.user_id, 'intention', t.intention, 'seconds', t.seconds))
      from (
        select l.user_id,
               coalesce(circle_intention_key(s.intention), 'untagged') as intention,
               sum(l.seconds)::int as seconds
          from circle_pause_ledger l
          left join pause_sessions s on s.id = l.session_id
         where l.circle_id = p_circle_id
           and case when p_mode = 'day'
                    then l.occurred_at >= v_from and l.occurred_at < v_from + interval '1 day'
                    else l.week_start = p_date
               end
         group by l.user_id, coalesce(circle_intention_key(s.intention), 'untagged')
      ) t
  ), '[]'::jsonb);
end;
$$;

-- Intentionen för de senaste pausraderna i flödet, nyckel per rad. Samma 50
-- som flödet hämtar.
create or replace function get_circle_activity_tags(p_circle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from circle_members where circle_id = p_circle_id and user_id = auth.uid()
  ) then
    raise exception 'You are not in this circle.';
  end if;

  return coalesce((
    select jsonb_object_agg(t.id, t.intention)
      from (
        select a.id, circle_intention_key(s.intention) as intention
          from circle_activity a
          join pause_sessions s on s.id = (a.metadata->>'session_id')::uuid
         where a.circle_id = p_circle_id
           and a.type = 'pause_completed'
           and a.metadata ? 'session_id'
           and circle_intention_key(s.intention) is not null
         order by a.created_at desc
         limit 50
      ) t
  ), '{}'::jsonb);
end;
$$;

revoke all on function get_circle_intentions(uuid, text, date, int) from public;
revoke all on function get_circle_activity_tags(uuid) from public;
grant execute on function get_circle_intentions(uuid, text, date, int) to authenticated;
grant execute on function get_circle_activity_tags(uuid) to authenticated;
