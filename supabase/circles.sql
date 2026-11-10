-- Circles feature — run this in the Supabase SQL editor.
-- Mirrors the existing convention in this project (see the RPC comment
-- block at the top of app/add-friend.tsx): schema lives here, not in a
-- migrations tool, and is applied by hand.
--
-- Idempotent end to end — every statement is safe to re-run (e.g. after a
-- partial failure) without manually dropping anything first.
--
-- ── Två system, inte ett ────────────────────────────────────────────────────
--
-- 1. VECKOMÅLET är en tabell av personliga mål, inte ett tal. Varje medlem
--    sätter sitt eget `profiles.daily_target_seconds`. Veckans ribba per person är
--    det talet gånger sju; cirkelns pott är SUMMAN av dem, och veckan är
--    vunnen först när VARJE medlem klarat sin egen.
--    Potten kan alltså stå på 94% och ändå vara olåst för att en person
--    saknas — det är meningen, inte en bugg, och UI:t måste säga det rakt ut.
--
-- 2. STEGEN är cirkelns livstidssumma, och den räknas ur `circle_pause_ledger`
--    — en rad per räknad session — inte ur en summering av medlemmarnas
--    `pause_sessions` vid läsning. Skillnaden syns först senare: en medlem som
--    lämnar skulle annars radera timmar cirkeln faktiskt klättrat, och en ny
--    medlem skulle teleportera cirkeln tre nivåer på historik hen samlat
--    ensam. Ledgern räknar bara det som hände MEDAN ni var i cirkeln ihop, och
--    den går aldrig bakåt.
--
-- Veckogränsen är måndag 00:00 UTC för alla medlemmar (`circle_week_start()`).
-- Delad gräns framför lokal: en cirkel som spänner över tidszoner ska nå målet
-- i samma ögonblick, inte vid midnatt i fyra olika länder.
--
-- ── Upp till tre kretsar per person ─────────────────────────────────────────
-- Man var förr med i högst EN krets, och det var `circle_members.user_id
-- UNIQUE` som var hela mekanismen. Nu är taket tre (`circle_max_per_user()`),
-- och nyckeln är paret `(circle_id, user_id)`. Två regler bär resten:
--
--   * **En paus räknas i varje krets man är med i.** `record_circle_pause`
--     skriver en ledgerrad per krets, och dubblettskyddet sitter därför på
--     `(circle_id, session_id)` och inte på `session_id` ensam. Det är det
--     enda som går att förklara på en rad ("your pauses count in every
--     circle you're in"); att välja krets per paus vore ett beslut efter
--     varje paus.
--   * **Dagsmålet är fortfarande ett.** Det bor på `profiles`, och varje krets
--     läser samma tal. Ändras det loggas ändringen i varje krets flöde.
--
-- RPC:er som förr slog upp "kretsen" tar numera `p_circle_id`, med `null`
-- som förval. `null` betyder den krets man gick med i först
-- (`resolve_my_circle`), så att en äldre app som inte skickar något id
-- fortsätter fungera för den som bara är med i en.

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists circles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists circles_created_by_idx on circles(created_by);

-- Cirkeln har ingen delad fritext längre. `group_goal` var det enhälligt
-- bekräftade gruppmålet, och `pact` hette samma kolumn en kort stund när den
-- skulle bli en överenskommelse i ord i stället — men ingenting läste den, och
-- utan omröstning fanns inget som höll ihop den. Det delade är potten och
-- stegen; det personliga är veckomålet och planerna i text. Båda namnen droppas
-- så att databasen hamnar rätt oavsett vilket skede den står i.
alter table circles drop column if exists pact;
alter table circles drop column if exists group_goal;

-- ── Kretsens inställningar ──────────────────────────────────────────────────
-- Två val som ägaren gör när kretsen skapas, och kan ändra i medlemslistan.
-- Det är inställningar för kretsen och inget innehåll — därför ägarens, till
-- skillnad från belöningsförslagen och chatten där ägaren inte har mer makt
-- än någon annan.
--
-- **`rewards_enabled`** — om kretsen har en belöning (supabase/circle_rewards.sql).
-- Av som förval: en fika varje gång alla nått sina mål blir för mycket för
-- många grupper, och att slå på det ska vara ett val.
--
-- **Räknefönstret** — vilka timmar och dagar en paus räknas i potten. En
-- arbetsplats vill räkna 08–17 måndag–fredag; en kompisgrupp dygnet runt.
--   * `count_from`/`count_to` är hela timmar (0–23 / 1–24) i varje medlems
--     EGEN lokala tid. Båda null = dygnet runt. En arbetsplats ligger nästan
--     alltid i en tidszon, och en kompisgrupp har inget fönster, så den egna
--     tiden är den enda som går att förklara.
--   * `count_workdays` = bara måndag–fredag. Veckans ribba blir då dagsmålet
--     × 5 i stället för × 7 (`circle_count_days()`), annars kan en
--     arbetsplats aldrig vinna en vecka.
--   * Fönstret tillämpas när pausen skrivs till ledgern
--     (`record_circle_pause`), inte vid läsning: en paus 16:30–17:30 med
--     fönster till 17 ger en rad på halva pausen, och raden ändras inte om
--     fönstret ändras senare. Stegen och historiken skrivs alltså aldrig om.
--   * **En ändring gäller från nästa måndag** (`pending_count_*`, flyttas
--     fram av `promote_circle_settings()` vid veckoskiftet) — samma skäl som
--     att veckans ribba inte ska kunna flyttas medan veckan pågår. Undantag:
--     kretsens första vecka, då gäller ändringen genast, för då har ingen
--     hunnit pausa mot det gamla fönstret.
--   * Hem påverkas inte: ringen där räknar alltid ens egna pauser dygnet runt
--     (`get_daily_goal_progress`). Bara kretsens pott följer fönstret.
alter table circles add column if not exists rewards_enabled boolean not null default false;
alter table circles add column if not exists count_from smallint check (count_from between 0 and 23);
alter table circles add column if not exists count_to smallint check (count_to between 1 and 24);
alter table circles add column if not exists count_workdays boolean not null default false;
alter table circles add column if not exists pending_count_week date;
alter table circles add column if not exists pending_count_from smallint check (pending_count_from between 0 and 23);
alter table circles add column if not exists pending_count_to smallint check (pending_count_to between 1 and 24);
alter table circles add column if not exists pending_count_workdays boolean;

create table if not exists circle_members (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references circles(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now()
);
create index if not exists circle_members_circle_id_idx on circle_members(circle_id);

-- Upp till tre kretsar per person: `user_id` är inte längre unik ensam, paret
-- är det. Constrainten hette `circle_members_user_id_key` (Postgres namn för
-- en kolumn-`unique`) och droppas här, så att en befintlig databas hamnar där
-- en ny hamnar. Taket på tre är ingen constraint — det sitter i
-- `create_circle` och `accept_circle_invite`.
alter table circle_members drop constraint if exists circle_members_user_id_key;
create unique index if not exists circle_members_circle_user_key on circle_members(circle_id, user_id);
create index if not exists circle_members_user_id_idx on circle_members(user_id, joined_at);

-- ── Målet bor INTE här längre ───────────────────────────────────────────────
-- `daily_target_seconds` låg på medlemsraden ("ett mål per person" kom gratis
-- av att `user_id` är UNIQUE här), men ett personligt mål som bara existerar
-- inne i en krets går inte att ha ensam: ringen på Hem stod tom och
-- introduktionen kunde inte spara siffran den just frågat om. Talet ligger nu
-- på `profiles.daily_target_seconds` — se supabase/dailygoal.sql, som också
-- flyttar över befintliga värden. Kolumnen nedan står kvar oläst och oskriven,
-- för kolumner droppas inte i den här filen.
--
-- Funktionerna här läser alltså målet via en join mot profiles:
-- `evaluate_circle_goals`, `get_circle_progress` och `get_circle_wrapped`.
-- Lägger du till en fjärde läsare, joina profiles där också — en kopia
-- tillbaka hit och de två talen glider isär utan att något felar.
--
-- ── Dagen bär vanan, veckan bär ansvaret ────────────────────────────────────
-- Löftet uttrycks PER DAG ("30 min om dagen") eftersom det är i den takten
-- vanan lever och det är den siffran man ser på Hem. Men ingenting mäts per
-- dag: veckans ribba är `daily_target_seconds * 7` (× 5 för en krets som bara
-- räknar vardagar, se `circle_count_days()`), och potten räknar
-- verkliga minuter ur ledgern. En missad tisdag kostar därför ingenting så
-- länge veckan går ihop — man tar igen den på torsdagen.
--
-- En ändring av talet gäller genast, åt båda håll. Se set_daily_goal för
-- varför spärren mot retroaktiva sänkningar togs bort till förmån för att
-- ändringen syns i aktivitetsflödet — och för att den skriver profiles numera.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'circle_members'
               and column_name = 'weekly_target_seconds')
     and not exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'circle_members'
               and column_name = 'daily_target_seconds') then
    alter table circle_members rename column weekly_target_seconds to daily_target_seconds;
  end if;
end;
$$;

alter table circle_members add column if not exists daily_target_seconds int;
alter table circle_members add column if not exists pending_target_seconds int;
-- `pending_target_seconds` och `target_week` är kvar av historiska skäl men
-- skrivs inte längre och läses ingenstans: det fanns en parkerad sänkning som
-- väntade på måndag, och den mekaniken finns inte mer. Kolumner droppas inte
-- i den här filen.
alter table circle_members add column if not exists target_week date;

create table if not exists circle_invites (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references circles(id) on delete cascade,
  inviter_id uuid not null references profiles(id) on delete cascade,
  invitee_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now()
);
create unique index if not exists circle_invites_one_pending_idx on circle_invites(circle_id, invitee_id) where status = 'pending';
create index if not exists circle_invites_invitee_idx on circle_invites(invitee_id, status);
create index if not exists circle_invites_circle_id_idx on circle_invites(circle_id);
create index if not exists circle_invites_inviter_id_idx on circle_invites(inviter_id);

-- Punkterna på någons lista bor inte här längre. De var "circle_weekly_goals"
-- men var varken veckovisa eller mål, och de tillhör en person snarare än en
-- krets — se supabase/wishlist.sql, som byter namn på tabellen till
-- wishlist_items och tar över dess grants och policies.

-- Cirkelns delade minne. En rad per räknad paus.
--
-- `session_id` är `on delete set null`, inte cascade, och det är ett medvetet
-- val: stats.tsx låter en användare radera en egen paus ur sin logg, och den
-- raderingen får inte skriva om gruppens historia i efterhand. Cirkeln har
-- redan sett pausen i flödet och i veckans stapel — att klättringen skulle gå
-- bakåt för att någon städat sin egen lista är värre än att raden blir
-- föräldralös. UNIQUE på `(circle_id, session_id)` är samtidigt det som gör
-- record_circle_pause idempotent när outboxen skickar om samma session.
--
-- Paret och inte kolumnen ensam: en paus räknas i varje krets man är med i,
-- så samma session står på upp till tre rader — en per krets.
create table if not exists circle_pause_ledger (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references circles(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  session_id uuid references pause_sessions(id) on delete set null,
  seconds int not null check (seconds >= 0),
  occurred_at timestamptz not null,
  week_start date not null,
  created_at timestamptz not null default now()
);
create index if not exists circle_pause_ledger_week_idx on circle_pause_ledger(circle_id, week_start);
create index if not exists circle_pause_ledger_member_week_idx on circle_pause_ledger(circle_id, user_id, week_start);
alter table circle_pause_ledger drop constraint if exists circle_pause_ledger_session_id_key;
create unique index if not exists circle_pause_ledger_circle_session_key on circle_pause_ledger(circle_id, session_id);

-- En rad per vecka där alla klarade sitt mål. UNIQUE gör firandet till en
-- engångshändelse: flera medlemmars appar kan utvärdera samma vecka samtidigt.
create table if not exists circle_goal_achievements (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references circles(id) on delete cascade,
  week_start date not null,
  pot_seconds bigint not null,
  member_count int not null,
  achieved_at timestamptz not null default now(),
  unique (circle_id, week_start)
);
create index if not exists circle_goal_achievements_circle_idx on circle_goal_achievements(circle_id, week_start desc);

-- Varje medlems mål för en vecka, så att en gången vecka kan visas mot målen
-- som gällde DÅ. Målet bor på `profiles` och skrivs över när det ändras —
-- utan den här tabellen fanns inget sätt att veta vad någon siktade på för
-- en månad sedan, och ringen i en gammal vecka hade mätts mot dagens mål.
--
-- Skrivs av `snapshot_circle_week_goals()` från `evaluate_circle_goals`, alltså
-- vid varje paus, måländring och öppning av fliken. Raden för pågående vecka
-- skrivs om så länge veckan pågår; när veckan vänt står det sista värdet kvar.
-- En medlem som lämnar mitt i veckan behåller sin rad.
--
-- **De verkliga målen börjar den dag den här tabellen kom till.** Veckorna
-- före det fylls en gång med nuvarande mål — se *Bakåtfyllnaden* vid
-- snapshot_circle_week_goals.
--
-- Inga grants, som ledgern: allt som visas kommer ur get_circle_period().
create table if not exists circle_week_goals (
  circle_id uuid not null references circles(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  week_start date not null,
  daily_target_seconds int,
  -- 5 eller 7 — veckans ribba är dagsmålet gånger det här talet, och
  -- räknefönstret kan ändras mellan veckor.
  count_days int not null default 7,
  updated_at timestamptz not null default now(),
  primary key (circle_id, week_start, user_id)
);

create table if not exists circle_level_ups (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references circles(id) on delete cascade,
  level int not null,
  total_seconds bigint not null,
  reached_at timestamptz not null default now(),
  unique (circle_id, level)
);
create index if not exists circle_level_ups_circle_idx on circle_level_ups(circle_id, level desc);

-- Hjärtat på sista sidan i veckans wrapped. Nyckeln innehåller veckan, så
-- varje vecka har sina egna hjärtan och förra veckans följer inte med.
create table if not exists circle_wrapped_hearts (
  circle_id uuid not null references circles(id) on delete cascade,
  week_start date not null,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (circle_id, week_start, user_id)
);

create table if not exists circle_activity (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references circles(id) on delete cascade,
  actor_id uuid references profiles(id) on delete set null,
  type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists circle_activity_circle_id_idx on circle_activity(circle_id, created_at desc);
create index if not exists circle_activity_actor_id_idx on circle_activity(actor_id);

-- ── Bort med omröstningen om gruppmålet ─────────────────────────────────────
-- Gruppmålet var förr ETT tal som alla skulle bekräfta enhälligt. Nu sätter var
-- och en sitt eget veckomål, och ingen röstar om någon annans siffra — så förslag
-- och bekräftelser har ingenting kvar att göra. Känslan av att ha bestämt något
-- ihop ligger i pakten och i potten i stället.
drop table if exists circle_goal_confirmations cascade;
drop table if exists circle_goal_proposals cascade;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- RLS decides WHICH ROWS a caller sees; these decide whether the caller may
-- touch the table at all. Tables created from the SQL editor get no privileges
-- for the API roles, so without this block every client read fails with
-- "permission denied for table ..." (42501) no matter how correct the policies
-- are — while the security definer RPCs below keep working, because they run
-- as their owner. That split is exactly what made the Circle tab show
-- "No circle yet" at the same time as create_circle answered "You are already
-- in a circle."
--
-- SELECT only: every mutation goes through the RPCs further down, which run
-- with elevated rights. anon gets nothing; none of this is readable logged
-- out. (wishlist_items skrivs direkt från klienten och har egna policies —
-- de ligger i supabase/wishlist.sql.)
--
-- circle_pause_ledger är medvetet INTE med: den är råmaterialet bakom
-- statistiken, inte något klienten ska bläddra i. Allt som ska visas av den
-- kommer aggregerat ur get_circle_progress().

grant select on
  circles,
  circle_members,
  circle_invites,
  circle_goal_achievements,
  circle_level_ups,
  circle_activity
to authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- auth.uid() is wrapped in `(select ...)` in every policy below so Postgres
-- evaluates it once per statement instead of once per row scanned.

alter table circles enable row level security;
alter table circle_members enable row level security;
alter table circle_invites enable row level security;
alter table circle_pause_ledger enable row level security;
alter table circle_goal_achievements enable row level security;
alter table circle_week_goals enable row level security;
alter table circle_level_ups enable row level security;
alter table circle_wrapped_hearts enable row level security;
alter table circle_activity enable row level security;

drop policy if exists "members can view their circle" on circles;
create policy "members can view their circle" on circles
  for select using (
    id in (select circle_id from circle_members where user_id = (select auth.uid()))
  );
-- Separate permissive policy (Postgres OR's multiple SELECT policies together):
-- lets someone see the circle's name on a pending invite before they've joined —
-- otherwise the circles!circle_id(name) embed in the invite query is silently
-- filtered out by RLS and the invite card can't show which circle it's for.
drop policy if exists "invitees can view circle name" on circles;
create policy "invitees can view circle name" on circles
  for select using (
    id in (select circle_id from circle_invites where invitee_id = (select auth.uid()) and status = 'pending')
  );

-- Always see your own row directly, no subquery needed. Also what lets
-- every other table's "circle_id in (select circle_id from circle_members
-- where user_id = ...)" check below actually find that row.
drop policy if exists "can view own membership row" on circle_members;
create policy "can view own membership row" on circle_members
  for select using (user_id = (select auth.uid()));

-- "members can view fellow members" needs "circle_id in (select circle_id
-- from circle_members where user_id = ...)" to see OTHER people's rows —
-- but that subquery reads circle_members from WITHIN a circle_members
-- policy, which Postgres can't resolve (ERROR 42P17: infinite recursion
-- detected in policy for relation "circle_members"). A security definer
-- function breaks the cycle: its internal query bypasses RLS entirely
-- instead of re-triggering this same policy.
create or replace function is_circle_member(p_circle_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from circle_members
    where circle_id = p_circle_id and user_id = auth.uid()
  );
$$;

drop policy if exists "members can view fellow members" on circle_members;
create policy "members can view fellow members" on circle_members
  for select using ( is_circle_member(circle_id) );

drop policy if exists "see invites you sent or received" on circle_invites;
create policy "see invites you sent or received" on circle_invites
  for select using (
    invitee_id = (select auth.uid())
    or inviter_id = (select auth.uid())
    or circle_id in (select circle_id from circle_members where user_id = (select auth.uid()))
  );

drop policy if exists "members can view achievements" on circle_goal_achievements;
create policy "members can view achievements" on circle_goal_achievements
  for select using (
    circle_id in (select circle_id from circle_members where user_id = (select auth.uid()))
  );

drop policy if exists "members can view level ups" on circle_level_ups;
create policy "members can view level ups" on circle_level_ups
  for select using (
    circle_id in (select circle_id from circle_members where user_id = (select auth.uid()))
  );

drop policy if exists "members can view activity" on circle_activity;
create policy "members can view activity" on circle_activity
  for select using (
    circle_id in (select circle_id from circle_members where user_id = (select auth.uid()))
  );

-- ── Stegen ──────────────────────────────────────────────────────────────────
-- Tio nivåer med namn, räknade på cirkelns livstidssumma i
-- `circle_pause_ledger` — summan av alla medlemmars pauser genom alla tider,
-- inte ett snitt och inte veckans siffra. Trösklarna i timmar är
-- 0 / 5 / 12 / 25 / 50 / 100 / 200 / 400 / 800 / 1500, och nivå 10 är taket:
-- stegen tar slut där i stället för att fortsätta i all oändlighet.
--
-- **Det här är källan till nivånumret.** Namnen bor i lib/circleLevels.ts,
-- som speglar exakt samma trösklar för att kunna rita hela listan utan en
-- rundtur hit. Ändras en siffra måste båda filerna ändras — annars visar
-- stegen en nivå och aktivitetsflödets `level_up` en annan.
--
-- Skalan ersatte en äldre (5/15/40/100/250/500, +500 utan tak). Rader som
-- redan ligger i `circle_level_ups` behåller sina nummer men betyder nu
-- andra timintervall; det är avsiktligt och accepterat, eftersom historiken
-- är testdata. Vill man städa den: `truncate circle_level_ups` plus
-- `delete from circle_activity where type = 'level_up'`, så bygger nästa
-- `evaluate_circle_goals()` upp den igen mot den nya skalan.

create or replace function circle_level_start_seconds(p_level int)
returns bigint
language sql
immutable
as $$
  select case
    when p_level <= 1 then 0::bigint
    when p_level = 2 then (5 * 3600)::bigint
    when p_level = 3 then (12 * 3600)::bigint
    when p_level = 4 then (25 * 3600)::bigint
    when p_level = 5 then (50 * 3600)::bigint
    when p_level = 6 then (100 * 3600)::bigint
    when p_level = 7 then (200 * 3600)::bigint
    when p_level = 8 then (400 * 3600)::bigint
    when p_level = 9 then (800 * 3600)::bigint
    -- Nivå 10 och allt ovanför landar på taket. Att fråga efter nivå 11 är
    -- hur `level_next_seconds` räknas ut, och på sista nivån ska det svaret
    -- bli samma tröskel som nivå 10 — klienten läser av det som "i mål".
    else (1500 * 3600)::bigint
  end;
$$;

create or replace function circle_level_for_seconds(p_seconds bigint)
returns int
language sql
immutable
as $$
  select case
    when p_seconds >= (1500 * 3600) then 10
    when p_seconds >= (800 * 3600) then 9
    when p_seconds >= (400 * 3600) then 8
    when p_seconds >= (200 * 3600) then 7
    when p_seconds >= (100 * 3600) then 6
    when p_seconds >= (50 * 3600) then 5
    when p_seconds >= (25 * 3600) then 4
    when p_seconds >= (12 * 3600) then 3
    when p_seconds >= (5 * 3600) then 2
    else 1
  end;
$$;

-- Måndag 00:00 UTC. date_trunc('week', ...) är ISO-vecka i Postgres, dvs
-- måndagsstart — samma gräns för alla medlemmar oavsett var de befinner sig.
create or replace function circle_week_start(p_at timestamptz default now())
returns date
language sql
stable
as $$
  select (date_trunc('week', p_at at time zone 'utc'))::date;
$$;

-- ── Räknefönstret ───────────────────────────────────────────────────────────

-- Flyttar fram en parkerad fönsterändring när dess vecka har kommit. Anropas
-- först i `evaluate_circle_goals` och `record_circle_pause`, så att ingen
-- räkning någonsin görs mot ett fönster som borde ha bytts.
create or replace function promote_circle_settings(p_circle_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update circles
     set count_from = pending_count_from,
         count_to = pending_count_to,
         count_workdays = coalesce(pending_count_workdays, false),
         pending_count_week = null,
         pending_count_from = null,
         pending_count_to = null,
         pending_count_workdays = null
   where id = p_circle_id
     and pending_count_week is not null
     and pending_count_week <= circle_week_start();
$$;

-- Hur många dagar i veckan som räknas: 5 för en arbetsplats, annars 7.
-- Veckans ribba är dagsmålet gånger det här talet — överallt där den räknas.
create or replace function circle_count_days(p_circle_id uuid)
returns int
language sql
security definer
set search_path = public
stable
as $$
  select case when coalesce((select count_workdays from circles where id = p_circle_id), false) then 5 else 7 end;
$$;

-- Hur många av en paus sekunder som faller inom kretsens fönster.
--
-- Väggklockan avgör överlappet, och andelen läggs på pausens egen längd
-- (`duration_seconds`, som inte räknar tiden telefonen var uppe): en paus
-- vars halva väggtid ligger i fönstret ger halva sin längd. Lokal tid är UTC
-- minus `p_tz_offset_minutes` (`Date.getTimezoneOffset()` från klienten).
create or replace function circle_counted_seconds(
  p_circle_id uuid, p_started timestamptz, p_ended timestamptz, p_duration int, p_tz_offset_minutes int
)
returns int
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_from smallint;
  v_to smallint;
  v_workdays boolean;
  v_start timestamp;
  v_end timestamp;
  v_wall numeric;
  v_overlap numeric := 0;
  v_day date;
  v_ws timestamp;
  v_we timestamp;
begin
  select count_from, count_to, count_workdays into v_from, v_to, v_workdays
    from circles where id = p_circle_id;

  if v_from is null and not coalesce(v_workdays, false) then
    return p_duration;
  end if;
  if p_started is null or p_ended is null or p_ended <= p_started then
    return 0;
  end if;

  v_start := (p_started at time zone 'utc') - make_interval(mins => p_tz_offset_minutes);
  v_end := (p_ended at time zone 'utc') - make_interval(mins => p_tz_offset_minutes);
  v_wall := extract(epoch from v_end - v_start);

  v_day := v_start::date;
  while v_day <= v_end::date loop
    if not (coalesce(v_workdays, false) and extract(isodow from v_day) in (6, 7)) then
      v_ws := v_day + make_interval(hours => coalesce(v_from, 0));
      v_we := v_day + make_interval(hours => coalesce(v_to, 24));
      v_overlap := v_overlap + greatest(0, extract(epoch from least(v_we, v_end) - greatest(v_ws, v_start)));
    end if;
    v_day := v_day + 1;
  end loop;

  return round(p_duration * least(1, v_overlap / v_wall))::int;
end;
$$;

revoke execute on function promote_circle_settings(uuid) from public, anon, authenticated;
revoke execute on function circle_counted_seconds(uuid, timestamptz, timestamptz, int, int) from public, anon, authenticated;

-- ── RPCs ────────────────────────────────────────────────────────────────────
-- All security definer: they run with elevated rights so they can enforce
-- invariants (max 10 people, at most three circles per user, the weekly-goal rules) across
-- tables that the client itself has no direct write access to. Same spirit as
-- the existing cancel_shared_pause / get_partner_session_status RPCs already
-- used elsewhere in this project.
--
-- `create or replace function` only replaces a function whose argument
-- TYPES match exactly — if an earlier draft of this script ran with a
-- different signature, that old version becomes a second overload instead
-- of being replaced, and PostgREST then can't tell the two apart ("Could
-- not choose the best candidate function..."). So: drop every existing
-- overload of each RPC name first, unconditionally, then create a single
-- clean version below. Safe to re-run any number of times.
--
-- propose_group_goal / confirm_group_goal / cancel_group_goal_proposal,
-- set_circle_pact, set_weekly_pledge och set_weekly_goal (som nu heter
-- set_daily_goal) står
-- kvar i listan enbart för att de ska försvinna ur databaser där en tidigare
-- version av det här skriptet skapade dem.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'create_circle', 'invite_to_circle', 'accept_circle_invite',
        'decline_circle_invite', 'leave_circle', 'remove_circle_member',
        'propose_group_goal', 'confirm_group_goal',
        'cancel_group_goal_proposal', 'log_circle_activity',
        'set_circle_pact', 'set_weekly_pledge', 'set_weekly_goal', 'set_daily_goal',
        'record_circle_pause', 'get_circle_wrapped', 'toggle_wrapped_heart',
        'get_circle_progress', 'evaluate_circle_goals', 'get_friend_circle_badge',
        'set_circle_settings'
      )
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end;
$$;

-- Hur många kretsar en person får vara med i. Ett ställe, så att
-- `create_circle` och `accept_circle_invite` inte kan säga olika.
-- `CIRCLE_MAX_PER_USER` i lib/circles.ts speglar talet — ändras det här måste
-- det ändras där, annars visar fliken ett plus som servern säger nej till.
create or replace function circle_max_per_user()
returns int
language sql
immutable
as $$ select 3 $$;

-- "Vilken krets menar anroparen?" Med ett id: den kretsen, om man är med i
-- den (annars null, och anroparen kastar sitt eget fel). Utan id: den man
-- gick med i först. Det senare är vad en äldre klient får, som aldrig skickar
-- något id och bara kan ha en krets.
create or replace function resolve_my_circle(p_circle_id uuid default null)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select circle_id from circle_members
   where user_id = auth.uid()
     and (p_circle_id is null or circle_id = p_circle_id)
   order by joined_at asc
   limit 1;
$$;

create or replace function create_circle(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle_id uuid;
begin
  if (select count(*) from circle_members where user_id = auth.uid()) >= circle_max_per_user() then
    raise exception 'You can be in up to % circles. Leave one to start a new one.', circle_max_per_user();
  end if;

  insert into circles (name, created_by) values (trim(p_name), auth.uid())
  returning id into v_circle_id;

  insert into circle_members (circle_id, user_id, role) values (v_circle_id, auth.uid(), 'owner');

  return v_circle_id;
end;
$$;

-- Ägarens två val — se *Kretsens inställningar* längst upp. Anropas direkt
-- efter `create_circle` från app/circle-create.tsx och från medlemslistan.
-- `create_circle` tar inte valen själv, så att den funktionen och dess
-- signatur får stå orörda.
--
-- Fönstret: båda timmarna null = dygnet runt. Ändras det gäller det från
-- nästa måndag, utom under kretsens första vecka. Sätter man tillbaka samma
-- fönster som gäller rivs en parkerad ändring. Svarar med `deferred`, så
-- att skärmen kan säga *From next week*.
create or replace function set_circle_settings(
  p_circle_id uuid,
  p_rewards_enabled boolean,
  p_count_from int default null,
  p_count_to int default null,
  p_count_workdays boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle circles%rowtype;
  v_deferred boolean := false;
begin
  if not exists (select 1 from circle_members
                  where circle_id = p_circle_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'Only the circle owner can change its settings.';
  end if;
  if (p_count_from is null) <> (p_count_to is null) then
    raise exception 'Pick both a start and an end hour.';
  end if;
  if p_count_from is not null and not (p_count_from between 0 and 23 and p_count_to between 1 and 24
                                       and p_count_from < p_count_to) then
    raise exception 'The end hour has to come after the start hour.';
  end if;

  perform promote_circle_settings(p_circle_id);
  select * into v_circle from circles where id = p_circle_id for update;

  update circles set rewards_enabled = coalesce(p_rewards_enabled, false) where id = p_circle_id;

  if v_circle.count_from is not distinct from p_count_from
     and v_circle.count_to is not distinct from p_count_to
     and v_circle.count_workdays = coalesce(p_count_workdays, false) then
    update circles set pending_count_week = null, pending_count_from = null,
                       pending_count_to = null, pending_count_workdays = null
     where id = p_circle_id;
  elsif v_circle.created_at >= circle_week_start() then
    update circles set count_from = p_count_from, count_to = p_count_to,
                       count_workdays = coalesce(p_count_workdays, false),
                       pending_count_week = null, pending_count_from = null,
                       pending_count_to = null, pending_count_workdays = null
     where id = p_circle_id;
  else
    update circles set pending_count_week = circle_week_start() + 7,
                       pending_count_from = p_count_from, pending_count_to = p_count_to,
                       pending_count_workdays = coalesce(p_count_workdays, false)
     where id = p_circle_id;
    v_deferred := true;
  end if;

  return jsonb_build_object('deferred', v_deferred);
end;
$$;

create or replace function invite_to_circle(p_circle_id uuid, p_invitee_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite_id uuid;
  v_member_count int;
  v_pending_count int;
begin
  if not exists (select 1 from circle_members where circle_id = p_circle_id and user_id = auth.uid()) then
    raise exception 'You are not a member of this circle.';
  end if;

  select count(*) into v_member_count from circle_members where circle_id = p_circle_id;
  select count(*) into v_pending_count from circle_invites where circle_id = p_circle_id and status = 'pending';
  if v_member_count + v_pending_count >= 10 then
    raise exception 'This circle is full.';
  end if;

  if exists (select 1 from circle_members where circle_id = p_circle_id and user_id = p_invitee_id) then
    raise exception 'That person is already in this circle.';
  end if;

  insert into circle_invites (circle_id, inviter_id, invitee_id)
  values (p_circle_id, auth.uid(), p_invitee_id)
  on conflict (circle_id, invitee_id) where status = 'pending' do nothing
  returning id into v_invite_id;

  if v_invite_id is null then
    raise exception 'That person already has a pending invite to this circle.';
  end if;

  return v_invite_id;
end;
$$;

create or replace function accept_circle_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle_id uuid;
  v_member_count int;
begin
  select circle_id into v_circle_id
  from circle_invites
  where id = p_invite_id and invitee_id = auth.uid() and status = 'pending';

  if v_circle_id is null then
    raise exception 'This invite is no longer available.';
  end if;

  -- Redan med (t.ex. två inbjudningar till samma krets): bocka av inbjudan
  -- och gör ingenting mer, i stället för att fela på unika paret.
  if exists (select 1 from circle_members where circle_id = v_circle_id and user_id = auth.uid()) then
    update circle_invites set status = 'accepted' where id = p_invite_id;
    return;
  end if;

  if (select count(*) from circle_members where user_id = auth.uid()) >= circle_max_per_user() then
    raise exception 'You''re already in % circles. Leave one to join this one.', circle_max_per_user();
  end if;

  select count(*) into v_member_count from circle_members where circle_id = v_circle_id;
  if v_member_count >= 10 then
    raise exception 'This circle is full.';
  end if;

  insert into circle_members (circle_id, user_id, role) values (v_circle_id, auth.uid(), 'member');
  update circle_invites set status = 'accepted' where id = p_invite_id;
  insert into circle_activity (circle_id, actor_id, type) values (v_circle_id, auth.uid(), 'member_joined');
end;
$$;

create or replace function decline_circle_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update circle_invites set status = 'declined'
  where id = p_invite_id and invitee_id = auth.uid() and status = 'pending';
end;
$$;

-- ── Utvärderingen ───────────────────────────────────────────────────────────
-- Anropas från varje väg som kan ändra utfallet (ny paus, nytt mål, någon
-- lämnar, någon öppnar fliken). Allt den skriver är idempotent via UNIQUE, så
-- att fyra medlemmars appar kör den samtidigt gör ingen skada.
--
-- Den promotar också parkerade sänkningar när veckan har vänt — det är därför
-- lösningen klarar sig utan pg_cron: veckoskiftet sker första gången någon
-- tittar efter måndag 00:00 UTC.
create or replace function evaluate_circle_goals(p_circle_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week date := circle_week_start();
  v_member_count int;
  v_goals_set_count int;
  v_met_count int;
  v_pot bigint;
  v_total bigint;
  v_level int;
  v_highest_new int := null;
  v_lvl int;
  v_rows int;
  v_days int;
begin
  -- Fönstret flyttas fram först, så att veckans ribba räknas med rätt antal
  -- dagar från första läsningen efter måndag.
  perform promote_circle_settings(p_circle_id);
  v_days := circle_count_days(p_circle_id);

  -- Veckans mål sparas för historiken (se circle_week_goals).
  perform snapshot_circle_week_goals(p_circle_id, v_week, v_days);

  -- Ingen promotering längre: målet ändras direkt när någon ändrar det, så
  -- det finns inget parkerat att vänta in vid veckoskiftet.
  -- `pending_target_seconds` och `target_week` står kvar i tabellen men
  -- skrivs inte och läses inte — kolumner droppas inte i den här filen.
  -- Målet joinas in från profiles — se supabase/dailygoal.sql. Kretsen äger
  -- inte längre talet, den läser det.
  select count(*), count(p.daily_target_seconds)
    into v_member_count, v_goals_set_count
    from circle_members m
    join profiles p on p.id = m.user_id
   where m.circle_id = p_circle_id;

  -- Målet går inte att bedöma förrän alla satt ett. En cirkel där någon
  -- ännu inte satt sitt dagsmål har inget "alla klarade sitt" att låsa upp.
  if v_member_count > 0 and v_goals_set_count = v_member_count then
    select
      count(*) filter (where coalesce(l.seconds, 0) >= p.daily_target_seconds * v_days),
      coalesce(sum(p.daily_target_seconds * v_days), 0)
      into v_met_count, v_pot
      from circle_members m
      join profiles p on p.id = m.user_id
      left join lateral (
        select sum(seconds) as seconds
          from circle_pause_ledger
         where circle_id = p_circle_id and user_id = m.user_id and week_start = v_week
      ) l on true
     where m.circle_id = p_circle_id;

    if v_met_count = v_member_count then
      insert into circle_goal_achievements (circle_id, week_start, pot_seconds, member_count)
      values (p_circle_id, v_week, v_pot, v_member_count)
      on conflict (circle_id, week_start) do nothing;

      if found then
        insert into circle_activity (circle_id, actor_id, type, metadata)
        values (p_circle_id, null, 'goal_reached', jsonb_build_object(
          'week_start', v_week, 'pot_seconds', v_pot, 'member_count', v_member_count));
      end if;
    end if;
  end if;

  -- Stegen. Loopen skriver varje passerad nivå så historiken blir hel även om
  -- cirkeln hoppar två steg på en gång, men bara det högsta nya steget får en
  -- rad i flödet — fyra "LEVEL UP" i rad är brus, inte ett firande.
  select coalesce(sum(seconds), 0) into v_total
    from circle_pause_ledger where circle_id = p_circle_id;

  v_level := circle_level_for_seconds(v_total);

  for v_lvl in 2..greatest(v_level, 1) loop
    insert into circle_level_ups (circle_id, level, total_seconds)
    values (p_circle_id, v_lvl, v_total)
    on conflict (circle_id, level) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then v_highest_new := v_lvl; end if;
  end loop;

  if v_highest_new is not null then
    insert into circle_activity (circle_id, actor_id, type, metadata)
    values (p_circle_id, null, 'level_up', jsonb_build_object(
      'level', v_highest_new, 'total_seconds', v_total));
  end if;
end;
$$;

-- Inte något klienten ska kunna ropa på direkt — den anropas från RPC:erna
-- nedan, och de har redan kollat medlemskap.
revoke execute on function evaluate_circle_goals(uuid) from public, anon, authenticated;

-- Skriver varje nuvarande medlems mål för veckan till circle_week_goals.
-- `where ... is distinct from` gör att en oförändrad rad inte skrivs om:
-- evaluate körs var fjärde sekund medan någon har fliken öppen.
create or replace function snapshot_circle_week_goals(p_circle_id uuid, p_week date, p_days int)
returns void
language sql
security definer
set search_path = public
as $$
  insert into circle_week_goals (circle_id, user_id, week_start, daily_target_seconds, count_days)
  select p_circle_id, m.user_id, p_week, p.daily_target_seconds, p_days
    from circle_members m
    join profiles p on p.id = m.user_id
   where m.circle_id = p_circle_id
  on conflict (circle_id, week_start, user_id) do update
    set daily_target_seconds = excluded.daily_target_seconds,
        count_days = excluded.count_days,
        updated_at = now()
    where circle_week_goals.daily_target_seconds is distinct from excluded.daily_target_seconds
       or circle_week_goals.count_days is distinct from excluded.count_days;
$$;

revoke execute on function snapshot_circle_week_goals(uuid, date, int) from public, anon, authenticated;

-- ── Bakåtfyllnaden ──
-- Veckorna innan circle_week_goals fanns fylls EN gång med varje persons
-- NUVARANDE mål (på begäran, oktober 2026). Det är en uppskattning: den som
-- ändrat sitt mål mäts mot dagens tal i gamla veckor. Alternativet var en tom
-- ring med "no goal" för all historik, vilket lästes som att vännen inte haft
-- något mål.
--
-- Bara veckor FÖRE kretsens första sparade vecka fylls, och `do nothing` rör
-- aldrig en rad som redan finns — så filen går att köra om utan att
-- uppskattningen någonsin skriver över det som sparats på riktigt. Från och
-- med första sparade veckan är målen de verkliga.
--
-- Personerna är de som var med då (nuvarande medlemmar som gått med före
-- veckans slut) plus de som har timmar i veckan, också om de lämnat sedan.
insert into circle_week_goals (circle_id, user_id, week_start, daily_target_seconds, count_days)
select c.id, p.user_id, w.week_start::date, pr.daily_target_seconds, circle_count_days(c.id)
  from circles c
  cross join lateral generate_series(
    circle_week_start(c.created_at)::timestamp,
    coalesce((select min(g.week_start) from circle_week_goals g where g.circle_id = c.id),
             circle_week_start())::timestamp - interval '7 days',
    interval '7 days'
  ) as w(week_start)
  cross join lateral (
    select m.user_id from circle_members m
     where m.circle_id = c.id and m.joined_at < w.week_start + interval '7 days'
    union
    select l.user_id from circle_pause_ledger l
     where l.circle_id = c.id and l.week_start = w.week_start::date
  ) p
  join profiles pr on pr.id = p.user_id
on conflict (circle_id, week_start, user_id) do nothing;

create or replace function leave_circle(p_circle_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle_id uuid;
  v_remaining_count int;
  v_next_owner uuid;
begin
  v_circle_id := resolve_my_circle(p_circle_id);
  if v_circle_id is null then
    raise exception 'You are not in that circle.';
  end if;

  insert into circle_activity (circle_id, actor_id, type) values (v_circle_id, auth.uid(), 'member_left');
  delete from circle_members where circle_id = v_circle_id and user_id = auth.uid();

  select count(*) into v_remaining_count from circle_members where circle_id = v_circle_id;
  if v_remaining_count = 0 then
    delete from circles where id = v_circle_id;
  else
    select user_id into v_next_owner from circle_members
      where circle_id = v_circle_id order by joined_at asc limit 1;
    update circle_members set role = 'owner' where circle_id = v_circle_id and user_id = v_next_owner;
    -- Den som lämnar tar med sig sitt mål ur potten, men inte sina timmar
    -- ur ledgern: veckan räknas om utan hen, klättringen står kvar.
    perform evaluate_circle_goals(v_circle_id);
  end if;
end;
$$;

-- Ägaren tar bort någon ur kretsen. Det är `leave_circle` sett från andra
-- hållet, och avsiktligt inte mer än så: samma bokföring, samma flödesrad.
--
-- Raden i flödet skrivs med den borttagna som `actor_id` och typen
-- `member_left`, alltså "Maja left the circle." — inte hela sanningen för
-- just hen, men kretsen ska inte läsa vem som tog bort vem. Att det inte
-- finns någon egen typ är därför ett val, inte en förenkling.
--
-- Timmarna stannar i `circle_pause_ledger` av exakt samma skäl som vid ett
-- frivilligt utträde: klättringen är kretsens och skrivs inte om i
-- efterhand. Målet däremot lämnar potten, så veckan räknas om utan hen.
--
-- Ingen ägarbyte-gren behövs: ägaren är den som ropar, och hen kan inte ta
-- bort sig själv, så kretsen kan varken bli tom eller ägarlös här.
create or replace function remove_circle_member(p_user_id uuid, p_circle_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle_id uuid;
  v_role text;
begin
  v_circle_id := resolve_my_circle(p_circle_id);
  if v_circle_id is null then
    raise exception 'You are not in that circle.';
  end if;
  select role into v_role
    from circle_members where circle_id = v_circle_id and user_id = auth.uid();
  if v_role <> 'owner' then
    raise exception 'Only the circle owner can remove members.';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'Use Leave circle to leave yourself.';
  end if;
  if not exists (
    select 1 from circle_members where circle_id = v_circle_id and user_id = p_user_id
  ) then
    raise exception 'They are not in this circle.';
  end if;

  insert into circle_activity (circle_id, actor_id, type)
    values (v_circle_id, p_user_id, 'member_left');
  delete from circle_members where circle_id = v_circle_id and user_id = p_user_id;

  perform evaluate_circle_goals(v_circle_id);
end;
$$;

-- ── Dagsmålet ───────────────────────────────────────────────────────────────
-- Varje ändring gäller genast, åt båda håll. Tidigare parkerades en sänkning
-- till nästa måndag för att veckans ribba inte skulle kunna krympa i
-- efterhand — men ett tal som inte ändras när man ändrar det är obegripligt,
-- och spärren byttes medvetet mot öppenhet: ändringen syns i aktivitetsflödet
-- i stället.
--
-- Priset är känt: sänker man på söndagen halveras veckans ribba retroaktivt
-- och en missad vecka kan gå igenom. I en krets på tre till tio vänner är
-- det ett rimligt byte — målet är självpåtaget, och kretsen ser att det
-- ändrades.
--
-- Potten och belöningen räknas mot `daily_target_seconds * circle_count_days()` —
-- 7, eller 5 för en krets som bara räknar vardagar.
--
-- Flödestexten för en sänkning säger bara att målet justerats, utan siffra
-- och utan ordet "lowered". En höjning skriver ut talet. Asymmetrin är
-- avsiktlig: att höja är något att visa, att sänka är ingens sak att granska.
--
-- **Talet skrivs på `profiles`, och krets krävs inte.** Funktionen kastade förr
-- "You are not in a circle." för alla utanför en krets, vilket gjorde ett
-- personligt mål till något bara en grupp kunde ha — se supabase/dailygoal.sql
-- för hela skälet. Kretsdelen är nu det VILLKORADE: finns ingen krets skrivs
-- målet ändå, men ingen flödesrad och ingen utvärdering. Det är därför
-- loopen över kretsarna längre ner får vara tom.
--
-- Med flera kretsar loggas ändringen i varje krets flöde och varje vecka
-- utvärderas om: talet är ett, men det ingår i upp till tre potter.
create or replace function set_daily_goal(p_seconds int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle_id uuid;
  v_current int;
begin
  if auth.uid() is null then
    raise exception 'You are not signed in.';
  end if;

  if p_seconds is null or p_seconds < 300 then
    raise exception 'A daily goal needs to be at least 5 minutes.';
  end if;
  if p_seconds > 12 * 3600 then
    raise exception 'That is more hours than a day can hold.';
  end if;

  select daily_target_seconds into v_current
    from profiles where id = auth.uid();

  -- Oförändrat tal: ingenting händer och ingenting loggas. Annars fylls
  -- flödet av "satte sitt mål till 30 min" varje gång någon öppnar ratten
  -- och stänger den igen.
  if v_current is not null and p_seconds = v_current then
    return jsonb_build_object('changed', false);
  end if;

  update profiles set daily_target_seconds = p_seconds where id = auth.uid();

  -- Resten är kretsarnas, och loopen är tom för den som pausar ensam: det
  -- finns ingen krets att logga i och ingen vecka att utvärdera.
  for v_circle_id in select circle_id from circle_members where user_id = auth.uid() loop
    if v_current is not null and p_seconds < v_current then
      insert into circle_activity (circle_id, actor_id, type, metadata)
        values (v_circle_id, auth.uid(), 'goal_adjusted', '{}'::jsonb);
    else
      insert into circle_activity (circle_id, actor_id, type, metadata)
        values (v_circle_id, auth.uid(), 'goal_set',
                jsonb_build_object('seconds', p_seconds, 'raised', v_current is not null));
    end if;

    perform evaluate_circle_goals(v_circle_id);
  end loop;

  return jsonb_build_object('changed', true);
end;
$$;

-- ── Pausen ──────────────────────────────────────────────────────────────────
-- Klienten skickar bara sitt pause_sessions-id; allt annat läses här, så att
-- ingen kan skriva in timmar som inte finns i sin egen logg. Dubblettskyddet
-- sitter på session_id, vilket gör anropet ofarligt att göra om — outboxen
-- gör det när den skickar om en köad låd-session.
--
-- Pausen räknas i VARJE krets man är med i: en rad per krets i ledgern och en
-- rad i varje flöde. Utan krets är loopen tom och anropet en tyst no-op.
--
-- Varje krets räknar bara den del som faller inom dess fönster
-- (`circle_counted_seconds`), i medlemmens egen tid — därför
-- `p_tz_offset_minutes`. En paus helt utanför fönstret ger ingen rad och ingen
-- flödesrad i den kretsen. Flödet visar den räknade längden, så att det aldrig
-- säger mer än potten.
create or replace function record_circle_pause(
  p_session_id uuid, p_category text default null, p_tz_offset_minutes int default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle_id uuid;
  v_seconds int;
  v_started_at timestamptz;
  v_ended_at timestamptz;
  v_counted int;
  v_rows int;
begin

  -- `kind = 'pause'`: en natt (supabase/sleep.sql) kommer aldrig in i
  -- ledgern, och därmed varken i potten, stegen, veckomålet eller
  -- dagsmålsnotisen. Appen anropar inte den här för sömn, men spärren sitter
  -- här så att ingen klient kan lägga in en natt genom att skicka dess id.
  select duration_seconds, started_at, ended_at into v_seconds, v_started_at, v_ended_at
    from pause_sessions
   where id = p_session_id and user_id = auth.uid() and kind = 'pause';

  if v_seconds is null or v_ended_at is null then
    return;
  end if;

  for v_circle_id in select circle_id from circle_members where user_id = auth.uid() loop
    perform promote_circle_settings(v_circle_id);
    v_counted := circle_counted_seconds(v_circle_id, v_started_at, v_ended_at, v_seconds,
                                        coalesce(p_tz_offset_minutes, 0));
    continue when v_counted <= 0;

    insert into circle_pause_ledger (circle_id, user_id, session_id, seconds, occurred_at, week_start)
    values (v_circle_id, auth.uid(), p_session_id, v_counted, v_ended_at, circle_week_start(v_ended_at))
    on conflict (circle_id, session_id) do nothing;

    -- Noll rader = redan räknad i den här kretsen; logga inte om den i
    -- flödet heller.
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      -- `session_id` så att flödet kan visa en tagg som sätts efteråt
      -- (`get_circle_activity_tags` i circle_intentions.sql). `category` är
      -- intentionen som valdes före pausen, om någon.
      insert into circle_activity (circle_id, actor_id, type, metadata)
        values (v_circle_id, auth.uid(), 'pause_completed',
                jsonb_build_object('duration_seconds', v_counted, 'category', p_category,
                                   'session_id', p_session_id));

      perform evaluate_circle_goals(v_circle_id);
    end if;
  end loop;
end;
$$;

-- ── Läsningen ───────────────────────────────────────────────────────────────
-- Allt fliken behöver i ett anrop. Utvärderar först, så att den som öppnar
-- fliken också är den som får veckoskiftet och ett eventuellt firande att ske.
--
-- Medlemmarnas veckosummor är tvärgående data: circle_members kan inte läsa
-- varandras pause_sessions under nuvarande policies, och ska inte heller
-- kunna. Därför definer, och därför bara summor per person — aldrig enskilda
-- sessioner. profiles.show_stats ignoreras medvetet: inne i en cirkel är din
-- andel av ett mål ni satt ihop själva hela poängen.
-- `p_tz_offset_minutes` är `Date.getTimezoneOffset()` från klienten (UTC minus
-- lokal tid, i minuter). Den styr BARA vad "idag" betyder i siffran på Hem.
-- Veckan — och därmed potten, ribban och belöningen — ligger kvar på måndag
-- 00:00 UTC och är delad för hela kretsen. Det är just för att dagen bara är
-- en visning som den får vara lokal: skulle den avgöra något vore olika
-- dygnsgränser per medlem ett verkligt problem.
create or replace function get_circle_progress(p_tz_offset_minutes int default 0, p_circle_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle_id uuid;
  v_week date := circle_week_start();
  v_day_start timestamptz := date_trunc('day', now() - make_interval(mins => p_tz_offset_minutes))
                             + make_interval(mins => p_tz_offset_minutes);
  v_total bigint;
  v_level int;
  v_members jsonb;
  v_pot bigint;
  v_progress bigint;
  v_member_count int;
  v_goals_set_count int;
  v_met_count int;
  v_reached boolean;
  v_achievements int;
  v_days int;
begin
  v_circle_id := resolve_my_circle(p_circle_id);
  if v_circle_id is null then
    return null;
  end if;

  perform evaluate_circle_goals(v_circle_id);
  v_days := circle_count_days(v_circle_id);

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'user_id', t.user_id,
      'daily_target_seconds', t.daily_target_seconds,
      'target_seconds', t.daily_target_seconds * v_days,
      'progress_seconds', t.progress,
      'today_seconds', t.today,
      'met', t.daily_target_seconds is not null and t.progress >= t.daily_target_seconds * v_days
    ) order by t.joined_at), '[]'::jsonb),
    count(*),
    count(t.daily_target_seconds),
    count(*) filter (where t.daily_target_seconds is not null and t.progress >= t.daily_target_seconds * v_days),
    coalesce(sum(t.daily_target_seconds * v_days), 0),
    coalesce(sum(t.progress), 0)
    into v_members, v_member_count, v_goals_set_count, v_met_count, v_pot, v_progress
  from (
    select m.user_id, m.joined_at, pr.daily_target_seconds,
           coalesce((
             select sum(seconds) from circle_pause_ledger
              where circle_id = v_circle_id and user_id = m.user_id and week_start = v_week
           ), 0) as progress,
           coalesce((
             select sum(seconds) from circle_pause_ledger
              where circle_id = v_circle_id and user_id = m.user_id and occurred_at >= v_day_start
           ), 0) as today
      from circle_members m
      join profiles pr on pr.id = m.user_id
     where m.circle_id = v_circle_id
  ) t;

  select coalesce(sum(seconds), 0) into v_total
    from circle_pause_ledger where circle_id = v_circle_id;
  v_level := circle_level_for_seconds(v_total);

  select exists (select 1 from circle_goal_achievements where circle_id = v_circle_id and week_start = v_week),
         (select count(*) from circle_goal_achievements where circle_id = v_circle_id)
    into v_reached, v_achievements;

  return jsonb_build_object(
    'circle_id', v_circle_id,
    'week_start', v_week,
    'members', v_members,
    'member_count', v_member_count,
    'goals_set_count', v_goals_set_count,
    'met_count', v_met_count,
    'pot_target_seconds', v_pot,
    'pot_progress_seconds', v_progress,
    'goal_reached', v_reached,
    'achievements_count', v_achievements,
    'lifetime_seconds', v_total,
    'level', v_level,
    'level_start_seconds', circle_level_start_seconds(v_level),
    'level_next_seconds', circle_level_start_seconds(v_level + 1),
    'count_days', v_days
  );
end;
$$;

-- ── En gången vecka eller dag ───────────────────────────────────────────────
-- Det kretsfliken visar när man sveper bakåt i ringen. Pågående period läses
-- fortfarande ur get_circle_progress (den utvärderar veckan, det här gör det
-- inte); den här läser bara det som redan hänt.
--
-- `p_mode` är 'week' eller 'day'. `p_date` är veckans måndag (vecka) eller
-- det lokala datumet (dag); dagen avgränsas med klientens tidszon, samma
-- regel som `today_seconds` i get_circle_progress — en kretsdag visar bara,
-- den låser aldrig upp något.
--
-- Svaret har samma form som get_circle_progress där de två överlappar, så
-- att klienten kan rita det med samma kod. Skillnaderna:
--   - Medlemmarna är de som var med DÅ: nuvarande medlemmar som gått med
--     före periodens slut, plus de som har en målrad eller timmar i perioden.
--     `is_member = false` är någon som lämnat — timmarna står kvar i ledgern
--     och måste visas, annars går brickorna inte ihop med summan.
--   - Målen kommer ur circle_week_goals. Saknas raden (veckor före tabellen)
--     är målet null och `goals_known` false — klienten visar då timmarna
--     utan ring.
--   - `circle_started` är kretsens första lokala dag, så att klienten vet var
--     bakåt tar slut.
create or replace function get_circle_period(
  p_circle_id uuid, p_mode text, p_date date, p_tz_offset_minutes int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_circle_id uuid;
  v_is_day boolean := p_mode = 'day';
  v_week date;
  v_start timestamptz;
  v_end timestamptz;
  v_members jsonb;
  v_pot bigint;
  v_progress bigint;
  v_member_count int;
  v_goals_set int;
  v_met int;
  v_reached boolean;
  v_week_no int;
  v_created timestamptz;
begin
  v_circle_id := resolve_my_circle(p_circle_id);
  if v_circle_id is null then
    return null;
  end if;
  select created_at into v_created from circles where id = v_circle_id;

  if v_is_day then
    -- Lokal midnatt i UTC: datumet 00:00 plus klientens avvikelse
    -- (getTimezoneOffset är positiv väster om Greenwich).
    v_start := (p_date::timestamp at time zone 'utc') + make_interval(mins => p_tz_offset_minutes);
    v_end := v_start + interval '1 day';
    v_week := circle_week_start(v_start);
  else
    v_week := date_trunc('week', p_date::timestamp)::date;
    v_start := v_week::timestamp at time zone 'utc';
    v_end := v_start + interval '7 days';
  end if;

  with people as (
    select m.user_id from circle_members m
     where m.circle_id = v_circle_id and m.joined_at < v_end
    union
    select g.user_id from circle_week_goals g
     where g.circle_id = v_circle_id and g.week_start = v_week
    union
    select l.user_id from circle_pause_ledger l
     where l.circle_id = v_circle_id
       and (case when v_is_day then l.occurred_at >= v_start and l.occurred_at < v_end
                 else l.week_start = v_week end)
  ),
  t as (
    select p.user_id, pr.username, pr.avatar_url,
           exists (select 1 from circle_members m where m.circle_id = v_circle_id and m.user_id = p.user_id) as is_member,
           (select m.joined_at from circle_members m where m.circle_id = v_circle_id and m.user_id = p.user_id) as joined_at,
           g.daily_target_seconds,
           case when g.daily_target_seconds is null then null
                when v_is_day then g.daily_target_seconds
                else g.daily_target_seconds * g.count_days end as target,
           coalesce((
             select sum(l.seconds) from circle_pause_ledger l
              where l.circle_id = v_circle_id and l.user_id = p.user_id
                and (case when v_is_day then l.occurred_at >= v_start and l.occurred_at < v_end
                          else l.week_start = v_week end)
           ), 0) as seconds
      from people p
      join profiles pr on pr.id = p.user_id
      left join circle_week_goals g
        on g.circle_id = v_circle_id and g.week_start = v_week and g.user_id = p.user_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'user_id', t.user_id,
      'username', t.username,
      'avatar_url', t.avatar_url,
      'is_member', t.is_member,
      'daily_target_seconds', t.daily_target_seconds,
      'target_seconds', t.target,
      'progress_seconds', t.seconds,
      'today_seconds', t.seconds,
      'met', t.target is not null and t.seconds >= t.target
    ) order by t.is_member desc, t.joined_at nulls last, t.username), '[]'::jsonb),
    count(*),
    count(t.target),
    count(*) filter (where t.target is not null and t.seconds >= t.target),
    coalesce(sum(t.target), 0),
    coalesce(sum(t.seconds), 0)
    into v_members, v_member_count, v_goals_set, v_met, v_pot, v_progress
  from t;

  select exists (select 1 from circle_goal_achievements where circle_id = v_circle_id and week_start = v_week),
         (select count(*) from circle_goal_achievements where circle_id = v_circle_id and week_start <= v_week)
    into v_reached, v_week_no;

  return jsonb_build_object(
    'circle_id', v_circle_id,
    'mode', case when v_is_day then 'day' else 'week' end,
    'week_start', v_week,
    'period_start', v_start,
    'members', v_members,
    'member_count', v_member_count,
    'goals_set_count', v_goals_set,
    'goals_known', v_member_count > 0 and v_goals_set = v_member_count,
    'met_count', v_met,
    'pot_target_seconds', v_pot,
    'pot_progress_seconds', v_progress,
    -- Bara veckan har en bedrift; en dag låser aldrig upp något.
    'goal_reached', not v_is_day and v_reached,
    'achievements_count', v_week_no,
    'circle_started', v_created
  );
end;
$$;

-- ── Veckans wrapped ─────────────────────────────────────────────────────────
-- Allt de sju sidorna behöver i ett anrop. Visar INNEVARANDE vecka, inte den
-- förra: resten av fliken räknar på veckan som pågår, och en sammanfattning
-- som tittade bakåt hade motsagt potten precis intill. Sidhuvudet skriver ut
-- datumspannet så det aldrig är oklart vilken vecka som räknas.
create or replace function get_circle_wrapped(p_circle_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle_id uuid;
  v_name text;
  v_week date := circle_week_start();
  v_members jsonb;
  v_pot bigint;
  v_progress bigint;
  v_sessions int;
  v_reached boolean;
  v_total_weeks int;
  v_streak int;
  v_hearts jsonb;
  v_longest jsonb;
  v_days int;
begin
  v_circle_id := resolve_my_circle(p_circle_id);
  if v_circle_id is null then
    return null;
  end if;
  select name into v_name from circles where id = v_circle_id;

  perform evaluate_circle_goals(v_circle_id);
  v_days := circle_count_days(v_circle_id);

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'user_id', t.user_id,
      'username', t.username,
      'avatar_url', t.avatar_url,
      'seconds', t.seconds,
      'met', t.daily_target_seconds is not null and t.seconds >= t.daily_target_seconds * v_days
    ) order by t.seconds desc), '[]'::jsonb),
    coalesce(sum(t.daily_target_seconds * v_days), 0),
    coalesce(sum(t.seconds), 0)
    into v_members, v_pot, v_progress
  from (
    select m.user_id, p.username, p.avatar_url, p.daily_target_seconds,
           coalesce((
             select sum(l.seconds) from circle_pause_ledger l
              where l.circle_id = v_circle_id and l.user_id = m.user_id and l.week_start = v_week
           ), 0) as seconds
      from circle_members m
      join profiles p on p.id = m.user_id
     where m.circle_id = v_circle_id
  ) t;

  select count(*) into v_sessions
    from circle_pause_ledger
   where circle_id = v_circle_id and week_start = v_week;

  select exists (select 1 from circle_goal_achievements
                  where circle_id = v_circle_id and week_start = v_week),
         (select count(*) from circle_goal_achievements where circle_id = v_circle_id)
    into v_reached, v_total_weeks;

  -- Svit: obrutna veckor bakåt från den senaste vunna. Veckorna ligger exakt
  -- sju dagar isär, så en rad vars datum avviker från sin position i
  -- ordningen bryter kedjan — allt därefter räknas inte.
  select count(*) into v_streak
    from (
      select week_start, row_number() over (order by week_start desc) as rn,
             max(week_start) over () as newest
        from circle_goal_achievements
       where circle_id = v_circle_id
    ) w
   -- `rn` är bigint från row_number(), och Postgres har `date - integer` men
   -- ingen `date - bigint`. Utan casten faller hela anropet på "operator does
   -- not exist" — vid anropet, inte när funktionen skapas.
   where w.week_start = w.newest - ((w.rn - 1)::int * 7);

  select coalesce(jsonb_agg(user_id), '[]'::jsonb) into v_hearts
    from circle_wrapped_hearts
   where circle_id = v_circle_id and week_start = v_week;

  -- Veckans längsta paus, med start och slut. Det är det enda stället där en
  -- medlem ser NÄR en annan pausade — resten av kretsen visar bara summor —
  -- och det är valt: en skärmfri dag blir veckans höjdpunkt, och en natt med
  -- en vanlig paus igång syns för vad den är utan att någon regel behövs.
  -- Bara tid och längd, aldrig intentionen. Inner join mot pause_sessions:
  -- en paus som raderats i stats.tsx har ingen starttid och ska inte lyftas
  -- fram. Inner join mot circle_members: samma personer som `members`.
  select jsonb_build_object(
           'user_id', l.user_id,
           'username', p.username,
           'avatar_url', p.avatar_url,
           'seconds', l.seconds,
           'started_at', s.started_at,
           'ended_at', s.ended_at
         )
    into v_longest
    from circle_pause_ledger l
    join circle_members m on m.circle_id = l.circle_id and m.user_id = l.user_id
    join profiles p on p.id = l.user_id
    join pause_sessions s on s.id = l.session_id
   where l.circle_id = v_circle_id
     and l.week_start = v_week
     and s.started_at is not null
     and s.ended_at is not null
   order by l.seconds desc, s.ended_at asc
   limit 1;

  return jsonb_build_object(
    'circle_id', v_circle_id,
    'circle_name', v_name,
    'week_start', v_week,
    'members', v_members,
    'pot_target_seconds', v_pot,
    'pot_progress_seconds', v_progress,
    'session_count', v_sessions,
    'goal_reached', v_reached,
    'weeks_reached', v_total_weeks,
    'streak_weeks', v_streak,
    'hearts', v_hearts,
    'longest_pause', v_longest
  );
end;
$$;

-- Hjärtat är en växling, inte en knapp som bara kan tryckas en gång: man ska
-- kunna ångra sig. Returnerar det nya läget så klienten slipper läsa om allt.
create or replace function toggle_wrapped_heart(p_circle_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle_id uuid;
  v_week date := circle_week_start();
  v_rows int;
begin
  v_circle_id := resolve_my_circle(p_circle_id);
  if v_circle_id is null then
    raise exception 'You are not in a circle.';
  end if;

  delete from circle_wrapped_hearts
   where circle_id = v_circle_id and week_start = v_week and user_id = auth.uid();

  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    return false;
  end if;

  insert into circle_wrapped_hearts (circle_id, week_start, user_id)
  values (v_circle_id, v_week, auth.uid());
  return true;
end;
$$;

create or replace function log_circle_activity(p_type text, p_metadata jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circle_id uuid;
begin
  -- I varje krets man är med i, av samma skäl som record_circle_pause.
  for v_circle_id in select circle_id from circle_members where user_id = auth.uid() loop
    insert into circle_activity (circle_id, actor_id, type, metadata)
      values (v_circle_id, auth.uid(), p_type, p_metadata);
  end loop;
end;
$$;

-- ── Kretsmärket på en väns profilkort ───────────────────────────────────────
-- RLS på `circles` och `circle_members` släpper med flit bara igenom den
-- krets man själv är med i. En vän i en ANNAN krets är därför osynlig, och
-- utan den här funktionen skulle kortet aldrig kunna visa något. Den kör
-- `security definer` av exakt samma skäl som `get_partner_session_status`.
--
-- **Den lämnar bara ut två saker: kretsens namn och dess nivå.** Inte
-- medlemmar, inte timmar, inte mål. Nivån är cirkelns gemensamma, inte
-- personens — det finns ingen personlig nivå i systemet, och kortet ska inte
-- antyda att det gör det.
--
-- Åtkomsten kräver en vänskapsrad åt något håll, oavsett status: kortet
-- öppnas både för accepterade vänner och för inkommande förfrågningar, och
-- den som frågar om att få lägga till dig ska kunna visa vilken krets hen
-- hör till.
--
-- `profiles.show_stats` gäller INTE här. Den flaggan styr pausaktivitet
-- (senaste pausen, wrapped-knappen), står `false` som förval, och en
-- kretstillhörighet är inte statistik utan hemvist. Skulle den någon gång
-- behöva döljas krävs en egen flagga — se anteckningen i CLAUDE.md.
--
-- Med upp till tre kretsar per person svarar den med listan `circles` (namn +
-- nivå per krets, i den ordning hen gick med). `circle_name` och `level` på
-- toppnivån är den första av dem och står kvar för äldre klienter.
create or replace function get_friend_circle_badge(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_circles jsonb;
begin
  if p_user_id is null or p_user_id = auth.uid() then
    return null;
  end if;

  if not exists (
    select 1 from friendships
     where (requester_id = auth.uid() and receiver_id = p_user_id)
        or (requester_id = p_user_id and receiver_id = auth.uid())
  ) then
    return null;
  end if;

  select jsonb_agg(jsonb_build_object(
           'circle_name', c.name,
           'level', circle_level_for_seconds(coalesce((
             select sum(l.seconds) from circle_pause_ledger l where l.circle_id = c.id
           ), 0))
         ) order by m.joined_at)
    into v_circles
    from circle_members m
    join circles c on c.id = m.circle_id
   where m.user_id = p_user_id;

  if v_circles is null then
    return null;
  end if;

  return jsonb_build_object(
    'circle_name', v_circles -> 0 ->> 'circle_name',
    'level', (v_circles -> 0 ->> 'level')::int,
    'circles', v_circles
  );
end;
$$;
