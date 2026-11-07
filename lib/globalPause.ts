import { track } from './analytics';
import { cancelGlobalPauseReminder, scheduleGlobalPauseReminder } from './notifications';
import { supabase } from './supabase';

/**
 * Den globala pausen — en gång om dagen pausar alla samtidigt.
 *
 * Schemat och reglerna bor i [supabase/global_pause.sql](../supabase/global_pause.sql);
 * den här filen är allt klienten gör med dem. Rummet är
 * [app/global-pause.tsx](../app/global-pause.tsx), raden på Hem
 * [components/global-pause-line.tsx](../components/global-pause-line.tsx).
 *
 * **Inget här får kunna stoppa en paus.** `reportGlobalPause` kastar aldrig och
 * väntas aldrig in: den anropas från pausskärmen, och utan anmälan är den en
 * no-op i SQL.
 */

export type GlobalPauseState = 'signed_up' | 'pausing' | 'on_hold' | 'done';
export type GlobalPauseRelation = 'me' | 'circle' | 'friend' | 'stranger';

/** En person i rummet. Bär aldrig ett user_id. */
export type GlobalPausePerson = {
  key: number;
  relation: GlobalPauseRelation;
  name: string | null;
  avatar_url: string | null;
  intention_id: string | null;
  state: GlobalPauseState;
  seconds: number;
  running: boolean;
};

export type GlobalPause = {
  starts_at: string;
  ends_at: string;
  opens_at: string;
  closes_at: string;
  server_now: string;
  /** `finished`: pausen är slut. Så länge dörren står öppen går det att gå in igen. */
  me: { intention_id: string | null; started: boolean; finished?: boolean } | null;
  counts: { signed_up: number; pausing: number; total_seconds: number };
  people: GlobalPausePerson[];
  /** Senaste globala pausen, en kvart efter slutet. `was_there`: man själv pausade i den. */
  last: { starts_at: string; people: number; total_seconds: number; was_there: boolean } | null;
};

/** Från det här blir raden på Hem tydlig. */
export const GLOBAL_PAUSE_NEAR_MS = 2 * 60 * 60_000;

/**
 * Demo för att se rummet medan en global paus pågår, utan att röra databasen:
 * påhittade personer, och anmälan lever bara i minnet. `__DEV__` gör att den
 * aldrig kan nå en riktig version. Sätt `false` när du sett det du ville.
 */
export const GLOBAL_PAUSE_DEMO = __DEV__ && false;

const DEMO_NAMES = ['hugo', 'ida_m', 'leo', 'alma', 'nils', 'tuva', 'adam', 'freja', 'sam', 'vera', 'kim', 'ebba', 'milo', 'stina'];

const DEMO_EXTRA = 24;

export type DemoPhase = 'before' | 'live' | 'done';

let demoPhase: DemoPhase = 'live';
let demoStart = Date.now() - 5 * 60_000;
let demoMe: { intention_id: string | null; started: boolean } | null = null;

/** Knapparna längst upp i rummet medan demot är på. */
export function setDemoPhase(phase: DemoPhase) {
  demoPhase = phase;
  demoStart = Date.now() + (phase === 'before' ? 80 : phase === 'done' ? 24 * 60 : -5) * 60_000;
}

function buildDemo(): GlobalPause {
  const iso = (ms: number) => new Date(ms).toISOString();
  const row = (
    key: number, relation: GlobalPauseRelation, name: string | null,
    intention_id: string | null, state: GlobalPauseState, minutes: number,
  ): GlobalPausePerson => ({
    key, relation, name, avatar_url: null, intention_id, state,
    seconds: minutes * 60 + (state === 'pausing' ? Math.floor((Date.now() - demoStart) / 1000) - 300 : 0),
    running: state === 'pausing',
  });
  const people = [
    row(2, 'circle', 'Anna', 'read', 'pausing', 5),
    row(3, 'circle', 'Steve', 'walk', 'on_hold', 3),
    row(4, 'friend', 'Lina', 'focus', 'pausing', 4),
    row(5, 'friend', 'Omar', 'clean', 'done', 4),
    row(6, 'stranger', 'maria_k', 'meditate', 'pausing', 5),
    row(7, 'stranger', 'jonas', 'workout', 'pausing', 2),
    row(8, 'stranger', 'noor', null, 'pausing', 3),
    row(9, 'stranger', 'elsa.b', 'nature', 'signed_up', 0),
    row(10, 'stranger', 'theo', 'create', 'on_hold', 2),
    row(11, 'stranger', 'sofia', 'rest', 'pausing', 1),
    ...['read', 'focus', 'clean', 'walk', 'create', 'music', 'rest', 'study', 'nature', 'meditate', 'social', 'read', 'focus', 'walk']
      .map((id, i) => row(12 + i, 'stranger', DEMO_NAMES[i], id, i % 5 === 4 ? 'on_hold' : 'pausing', 2 + (i % 4))),
  ];
  for (let i = 0; i < DEMO_EXTRA; i++) {
    people.push(row(30 + i, 'stranger', `pauser${i + 1}`, 'read', 'pausing', 1 + (i % 6)));
  }
  if (demoPhase === 'before') {
    people.forEach(p => { p.state = 'signed_up'; p.running = false; p.seconds = 0; });
  }
  if (demoMe) people.unshift(row(1, 'me', 'You', demoMe.intention_id, 'signed_up', 0));
  return {
    starts_at: iso(demoStart),
    ends_at: iso(demoStart + 60 * 60_000),
    opens_at: iso(demoStart - 10 * 60_000),
    closes_at: iso(demoStart + 30 * 60_000),
    server_now: iso(Date.now()),
    me: demoMe,
    counts: {
      signed_up: people.length,
      pausing: people.filter(p => p.running).length,
      total_seconds: people.reduce((sum, p) => sum + p.seconds, 0),
    },
    people,
    last: demoPhase === 'done' ? { starts_at: iso(demoStart), people: 24, total_seconds: 41 * 60 * 60, was_there: true } : null,
  };
}

export async function fetchGlobalPause(): Promise<GlobalPause | null> {
  if (GLOBAL_PAUSE_DEMO) return buildDemo();
  const { data, error } = await supabase.rpc('get_global_pause');
  if (error || !data) return null;
  return data as GlobalPause;
}

/** Att anmäla sig igen byter bara intention. Kastar med serverns mening. */
export async function joinGlobalPause(intentionId: string | null): Promise<void> {
  if (GLOBAL_PAUSE_DEMO) { demoMe = { intention_id: intentionId, started: false }; return; }
  const { data, error } = await supabase.rpc('join_global_pause', { p_intention_id: intentionId });
  if (error) throw new Error(error.message);
  track('global_pause_joined', { intention: intentionId });
  await scheduleGlobalPauseReminder(new Date((data as { starts_at: string }).starts_at));
}

export async function leaveGlobalPause(): Promise<void> {
  if (GLOBAL_PAUSE_DEMO) { demoMe = null; return; }
  const { error } = await supabase.rpc('leave_global_pause');
  if (error) throw new Error(error.message);
  track('global_pause_left');
  await cancelGlobalPauseReminder();
}

/** `running` när klockan går, `held` när den fryser, `finished` när pausen slutar. */
export function reportGlobalPause(event: 'running' | 'held' | 'finished'): void {
  supabase.rpc('report_global_pause', { p_event: event }).then(() => {}, () => {});
}

/**
 * Mina globala pauser, för statistiken: tidsfönstret jag pausade i varje.
 * Tom lista vid fel — då står bara inget jordklot på korten.
 */
export async function fetchMyGlobalPauseWindows(): Promise<{ from: number; to: number }[]> {
  const { data, error } = await supabase.rpc('get_my_global_pauses');
  if (error || !Array.isArray(data)) return [];
  return (data as { started_at: string; finished_at: string | null; ends_at: string }[]).map(r => ({
    from: new Date(r.started_at).getTime(),
    to: new Date(r.finished_at ?? r.ends_at).getTime(),
  }));
}

/** Den Global Pause man just var med i, för sammanfattningen efter pausen. */
export type GlobalPauseResult = { starts_at: string; seconds: number; people: number; total_seconds: number };

// Sammanfattningen visas en gång per Global Pause: en andra paus samma
// kvart ska bli en vanlig paus igen — utom när man gått in i rummet igen
// (`rejoinGlobalPause`), för då är den en del av samma Global Pause.
const summarized = new Set<string>();

/** Har sammanfattningen visats för den här Global Pause? Då visar rummet nästa. */
export function wasSummarized(startsAt: string): boolean {
  return summarized.has(startsAt);
}

/** Man går in igen efter att ha gått ut: nästa slut får sin sammanfattning. */
export function rejoinGlobalPause(startsAt: string): void {
  summarized.delete(startsAt);
}

/**
 * Var pausen som just slutade en del av en Global Pause? `null` om inte, och
 * om sammanfattningen redan visats för den. Kastar aldrig.
 */
export async function takeGlobalPauseResult(): Promise<GlobalPauseResult | null> {
  let result: GlobalPauseResult | null = null;
  if (GLOBAL_PAUSE_DEMO) {
    result = demoMe ? { starts_at: new Date(demoStart).toISOString(), seconds: 0, people: 24, total_seconds: 41 * 3600 } : null;
  } else {
    try {
      const { data, error } = await supabase.rpc('get_my_last_global_result');
      if (!error && data) result = data as GlobalPauseResult;
    } catch {
      result = null;
    }
  }
  if (!result || summarized.has(result.starts_at)) return null;
  summarized.add(result.starts_at);
  // Demot: rummet går tillbaka till före-vyn för nästa, och anmälan gällde den
  // som var.
  if (GLOBAL_PAUSE_DEMO) { setDemoPhase('before'); demoMe = null; }
  return result;
}

/** `Tue 18:00`, i telefonens tid. */
export function formatGlobalPauseStart(iso: string): string {
  const d = new Date(iso);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** `today 19:00`, `tomorrow 18:00`, annars `Tue 18:00`. */
export function formatGlobalPauseWhen(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  const clock = formatGlobalPauseStart(iso).slice(4);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  return formatGlobalPauseStart(iso);
}

/** Hur länge kvar: `1h 20min`, `45 min`, högst nedåt `1 min`. */
export function formatCountdown(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}
