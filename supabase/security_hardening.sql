-- Säkerhetshärdning före lansering (november 2026).
-- Körs för hand i SQL-editorn, samma konvention som resten av mappen. Går att
-- köra om. Ändrar ingenting appen gör — bara det en klient *inte* ska kunna.
--
-- Bucketens sista steg (privat) ligger i security_private_media.sql och körs
-- först när en app med `signSupportMediaUrls` (lib/supportMedia.ts) är ute.

-- ─── 1. Vänskaper: ingen kan godkänna sin egen förfrågan ──────────────────
-- Policyn "users can update own friendships" släppte igenom avsändaren, utan
-- `with check`, och `authenticated` fick skriva varje kolumn. Den som skickat
-- en förfrågan kunde alltså själv sätta `status = 'accepted'` och därmed läsa
-- mottagarens pauser. Likadant gick det att lägga in en rad som redan var
-- accepterad.
--
-- Appen gör exakt två skrivningar: insert med `status = 'pending'`
-- (add-friend, kretsens medlemslista) och mottagarens update till
-- `'accepted'` (Friends). Båda går igenom som förut.

drop policy if exists "users can update own friendships" on public.friendships;
drop policy if exists "Users can update friendships they received" on public.friendships;
create policy "receiver accepts friendship" on public.friendships
  for update to authenticated
  using (receiver_id = (select auth.uid()))
  with check (receiver_id = (select auth.uid()) and status = 'accepted');

drop policy if exists "users can insert friendships" on public.friendships;
drop policy if exists "Users can send friend requests" on public.friendships;
create policy "send friend request" on public.friendships
  for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and receiver_id <> (select auth.uid())
    and status = 'pending'
  );

-- Bara status går att ändra; parterna i en vänskap är fasta.
revoke update on public.friendships from authenticated, anon;
grant update (status) on public.friendships to authenticated;

-- Dubbletterna (samma villkor två gånger) gör det svårt att se vad som gäller.
drop policy if exists "users can delete own friendships" on public.friendships;
drop policy if exists "users can select own friendships" on public.friendships;

-- ─── 2. Profiler: push-token och oanvända kolumner går inte att läsa ──────
-- Raderna förblir läsbara för inloggade ("authenticated users can view
-- profiles"): kretsmedlemmar, chattförfattare, kretsinbjudningar, värdar för
-- pausinbjudningar och avsändare av stöd hämtar alla namn och ansikte direkt
-- ur tabellen, och de är inte alltid vänner. Det som inte ska lämnas ut är
-- `push_token` — med den kan vem som helst skicka push till användaren via
-- Expo — och kolumnerna ingen läser.
--
-- `tz_offset_minutes` och `daily_target_seconds` står kvar: RPC:er som körs
-- som anroparen (get_daily_goal_progress, get_habit_progress, sömnens) läser
-- dem. `security definer`-funktionerna (notiserna) påverkas inte.
--
-- **En ny kolumn på profiles måste läggas till här** för att klienten ska
-- kunna läsa den — och `select('*')` mot profiles fungerar inte längre.

revoke select on public.profiles from authenticated, anon;
grant select (
  id, username, avatar_url, show_stats, created_at, onboarding_completed,
  is_pausing, tz_offset_minutes, daily_target_seconds
) on public.profiles to authenticated;

-- Dubbletter.
drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;

-- ─── 3. Stödsvarens media: bara avsändaren och mottagaren ─────────────────
-- Läsningen avgörs av raden i support_responses, med dess RLS — alltså också
-- spärren för förseglade svar. Avsändaren läser sin egen mapp.
drop policy if exists "Support media: sender or recipient can read" on storage.objects;
create policy "Support media: sender or recipient can read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'support-media'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or exists (
        select 1 from public.support_responses r
        where right(r.content_url, length(name) + 15) = '/support-media/' || name
      )
    )
  );

-- Uppladdning till vilken mapp som helst. "Users can upload own media" står
-- kvar och kräver den egna mappen, som appen redan använder.
drop policy if exists "Authenticated upload" on storage.objects;
