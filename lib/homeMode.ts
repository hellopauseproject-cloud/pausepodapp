import { useSyncExternalStore } from 'react';

/**
 * Hems läge: dagen eller natten (Day / Night-kapseln ovanför ringen).
 *
 * En liten delad butik och inte state i skärmen, för TRE läsare måste vara
 * överens: Hem själv, flikraden ([components/room-tab-bar.tsx](../components/room-tab-bar.tsx))
 * och botten bakom scenerna i app/(tabs)/_layout.tsx. Nattläget flyttar Hem
 * till `night`-rummet, och en flikrad i dagens ljusblå under en nattblå skärm
 * hade sett ut som två appar.
 *
 * **Förvalet följer klockan** (natt från `NIGHT_FROM_HOUR` till
 * `NIGHT_UNTIL_HOUR`), men ett eget val står sig i `MANUAL_HOLD_MS` — annars
 * hade Hem hoppat tillbaka varje gång fliken fick fokus. Per app-session, i
 * minnet: läget är en vy, inte en inställning.
 */
export type HomeMode = 'day' | 'night';

const NIGHT_FROM_HOUR = 20;
const NIGHT_UNTIL_HOUR = 5;
const MANUAL_HOLD_MS = 4 * 3600 * 1000;

const autoMode = (): HomeMode => {
  const h = new Date().getHours();
  return h >= NIGHT_FROM_HOUR || h < NIGHT_UNTIL_HOUR ? 'night' : 'day';
};

/**
 * **Mellan midnatt och `NIGHT_UNTIL_HOUR` (05) är det natt.** Hem står då i
 * nattläge som förval, men dagen går att välja och en paus går att starta
 * (november 2026, på begäran — förr låstes Hem och varje paus blev en natt).
 * En paus som legat i det här fönstret frågar i stället *Were you asleep?*
 * när den slutar (`nightOverlap`, app/pausing.tsx), och "pausing now" visas
 * inte under det (lib/pausingFlag.ts).
 *
 * Skälet till frågan är detsamma som till låset: en paus över natten fyllde
 * annars morgonens dagsring, och allt som någon gång rankar pauser hade mätt
 * sömn. Kretsens flöde visar dessutom tiderna för en sådan paus.
 */
export function isNightHours(at: Date = new Date()): boolean {
  return at.getHours() < NIGHT_UNTIL_HOUR;
}

/** Nästa lokala midnatt efter `fromMs`. */
export function nextMidnight(fromMs: number): number {
  const d = new Date(fromMs);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Så mycket av en paus som måste ha legat i natten för att frågan ska ställas. */
export const ASK_ASLEEP_MIN_MS = 30 * 60_000;

/**
 * Hur mycket av `[startMs, endMs]` som låg mellan 00 och 05 i telefonens
 * tid, och var det första sådana fönstret började — där natten börjar om
 * svaret är *Yes*. `null` när inget av det låg i natten.
 */
export function nightOverlap(startMs: number, endMs: number): { ms: number; firstStartMs: number } | null {
  const day = new Date(startMs);
  day.setHours(0, 0, 0, 0);
  let ms = 0;
  let firstStartMs: number | null = null;
  while (day.getTime() < endMs) {
    const from = day.getTime();
    const until = new Date(day);
    until.setHours(NIGHT_UNTIL_HOUR);
    const overlap = Math.min(endMs, until.getTime()) - Math.max(startMs, from);
    if (overlap > 0) {
      ms += overlap;
      if (firstStartMs === null) firstStartMs = from;
    }
    day.setDate(day.getDate() + 1);
  }
  return firstStartMs === null ? null : { ms, firstStartMs };
}

let mode: HomeMode = autoMode();
let chosenAt = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export function getHomeMode(): HomeMode {
  return mode;
}

/** Ett val i kapseln — står sig i några timmar. */
export function chooseHomeMode(next: HomeMode) {
  chosenAt = Date.now();
  if (next === mode) return;
  mode = next;
  emit();
}

/** Vid fokus på Hem: klockans läge, om inget eget val är färskt. */
export function refreshHomeMode() {
  // Efter midnatt är natten förval igen: ett eget val från i går kväll står
  // sig inte över midnatt, ett gjort efter den gör det.
  const lastMidnight = nextMidnight(Date.now()) - 24 * 3600 * 1000;
  const fresh = Date.now() - chosenAt < MANUAL_HOLD_MS && !(isNightHours() && chosenAt < lastMidnight);
  const next = fresh ? mode : autoMode();
  if (next === mode) return;
  mode = next;
  emit();
}

// ── Efter en natt ─────────────────────────────────────────────────────────
// Natten slutar på Hem (app/_layout.tsx), och då i DAGläge: det är morgon,
// och nattläget visar ändå ingenting om natten som gått (den står i
// statistiken). Som ett eget val, så att ett nattval från i går kväll inte
// står sig i fyra timmar till.
export function markNightEnded() {
  // Slutar natten före fem är det fortfarande natt — då står Hem kvar där.
  if (isNightHours()) return;
  chooseHomeMode('day');
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useHomeMode(): HomeMode {
  return useSyncExternalStore(subscribe, getHomeMode, getHomeMode);
}
