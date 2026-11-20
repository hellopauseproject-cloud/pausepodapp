import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';
import { supabase } from './supabase';

/**
 * Händelselogg för funktionsanvändning. Tabellen och analysvyerna bor i
 * supabase/app_events.sql.
 *
 * Tre regler som hela filen vilar på:
 *
 * 1. **`track()` får aldrig kasta och aldrig vänta.** Den anropas från
 *    renderingar, från knapptryck och från BLE-callbacks. Ett nät som är
 *    nere, en full disk eller en avvisad insert ska vara osynligt för den
 *    som anropar — därför är returtypen `void` och allt ligger i try/catch.
 * 2. **Kön är beständig.** Händelser skrivs till AsyncStorage och skickas i
 *    batch, så ett flygplansläge eller en tvångsstängning inte tappar dem.
 *    Insatsen är ändå låg: tappas en skärmvisning är det en lucka i en
 *    kurva, inte en förlorad paus.
 * 3. **`occurred_at` sätts vid händelsen, inte vid inserten.** En rad kan
 *    landa timmar senare. Samma skillnad som lådans `ageMs` bär.
 *
 * Det här är ingen notis-kanal och ska inte bli en. Appen skickar inga
 * notiser (se CLAUDE.md) — den här filen skickar rader till en tabell som
 * bara SQL-editorn läser.
 */

type PropValue = string | number | boolean | null | undefined;
export type EventProps = Record<string, PropValue>;

type QueuedEvent = {
  /** null så länge sessionen inte hunnit avgöras — fylls i av
   *  setAnalyticsUser innan raden skickas. Se kommentaren där. */
  user_id: string | null;
  name: string;
  props: Record<string, Exclude<PropValue, undefined>>;
  occurred_at: string;
  platform: string;
  app_version: string | null;
  app_session_id: string;
};

const QUEUE_KEY = 'analytics_queue_v1';
/** Taket finns för att en användare som aldrig loggar in annars samlar
 *  händelser i evighet — ingen av dem går att skicka utan ett user_id. De
 *  äldsta faller ut först. */
const MAX_QUEUE = 500;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 20_000;
/** Skicka direkt när kön vuxit så här mycket, utan att vänta ut intervallet.
 *  Håller bursten vid en appstart från att ligga en halv minut i kö. */
const FLUSH_AT_COUNT = 25;

const APP_VERSION = Constants.expoConfig?.version ?? null;

/** En per appstart. Inte sparad mellan starter — det är just "den här
 *  gången appen var öppen" som vyerna räknar försök i. */
const APP_SESSION_ID = uuidv4();

let queue: QueuedEvent[] = [];
let currentUserId: string | null = null;
let flushing = false;
let timer: ReturnType<typeof setInterval> | null = null;
let hydrated = false;
/** Skrivningen till disk slås ihop: tio skärmvisningar i rad ska inte bli
 *  tio JSON-serialiseringar av hela kön. */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** uuid v4 utan beroende. Kolumnen är av typen uuid, så formatet måste
 *  stämma; slumpen behöver inte vara kryptografisk — det här är ett
 *  grupperings-id, inte en hemlighet. */
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function cleanProps(props?: EventProps): Record<string, Exclude<PropValue, undefined>> {
  if (!props) return {};
  const out: Record<string, Exclude<PropValue, undefined>> = {};
  for (const [k, v] of Object.entries(props)) {
    // undefined försvinner i JSON ändå; bättre att nyckeln uteblir helt än
    // att den dyker upp som null i vyerna och ser ut som ett mätvärde.
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function persistSoon(): Promise<void> {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, 1_000);
}

async function persistNow(): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {}
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved)) {
      // Sparade rader först: de är äldre än allt som hunnit spåras i den
      // här starten.
      queue = [...saved, ...queue].slice(-MAX_QUEUE);
    }
  } catch {}
}

/**
 * Starta kön. Anropas en gång från app/_layout.tsx.
 *
 * Idempotent: ett andra anrop (fast refresh i utvecklingsläge) lägger inte
 * till ett andra intervall eller en andra AppState-lyssnare.
 */
export function initAnalytics(): void {
  if (timer) return;
  void hydrate().then(() => void flush());
  timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  AppState.addEventListener('change', next => {
    // Vägen ut ur förgrunden är sista chansen att köra kod innan appen kan
    // bli dödad. Skriv till disk FÖRE försöket att skicka: nätanropet kan
    // hinna avbrytas, disken hinner inte.
    if (next !== 'active') {
      void persistNow();
      void flush();
    }
  });
}

/**
 * Berätta vem som är inloggad. Anropas från AuthContext när sessionen
 * avgjorts, och med `null` vid utloggning.
 *
 * Back-fillen är avsiktlig: händelserna med `user_id: null` i kön hände
 * under den här appstarten, innan sessionen hunnit läsas ur AsyncStorage —
 * de tillhör den användare som sessionen visade sig vara. Vid utloggning
 * töms kön först, så ingen rad kan flyttas över till nästa inloggade konto.
 */
export function setAnalyticsUser(userId: string | null): void {
  if (userId === currentUserId) return;

  if (userId === null) {
    void flush();
    currentUserId = null;
    return;
  }

  currentUserId = userId;
  let changed = false;
  for (const e of queue) {
    if (e.user_id === null) {
      e.user_id = userId;
      changed = true;
    }
  }
  if (changed) void persistSoon();
  void flush();
}

/**
 * Släng det som ligger kvar i kön för ett konto som raderats. Raderna kan
 * aldrig skickas (RLS kräver `user_id = auth.uid()`), och eftersom en avvisad
 * insert lämnar hela batchen kvar hade de stoppat kön för nästa konto som
 * loggar in på telefonen.
 */
export function forgetAnalyticsUser(userId: string): void {
  try {
    queue = queue.filter(e => e.user_id !== userId);
    void persistNow();
  } catch {}
}

/**
 * Logga en händelse. Fire-and-forget — anropa utan `await`.
 *
 * Namnge i `snake_case` och i tempus "det här hände" (`pause_started`, inte
 * `startPause`): namnet blir en kolumnrubrik i analytics-vyerna, och
 * vyernas `like 'box_%'` bygger på att prefixet är funktionens.
 */
export function track(name: string, props?: EventProps): void {
  try {
    queue.push({
      user_id: currentUserId,
      name,
      props: cleanProps(props),
      occurred_at: new Date().toISOString(),
      platform: Platform.OS,
      app_version: APP_VERSION,
      app_session_id: APP_SESSION_ID,
    });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    void persistSoon();
    if (queue.length >= FLUSH_AT_COUNT) void flush();
  } catch {}
}

/**
 * Skicka det som går att skicka. Rader utan `user_id` stannar i kön: RLS
 * kräver `user_id = auth.uid()`, så de skulle avvisas, och de får hellre
 * vänta på att sessionen avgörs än kastas bort.
 */
export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    await hydrate();
    if (!currentUserId) return;

    while (true) {
      const sendable = queue.filter(e => e.user_id !== null).slice(0, BATCH_SIZE);
      if (sendable.length === 0) break;

      const { error } = await supabase.from('app_events').insert(sendable);
      if (error) {
        // Inget nät, eller tabellen inte uppsatt än. Kön ligger kvar och
        // nästa intervall försöker om.
        console.log('analytics: insert misslyckades, försöker igen senare:', error.message);
        break;
      }

      const sent = new Set(sendable);
      queue = queue.filter(e => !sent.has(e));
      await persistNow();
      if (sendable.length < BATCH_SIZE) break;
    }
  } catch {} finally {
    flushing = false;
  }
}
