import { supabase } from './supabase';

/**
 * En stödförfrågan står i 24 timmar, oavsett väg in: från *Ask for support*
 * (support-story-create.tsx) eller från en punkt på att göra-listan
 * (`activate_story` i supabase/wishlist.sql, som sätter samma tal i SQL).
 * Ändras det ena måste det andra följa med.
 */
export const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const storyExpiresAt = () => new Date(Date.now() + STORY_LIFETIME_MS).toISOString();

/**
 * "Ute just nu" = `is_active` och inte utgången. Ingen städning: raden
 * filtreras vid läsning, precis som kretsarnas veckoskifte. Rader från innan
 * alla förfrågningar fick en gräns (`expires_at is null`) räknas från
 * `created_at` med samma 24 timmar — de släpptes förr igenom villkorslöst och
 * stod då kvar i raden för alltid.
 * Används som `.eq('is_active', true).or(liveStoryFilter())`.
 */
export const liveStoryFilter = () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const bornAfter = new Date(now - STORY_LIFETIME_MS).toISOString();
  return `expires_at.gt.${nowIso},and(expires_at.is.null,created_at.gt.${bornAfter})`;
};

/**
 * Hur länge förfrågan står kvar, för kortet i story-läsaren: `22h left`,
 * `40 min left`. Samma regel som `liveStoryFilter` — saknas `expires_at`
 * räknas 24 timmar från `created_at`. Hela timmar avrundas nedåt, så att
 * kortet aldrig lovar mer tid än som finns.
 */
export function storyTimeLeft(
  story: { expires_at?: string | null; created_at: string },
  now = Date.now(),
): string {
  const end = story.expires_at
    ? new Date(story.expires_at).getTime()
    : new Date(story.created_at).getTime() + STORY_LIFETIME_MS;
  const min = Math.floor((end - now) / 60000);
  if (min >= 60) return `${Math.floor(min / 60)}h left`;
  if (min >= 1) return `${min} min left`;
  return 'Ending now';
}

/**
 * Oöppnade svar på **alla** ens förfrågningar — också utgångna och
 * borttagna. Svaren överlever förfrågan: den som svarar i timme 23 ska nå
 * fram, och en förfrågan som släcks får inte ta med sig det som redan
 * skickats. RLS släpper igenom svar på egna stories oavsett `is_active`.
 *
 * Kedja på `.in('response_type', …)`, `.order(…)` och så vidare som vanligt.
 */
export function unopenedResponsesQuery<Columns extends string>(
  userId: string,
  columns: Columns,
  options?: { count?: 'exact'; head?: boolean },
) {
  // Generisk så att postgrest-js kan tolka kolumnlistan som en literal och
  // typa raderna — som `string` ger den bara ett ParserError-typat svar.
  return supabase
    .from('support_responses')
    .select(`${columns}, support_stories!inner(user_id)` as `${Columns}, support_stories!inner(user_id)`, options)
    .eq('support_stories.user_id', userId)
    .is('delivered_at', null);
}

/**
 * Hur länge ett öppnat stödsvar går att se igen (app/support-history.tsx).
 * Räknas från när det **öppnades** (`delivered_at`), inte när det skickades —
 * ett förseglat svar kan ha väntat i dagar. Samma 24 timmar som förfrågan.
 */
export const SUPPORT_HISTORY_MS = STORY_LIFETIME_MS;

/**
 * Öppnade svar på egna förfrågningar, de senaste 24 timmarna. Inget raderas:
 * raden filtreras bort vid läsning, samma linje som `liveStoryFilter` (det
 * finns ingen cron i projektet). Att `delivered_at` inte flyttas när ett svar
 * ses igen sköts av triggern i supabase/support_history.sql.
 */
export function recentSupportQuery<Columns extends string>(
  userId: string,
  columns: Columns,
  options?: { count?: 'exact'; head?: boolean },
) {
  const since = new Date(Date.now() - SUPPORT_HISTORY_MS).toISOString();
  return supabase
    .from('support_responses')
    .select(`${columns}, support_stories!inner(user_id)` as `${Columns}, support_stories!inner(user_id)`, options)
    .eq('support_stories.user_id', userId)
    .gte('delivered_at', since);
}
