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
