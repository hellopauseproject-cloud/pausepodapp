import { router } from 'expo-router';

import { track } from './analytics';
import { isNightHours } from './homeMode';
import { startSleep } from './sleep';

/**
 * Vägen in i en paus — med eller utan valskärmen ([app/pause.tsx](../app/pause.tsx)).
 *
 * **`SHOW_PAUSE_SETUP_VIEW`** avgör om PAUSE på Hem (och *I'll take a pause*
 * efter ett stödsvar) öppnar valskärmen som förut, eller startar en lådlös
 * paus direkt. Valskärmen frågade två saker: läge och intention. Läget har
 * bara ett svar så länge `POD_COMING_SOON` står på, och intentionen ställs
 * numera efteråt, i sammanfattningen och i statistiken (lib/pauseTags.ts).
 * Med `false` försvinner alltså ingenting man kan välja — bara steget.
 *
 * `true` är förvalet tills testerna är klara: ingen tester ska se flödet byta
 * form mitt i ett test. Valskärmen står kvar i koden, så att slå tillbaka är
 * en rad. Lådan berörs inte: dess väg går genom valskärmen och `set_mode`,
 * och den är avstängd.
 */
export const SHOW_PAUSE_SETUP_VIEW = false;

/**
 * Hur länge en startknapp hålls in — CHECK IN i valskärmen och PAUSE på Hem
 * (när valskärmen är avslagen). Ett tal för båda, så att de känns likadana.
 */
export const HOLD_TO_START_MS = 700;

/**
 * Startar en lådlös paus utan intention.
 *
 * **Måste vara identisk med den lådlösa grenen av `handleCheckIn` i
 * app/pause.tsx** — samma rutt, samma parametrar, samma händelse. Den grenen
 * rörs inte (den filen ändras bara i gest och utseende), så de två finns som
 * två kopior; ändras den ena ska den andra följas åt. Händelsen bär dessutom
 * `skipped_setup: true`, så att tratten kan skilja de två vägarna åt.
 *
 * `category` är intentionen när den redan är vald — det rummet för den globala
 * pausen, där man väljer den vid *I'll join*.
 */
export function startPhonePause(how: 'push' | 'replace' = 'push', category = '') {
  // Efter midnatt finns ingen dagpaus att starta — se `isNightHours`.
  if (isNightHours()) { startSleep(how, 'night_hours'); return; }
  track('pause_mode_selected', {
    with_pod: false,
    category: category || null,
    shared: false,
    skipped_setup: true,
  });
  const params = {
    mode: 'session',
    category,
    withPod: 'false',
    pauseType: 'session',
    targetSeconds: '0',
  };
  if (how === 'replace') router.replace({ pathname: '/pausing', params });
  else router.push({ pathname: '/pausing', params });
}

/**
 * Det som förr var `router.push('/pause')`: valskärmen när den är påslagen,
 * annars en direkt start. För de ställen som redan ÄR ett avsiktligt val —
 * *I'll take a pause* efter ett stödsvar — och därför inte behöver hållas in.
 */
export function openPauseStart(how: 'push' | 'replace' = 'push') {
  if (SHOW_PAUSE_SETUP_VIEW && !isNightHours()) {
    if (how === 'replace') router.replace('/pause');
    else router.push('/pause');
    return;
  }
  startPhonePause(how);
}
