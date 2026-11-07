-- On my list, stories och delad progress — kör i Supabase SQL-editorn.
-- Samma konvention som supabase/circles.sql: schemat bor här, inte i ett
-- migrationsverktyg, och filen är idempotent hela vägen.
--
-- **Kör supabase/circles.sql först.** Den här filen använder
-- `circle_week_start()` och `circle_members` därifrån.
--
-- ── Vad det här är ──────────────────────────────────────────────────────────
--
-- En punkt på någons lista tillhör en PERSON, inte en krets. Vem som får se
-- den avgörs vid läsning av delat kretsmedlemskap. Alternativet — att hänga
-- punkten på en krets — hade tömt någons lista den dagen de lämnade kretsen.
--
-- Tabellen hette `circle_weekly_goals` och var varken veckovis (ingen
-- veckokolumn, ingen återställning) eller mål. Den byter namn till
-- `wishlist_items` så att spec och kod menar samma sak.
--
-- Tokens och synlighetskategorier ingår INTE i v1. `complete_wishlist_item`
-- ger därför ingen token, och `wishlist_completed` loggas utan kategori.

-- ── Tabellen ────────────────────────────────────────────────────────────────

-- Namnbytet, guardat så att filen kan köras om och funkar på en tom databas.
do $$
begin
  if to_regclass('public.circle_weekly_goals') is not null
     and to_regclass('public.wishlist_items') is null then
    alter table circle_weekly_goals rename to wishlist_items;
  end if;
end;
$$;

create table if not exists wishlist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  text text not null,
  position smallint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- `create table if not exists` ovan gör INGENTING när tabellen redan finns —
-- och efter namnbytet finns den alltid. Kolumnlistan där gäller alltså bara
-- en tom databas. Varje kolumn som måste finnas behöver därför sin egen
-- `add column if not exists`, även de som stod i den gamla tabellen: en
-- databas från ett tidigare skede av projektet kan sakna dem.
alter table wishlist_items add column if not exists created_at timestamptz not null default now();
alter table wishlist_items add column if not exists updated_at timestamptz not null default now();

-- `done_at` är det som driver både bocken i listan och den delade veckopotten.
alter table wishlist_items add column if not exists done_at timestamptz;
-- Tonen sätts när punkten aktiveras som story, inte när den skrivs.
alter table wishlist_items add column if not exists tone text;
alter table wishlist_items add column if not exists story_expires_at timestamptz;
-- Inerta i v1: utmaningsflödet är pausat. `private` styr när det byggs BARA
-- om andra får skicka utmaningar mot punkten — aldrig om du själv får göra en
-- story av den. Att dela i stunden är alltid ditt eget val.
alter table wishlist_items add column if not exists private boolean not null default false;
alter table wishlist_items add column if not exists open_for_challenges boolean not null default false;
-- Dold för kretsen: ögat med streck i att göra-arket. Egen kolumn och inte
-- `private`, som är reserverad för utmaningar ovan. Gäller alla ens kretsar
-- på en gång — synligheten avgörs av `shares_circle_with`, inte per krets.
-- Spärren sitter i policyn nedan och i de två definer-funktionerna längst
-- ner (flödesraden vid avbockning och veckans avklarade), som annars hade
-- gått förbi den.
alter table wishlist_items add column if not exists hidden_from_circle boolean not null default false;

do $$
declare
  r record;
begin
  -- Tonen hade en check på fyra egna värden ('tillsagelse', 'varme', ...) —
  -- men samma begrepp fanns redan i appens SUPPORT_TYPES med andra id:n
  -- ('tillsägelse', 'värme', 'motivationstal'). Två vokabulär i samma kolumn
  -- är vad som gjorde de två flödena omöjliga att skilja på. Nu finns ett
  -- vokabulär, det gamla, och det bor i klienten — plus att fältet kan bära
  -- flera värden kommaseparerat precis som support_stories.support_type.
  -- Därför ingen check alls; den hade bara varit en andra, sämre kopia.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'wishlist_items'::regclass and conname = 'wishlist_items_tone_check'
  ) then
    alter table wishlist_items drop constraint wishlist_items_tone_check;
  end if;

  -- Arvet från tre fasta platser: unique(user_id, position) och
  -- check(position between 0 and 2). En att-göra-lista växer och krymper, så
  -- båda måste bort — annars går det inte att lägga till en fjärde punkt.
  for r in
    select conname from pg_constraint
     where conrelid = 'wishlist_items'::regclass
       and contype in ('u', 'c')
       and pg_get_constraintdef(oid) ilike '%position%'
  loop
    execute format('alter table wishlist_items drop constraint %I', r.conname);
  end loop;

  -- `position` var not null när den var en platsnummer. Nu är den valfri
  -- sorteringshjälp.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'wishlist_items'
       and column_name = 'position' and is_nullable = 'NO'
  ) then
    alter table wishlist_items alter column position drop not null;
  end if;

  -- `circle_id` lämnas kvar med sitt data (inget raderas), men dess
  -- främmande nyckel MÅSTE bort: den var `on delete cascade`, så en raderad
  -- krets hade tagit medlemmarnas listor med sig. Kolumnen skrivs inte längre
  -- och läses ingenstans.
  for r in
    select conname from pg_constraint
     where conrelid = 'wishlist_items'::regclass and contype = 'f'
       and pg_get_constraintdef(oid) ilike '%circles%'
  loop
    execute format('alter table wishlist_items drop constraint %I', r.conname);
  end loop;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'wishlist_items'
       and column_name = 'circle_id' and is_nullable = 'NO'
  ) then
    alter table wishlist_items alter column circle_id drop not null;
  end if;
end;
$$;

create index if not exists wishlist_items_user_idx on wishlist_items(user_id, created_at desc);
create index if not exists wishlist_items_open_idx on wishlist_items(user_id) where done_at is null;
create index if not exists wishlist_items_done_idx on wishlist_items(done_at) where done_at is not null;
create index if not exists wishlist_items_story_idx on wishlist_items(story_expires_at) where story_expires_at is not null;

-- ── Grants & RLS ────────────────────────────────────────────────────────────
-- Punkterna skrivs direkt från klienten (som tidigare), så till skillnad från
-- kretsarnas tabeller behöver den här både skriv- och läsrättigheter. Allt som
-- rör andra än en själv går ändå via RPC:erna längst ner.

grant select, insert, update, delete on wishlist_items to authenticated;

alter table wishlist_items enable row level security;

-- Samma trick som is_circle_member i circles.sql: en definer-funktion som går
-- förbi RLS, så att policyn nedan kan fråga om delat medlemskap utan att
-- fastna i andra tabellers policies.
--
-- Droppas först, av samma skäl som RPC:erna längst ner: `create or replace`
-- vägrar byta namn på en inparameter ("cannot change name of input parameter"),
-- så en tidigare version med ett annat parameternamn blockerar hela filen.
-- `cascade` tar med sig policyn som använder funktionen — den återskapas
-- direkt nedanför, så det enda som försvinner är det den här filen äger.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'shares_circle_with'
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end;
$$;

create or replace function shares_circle_with(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
      from circle_members me
      join circle_members them on them.circle_id = me.circle_id
     where me.user_id = auth.uid()
       and them.user_id = p_user_id
  );
$$;

-- Bara kretsen ser listan, inte vännerna. Vänlistan har ingen övre gräns
-- och vänner ser inte ens pausaktivitet utan `show_stats`; en enskild punkt
-- når vänner bara när man själv gör den till en story (activate_story nedan).
--
-- En kort stund släppte policyn också igenom accepterade vänner via
-- `is_friend_with()`. Den tas bort här, med samma droppmönster, så att en
-- databas där den versionen kördes blir kretsbegränsad igen.
drop policy if exists "see own, circle mates and friends items" on wishlist_items;
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_friend_with'
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end;
$$;

drop policy if exists "see own and circle mates items" on wishlist_items;
create policy "see own and circle mates items" on wishlist_items
  for select using (
    user_id = (select auth.uid())
    or (not hidden_from_circle and shares_circle_with(user_id))
  );

drop policy if exists "insert own items" on wishlist_items;
create policy "insert own items" on wishlist_items
  for insert with check (user_id = (select auth.uid()));

drop policy if exists "update own items" on wishlist_items;
create policy "update own items" on wishlist_items
  for update using (user_id = (select auth.uid()));

drop policy if exists "delete own items" on wishlist_items;
create policy "delete own items" on wishlist_items
  for delete using (user_id = (select auth.uid()));

-- ── Aktiva stories ──────────────────────────────────────────────────────────
-- Ingen städning och inget schemalagt jobb: en story är helt enkelt en rad
-- vars `story_expires_at` ännu inte passerats. Efter 24 h faller den ur vyn
-- medan punkten och eventuella svar ligger kvar i datan — samma lata
-- utvärdering som veckoskiftet i kretsarna.
--
-- `security_invoker = true` (kräver Postgres 15+) gör att wishlist_items
-- policy ovan gäller den som frågar. Utan den hade vyn körts som sin ägare
-- och visat allas stories för alla.
drop view if exists active_stories;
create view active_stories
with (security_invoker = true)
as
  select
    i.id,
    i.user_id,
    i.text,
    i.tone,
    i.story_expires_at,
    i.done_at,
    p.username,
    p.avatar_url
  from wishlist_items i
  join profiles p on p.id = i.user_id
  where i.story_expires_at > now();

grant select on active_stories to authenticated;

-- ── RPC:er ──────────────────────────────────────────────────────────────────
-- Samma droppmönster som circles.sql: varje överlagring tas bort först, så att
-- en tidigare signatur inte blir kvar som ett andra alternativ PostgREST inte
-- kan välja mellan.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('activate_story', 'complete_wishlist_item', 'circle_weekly_completions')
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end;
$$;

-- ── Bryggan till support_stories ────────────────────────────────────────────
-- `support_stories` skapades utanför det här repot (ingen DDL finns här), så
-- nedan läggs bara till kolumner — inget rörs som redan finns.
--
-- Varför en brygga i stället för en egen story-tabell: Community-fliken har
-- redan story-raden, helskärmsläsaren och svarsknapparna, svaren hänger på
-- `support_responses.story_id`, och Hems inkorgs-badge räknar undlevererade
-- svar på ENS EGNA aktiva stories. Ett eget spår hade betytt en andra
-- story-rad i samma flik och ändringar i alla tre. En punkt är "det jag vill
-- göra", en story är "att publicera den i 24 timmar" — två poster, den ena
-- pekar på den andra.
alter table support_stories add column if not exists wishlist_item_id uuid
  references wishlist_items(id) on delete cascade;
-- Vanliga stöd-stories har ingen utgång (de stängs för hand) och lämnas som
-- null. Bara de bryggade får en.
alter table support_stories add column if not exists expires_at timestamptz;
create index if not exists support_stories_item_idx on support_stories(wishlist_item_id);

-- ── Vem förfrågan går till ──────────────────────────────────────────────────
-- `recipient_ids` null = alla ens vänner (som förut); annars bara de valda.
-- En kolumn och inte en egen tabell, för att notistriggern i
-- social_notify.sql körs i samma ögonblick som raden skrivs: en
-- mottagartabell hade varit tom då, och notisen hade gått till ingen.
-- Priset är att de valda kan läsa vilka andra som fått samma fråga — de ser
-- id:n, inga namn, och bara för en förfrågan de själva fått.
alter table support_stories add column if not exists recipient_ids uuid[];

-- Spärren är en **restriktiv** policy. Den vanliga SELECT-policyn på
-- support_stories skapades utanför repot (den släpper igenom vänners rader),
-- och en restriktiv policy läggs till med AND ovanpå den utan att någon
-- behöver veta hur den ser ut. RLS är redan på för tabellen — det är den som
-- gör att bara vänner ser varandras förfrågningar.
drop policy if exists support_stories_audience on support_stories;
create policy support_stories_audience on support_stories
  as restrictive
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or recipient_ids is null
    or auth.uid() = any(recipient_ids)
  );

-- Aktiverar en punkt som story i 24 timmar. Loggar med flit INGET i
-- aktivitetsflödet: en story syns i story-raden, och skulle dubblerats i
-- flödet annars.
-- `p_tone` är en kommaseparerad lista av samma id:n som
-- support_stories.support_type redan använder, och skrivs rakt in i den
-- kolumnen. Ingen lista av tillåtna värden här: vokabulären bor i klienten
-- (SUPPORT_TYPE_LABELS), och en kopia av den i databasen hade bara kunnat
-- hamna ur fas med originalet.
-- `p_item_id` är valfritt. Kommer ämnet från listan hänger storyn ihop med
-- punkten; skrevs det i stunden ("ask for support to study") är det INGEN
-- punkt på någons lista och ska inte bli en heller — då bär storyn bara sin
-- egen text i `p_activity`, och `wishlist_item_id` blir null.
--
-- `p_recipient_ids` null = alla vänner. En lista filtreras mot ens
-- accepterade vänner, så ingen kan be en främling; blir den tom är det ett
-- fel och inte "alla". Den fjärde parametern kom till efteråt, och en ny
-- parameter skapar en överlagring i stället för att ersätta — därför droppas
-- den gamla signaturen först.
drop function if exists activate_story(uuid, text, text, text);
create or replace function activate_story(
  p_item_id uuid,
  p_tone text,
  p_intention_id text default null,
  p_activity text default null,
  p_recipient_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipients uuid[];
  v_text text;
  -- Samma 24 h som STORY_LIFETIME_MS i lib/supportStories.ts — ändras det
  -- ena måste det andra följa med.
  v_expires timestamptz := now() + interval '24 hours';
  v_story_id uuid;
begin
  if p_tone is null or length(trim(p_tone)) = 0 then
    raise exception 'Pick at least one kind of support.';
  end if;

  if p_item_id is not null then
    select w.text into v_text
      from wishlist_items w
     where w.id = p_item_id and w.user_id = auth.uid();

    if v_text is null then
      raise exception 'That item is not yours.';
    end if;

    -- Tonen och utgången sätts på punkten bara när storyn faktiskt ÄR en
    -- punkt. En fristående story rör ingen rad i listan.
    update wishlist_items
       set tone = p_tone,
           story_expires_at = v_expires,
           updated_at = now()
     where id = p_item_id;
  else
    v_text := nullif(trim(coalesce(p_activity, '')), '');
    if v_text is null then
      raise exception 'Nothing to share.';
    end if;
  end if;

  -- En aktiv story per person. Story-raden plockar ut den egna med `.find()`
  -- på user_id, så två aktiva rader hade gjort vilken som visas godtycklig.
  -- Att publicera en ny ersätter alltså den förra.
  if p_recipient_ids is not null then
    select array_agg(distinct x) into v_recipients
      from unnest(p_recipient_ids) as x
     where exists (
       select 1 from friendships f
        where f.status = 'accepted'
          and ((f.requester_id = auth.uid() and f.receiver_id = x)
            or (f.receiver_id = auth.uid() and f.requester_id = x))
     );
    if v_recipients is null then
      raise exception 'Pick at least one friend.';
    end if;
  end if;

  update support_stories set is_active = false
   where user_id = auth.uid() and is_active = true;

  insert into support_stories (user_id, support_type, activity, intention_id, wishlist_item_id, expires_at, recipient_ids)
  values (auth.uid(), p_tone, v_text, p_intention_id, p_item_id, v_expires, v_recipients)
  returning id into v_story_id;

  return v_story_id;
end;
$$;

-- Markerar en punkt klar. Idempotent: en punkt som redan är klar rör vi inte,
-- annars hade `done_at` kunnat hoppa till en ny vecka och räknats två gånger
-- i den delade potten.
--
-- Specens `proof_moment_id` och token utgår i v1 — bevis-moment finns inte i
-- schemat och tokens är medvetet uteslutna.
create or replace function complete_wishlist_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_text text;
  v_hidden boolean;
  v_circle_id uuid;
begin
  select w.text, w.hidden_from_circle into v_text, v_hidden
    from wishlist_items w
   where w.id = p_item_id and w.user_id = auth.uid() and w.done_at is null;

  if v_text is null then
    return;
  end if;

  update wishlist_items set done_at = now(), updated_at = now() where id = p_item_id;

  -- En dold punkt bockas av i tysthet: flödesraden bär texten, och den
  -- skulle annars visa kretsen just det som doldes.
  if v_hidden then
    return;
  end if;

  -- I varje krets man är med i: listan syns för alla ens kretsar
  -- (`shares_circle_with`), så bocken hör hemma i alla deras flöden.
  for v_circle_id in select circle_id from circle_members where user_id = auth.uid() loop
    insert into circle_activity (circle_id, actor_id, type, metadata)
      values (v_circle_id, auth.uid(), 'wishlist_completed', jsonb_build_object('text', v_text));
  end loop;
end;
$$;

-- Veckans avklarade punkter för hela kretsen. Driver både siffran i
-- "Done together" och listan bakom den. Ingen rangordning per person — det är
-- kretsens gemensamma siffra, och `order by done_at desc` är senast först.
create or replace function circle_weekly_completions(p_circle_id uuid)
-- Kolumnen heter `item_text`, inte `text`: en OUT-parameter som heter samma
-- sak som en typ är en fälla att läsa, och skuggar kolumnreferenser i kroppen.
returns table (
  item_id uuid,
  user_id uuid,
  username text,
  avatar_url text,
  item_text text,
  done_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- `m.` behövs: RETURNS TABLE gör `user_id` till en OUT-variabel, och ett
  -- okvalificerat `user_id` här är därför tvetydigt mellan variabeln och
  -- kolumnen. PL/pgSQL avvisar det med "column reference is ambiguous" —
  -- vid anropet, inte när funktionen skapas, så filen körs igenom fint och
  -- felet dyker upp först när någon öppnar potten.
  if not exists (
    select 1 from circle_members m
     where m.circle_id = p_circle_id and m.user_id = auth.uid()
  ) then
    raise exception 'You are not a member of this circle.';
  end if;

  -- circle_week_start() är ett datum; jämförs det direkt mot en timestamptz
  -- tolkas det i sessionens tidszon. Kretsens vecka börjar måndag 00:00 UTC,
  -- så den gränsen skrivs ut explicit i stället för att förlita sig på att
  -- servern råkar stå på UTC.
  return query
    select i.id, i.user_id, p.username, p.avatar_url, i.text, i.done_at
      from wishlist_items i
      join circle_members m on m.user_id = i.user_id and m.circle_id = p_circle_id
      join profiles p on p.id = i.user_id
     where i.done_at >= (circle_week_start()::timestamp at time zone 'utc')
       -- Definer går förbi policyn, så dolda punkter filtreras här också.
       and not i.hidden_from_circle
     order by i.done_at desc;
end;
$$;
