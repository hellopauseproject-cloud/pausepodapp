-- Fyra sociala notiser: kretsens chatt, en stödförfrågan, ett stödsvar som
-- landat, en pausinbjudan.
--
-- Körs för hand i Supabase SQL-editorn, EFTER circle_goal_notify.sql,
-- circle_chat.sql, wishlist.sql och pause_invites.sql (samma konvention som
-- resten av mappen).
-- Allt är idempotent rakt igenom.
--
-- ─── Vad det här är ─────────────────────────────────────────────────────────
--
-- Röret är kretsens dagsmålsnotis: samma `notify_config`-rader, samma
-- edge-funktion, samma nattfönster 08–21 i mottagarens tid, samma princip att
-- mottagare och text räknas fram här och att funktionen bara skickar vidare.
-- Det enda som är nytt är **taken**, och varje notis har sitt eget. Frågan
-- CLAUDE.md ställer om en ny notis — kan den växa av sig själv? — besvaras
-- per notis nedan:
--
--   * Chatten: **en per oläst svit.** Första meddelandet efter att man senast
--     läste chatten knackar; resten är tysta tills man öppnat den. Taket är
--     alltså en notis per läsning, hur mycket de andra än skriver.
--   * Stödförfrågan: **högst en per avsändare och dygn**, till avsändarens
--     accepterade vänner. Primärnyckeln `(sender_id, day)` är spärren.
--   * Stödsvar: **buntat tills öppnat.** Första oöppnade svaret knackar;
--     svarar tre vänner till innan man öppnat är det fortfarande en notis.
--   * Pausinbjudan: **varje inbjudan knackar.** Den är handplockad, så taket
--     är att någon aktivt valt en; bara nattfönstret gäller.
--
-- **Ingen av dem bär innehåll.** Chatten säger vem som skrev, inte vad.
-- Stödsvaret säger vem som svarade, aldrig vad — läses det på låsskärmen tror
-- appen fortfarande att det är oläst, och öppningsritualen i
-- app/support-view-text.tsx går förbi. Förfrågan säger vem som bad, inte om
-- vad: ämnet kan vara en punkt ur någons att göra-lista.
--
-- **Varför triggers, när dagsmålsnotisen är ett RPC.** Dagsmålet måste räknas
-- ut (ledgern, målet, dygnet), och det gör RPC:t. Här är händelsen själva
-- inserten, och den görs från sex ställen i klienten (fyra svarsskärmar,
-- story-skapandet, `activate_story`) plus `send_circle_message`. Ett anrop
-- efter varje hade varit sex ställen att glömma. Avstängningen är densamma som
-- för dagsmålet: tas konfigraderna bort blir allt en tyst no-op.


-- ══ 1. Gemensamt ═════════════════════════════════════════════════════════════

-- Är det dag där mottagaren är? Ord för ord samma uttryck som i
-- `notify_circle_goal_reached`. Saknas tidszonen antas UTC, av samma skäl som
-- där: en notis i möjligen fel timme är bättre än ingen, och kolumnen fylls
-- vid nästa appstart.
create or replace function push_is_daytime(p_tz_offset_minutes int)
returns boolean
language sql
stable
as $$
  select extract(hour from (
           (now() at time zone 'utc') - make_interval(mins => coalesce(p_tz_offset_minutes, 0))
         )) between 8 and 20;
$$;

revoke all on function push_is_daytime(int) from anon, authenticated;

-- Postar en färdig notis till edge-funktionen. `p_channel` är Androids kanal
-- och iOS tråd; den måste finnas i `PUSH_CHANNELS` i lib/notifications.ts och
-- i `CHANNELS` i edge-funktionen, annars faller den tillbaka på förvalet.
create or replace function push_post(
  p_tokens  jsonb,
  p_title   text,
  p_body    text,
  p_data    jsonb,
  p_channel text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
begin
  if p_tokens is null or jsonb_array_length(p_tokens) = 0 then
    return;
  end if;

  select value into v_url    from notify_config where key = 'goal_notify_url';
  select value into v_secret from notify_config where key = 'goal_notify_secret';
  if v_url is null or v_secret is null then
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'x-pause-secret', v_secret
    ),
    body    := jsonb_build_object(
      'tokens',  p_tokens,
      'title',   p_title,
      'body',    p_body,
      'data',    p_data,
      'channel', p_channel
    )
  );
end;
$$;

revoke all on function push_post(jsonb, text, text, jsonb, text) from anon, authenticated;

-- Konfigen är tom innan någon fyllt i den. Triggarna nedan slår upp den
-- FÖRST, så att en databas utan push inte ens bokför tak — annars hade den
-- första notisen efter att konfigen fyllts i kunnat tystas av en bokning som
-- gjordes medan ingenting kunde skickas.
create or replace function push_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from notify_config where key = 'goal_notify_url')
     and exists (select 1 from notify_config where key = 'goal_notify_secret');
$$;

revoke all on function push_enabled() from anon, authenticated;


-- ══ 2. Kretsens chatt ════════════════════════════════════════════════════════
--
--   Anna wrote in the chat
--   Tap to read.
--
-- **En per oläst svit.** `chat_notified_at` är när man senast knackades. Man
-- knackas igen först när man läst sedan dess (`chat_read_at` — eller
-- `joined_at` för den som aldrig öppnat chatten, samma reserv som
-- olästräknaren använder). Det är ett tak som inte kan växa: mellan två
-- läsningar finns högst en notis, oavsett om de andra skriver tre rader eller
-- trehundra.
--
-- Den som filtrerats bort av nattfönstret bokförs INTE. Ett meddelande klockan
-- 23 ska inte äta upp morgonens knackning — det första meddelandet efter
-- klockan åtta knackar i stället.
--
-- Bokningen och urvalet är samma `update … returning`, så två meddelanden i
-- samma ögonblick kan inte båda knacka: det andra väntar på radlåset och ser
-- då en `chat_notified_at` som redan flyttats fram.
alter table circle_members add column if not exists chat_notified_at timestamptz;

create or replace function notify_circle_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name   text;
  v_tokens jsonb;
begin
  if new.user_id is null or not push_enabled() then
    return new;
  end if;

  select username into v_name from profiles where id = new.user_id;
  if v_name is null then
    return new;
  end if;

  with picked as (
    update circle_members m
       set chat_notified_at = now()
      from profiles p
     where p.id = m.user_id
       and m.circle_id = new.circle_id
       and m.user_id  <> new.user_id
       and p.push_token is not null
       and push_is_daytime(p.tz_offset_minutes)
       and (m.chat_notified_at is null
            or m.chat_notified_at < coalesce(m.chat_read_at, m.joined_at))
    returning p.push_token
  )
  select jsonb_agg(push_token) into v_tokens from picked;

  -- Inget pronomen, ingen text ur meddelandet. Se filens huvud.
  perform push_post(
    v_tokens,
    v_name || ' wrote in the chat',
    'Tap to read.',
    jsonb_build_object('type', 'circle_chat', 'circle_id', new.circle_id),
    'circle-chat'
  );

  return new;
-- En notis som inte gick att skicka får aldrig fälla inserten den hänger på:
-- meddelandet är det som räknas, knackningen är en bisak. Saknas pg_net eller
-- felar något annat loggas en varning och raden skrivs ändå. Samma block står
-- i de två triggarna nedan.
exception when others then
  raise warning 'notify_circle_message: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists circle_messages_notify on circle_messages;
create trigger circle_messages_notify
  after insert on circle_messages
  for each row execute function notify_circle_message();


-- ══ 3. Stödförfrågan ═════════════════════════════════════════════════════════
--
--   Anna asked for support
--   Send a few words.
--
-- **Högst en per avsändare och dygn**, till avsändarens accepterade vänner.
-- Vänlistan har ingen övre gräns, så taket kan inte sitta i mottagarna — det
-- sitter i avsändaren. En story ersätter den förra (`activate_story` släcker
-- den gamla), så den som publicerar om sin fråga tre gånger på en kväll ska
-- inte ha knackat på hos alla vänner tre gånger.
--
-- `day` är avsändarens lokala dag, ur `profiles.tz_offset_minutes`. Samma
-- resonemang som `daily_goal_achievements`: det här jämför ingen med någon,
-- så dygnsgränsen behöver inte vara delad.
--
-- Dygnet bokförs bara när någon faktiskt kan nås. En fråga som ställs när
-- alla vänner sover ska inte tysta en fråga som ställs på förmiddagen.
create table if not exists support_request_pings (
  sender_id uuid not null references profiles(id) on delete cascade,
  day       date not null,
  story_id  uuid,
  sent_at   timestamptz not null default now(),
  primary key (sender_id, day)
);

alter table support_request_pings enable row level security;
revoke all on support_request_pings from anon, authenticated;

create or replace function notify_support_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name   text;
  v_tz     int;
  v_day    date;
  v_tokens jsonb;
  v_rows   int;
begin
  if new.is_active is not true or not push_enabled() then
    return new;
  end if;

  select username, tz_offset_minutes into v_name, v_tz from profiles where id = new.user_id;
  if v_name is null then
    return new;
  end if;

  select jsonb_agg(p.push_token)
    into v_tokens
    from friendships f
    join profiles p
      on p.id = case when f.requester_id = new.user_id then f.receiver_id else f.requester_id end
   where f.status = 'accepted'
     and (f.requester_id = new.user_id or f.receiver_id = new.user_id)
     and p.id <> new.user_id
     -- En förfrågan till utvalda vänner knackar bara hos dem (se
     -- `recipient_ids` i wishlist.sql); null är alla vänner.
     and (new.recipient_ids is null or p.id = any(new.recipient_ids))
     and p.push_token is not null
     and push_is_daytime(p.tz_offset_minutes);

  if v_tokens is null then
    return new;
  end if;

  v_day :=((now() at time zone 'utc') - make_interval(mins => coalesce(v_tz, 0)))::date;

  insert into support_request_pings (sender_id, day, story_id)
  values (new.user_id, v_day, new.id)
  on conflict (sender_id, day) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return new;
  end if;

  perform push_post(
    v_tokens,
    v_name || ' asked for support',
    'Send a few words.',
    jsonb_build_object('type', 'support_request', 'story_id', new.id),
    'support-request'
  );

  return new;
exception when others then
  raise warning 'notify_support_request: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists support_stories_notify on support_stories;
create trigger support_stories_notify
  after insert on support_stories
  for each row execute function notify_support_request();


-- ══ 4. Stödsvar som landat ═══════════════════════════════════════════════════
--
--   Anna sent you support
--   Open it now.
--
-- **Buntat tills öppnat.** Har man redan knackats om ett svar som fortfarande
-- ligger oöppnat (`delivered_at is null`), är man redan på väg dit — ett
-- andra, tredje svar lägger sig i samma kuvert utan att knacka. Öppnar man
-- dem knackar nästa svar igen.
--
-- "Oöppnat" räknas på samma rader som Friends-flikens bricka: svar på **alla**
-- ens egna stories, också utgångna och borttagna. Svaren överlever förfrågan
-- (en förfrågan står 24 timmar, se lib/supportStories.ts), så ett oöppnat svar
-- på en gammal story ligger fortfarande i inkorgen och är något man är på väg
-- till. Förr räknades bara aktiva stories, för då syntes svaren på en släckt
-- story ingenstans och hade tystat notisen för alltid.
--
-- Rubriken namnger den första avsändaren även när fler hunnit svara. Det är
-- sant om notisen när den kom, och inkorgen visar resten.
create table if not exists support_inbox_pings (
  user_id     uuid primary key references profiles(id) on delete cascade,
  notified_at timestamptz not null
);

alter table support_inbox_pings enable row level security;
revoke all on support_inbox_pings from anon, authenticated;

create or replace function notify_support_response()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner    uuid;
  v_name     text;
  v_token    text;
  v_tz       int;
  v_notified timestamptz;
begin
  if not push_enabled() then
    return new;
  end if;

  select user_id into v_owner from support_stories where id = new.story_id;
  if v_owner is null or v_owner = new.sender_id then
    return new;
  end if;

  select push_token, tz_offset_minutes into v_token, v_tz from profiles where id = v_owner;
  if v_token is null or not push_is_daytime(v_tz) then
    return new;
  end if;

  select username into v_name from profiles where id = new.sender_id;
  if v_name is null then
    return new;
  end if;

  -- Raden låses, så att två svar i samma ögonblick inte båda ser "inte
  -- knackad" och knackar var sitt.
  insert into support_inbox_pings (user_id, notified_at)
  values (v_owner, '-infinity')
  on conflict (user_id) do nothing;

  select notified_at into v_notified
    from support_inbox_pings
   where user_id = v_owner
   for update;

  if exists (
    select 1
      from support_responses r
      join support_stories s on s.id = r.story_id
     where s.user_id = v_owner
       and r.id <> new.id
       and r.delivered_at is null
       and r.created_at <= v_notified
  ) then
    return new;
  end if;

  update support_inbox_pings set notified_at = now() where user_id = v_owner;

  perform push_post(
    jsonb_build_array(v_token),
    v_name || ' sent you support',
    -- Ett förseglat svar (supabase/support_sealed.sql) öppnas efter en paus.
    -- Läst ur jsonb, så att funktionen fungerar också innan kolumnen finns.
    case when coalesce((to_jsonb(new) ->> 'opens_after_pause')::boolean, false)
      then 'Take a pause to open.'
      else 'Open it now.'
    end,
    jsonb_build_object('type', 'support_received'),
    'support-received'
  );

  return new;
exception when others then
  raise warning 'notify_support_response: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists support_responses_notify on support_responses;
create trigger support_responses_notify
  after insert on support_responses
  for each row execute function notify_support_response();


-- ══ 5. Pausinbjudan ══════════════════════════════════════════════════════════
--
--   Anna invited you to pause
--   Join in.
--
-- Inbjudan är en rad i `pause_invites` (supabase/pause_invites.sql, som måste
-- köras FÖRE den här filen). Den skrivs i samma stund som värdens paus
-- startar, och dörren står öppen så länge värden pausar — högst 30 minuter.
-- Det är den enda notisen som lagar något trasigt: inbjudan nådde förr bara
-- den som redan satt i appen.
--
-- **Varje inbjudan knackar.** Taket är handen, inte en räknare: en inbjudan
-- är handplockad på Hem (valet töms när pausen startar), så varje push är en
-- person som just valde en annan person. Den kan inte växa med vänlistan och
-- inte av sig själv — bara av att någon aktivt bjuder in igen. Bara
-- nattfönstret 08–21 gäller, i mottagarens tid.
--
-- Förr var taket en per avsändare och dygn (`pause_invite_pings`), och innan
-- dess tio minuter. Det togs bort på begäran: en andra inbjudan samma dag
-- syntes då bara i Friends, och mottagaren missade den. Tabellen står kvar
-- oläst och oskriven, samma linje som kolumnerna i den här mappen.
create table if not exists pause_invite_pings (
  inviter_id  uuid not null references profiles(id) on delete cascade,
  invitee_id  uuid not null references profiles(id) on delete cascade,
  notified_at timestamptz not null,
  primary key (inviter_id, invitee_id)
);

alter table pause_invite_pings enable row level security;
revoke all on pause_invite_pings from anon, authenticated;

create or replace function notify_pause_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text;
  v_token text;
  v_tz    int;
begin
  if not push_enabled() then
    return new;
  end if;

  select push_token, tz_offset_minutes into v_token, v_tz from profiles where id = new.invitee_id;
  if v_token is null or not push_is_daytime(v_tz) then
    return new;
  end if;

  select username into v_name from profiles where id = new.host_id;
  if v_name is null then
    return new;
  end if;

  -- Inget pronomen och inget om vad värden gör — bara vem.
  perform push_post(
    jsonb_build_array(v_token),
    v_name || ' invited you to pause',
    'Join in.',
    jsonb_build_object('type', 'pause_invite', 'shared_id', new.shared_id),
    'pause-invite'
  );

  return new;
exception when others then
  raise warning 'notify_pause_invite: %', sqlerrm;
  return new;
end;
$$;

-- Den första versionen satt på `pause_sessions` och läste den gamla
-- modellens `invite_status`. Den rivs här, så att en databas där den hann
-- köras inte knackar två gånger.
drop trigger if exists pause_sessions_invite_notify on pause_sessions;

drop trigger if exists pause_invites_notify on pause_invites;
create trigger pause_invites_notify
  after insert on pause_invites
  for each row execute function notify_pause_invite();


-- ══ 6. Kontroll ═════════════════════════════════════════════════════════════
--
-- Ska ge fyra rader.
--   select tgname, tgrelid::regclass from pg_trigger
--    where tgname in ('circle_messages_notify', 'support_stories_notify',
--                     'support_responses_notify', 'pause_invites_notify');
--
-- Gick utskicken fram? pg_net loggar svaren själv.
--   select id, status_code, left(content, 200) as svar, created
--     from net._http_response order by created desc limit 10;


-- ══ 7. Att stänga av dem ════════════════════════════════════════════════════
--
-- En i taget, utan att röra dagsmålsnotisen:
--
--   drop trigger if exists circle_messages_notify   on circle_messages;
--   drop trigger if exists support_stories_notify   on support_stories;
--   drop trigger if exists support_responses_notify on support_responses;
--   drop trigger if exists pause_invites_notify     on pause_invites;
--
-- Alla på en gång, dagsmålet inräknat: töm konfigen, se
-- circle_goal_notify.sql avsnitt 6.
