-- Radera sitt eget konto (november 2026, krav från App Store och Google Play).
-- Körs för hand i SQL-editorn, samma konvention som resten av mappen. Går att
-- köra om. Kör den FÖRE appen: knappen i profilen anropar delete_my_account().
--
-- Klienten (deleteAccount i contexts/AuthContext.tsx) tar bort de egna filerna
-- i storage först — storage.objects går inte att radera med SQL
-- (`protect_objects_delete`) — och anropar sedan den här funktionen.

-- ─── 1. Filerna: ägaren får radera sin egen mapp ──────────────────────────
-- support-media hade redan en delete-policy. Avatarerna och de gamla röst-
-- och videomeddelandena hade bara insert/select, så klienten kunde inte
-- städa efter sig. Mappen är alltid `<user_id>/…`, samma som uppladdningen.

drop policy if exists "Users can delete own avatar" on storage.objects;
create policy "Users can delete own avatar" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users can delete own voice messages" on storage.objects;
create policy "Users can delete own voice messages" on storage.objects
  for delete to authenticated
  using (bucket_id = 'voice-messages' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users can delete own video messages" on storage.objects;
create policy "Users can delete own video messages" on storage.objects
  for delete to authenticated
  using (bucket_id in ('video-messages', 'video-message')
         and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ─── 2. Raderingen ────────────────────────────────────────────────────────
-- Det mesta försvinner av sig självt: nästan allt pekar på profiles med
-- `on delete cascade`, och chatten, flödet och belöningsförslagen sätter
-- avsändaren till null ("Someone") i stället för att riva andras samtal.
-- Fyra saker gör det inte, och ordningen nedan är därför inte valfri:
--
-- * **Kretsar.** `circles.created_by` är `on delete cascade`, så att radera
--   den som skapade en krets hade raderat kretsen för alla andra. Först går
--   man ur varje krets med leave_circle (som ger ägarskapet vidare och räknar
--   om veckan), sedan flyttas `created_by` till kretsens ägare. Bara en krets
--   utan medlemmar kvar raderas.
-- * **friendships, pause_sessions, pause_messages** har `no action` mot
--   profiles och skulle stoppa raderingen. pause_messages pekar dessutom på
--   pause_sessions, så meddelandena går först.
-- * **profiles** har `no action` mot auth.users, så profilen raderas före
--   inloggningen.
--
-- Händelseloggen (app_events) behåller sina rader med `user_id` null — de är
-- anonyma räknare, samma linje som när ett testkonto raderas.

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_circle uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;

  for v_circle in select circle_id from circle_members where user_id = v_uid loop
    perform leave_circle(v_circle);
  end loop;

  update circles c
     set created_by = (
       select m.user_id from circle_members m
        where m.circle_id = c.id
        order by (m.role = 'owner') desc, m.joined_at asc
        limit 1)
   where c.created_by = v_uid
     and exists (select 1 from circle_members m where m.circle_id = c.id);
  delete from circles where created_by = v_uid;

  delete from pause_messages
   where sender_id = v_uid
      or receiver_id = v_uid
      or session_id in (select id from pause_sessions where user_id = v_uid);
  delete from friendships where requester_id = v_uid or receiver_id = v_uid;
  delete from pause_sessions where user_id = v_uid;
  delete from box_session_starts where user_id = v_uid;

  delete from profiles where id = v_uid;
  delete from auth.users where id = v_uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
