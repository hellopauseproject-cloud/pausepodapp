-- Ett hjärta tillbaka för ett stödsvar.
-- Körs för hand i Supabase SQL-editorn, efter support_photo.sql (samma
-- konvention som resten av mappen). Allt är idempotent.
--
-- ─── Vad det är ───────────────────────────────────────────────────────────
-- Den som fått stöd kan skicka ett hjärta tillbaka när svaret öppnats. Den
-- som stöttade ser det en gång, som ett kort överst i Support-fliken
-- (*Anna sent you a heart*), och sedan på sin bock i förfrågans cirkel så
-- länge förfrågan står kvar. Det är det man vill veta efter att ha skickat
-- stöd, och förr fick man aldrig veta något.
--
-- **Två kolumner på svarsraden, inte en egen tabell.** Det finns exakt ett
-- hjärta per svar, och svaret är redan raden som binder ihop de två
-- personerna. `pause_cheers` fick en egen tabell för att `pause_messages`
-- var fel plats; här är `support_responses` precis rätt plats.
--
-- **Skrivningen går genom RPC:er**, inte genom en update från klienten.
-- Tabellen skapades utanför repot och dess update-policy står ingenstans här,
-- och de två kolumnerna ska skrivas av var sin person: `thanked_at` bara av
-- förfrågans ägare, `thanks_seen_at` bara av svarets avsändare.
--
-- **Ingen notis.** Antalet hjärtan beror på hur aktiva andra är — se
-- notisavsnittet i CLAUDE.md. Hjärtat väntar i fliken tills man tittar.

alter table public.support_responses
  add column if not exists thanked_at timestamptz,
  add column if not exists thanks_seen_at timestamptz;

-- Hjärtar eller tar tillbaka hjärtat på ett svar man fått. Bara förfrågans
-- ägare. Att ta tillbaka det går så länge avsändaren inte sett det: ett
-- hjärta som redan landat ska inte försvinna under någons tumme.
create or replace function public.thank_support_response(p_response_id uuid, p_on boolean default true)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  update support_responses r
     set thanked_at = case when p_on then coalesce(r.thanked_at, now()) else null end
    from support_stories s
   where s.id = r.story_id
     and r.id = p_response_id
     and s.user_id = auth.uid()
     and (p_on or r.thanks_seen_at is null);
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- Hjärtan på mina svar som jag inte sett än, med vem som skickade dem och
-- vad förfrågan gällde.
create or replace function public.get_unseen_support_thanks()
returns table (
  response_id uuid,
  thanked_at timestamptz,
  user_id uuid,
  username text,
  avatar_url text,
  activity text
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.thanked_at, p.id, p.username, p.avatar_url, s.activity
    from support_responses r
    join support_stories s on s.id = r.story_id
    join profiles p on p.id = s.user_id
   where r.sender_id = auth.uid()
     and r.thanked_at is not null
     and r.thanks_seen_at is null
   order by r.thanked_at desc
   limit 20;
$$;

-- Markerar hjärtan som sedda. Bara på egna svar.
create or replace function public.mark_support_thanks_seen(p_response_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update support_responses
     set thanks_seen_at = now()
   where sender_id = auth.uid()
     and id = any(p_response_ids)
     and thanked_at is not null
     and thanks_seen_at is null;
$$;

revoke all on function public.thank_support_response(uuid, boolean) from public, anon;
revoke all on function public.get_unseen_support_thanks() from public, anon;
revoke all on function public.mark_support_thanks_seen(uuid[]) from public, anon;
grant execute on function public.thank_support_response(uuid, boolean) to authenticated;
grant execute on function public.get_unseen_support_thanks() to authenticated;
grant execute on function public.mark_support_thanks_seen(uuid[]) to authenticated;
