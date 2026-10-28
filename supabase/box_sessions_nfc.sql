-- Pauser som lådan själv startat (NFC-taggen + locket), sparade av lådan via
-- WiFi och edge-funktionen box-session. Körs för hand efter tag_pairing.sql,
-- samma konvention som resten av mappen.
--
-- Varför en definer-funktion och inte en insert från edge-funktionen:
-- service_role har ingen skrivrätt på pause_sessions i den riktiga databasen,
-- och behörigheterna på en befintlig tabell ska inte ändras för lådans skull.
-- Funktionen kan bara anropas av service_role.
--
-- Raden blir likadan som appens lådpauser (lib/sessionOutbox.ts), med
-- source = 'nfc' så att de går att skilja åt. box_seq är `<box_id>:<seq>`:
-- appens egna lådpauser skriver bara seq, och unika indexet
-- pause_sessions_box_seq_unique (user_id, box_seq) gör anropet idempotent —
-- lådan kan skicka om samma paus hur många gånger som helst.
--
-- Kretsen och dagsmålet: appen anropar record_circle_pause och
-- record_daily_goal_reached efter varje paus, och båda läser auth.uid().
-- Funktionen sätter därför taggägarens id som inloggad användare i just den
-- här transaktionen (set_config med is_local = true) och anropar samma två
-- funktioner — ingen kopia av deras logik. Tidszonen kommer inte från någon
-- telefon, så den räknas för Europe/Stockholm med samma tecken som JS
-- getTimezoneOffset (UTC minus lokal tid, -60 på vintern).

create or replace function public.record_box_session(
  p_box_id      text,
  p_tag_uid     text,
  p_seq         bigint,
  p_duration_ms bigint,
  p_completed   boolean,
  p_ended_ago_ms bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id  uuid;
  v_ended    timestamptz;
  v_started  timestamptz;
  v_id       uuid;
  v_tz       int;
begin
  if p_duration_ms is null or p_duration_ms <= 0 or p_seq is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  select t.user_id into v_user_id
    from public.pause_tags t
   where t.tag_uid = p_tag_uid and t.deactivated_at is null
   limit 1;
  if v_user_id is null then
    return jsonb_build_object('status', 'unknown_tag');
  end if;

  v_ended   := now() - make_interval(secs => greatest(coalesce(p_ended_ago_ms, 0), 0) / 1000.0);
  v_started := v_ended - make_interval(secs => p_duration_ms / 1000.0);

  insert into public.pause_sessions
    (user_id, started_at, ended_at, duration_seconds, intention, is_shared,
     with_pod, completed, box_id, box_seq, source, kind)
  values
    (v_user_id, v_started, v_ended, round(p_duration_ms / 1000.0)::int, null, false,
     true, p_completed, p_box_id, p_box_id || ':' || p_seq, 'nfc', 'pause')
  on conflict (user_id, box_seq) where box_seq is not null do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('status', 'duplicate');
  end if;

  if p_completed then
    perform set_config('request.jwt.claim.sub', v_user_id::text, true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', v_user_id, 'role', 'authenticated')::text, true);
    v_tz := round(extract(epoch from (now() at time zone 'UTC') - (now() at time zone 'Europe/Stockholm')) / 60)::int;
    perform public.record_circle_pause(v_id, null, v_tz);
    perform public.record_daily_goal_reached(v_tz);
  end if;

  return jsonb_build_object('status', 'saved', 'session_id', v_id);
end;
$$;

revoke execute on function public.record_box_session(text, text, bigint, bigint, boolean, bigint)
  from public, anon, authenticated;
grant execute on function public.record_box_session(text, text, bigint, bigint, boolean, bigint)
  to service_role;
