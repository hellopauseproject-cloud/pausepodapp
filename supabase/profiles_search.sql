-- Sökningen efter personer — kör i Supabase SQL-editorn.
-- Samma konvention som supabase/circles.sql: schemat bor här, inte i ett
-- migrationsverktyg, och körs för hand. Allt är idempotent.
--
-- ── Problemet ───────────────────────────────────────────────────────────────
--
-- Förut sökte klienten direkt i tabellen:
--
--     supabase.from('profiles').select(...).ilike('username', '%' + q + '%')
--
-- med två tecken som minimum. Två tecken i en substrängsökning är ingen
-- sökning, det är en bläddring: 676 anrop ('aa' till 'zz') och man har gått
-- igenom hela användarregistret. Man behövde inte känna någon för att se vilka
-- som fanns.
--
-- ── Regeln ──────────────────────────────────────────────────────────────────
--
-- Minst TRE tecken rätt, var som helst i namnet.
--
-- Det stod fem här förut, med motiveringen att det är där gissning slutar
-- fungera och igenkänning tar vid. Det argumentet håller fortfarande — tre
-- tecken är mätbart svagare, 26³ ≈ 17 600 kombinationer att beta av mot
-- 26⁵ ≈ 11,9 miljoner — men fem kostade mer än det skyddade:
--
--   • Den som minns "and" ur "andersson" fick noll träffar och en tillsägelse
--     i stället för sin vän. Att minnas fyra tecken av ett namn är vanligt.
--   • Klienten var tvungen att ha ett ANDRA tröskelvärde (`FULL_QUERY`) bara
--     för att kunna säga "vi har inte letat än" i glappet mellan tre och fem,
--     eftersom "No one found" hade varit en lögn där. Med samma tal på båda
--     ställena försvinner både glappet och raden som förklarade det.
--
-- Och framför allt: **skyddet är teoretiskt så länge RLS-policyn längst ner i
-- den här filen är bortkommenterad.** Så länge `profiles` går att läsa fritt
-- kan vem som helst med en inloggad session hämta hela tabellen i ett anrop
-- och behöver inte söka alls. Tröskeln här är dörren; policyn är väggen. Ska
-- talet höjas igen är det policyn som ska sättas på först — då, och först då,
-- är skillnaden mellan tre och fem värd något.
--
-- Substräng och inte prefix med flit. Prefix hade varit säkrare men hade
-- krävt att man vet hur namnet BÖRJAR, och den som söker efter en vän minns
-- oftast en bit av namnet snarare än dess början. Skyddet ligger i längden,
-- inte i positionen.
--
-- Undantaget är namn kortare än tre tecken: de går att hitta bara genom att
-- skriva hela namnet. Utan det undantaget vore de omöjliga att hitta över
-- huvud taget, och en användare som inte går att lägga till är en bugg och
-- inte ett skydd. (Det finns inget minimilängdskrav på `username` i
-- databasen, så ett namn på ett eller två tecken är möjligt.)
--
-- Taket är fem träffar. Även med en träff ska svaret vara "den här personen"
-- och inte "här är alla som råkar innehålla det".

-- ── RPC ─────────────────────────────────────────────────────────────────────
-- `security definer`, av samma skäl som get_circle_progress och
-- get_friend_circle_badge: det här ska vara den ENDA vägen till en främlings
-- profilrad, så att regeln ovan gäller även när RLS på `profiles` stramas åt
-- (se avsnittet längst ner). En funktion som kör som sin ägare fortsätter
-- fungera när tabellen slutar vara läsbar.
--
-- Samma drop-först-mönster som i circles.sql: `create or replace` ersätter
-- bara en funktion med exakt samma argumenttyper, så en tidigare version med
-- annan signatur hade blivit en andra överlagring och PostgREST hade inte
-- kunnat välja mellan dem.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'search_profiles'
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end;
$$;

create or replace function search_profiles(search_query text)
returns table (id uuid, username text, avatar_url text)
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select
      trim(search_query) as raw,
      -- **Jokertecknen måste neutraliseras.** `%` och `_` är operatorer i
      -- ILIKE, så utan det här kunde man söka på '%%%' — tre tecken enligt
      -- regeln, men ett mönster som matchar varenda rad i tabellen. Hela
      -- skyddet hade gått att kringgå med tre tangenttryck.
      replace(replace(replace(trim(search_query), '\', '\\'), '%', '\%'), '_', '\_') as pat
  )
  select p.id, p.username, p.avatar_url
    from profiles p, q
   where p.id <> auth.uid()
     -- Blockerade åt något håll syns inte (moderation.sql, körs före).
     and not private.blocked_pair(auth.uid(), p.id)
     and (
       (length(q.raw) >= 3 and p.username ilike '%' || q.pat || '%' escape '\')
       -- Kortare namn än tre tecken: bara hela namnet duger.
       or (length(p.username) < 3 and lower(p.username) = lower(q.raw))
     )
   -- Kortast först: den vars namn är närmast det man skrev står överst.
   order by length(p.username), p.username
   limit 5;
$$;

revoke execute on function search_profiles(text) from public, anon;
grant execute on function search_profiles(text) to authenticated;


-- ── Det som gör skillnaden mellan ett skydd och en fördröjning ──────────────
--
-- **Regeln ovan är verkningslös så länge `profiles` går att läsa fritt.**
-- Klienten har anon-nyckeln och en inloggad session, och kan skriva vilken
-- fråga som helst mot tabellen — inklusive `select * from profiles` utan
-- filter. Att lägga regeln i en RPC hjälper bara om tabellen bakom den slutar
-- vara öppen. Annars har vi flyttat framdörren men lämnat väggen öppen.
--
-- Policyn nedan ger läsrätt till din egen rad, till dem du har en
-- vänskapsrad med (oavsett status — en förfrågan åt något håll räcker), och
-- till dem du delar krets med.
--
-- **Den är medvetet bortkommenterad.** Den rör varje skärm som läser
-- `profiles`, och flera gör det genom inbäddningar som RLS filtrerar tyst:
-- en rad försvinner inte med ett felmeddelande, den blir bara `null` och
-- namnet blir "Unknown". Innan du kör den, gå igenom:
--
--   • Vänner-fliken — listan och profilkorten
--   • Stöd-storyn i Community: `profile:profiles!user_id(...)` — är alla som
--     lägger upp en story alltid vänner med den som ser den?
--   • Kretsen — medlemslistan går via get_circle_progress (definer, opåverkad)
--     men modalens `profiles!user_id`-inbäddning gör det inte
--   • Inkommande vänförfrågningar från någon du ännu inte har en rad med
--   • Samtalsskärmen och partnerstatus
--
-- Hittar du en yta som behöver en främlings namn är rätt svar en ny
-- `security definer`-funktion för just den ytan, inte en bredare policy.
--
-- alter table profiles enable row level security;
--
-- drop policy if exists "read own and related profiles" on profiles;
-- create policy "read own and related profiles" on profiles
--   for select using (
--     id = (select auth.uid())
--     or exists (
--       select 1 from friendships f
--        where (f.requester_id = (select auth.uid()) and f.receiver_id = profiles.id)
--           or (f.receiver_id = (select auth.uid()) and f.requester_id = profiles.id)
--     )
--     or exists (
--       select 1 from circle_members me
--       join circle_members them on them.circle_id = me.circle_id
--        where me.user_id = (select auth.uid()) and them.user_id = profiles.id
--     )
--   );
