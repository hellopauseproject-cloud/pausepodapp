import { supabase } from './supabase';

/**
 * `profiles.is_pausing` — en skrivning i taget, i anropsordning.
 *
 * Flaggan är allt vännerna har. En ensam paus skriver ingen rad i
 * `pause_sessions` förrän den är slut, så "pausing now" under en väns namn i
 * Community hänger på just det här booleanet.
 *
 * Den bar förr en andra sak: triggern bakom vän-notisen, som fyrade på
 * övergången false → true. Notiserna är borta (se supabase/notifications-
 * teardown.sql), och därmed är den här flaggan bara en synlig status igen.
 * Det är också varför nollningen vid appstart i `app/_layout.tsx` inte längre
 * har något med en notis att göra — den finns för att en tvångsstängd app
 * annars lämnar en vän stående som pausande i all evighet.
 *
 * **Varför en modulglobal kö och inte tre spridda `.update()`.** Tre ställen
 * skriver flaggan — pausskärmen sätter `true` när den monteras och `false` när
 * den lämnas, och [app/_layout.tsx](../app/_layout.tsx) nollar den vid
 * appstart. Två HTTP-anrop som skickas utan att invänta varandra har ingen
 * inbördes ordning, så ett `false` kunde landa EFTER det `true` som skulle
 * ersätta det, och då stod man som pausande utan att pausa (eller tvärtom).
 * Ordningen går inte att få till lokalt i varje anropare: appstartens nollning
 * och pausskärmens `true` bor i olika komponenter och känner inte till
 * varandra. Kön måste därför vara gemensam, och den är per appstart — det
 * finns bara en användare inloggad i taget.
 *
 * Den avvisar aldrig. Anroparna är alla fire-and-forget (en av dem är en
 * effekt-cleanup, som inte kan invänta något), och ett avslag därifrån hade
 * blivit en obehandlad rejection utan att någon blev hjälpt. Felet loggas i
 * stället — **att inte läsa felet var den andra halvan av buggen**: en
 * skrivning som föll på RLS eller nät gjorde en paus osynlig utan ett spår att
 * följa.
 */
/**
 * **Flaggan har ett utgångsdatum** (supabase/pausing_flag.sql): medan klockan
 * går till nästa lokala midnatt, medan den står fryst i tio minuter. Dör
 * appen — batteriet, en tvångsstängning — släcks flaggan av sig själv i
 * stället för att stå kvar tills appen öppnas igen. Tiden sätts av servern;
 * appen säger bara vilket läge pausen är i.
 */
export type PausingState = 'running' | 'frozen' | 'off';

/** "Pausing now" för en profilrad — läsarnas enda fråga om flaggan. */
export function isPausingNow(row: { is_pausing?: boolean | null; pausing_until?: string | null }): boolean {
  return !!row.is_pausing && !!row.pausing_until && Date.parse(row.pausing_until) > Date.now();
}

let chain: Promise<void> = Promise.resolve();

/**
 * Det senast **bekräftade** läget i databasen, eller `null` när vi inte vet.
 * En skrivning av samma läge hoppas över — både nollningen vid varje
 * återkomst och pausskärmens läge, som skrivs vid varje fasbyte.
 */
let confirmed: PausingState | null = null;

/**
 * Tre försök med en kort väntan emellan. Taket är inte en detalj: omförsöken
 * står i samma kö som allt annat, och ett `false` som aldrig gav upp hade
 * hållit nästa paus `true` borta för alltid.
 */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * `userId` behövs inte av RPC:n (den läser `auth.uid()`), men står kvar i
 * signaturen: anroparna har det, och utan en inloggad användare finns inget
 * att skriva.
 */
export function setPausingState(userId: string, state: PausingState): Promise<void> {
  const next = chain.then(async () => {
    if (!userId || confirmed === state) return;
    confirmed = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        // RPC:n svarar `false` när ingen rad uppdaterades: ett anrop som går
        // ut innan token förnyats ger noll rader UTAN fel. Så kunde en
        // nollning vid appstart "lyckas" och lämna en vän som pausande i ett
        // dygn.
        const { data, error } = await supabase.rpc('set_pausing_state', {
          p_state: state,
          p_tz_offset_minutes: new Date().getTimezoneOffset(),
        });
        if (!error && data === true) {
          confirmed = state;
          return;
        }
        console.log('[pausingFlag] set', state, 'attempt', attempt, 'failed:', error?.message ?? 'no rows updated');
      } catch (e: any) {
        console.log('[pausingFlag] set', state, 'attempt', attempt, 'threw:', e?.message ?? e);
      }
      if (attempt < ATTEMPTS) await wait(RETRY_DELAY_MS);
    }
  });
  chain = next;
  return next;
}

/** Paus börjar (`true`, klockan går) eller slutar (`false`). */
export function setPausingFlag(userId: string, value: boolean): Promise<void> {
  return setPausingState(userId, value ? 'running' : 'off');
}

/**
 * Nollningen när appen kommer fram, se `app/_layout.tsx`. Anroparen avgör att
 * ingen paus pågår; skrivs samma läge redan hoppas den över i kön.
 */
export function clearStalePausingFlag(userId: string): Promise<void> {
  return setPausingState(userId, 'off');
}
