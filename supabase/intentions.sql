-- Intentionerna per konto: vilka som erbjuds före och efter en paus, och de
-- egna. Körs för hand i SQL-editorn, samma konvention som resten av mappen.
--
-- De låg förr bara i två filer på telefonen (selectedCategories.json,
-- customCategories.json), utan något användar-id. Följden var att de följde
-- med till nästa konto på samma telefon, och att de försvann vid utloggning
-- när den buggen rättades. Filerna står kvar som cache i klienten
-- (app/pauseLogger.ts); det här är källan.
--
-- **Egen tabell och inte kolumner på profiles**, med flit: RLS är av på
-- profiles, så varje inloggad kan läsa varje rad. En egen intention får aldrig
-- lämnas ut med namn (se circle_intention_key i circle_intentions.sql) — här
-- kan bara ägaren läsa sin rad.
--
-- `selected` null = aldrig valt (klienten ger då alla standardintentioner);
-- ett sparat [] = medvetet tömt. Samma skillnad som filen gjorde.

create table if not exists public.user_intentions (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  selected   jsonb,
  custom     jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_intentions enable row level security;

revoke all on public.user_intentions from anon, authenticated;
grant select, insert, update on public.user_intentions to authenticated;

drop policy if exists user_intentions_own_select on public.user_intentions;
create policy user_intentions_own_select on public.user_intentions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists user_intentions_own_insert on public.user_intentions;
create policy user_intentions_own_insert on public.user_intentions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists user_intentions_own_update on public.user_intentions;
create policy user_intentions_own_update on public.user_intentions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
