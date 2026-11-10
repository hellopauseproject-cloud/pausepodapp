-- Stödhistoriken: öppnade svar går att se igen i 24 timmar
-- (app/support-history.tsx, `recentSupportQuery` i lib/supportStories.ts).
-- Körs för hand i SQL-editorn, efter support_sealed.sql.
--
-- Fönstret räknas från `delivered_at`, och varje visningsskärm skriver
-- `delivered_at` när svaret visas — också när det ses igen ur historiken.
-- Utan den här triggern hade varje omtitt flyttat fram fönstret, och ett svar
-- man tittade på en gång om dagen hade aldrig försvunnit.
--
-- Triggern låser alltså tiden för första öppningen. `played_at` rörs inte:
-- den får gärna säga när det senast spelades.

create or replace function public.keep_first_delivered_at()
returns trigger
language plpgsql
as $$
begin
  if old.delivered_at is not null then
    new.delivered_at := old.delivered_at;
  end if;
  return new;
end;
$$;

drop trigger if exists support_responses_keep_delivered on public.support_responses;
create trigger support_responses_keep_delivered
  before update of delivered_at on public.support_responses
  for each row execute function public.keep_first_delivered_at();

-- ── Skickat stöd ───────────────────────────────────────────────────────────
--
-- Fliken *Sent* i historiken: svar man själv skickat de senaste 24 timmarna
-- (räknat från när de skickades), med mottagaren och om hen öppnat eller
-- skickat ett hjärta tillbaka.
--
-- En RPC och inte en select, för att mottagaren ska gå att namnge också när
-- förfrågan är borttagen: stories_select släpper bara igenom vänners aktiva
-- förfrågningar. Den lämnar bara ut egna svar, och om mottagaren bara namn,
-- foto och förfrågans ämne — samma som läsaren visade när man svarade.

create or replace function public.get_my_sent_support(p_since timestamptz)
returns table (
  id uuid,
  response_type text,
  created_at timestamptz,
  delivered_at timestamptz,
  thanked_at timestamptz,
  sealed boolean,
  recipient_username text,
  recipient_avatar_url text,
  activity text
)
language sql
security definer
set search_path = public
stable
as $$
  select r.id, r.response_type, r.created_at, r.delivered_at, r.thanked_at,
         (coalesce(r.opens_after_pause, false) and r.unlocked_at is null and r.delivered_at is null),
         p.username, p.avatar_url, s.activity
    from support_responses r
    join support_stories s on s.id = r.story_id
    left join profiles p on p.id = s.user_id
   where r.sender_id = auth.uid()
     and r.created_at >= p_since
   order by r.created_at desc;
$$;

revoke all on function public.get_my_sent_support(timestamptz) from public;
grant execute on function public.get_my_sent_support(timestamptz) to authenticated;
