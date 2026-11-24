-- Rapportera och blockera, och godkännandet av användarvillkoren.
--
-- Körs för hand i Supabase SQL-editorn (samma konvention som resten av
-- mappen), EFTER social_notify.sql, wishlist.sql, pause_invites.sql,
-- circle_chat.sql och security_hardening.sql. Allt är idempotent.
-- profiles_search.sql, global_pause.sql och social_notify.sql läser
-- `private.blocked_pair()` och måste köras om EFTER den här filen.
--
-- Krav från Google Plays regler för användargenererat innehåll, och det ska
-- stämma med villkoren på https://joinpausepod.com/privacypolicy/#terms.
--
-- ─── Vad en blockering gör ──────────────────────────────────────────────────
--
-- Den gäller ÅT BÅDA HÅLLEN, med ett undantag:
--
--   * Ingen av dem syns för den andra i sökningen (`search_profiles`), i
--     Global Pause-rummet (`get_global_pause`) eller i kretsens flöde
--     (`circle_activity`).
--   * Vänskapen tas bort, och väntande vän-, krets- och pausinbjudningar
--     mellan dem rivs (triggern `blocks_after_insert`). En ny vänförfrågan går
--     inte att skicka åt något håll (restriktiv policy på `friendships`).
--   * Stöd går inte att skicka åt något håll (triggern på
--     `support_responses`), och redan skickat stöd syns inte längre.
--   * **Undantaget är kretsen.** Delar de en krets ligger båda kvar — en
--     blockering ska inte kunna sparka någon ur en grupp den inte äger. Den
--     som blockerat ser inte den blockerades meddelanden i chatten; den
--     blockerade ser allt som förut. Bara åt ett håll, för det är den som
--     blockerat som bett om att slippa.
--   * Den blockerade får ingen notis och ingenting i appen säger det.
--
-- `profiles` är fortfarande läsbar för alla inloggade (kretsar, chatten och
-- inbjudningarna läser namn och ansikte på icke-vänner, se
-- security_hardening.sql). Blockeringen gömmer personen där man *hittar*
-- någon, inte den rad som bär ett namn man redan har.
--
-- ─── Varför `private.blocked_pair()` ────────────────────────────────────────
--
-- Policyerna körs som anroparen och behöver kunna läsa båda hållen av
-- `blocks`, men en användare får bara se sina egna rader — annars kunde den
-- blockerade läsa ut att den blivit blockerad. Funktionen är därför
-- `security definer`. Den ligger i schemat `private`, som PostgREST inte
-- exponerar: i `public` hade vem som helst kunnat anropa
-- `blocked_pair(mig, x)` och få svaret rakt ut.


-- ══ 1. Blockeringar ══════════════════════════════════════════════════════════

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);

create index if not exists blocks_blocked_id_idx on public.blocks(blocked_id);

alter table public.blocks enable row level security;
revoke all on public.blocks from anon, authenticated;
grant select, insert, delete on public.blocks to authenticated;

drop policy if exists "blocks_select_own" on public.blocks;
create policy "blocks_select_own" on public.blocks
  for select to authenticated
  using (blocker_id = (select auth.uid()));

drop policy if exists "blocks_insert_own" on public.blocks;
create policy "blocks_insert_own" on public.blocks
  for insert to authenticated
  with check (blocker_id = (select auth.uid()));

drop policy if exists "blocks_delete_own" on public.blocks;
create policy "blocks_delete_own" on public.blocks
  for delete to authenticated
  using (blocker_id = (select auth.uid()));

create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.blocked_pair(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.blocks
     where (blocker_id = a and blocked_id = b)
        or (blocker_id = b and blocked_id = a)
  );
$$;

revoke all on function private.blocked_pair(uuid, uuid) from public, anon;
grant execute on function private.blocked_pair(uuid, uuid) to authenticated;

-- Det som hänger mellan dem rivs när blockeringen skrivs. Unblock lägger
-- inte tillbaka något — vänskapen är borta på riktigt.
create or replace function public.blocks_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from friendships
   where (requester_id = new.blocker_id and receiver_id = new.blocked_id)
      or (requester_id = new.blocked_id and receiver_id = new.blocker_id);

  delete from pause_invites
   where joined_at is null
     and ((host_id = new.blocker_id and invitee_id = new.blocked_id)
       or (host_id = new.blocked_id and invitee_id = new.blocker_id));

  delete from circle_invites
   where status = 'pending'
     and ((inviter_id = new.blocker_id and invitee_id = new.blocked_id)
       or (inviter_id = new.blocked_id and invitee_id = new.blocker_id));

  return new;
end;
$$;

drop trigger if exists blocks_after_insert on public.blocks;
create trigger blocks_after_insert
  after insert on public.blocks
  for each row execute function public.blocks_after_insert();

-- Ingen ny vänförfrågan åt något håll. Restriktiv, så den läggs ovanpå
-- "send friend request" utan att röra den.
drop policy if exists "friendships_not_blocked" on public.friendships;
create policy "friendships_not_blocked" on public.friendships
  as restrictive for insert to authenticated
  with check (not private.blocked_pair(requester_id, receiver_id));

-- Stöd: inget nytt åt något håll, och det gamla syns inte.
create or replace function public.support_responses_not_blocked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select user_id into v_owner from support_stories where id = new.story_id;
  if v_owner is not null and private.blocked_pair(new.sender_id, v_owner) then
    raise exception 'You can''t send support to this person.';
  end if;
  return new;
end;
$$;

drop trigger if exists support_responses_not_blocked on public.support_responses;
create trigger support_responses_not_blocked
  before insert on public.support_responses
  for each row execute function public.support_responses_not_blocked();

drop policy if exists "support_responses_not_blocked" on public.support_responses;
create policy "support_responses_not_blocked" on public.support_responses
  as restrictive for select to authenticated
  using (sender_id = (select auth.uid()) or not private.blocked_pair((select auth.uid()), sender_id));

drop policy if exists "support_stories_not_blocked" on public.support_stories;
create policy "support_stories_not_blocked" on public.support_stories
  as restrictive for select to authenticated
  using (user_id = (select auth.uid()) or not private.blocked_pair((select auth.uid()), user_id));

-- Pausinbjudningar: `send_pause_invites` bjuder bara in vänner, och
-- vänskapen är borta. Policyn täcker en inbjudan som hann skickas.
drop policy if exists "pause_invites_not_blocked" on public.pause_invites;
create policy "pause_invites_not_blocked" on public.pause_invites
  as restrictive for select to authenticated
  using (not private.blocked_pair(host_id, invitee_id));

-- Kretsens chatt: bara åt ett håll, se filens huvud. Olästräknaren läser
-- samma tabell och följer alltså med av sig själv.
drop policy if exists "circle_messages_hide_blocked" on public.circle_messages;
create policy "circle_messages_hide_blocked" on public.circle_messages
  as restrictive for select to authenticated
  using (
    user_id is null
    or not exists (
      select 1 from public.blocks b
       where b.blocker_id = (select auth.uid()) and b.blocked_id = circle_messages.user_id
    )
  );

-- Kretsens flöde: åt båda hållen.
drop policy if exists "circle_activity_hide_blocked" on public.circle_activity;
create policy "circle_activity_hide_blocked" on public.circle_activity
  as restrictive for select to authenticated
  using (
    actor_id is null
    or actor_id = (select auth.uid())
    or not private.blocked_pair((select auth.uid()), actor_id)
  );

-- Sökningen och Global Pause-rummet filtrerar på `private.blocked_pair()`
-- i sina egna filer (profiles_search.sql, global_pause.sql), och kretsens
-- chattnotis hoppar över den som blockerat avsändaren (social_notify.sql).
-- En andra kopia av de funktionerna här hade glidit isär vid nästa ändring.


-- ══ 2. Rapporter ═════════════════════════════════════════════════════════════
--
-- Ingen klient läser tabellen — inga select-grants och ingen select-policy.
-- Den läses i Supabase-dashboarden. `content_snapshot` är en kopia av det
-- rapporterade (texten, länken till bilden, namnet) i det ögonblick
-- rapporten skrevs: raderar avsändaren sitt meddelande ska granskningen ändå
-- ha något att granska. Det är det enda stället appen kopierar någons text,
-- och skälet är just att den annars kan försvinna innan någon hunnit läsa.

create table if not exists public.reports (
  id               uuid primary key default gen_random_uuid(),
  reporter_id      uuid references public.profiles(id) on delete set null,
  reported_user_id uuid references public.profiles(id) on delete set null,
  content_type     text not null check (content_type in ('message', 'support', 'photo', 'profile')),
  content_id       uuid,
  reason           text not null check (reason in ('sexual', 'harassment', 'hate', 'violence', 'spam', 'other')),
  details          text check (details is null or length(details) <= 1000),
  content_snapshot jsonb,
  status           text not null default 'open' check (status in ('open', 'reviewed', 'actioned')),
  created_at       timestamptz not null default now()
);

create index if not exists reports_status_idx on public.reports(status, created_at desc);
create index if not exists reports_reported_user_idx on public.reports(reported_user_id);

alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;
grant insert on public.reports to authenticated;

drop policy if exists "reports_insert_own" on public.reports;
create policy "reports_insert_own" on public.reports
  for insert to authenticated
  with check (reporter_id = (select auth.uid()) and status = 'open');

-- Appen rapporterar genom den här, inte genom en insert: vem som skrev
-- innehållet slås upp här och inte i klienten, så ingen kan rapportera ett
-- meddelande i någon annans namn.
create or replace function public.report_content(
  p_content_type     text,
  p_content_id       uuid,
  p_reported_user_id uuid,
  p_reason           text,
  p_details          text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me       uuid := auth.uid();
  v_reported uuid := p_reported_user_id;
  v_snapshot jsonb;
  v_id       uuid;
begin
  if v_me is null then
    raise exception 'Not signed in.';
  end if;

  -- Ett tak mot att rapportknappen används som spam mot granskningen.
  if (select count(*) from reports where reporter_id = v_me and created_at > now() - interval '1 day') >= 30 then
    raise exception 'You have sent a lot of reports today. Try again tomorrow.';
  end if;

  if p_content_type = 'message' then
    select m.user_id, jsonb_build_object('body', m.body, 'circle_id', m.circle_id, 'sent_at', m.created_at)
      into v_reported, v_snapshot
      from circle_messages m
     where m.id = p_content_id
       and m.circle_id in (select circle_id from circle_members where user_id = v_me);
  elsif p_content_type in ('support', 'photo') then
    select r.sender_id,
           jsonb_build_object('response_type', r.response_type, 'text', r.text_content,
                              'content_url', r.content_url, 'sent_at', r.created_at)
      into v_reported, v_snapshot
      from support_responses r
      join support_stories s on s.id = r.story_id
     where r.id = p_content_id and s.user_id = v_me;
    if v_reported is null then
      -- En väns stödförfrågan, inte ett svar.
      select s.user_id, jsonb_build_object('story', s.activity, 'note', s.personal_note, 'sent_at', s.created_at)
        into v_reported, v_snapshot
        from support_stories s
       where s.id = p_content_id;
    end if;
  elsif p_content_type = 'profile' then
    select jsonb_build_object('username', p.username, 'avatar_url', p.avatar_url)
      into v_snapshot
      from profiles p where p.id = v_reported;
  else
    raise exception 'Unknown content type.';
  end if;

  if v_reported is null then
    raise exception 'That content is no longer available.';
  end if;
  if v_reported = v_me then
    raise exception 'You can''t report yourself.';
  end if;

  v_snapshot := coalesce(v_snapshot, '{}'::jsonb)
    || jsonb_build_object('reported_username', (select username from profiles where id = v_reported));

  insert into reports (reporter_id, reported_user_id, content_type, content_id, reason, details, content_snapshot)
  values (v_me, v_reported, p_content_type, p_content_id, p_reason,
          nullif(left(trim(coalesce(p_details, '')), 1000), ''), v_snapshot)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.report_content(text, uuid, uuid, text, text) from public, anon;
grant execute on function public.report_content(text, uuid, uuid, text, text) to authenticated;

-- ── Avisering till granskaren ──────────────────────────────────────────────
--
-- Samma rör som de andra notiserna (`notify_config`, `x-pause-secret`), men
-- till en egen edge-funktion, `notify-report`, som skickar både push och
-- mejl. Mottagarna är kontona i `report_admin_ids` (kommaseparerade uuid:n)
-- och adressen i funktionens miljö. Inget nattfönster: en rapport väntar inte
-- till klockan åtta.
--
--   insert into notify_config (key, value) values
--     ('report_notify_url', 'https://<projekt>.supabase.co/functions/v1/notify-report'),
--     ('report_admin_ids',  '<uuid>,<uuid>')
--   on conflict (key) do update set value = excluded.value;
create or replace function public.notify_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url      text;
  v_secret   text;
  v_admins   text;
  v_tokens   jsonb;
begin
  select value into v_url    from notify_config where key = 'report_notify_url';
  select value into v_secret from notify_config where key = 'goal_notify_secret';
  select value into v_admins from notify_config where key = 'report_admin_ids';
  if v_url is null or v_secret is null then
    return new;
  end if;

  select jsonb_agg(p.push_token) into v_tokens
    from profiles p
   where p.push_token is not null
     and p.id::text = any (string_to_array(replace(coalesce(v_admins, ''), ' ', ''), ','));

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pause-secret', v_secret),
    body    := jsonb_build_object(
      'tokens', coalesce(v_tokens, '[]'::jsonb),
      'report', jsonb_build_object(
        'id', new.id,
        'content_type', new.content_type,
        'content_id', new.content_id,
        'reason', new.reason,
        'details', new.details,
        'snapshot', new.content_snapshot,
        'reporter', (select username from profiles where id = new.reporter_id),
        'reported', (select username from profiles where id = new.reported_user_id),
        'reported_user_id', new.reported_user_id,
        'created_at', new.created_at
      )
    )
  );
  return new;
exception when others then
  raise warning 'notify_report: %', sqlerrm;
  return new;
end;
$$;

revoke all on function public.notify_report() from public, anon, authenticated;

drop trigger if exists reports_notify on public.reports;
create trigger reports_notify
  after insert on public.reports
  for each row execute function public.notify_report();


-- ══ 3. Användarvillkoren ═════════════════════════════════════════════════════
--
-- Tidpunkten sätts av servern, inte av klienten. Den skrivs en gång och
-- flyttas aldrig fram.

alter table public.profiles add column if not exists terms_accepted_at timestamptz;

-- Läggs också till i listan i security_hardening.sql.
grant select (terms_accepted_at) on public.profiles to authenticated;

create or replace function public.accept_terms()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  update profiles
     set terms_accepted_at = coalesce(terms_accepted_at, now())
   where id = auth.uid()
  returning terms_accepted_at;
$$;

revoke all on function public.accept_terms() from public, anon;
grant execute on function public.accept_terms() to authenticated;
