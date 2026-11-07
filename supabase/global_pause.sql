-- Den globala pausen — en gång om dagen pausar alla samtidigt. Körs för hand
-- i Supabase SQL-editorn efter circles.sql och wishlist.sql
-- (`shares_circle_with`). Idempotent rakt igenom, och den lägger bara till:
-- inget befintligt ändras utom en trigger på `pause_sessions`, som inte kan
-- fälla en paus.
--
-- Klienten är lib/globalPause.ts. Reglerna, kort:
--
-- * **Ett enda ögonblick för hela världen**, visat i var och ens lokala tid.
--   Schemat står i Stockholmstid: en rad per veckodag, ändras här och ingen
--   annanstans. En gemensam tid ger ett rum och en summa; låter man var och en
--   välja tidszon delas rummet.
-- * **Dörren** står öppen från 10 minuter före till 30 minuter efter starten.
--   Den egna pausen går sedan hur länge som helst, och den globala blir DONE
--   vid sitt slut utan att röra pausen.
-- * **Man anmäler sig när som helst före**, från att den förra tagit slut.
-- * **Alla i rummet syns med användarnamn**, på begäran: att anmäla sig är att
--   kliva in i rummet. Tabellen har inga grants, och `get_global_pause` lämnar
--   aldrig ut ett user_id. Egna intentioner visas inte för någon annan.
-- * **Den som gått ut får gå in igen** så länge dörren står öppen. Raden
--   öppnas igen och tiden läggs till; efter dörren är en ny paus en vanlig paus.
-- * **Bara den som anmält sig räknas.** En vanlig paus rapporterar också, men
--   utan rad händer ingenting.

create table if not exists global_pause_schedule (
  -- ISO-veckodag: 1 = måndag, 7 = söndag.
  weekday    int primary key check (weekday between 1 and 7),
  start_time time not null,
  minutes    int not null check (minutes > 0)
);

alter table global_pause_schedule enable row level security;

insert into global_pause_schedule (weekday, start_time, minutes) values
  (1, '19:00', 60),
  (2, '18:00', 60),
  (3, '17:00', 60),
  (4, '20:00', 60),
  (5, '18:00', 60),
  (6, '11:00', 60),
  (7, '13:00', 60)
on conflict (weekday) do update
  set start_time = excluded.start_time, minutes = excluded.minutes;

create table if not exists global_pause_joins (
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  user_id         uuid not null references profiles(id) on delete cascade,
  intention_id    text,
  signed_up_at    timestamptz not null default now(),
  -- Null tills pausen börjat: då är personen bara anmäld.
  started_at      timestamptz,
  -- Satt medan klockan går. Null efter start betyder *on hold*.
  running_since   timestamptz,
  -- Tid som redan räknats, utan det pågående varvet.
  counted_seconds int not null default 0,
  finished_at     timestamptz,
  primary key (starts_at, user_id)
);

create index if not exists global_pause_joins_user_idx on global_pause_joins (user_id, starts_at desc);

-- Inga grants, som ledgern: allt går genom funktionerna nedan.
alter table global_pause_joins enable row level security;
revoke all on global_pause_joins from anon, authenticated;
revoke all on global_pause_schedule from anon, authenticated;

create or replace function global_pause_open_before() returns interval
language sql immutable as $$ select interval '10 minutes' $$;

create or replace function global_pause_open_after() returns interval
language sql immutable as $$ select interval '30 minutes' $$;

-- De inbyggda intentionerna (`DEFAULT_CATEGORIES`). Bara de får visas för
-- andra: en egen intention är fritext, och där står *Someone is pausing*.
create or replace function global_pause_public_intentions() returns text[]
language sql immutable as $$
  select array['focus','walk','workout','social','clean','meditate','read','study','rest','create','music','nature']
$$;

-- Första globala pausen som slutar efter `p_at`.
create or replace function global_pause_next(p_at timestamptz default now())
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select o.starts_at, o.starts_at + make_interval(mins => o.minutes)
    from (
      select ((l.day + s.start_time) at time zone 'Europe/Stockholm') as starts_at, s.minutes
        from generate_series(-1, 8) as d(n)
        cross join lateral (
          select ((p_at at time zone 'Europe/Stockholm')::date + d.n) as day
        ) l
        join global_pause_schedule s on s.weekday = extract(isodow from l.day)::int
    ) o
   where o.starts_at + make_interval(mins => o.minutes) > p_at
   order by o.starts_at
   limit 1
$$;

-- Tiden för en rad just nu, kapad vid den globala pausens slut.
create or replace function global_pause_seconds(j global_pause_joins, p_now timestamptz)
returns int
language sql
stable
as $$
  select j.counted_seconds + case
    when j.running_since is null then 0
    else greatest(0, extract(epoch from (least(p_now, j.ends_at) - j.running_since)))::int
  end
$$;

revoke execute on function global_pause_next(timestamptz) from public, anon;
revoke execute on function global_pause_seconds(global_pause_joins, timestamptz) from public, anon, authenticated;


-- ── Anmälan ─────────────────────────────────────────────────────────────────
--
-- Gäller alltid nästa globala paus. Att anmäla sig igen byter bara intention.
create or replace function join_global_pause(p_intention_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_starts timestamptz;
  v_ends timestamptz;
begin
  if auth.uid() is null then
    raise exception 'You are not signed in.';
  end if;
  select n.starts_at, n.ends_at into v_starts, v_ends from global_pause_next() n;

  if now() > v_starts + global_pause_open_after() then
    raise exception 'This global pause has closed.';
  end if;

  insert into global_pause_joins (starts_at, ends_at, user_id, intention_id)
  values (v_starts, v_ends, auth.uid(), nullif(left(p_intention_id, 64), ''))
  on conflict (starts_at, user_id) do update set intention_id = excluded.intention_id;

  return jsonb_build_object('starts_at', v_starts, 'ends_at', v_ends);
end;
$$;

-- Går bara före pausens start: den som pausat står kvar i rummet.
create or replace function leave_global_pause()
returns void
language sql
security definer
set search_path = public
as $$
  delete from global_pause_joins
   where user_id = auth.uid()
     and started_at is null
     and starts_at = (select n.starts_at from global_pause_next() n);
$$;


-- ── Pausen rapporterar ──────────────────────────────────────────────────────
--
-- `running` när klockan går, `held` när den fryser, `finished` när pausen
-- slutar. Tiden räknas här och inte i klienten, och en rapport som aldrig kom
-- fram gör bara att raden ligger efter tills nästa kommer. Utan anmälan
-- finns ingen rad, och då händer ingenting.
create or replace function report_global_pause(p_event text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  j global_pause_joins%rowtype;
  v_now timestamptz := now();
begin
  if auth.uid() is null or p_event not in ('running', 'held', 'finished') then
    return;
  end if;

  -- En avslutad rad öppnas igen av en ny start så länge dörren står öppen:
  -- den som gått ut får gå in igen, och tiden läggs till den som redan räknats.
  select * into j
    from global_pause_joins g
   where g.user_id = auth.uid()
     and (g.finished_at is null
          or (p_event = 'running' and v_now <= g.starts_at + global_pause_open_after()))
     and g.starts_at - global_pause_open_before() <= v_now
     and g.starts_at > v_now - interval '1 day'
   order by g.starts_at desc
   limit 1;

  if j.user_id is null then
    return;
  end if;

  if p_event = 'running' then
    -- Dörren gäller bara första starten. Den som redan pausar får fortsätta.
    if j.started_at is null and v_now > j.starts_at + global_pause_open_after() then
      return;
    end if;
    update global_pause_joins g
       set started_at = coalesce(g.started_at, v_now),
           running_since = coalesce(g.running_since, v_now),
           finished_at = null
     where g.starts_at = j.starts_at and g.user_id = j.user_id;
    return;
  end if;

  if j.started_at is null then
    return;
  end if;

  update global_pause_joins g
     set counted_seconds = global_pause_seconds(g, v_now),
         running_since = null,
         finished_at = case when p_event = 'finished' then v_now else g.finished_at end
   where g.starts_at = j.starts_at and g.user_id = j.user_id;
end;
$$;


-- ── Lådpauser ───────────────────────────────────────────────────────────────
--
-- En lådpaus rapporterar ingenting medan den pågår: raden skrivs när den är
-- slut (lib/sessionOutbox.ts, record_box_session). Då räknas den in, med den
-- tid den låg inom den globala pausen. `exception when others`: en paus får
-- aldrig falla på det här.
create or replace function count_box_pause_in_global()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update global_pause_joins g
     set started_at = new.started_at,
         finished_at = new.ended_at,
         counted_seconds = greatest(0, extract(epoch from (
           least(new.ended_at, g.ends_at) - greatest(new.started_at, g.starts_at)
         )))::int
   where g.user_id = new.user_id
     and g.started_at is null
     and new.started_at between g.starts_at - global_pause_open_before()
                            and g.starts_at + global_pause_open_after();
  return null;
exception when others then
  return null;
end;
$$;

revoke execute on function count_box_pause_in_global() from public, anon, authenticated;

drop trigger if exists pause_sessions_count_box_in_global on pause_sessions;
create trigger pause_sessions_count_box_in_global
  after insert on pause_sessions
  for each row
  when (new.with_pod is true and new.kind = 'pause' and new.ended_at is not null)
  execute function count_box_pause_in_global();


-- ── Rummet ──────────────────────────────────────────────────────────────────
--
-- Nästa globala paus med allt rummet visar, plus `last`: den som slutat
-- senaste kvarten, så att rummet kan säga DONE.
--
-- `people` bär aldrig ett user_id.
create or replace function get_global_pause()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_now timestamptz := now();
  v_starts timestamptz;
  v_ends timestamptz;
  v_public text[] := global_pause_public_intentions();
  v_me_row global_pause_joins%rowtype;
  v_last jsonb;
  v_counts jsonb;
  v_people jsonb;
begin
  if v_me is null then
    return null;
  end if;
  select n.starts_at, n.ends_at into v_starts, v_ends from global_pause_next() n;

  select * into v_me_row from global_pause_joins g where g.starts_at = v_starts and g.user_id = v_me;

  select jsonb_build_object(
           'signed_up', count(*),
           'pausing', count(*) filter (where g.running_since is not null),
           'total_seconds', coalesce(sum(global_pause_seconds(g, v_now)), 0)
         )
    into v_counts
    from global_pause_joins g
   where g.starts_at = v_starts;

  with friends as (
    select case when f.requester_id = v_me then f.receiver_id else f.requester_id end as id
      from friendships f
     where f.status = 'accepted' and (f.requester_id = v_me or f.receiver_id = v_me)
  ),
  mates as (
    select distinct o.user_id as id
      from circle_members m
      join circle_members o on o.circle_id = m.circle_id
     where m.user_id = v_me and o.user_id <> v_me
  ),
  r as (
    select g, p.username, p.avatar_url,
           g.user_id = v_me as is_me,
           exists (select 1 from mates x where x.id = g.user_id) as is_circle,
           exists (select 1 from friends x where x.id = g.user_id) as is_friend,
           case when g.finished_at is not null then 'done'
                when g.running_since is not null then 'pausing'
                when g.started_at is not null then 'on_hold'
                else 'signed_up' end as state
      from global_pause_joins g
      join profiles p on p.id = g.user_id
     where g.starts_at = v_starts
  ),
  ranked as (
    select r.*, row_number() over (
             order by r.is_me desc, r.is_circle desc, r.is_friend desc,
                      case r.state when 'pausing' then 0 when 'on_hold' then 1 when 'signed_up' then 2 else 3 end,
                      (r.g).signed_up_at
           ) as n
      from r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', t.n,
           'relation', case when t.is_me then 'me' when t.is_circle then 'circle'
                            when t.is_friend then 'friend' else 'stranger' end,
           'name', t.username,
           'avatar_url', t.avatar_url,
           'intention_id', case when t.is_me or (t.g).intention_id = any (v_public)
                                then (t.g).intention_id end,
           'state', t.state,
           'seconds', global_pause_seconds(t.g, v_now),
           'running', (t.g).running_since is not null
         ) order by t.n), '[]'::jsonb)
    into v_people
    from (select * from ranked where n <= 200) t;

  select jsonb_build_object(
           'starts_at', x.starts_at,
           'was_there', coalesce(bool_or(g.user_id = v_me and g.started_at is not null), false),
           'people', count(*) filter (where g.started_at is not null),
           'total_seconds', coalesce(sum(global_pause_seconds(g, v_now)) filter (where g.started_at is not null), 0)
         )
    into v_last
    from (
      select j.starts_at from global_pause_joins j
       where j.ends_at <= v_now and j.ends_at > v_now - interval '15 minutes'
       order by j.starts_at desc limit 1
    ) x
    join global_pause_joins g on g.starts_at = x.starts_at
   group by x.starts_at;

  return jsonb_build_object(
    'starts_at', v_starts,
    'ends_at', v_ends,
    'opens_at', v_starts - global_pause_open_before(),
    'closes_at', v_starts + global_pause_open_after(),
    'server_now', v_now,
    'me', case when v_me_row.user_id is null then null else jsonb_build_object(
      'intention_id', v_me_row.intention_id,
      'started', v_me_row.started_at is not null,
      'finished', v_me_row.finished_at is not null
    ) end,
    'counts', v_counts,
    'people', v_people,
    'last', v_last
  );
end;
$$;

revoke execute on function join_global_pause(text) from public, anon;
revoke execute on function leave_global_pause() from public, anon;
revoke execute on function report_global_pause(text) from public, anon;
revoke execute on function get_global_pause() from public, anon;
grant execute on function join_global_pause(text) to authenticated;
grant execute on function leave_global_pause() to authenticated;
grant execute on function report_global_pause(text) to authenticated;
grant execute on function get_global_pause() to authenticated;


-- ── Statistiken ─────────────────────────────────────────────────────────────
--
-- Mina globala pauser, så att statistiken kan märka pausen som låg i en
-- (jordklotet under lådan på kortet). Klienten matchar på tid: en paus som
-- överlappar [started_at, finished_at eller ends_at]. Ingen kolumn på
-- pause_sessions, för raden skrivs innan pausskärmen hunnit rapportera slutet,
-- och lådpausen skrivs av lådan.
create or replace function get_my_global_pauses()
returns table (started_at timestamptz, finished_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select g.started_at, g.finished_at, g.ends_at
    from global_pause_joins g
   where g.user_id = auth.uid() and g.started_at is not null
   order by g.starts_at desc
   limit 500
$$;

revoke execute on function get_my_global_pauses() from public, anon;
grant execute on function get_my_global_pauses() to authenticated;


-- ── Efter pausen ────────────────────────────────────────────────────────────
--
-- Var pausen som just slutade en del av en Global Pause? Sammanfattningen
-- (app/pausesummary.tsx) frågar direkt när pausen slutat, och då kan
-- `finished` ännu inte ha hunnit fram: därför räknas också en rad som
-- fortfarande går. Bara de senaste tio minuterna, så att en senare ensam paus
-- inte får den globala sammanfattningen.
create or replace function get_my_last_global_result()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  j global_pause_joins%rowtype;
  v_now timestamptz := now();
  v_people int;
  v_total bigint;
begin
  if auth.uid() is null then
    return null;
  end if;
  select * into j
    from global_pause_joins g
   where g.user_id = auth.uid()
     and g.started_at is not null
     and coalesce(g.finished_at, v_now) > v_now - interval '10 minutes'
     and g.starts_at > v_now - interval '1 day'
   order by g.starts_at desc
   limit 1;
  if j.user_id is null then
    return null;
  end if;
  select count(*) filter (where g.started_at is not null),
         coalesce(sum(global_pause_seconds(g, v_now)) filter (where g.started_at is not null), 0)
    into v_people, v_total
    from global_pause_joins g
   where g.starts_at = j.starts_at;
  return jsonb_build_object(
    'starts_at', j.starts_at,
    'seconds', global_pause_seconds(j, v_now),
    'people', v_people,
    'total_seconds', v_total
  );
end;
$$;

revoke execute on function get_my_last_global_result() from public, anon;
grant execute on function get_my_last_global_result() to authenticated;
