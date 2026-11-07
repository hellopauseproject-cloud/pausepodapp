-- En paus taggad som natt i efterhand.
-- Körs för hand i Supabase SQL-editorn, efter sleep.sql och circles.sql
-- (samma konvention som resten av mappen). Allt är idempotent.
--
-- ─── Varför ───────────────────────────────────────────────────────────────
-- Lådan vet inte om det är natt. En NFC-paus sparas av lådan själv, och en
-- lådpaus från appen går genom kön — båda som `kind = 'pause'`. I stället
-- för att lära lådan skillnaden taggar användaren pausen efteråt: *Sleep*
-- står sist bland intentionerna, på taggkortet på Hem och under pausens kort
-- i statistiken. **Bara för lådpauser** (`with_pod`): en telefonpaus blir en
-- natt genom att startas med SLEEP i nattläget.
--
-- ─── Natten är privat, också i efterhand ──────────────────────────────────
-- När pausen sparades räknades den in i kretsen. En natt får aldrig nå
-- ledgern (sleep.sql), så taggningen tar bort pausens ledgerrader och den
-- flödesrad varje krets fick, och utvärderar veckan på nytt. Det skriver om
-- kretsens historik, vilket en raderad paus inte gör — men en raderad paus
-- *har* skett, och en natt har aldrig varit en paus.
--
-- Det som redan hänt står kvar: en dagsmålsnotis som gått ut, en vecka som
-- låsts eller en nivå som nåtts (alla tre är engångshändelser), och tiden i
-- en Global Pause. Nätter hamnar sällan i någon av dem.
--
-- `pause_messages`, `pause_cheers` och delade pauser: en delad paus kan inte
-- bli en natt, för en natt är aldrig delad.
--
-- ─── Tillbaka ─────────────────────────────────────────────────────────────
-- På en taggad natt går SLEEP att trycka på igen, och en annan intention gör
-- den till en paus med den etiketten (`untag_sleep`). `tagged_as_sleep`
-- skiljer en taggad natt från en natt som startades med SLEEP. Bara den förra
-- går att göra till en paus igen — annars kunde en natts åtta timmar flyttas
-- in i potten, precis det sleep.sql finns för att hindra. Klienten anropar
-- `record_circle_pause` efteråt, som för vilken nysparad paus som helst.
--
-- **Kör den här före appen:** statistiken väljer `tagged_as_sleep`.

alter table public.pause_sessions
  add column if not exists tagged_as_sleep boolean not null default false;

create or replace function tag_pause_as_sleep(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  update pause_sessions
     set kind = 'sleep', intention = null,
         wake_count = 0, awake_seconds = 0,
         tagged_as_sleep = true
   where id = p_session_id
     and user_id = auth.uid()
     and kind = 'pause'
     and with_pod
     and shared_session_id is null
     and ended_at is not null;
  if not found then
    return false;
  end if;

  for v_row in
    delete from circle_pause_ledger
     where session_id = p_session_id and user_id = auth.uid()
    returning circle_id, seconds, created_at
  loop
    -- Flödesraden bär inget sessions-id. Den skrevs i samma anrop som
    -- ledgerraden, med samma räknade längd, så den närmaste sådana raden är
    -- pausens.
    delete from circle_activity
     where id = (
       select a.id from circle_activity a
        where a.circle_id = v_row.circle_id
          and a.actor_id = auth.uid()
          and a.type = 'pause_completed'
          and (a.metadata->>'duration_seconds')::int = v_row.seconds
          and a.created_at between v_row.created_at - interval '5 minutes'
                               and v_row.created_at + interval '5 minutes'
        order by abs(extract(epoch from a.created_at - v_row.created_at))
        limit 1
     );
    perform evaluate_circle_goals(v_row.circle_id);
  end loop;

  return true;
end;
$$;

-- Första versionen tog bara id:t. En ny parameter skapar en överlagring i
-- stället för att ersätta, så den gamla droppas.
drop function if exists untag_sleep(uuid);

create or replace function untag_sleep(p_session_id uuid, p_intention text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update pause_sessions
     set kind = 'pause', intention = nullif(trim(p_intention), ''),
         wake_count = null, awake_seconds = null,
         tagged_as_sleep = false
   where id = p_session_id
     and user_id = auth.uid()
     and kind = 'sleep'
     and tagged_as_sleep;
  return found;
end;
$$;

revoke execute on function tag_pause_as_sleep(uuid) from public, anon;
revoke execute on function untag_sleep(uuid, text) from public, anon;
grant execute on function tag_pause_as_sleep(uuid) to authenticated;
grant execute on function untag_sleep(uuid, text) to authenticated;
