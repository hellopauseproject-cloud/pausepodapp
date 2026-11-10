import AsyncStorage from '@react-native-async-storage/async-storage';
import { track } from './analytics';
import { enableDailyReminder } from './notifications';
import { supabase } from './supabase';
import type { CircleActivity, CircleActivityType, CirclePeriod, CircleProgress, DailyGoalProgress } from '../types/database';

// Samma verb-fraser som CATEGORY_VERB i app/support-story-create.tsx, så
// aktivitetsflödet låter likadant som resten av appen ("took a pause to study").
const CATEGORY_VERB: Record<string, string> = {
  focus: 'focus',
  walk: 'go for a walk',
  workout: 'work out',
  social: 'hang out',
  clean: 'clean',
  meditate: 'meditate',
  read: 'read',
  study: 'study',
  rest: 'rest',
  create: 'create',
  music: 'play music',
  nature: 'be in nature',
  // En egen intention lämnas aldrig ut med namn i en krets
  // (supabase/circle_intentions.sql) — den står som `other`.
  other: 'do their own thing',
};

/**
 * Stegen i målratten (och i `− +` på Hem). Talet är ett DAGSmål, så spannet
 * är 10 min till 12 h — inom `set_daily_goal`s gränser i circles.sql (minst
 * 5 min, högst 12 h). Ändras ett tak här måste det stämma där också, annars
 * erbjuder ratten ett steg servern säger nej till.
 *
 * **Hela timmar, med minuter bara i början.** Halvtimmessteg hela vägen upp
 * gav tolv detenter där hälften bara var `2h 30min`-varianter av sina
 * grannar — ratten blev stökig att läsa utan att bli mer användbar. Under en
 * timme är stegen verkligt olika löften (10, 20, 30, 45 min); skillnaden
 * mellan 4 h och 4 h 30 min är det inte.
 *
 * Veckans ribba räknas sedan som detta gånger sju.
 */
export const GOAL_OPTIONS: number[] = [
  // Från 10 min (november 2026, på begäran): en liten början är bättre än
  // ingen. `set_daily_goal` tar emot ner till 5 min, så ingen SQL behövdes.
  10 * 60, 20 * 60, 30 * 60, 45 * 60,
  ...Array.from({ length: 12 }, (_, i) => (i + 1) * 3600),
];

/**
 * Hur många kretsar man får vara med i. Speglar `circle_max_per_user()` i
 * supabase/circles.sql — ändras talet där måste det ändras här, annars visar
 * fliken ett plus som servern säger nej till.
 */
export const CIRCLE_MAX_PER_USER = 3;

/** Kretsens namn och nivå så som den visas på en väns profilkort. */
export type FriendCircleBadge = {
  circle_name: string;
  /** Kretsens gemensamma nivå — det finns ingen personlig nivå i systemet. */
  level: number;
  /** Alla hens kretsar (högst tre), i den ordning hen gick med. Den första
   *  är också `circle_name`/`level` ovan. Saknas mot en äldre databas. */
  circles?: { circle_name: string; level: number }[];
};

/**
 * Vilken krets en vän är med i, och på vilken nivå den står.
 *
 * Går via RPC och inte via en vanlig select: RLS på `circles`/`circle_members`
 * släpper bara igenom den krets man själv är med i, så en vän i en annan
 * krets vore annars osynlig. Servern kräver en vänskapsrad åt något håll och
 * lämnar bara ut namn + nivå.
 *
 * `null` betyder "ingen krets att visa" — antingen är hen inte med i någon,
 * eller så är ni inte vänner. Kortet skiljer inte på de två, och ska inte
 * göra det: ett "hen är med i en krets men du får inte se vilken" vore att
 * läcka just det man inte lämnar ut.
 */
export async function getFriendCircleBadge(userId: string): Promise<FriendCircleBadge | null> {
  const { data, error } = await supabase.rpc('get_friend_circle_badge', { p_user_id: userId });
  if (error) {
    console.log('[circles] getFriendCircleBadge error:', error.message);
    return null;
  }
  return (data as FriendCircleBadge) ?? null;
}

/** Närmaste detent till ett godtyckligt antal sekunder. */
export function nearestGoalIndex(seconds: number): number {
  let best = 0;
  for (let i = 1; i < GOAL_OPTIONS.length; i++) {
    if (Math.abs(GOAL_OPTIONS[i] - seconds) < Math.abs(GOAL_OPTIONS[best] - seconds)) best = i;
  }
  return best;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}min` : `${h}h`;
  return `${m} min`;
}

// Veckan kommer som ett datum i UTC ('2026-09-21'). Läs det med UTC-getters —
// med lokala skulle en användare väster om Greenwich få måndagen renderad som
// söndagen innan, alltså fel veckospann på etiketten.
//
// Månaden står på båda ändarna ("OCT 5 – OCT 11"), också när den är samma:
// veckodagarna sa ingenting — en vecka går alltid måndag till söndag.
//
// `workdays`: kretsen räknar bara måndag–fredag, och då slutar spannet på
// fredagen ("OCT 5 – OCT 9") — datumen ska vara de som räknas.
export function formatWeekRange(weekStart: string, workdays = false): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start.getTime() + (workdays ? 4 : 6) * 86400000);
  const label = (d: Date) => `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return `${label(start)} – ${label(end)}`;
}

// Formaterar en circle_activity-rad till läsbar text client-side — samma
// princip som friend-wrapped.tsx/my-wrapped.tsx, som aldrig sparar färdig
// engelsk text i databasen utan bygger den av typ + metadata vid rendering.
//
// goal_reached och level_up har actor_id = null: de är cirkelns händelser,
// inte någon enskild persons, och texten nämner därför ingen. UI:t renderar
// dem med en milstolpe-ikon i stället för en avatar.
/**
 * Samma rad som `formatActivity`, men delad i bitar så att själva saken kan
 * kursiveras: "Maja did *bada i havet*". En enda sträng går inte att
 * styla styckvis i React Native — det krävs skilda <Text>-barn.
 *
 * `em` markerar den delen som är innehållet snarare än meningen omkring det.
 */
export type ActivitySegment = { text: string; em?: boolean };

export function formatActivitySegments(item: CircleActivity, actorName: string): ActivitySegment[] {
  const meta = item.metadata ?? {};
  switch (item.type as CircleActivityType) {
    case 'wishlist_completed':
      return [
        { text: `${actorName} did ` },
        { text: String(meta.text ?? 'something on their list'), em: true },
      ];
    case 'pause_completed': {
      const dur = formatDuration(meta.duration_seconds ?? 0);
      const verb = meta.category ? CATEGORY_VERB[meta.category] : null;
      return verb
        ? [{ text: `${actorName} took a ` }, { text: dur, em: true }, { text: ' pause to ' }, { text: verb, em: true }]
        : [{ text: `${actorName} took a ` }, { text: dur, em: true }, { text: ' pause' }];
    }
    case 'goal_set':
      return meta.raised
        ? [{ text: `${actorName} raised their goal to ` }, { text: formatDuration(meta.seconds ?? 0), em: true }]
        : [{ text: `${actorName} set their daily goal to ` }, { text: formatDuration(meta.seconds ?? 0), em: true }];
    case 'goal_reached':
      return [
        { text: 'Everyone reached their goal — ' },
        { text: formatDuration(meta.pot_seconds ?? 0), em: true },
        { text: ' together this week.' },
      ];
    case 'level_up':
      return [
        { text: 'The circle reached ' },
        { text: `Level ${meta.level}`, em: true },
        { text: ' — ' },
        { text: formatDuration(meta.total_seconds ?? 0), em: true },
        { text: ' together.' },
      ];
    case 'reward_unlocked':
      return [{ text: 'Reward unlocked: ' }, { text: String(meta.text ?? 'something together'), em: true }];
    case 'reward_adopted':
      return [{ text: 'New circle reward: ' }, { text: String(meta.text ?? 'something together'), em: true }];
    // Resten har ingen egen "sak" att lyfta fram — hela meningen är budskapet.
    default:
      return [{ text: formatActivity(item, actorName) }];
  }
}

export function formatActivity(item: CircleActivity, actorName: string): string {
  const meta = item.metadata ?? {};
  switch (item.type as CircleActivityType) {
    case 'member_joined':
      return `${actorName} joined the circle.`;
    case 'member_left':
      return `${actorName} left the circle.`;
    case 'weekly_goal_updated':
      return `${actorName} updated their plans.`;
    case 'goal_set':
      return meta.raised
        ? `${actorName} raised their goal to ${formatDuration(meta.seconds ?? 0)}.`
        : `${actorName} set their daily goal to ${formatDuration(meta.seconds ?? 0)}.`;
    // Medvetet utan siffra och utan ordet "lowered" — en sänkning som
    // parkerats till nästa vecka ska inte hängas ut i flödet.
    case 'goal_adjusted':
      return `${actorName} adjusted their daily goal.`;
    case 'wishlist_completed':
      return `${actorName} did ${meta.text ?? 'something on their list'}.`;
    case 'goal_reached':
      return `Everyone reached their goal — ${formatDuration(meta.pot_seconds ?? 0)} together this week.`;
    case 'level_up':
      return `The circle reached Level ${meta.level} — ${formatDuration(meta.total_seconds ?? 0)} together.`;
    // Förslagsställaren står som aktör (avataren), men meningen nämner ingen:
    // belöningen är kretsens beslut, inte hens.
    // Veckan låstes och belöningen med den. Kretsens händelse, ingen aktör.
    case 'reward_unlocked':
      return `Reward unlocked: ${meta.text ?? 'something together'}.`;
    // Från första versionen, då en belöning antogs med majoritet. Skrivs inte
    // längre men kan ligga kvar i flödet.
    case 'reward_adopted':
      return `New circle reward: ${meta.text ?? 'something together'}.`;
    case 'pause_completed': {
      const dur = formatDuration(meta.duration_seconds ?? 0);
      const verb = meta.category ? CATEGORY_VERB[meta.category] : null;
      return verb
        ? `${actorName} took a ${dur} pause to ${verb}!`
        : `${actorName} took a ${dur} pause!`;
    }
    default:
      return `${actorName} did something in the circle.`;
  }
}

/** En av ens egna kretsar, med det som fliken och brickan behöver. */
export type MyCircle = {
  id: string;
  name: string;
  role: 'owner' | 'member';
  joined_at: string;
  /** Läsmärket i just den kretsens chatt; null = aldrig öppnad. */
  chat_read_at: string | null;
  settings: CircleSettings;
  /** När kretsen skapades — där bakåtbläddringen i ringen tar slut. */
  created_at: string | null;
};

// ── Kretsens inställningar ────────────────────────────────────────────────
// Ägarens två val: belöning på/av, och vilka timmar och dagar en paus räknas
// i potten. Reglerna bor i supabase/circles.sql (*Kretsens inställningar*);
// här finns bara formen och texten.

/** Räknefönstret. Båda timmarna null = dygnet runt. Timmarna är hela, i varje medlems egen tid. */
export type CountWindow = {
  count_from: number | null;
  count_to: number | null;
  count_workdays: boolean;
};

export type CircleSettings = CountWindow & {
  rewards_enabled: boolean;
  /** En fönsterändring som gäller från en kommande måndag. */
  pending: (CountWindow & { week: string }) | null;
};

export const DEFAULT_CIRCLE_SETTINGS: CircleSettings = {
  rewards_enabled: false, count_from: null, count_to: null, count_workdays: false, pending: null,
};

/**
 * Fönstret med samma etikett varje gång: "Time window: any time",
 * "Time window: 8–17, Mon–Fri". Samma ord som inställningsformuläret
 * (*this time window*), så att raden och det den öppnar säger samma sak.
 * *Counts all day, every day* sa inte vad som räknades, och *Every pause
 * counts* läste som en slogan.
 */
export function formatCountRule(w: CountWindow, midSentence = false): string {
  // Mitt i en mening ("From next week: time window …") utan kolon.
  return midSentence ? `time window ${formatCountValue(w)}` : `Time window: ${formatCountValue(w)}`;
}

/** Bara värdet: "any time", "8–17, Mon–Fri". */
export function formatCountValue(w: CountWindow): string {
  const hours = w.count_from === null || w.count_to === null ? null : `${w.count_from}–${w.count_to}`;
  const days = w.count_workdays ? 'Mon–Fri' : null;
  return !hours && !days ? 'any time' : [hours, days].filter(Boolean).join(', ');
}

/** Om fönstret är något annat än dygnet runt alla dagar. */
export function hasCountWindow(w: CountWindow): boolean {
  return w.count_from !== null || w.count_workdays;
}

const CIRCLE_COLUMNS =
  'name, created_at, rewards_enabled, count_from, count_to, count_workdays, ' +
  'pending_count_week, pending_count_from, pending_count_to, pending_count_workdays';

function settingsFromRow(c: any): CircleSettings {
  if (!c) return DEFAULT_CIRCLE_SETTINGS;
  return {
    rewards_enabled: !!c.rewards_enabled,
    count_from: c.count_from ?? null,
    count_to: c.count_to ?? null,
    count_workdays: !!c.count_workdays,
    pending: c.pending_count_week
      ? {
          week: c.pending_count_week,
          count_from: c.pending_count_from ?? null,
          count_to: c.pending_count_to ?? null,
          count_workdays: !!c.pending_count_workdays,
        }
      : null,
  };
}

/**
 * Sparar ägarens val. Svarar med `deferred` när fönstret ändrades och
 * gäller först från nästa måndag — skärmen måste säga det, annars ser det ut
 * som att sparningen inte tog.
 */
export async function setCircleSettings(
  circleId: string,
  s: { rewards_enabled: boolean } & CountWindow,
): Promise<{ deferred: boolean }> {
  const { data, error } = await supabase.rpc('set_circle_settings', {
    p_circle_id: circleId,
    p_rewards_enabled: s.rewards_enabled,
    p_count_from: s.count_from,
    p_count_to: s.count_to,
    p_count_workdays: s.count_workdays,
  });
  if (error) throw error;
  return { deferred: !!(data as any)?.deferred };
}

/**
 * Alla kretsar man är med i (högst `CIRCLE_MAX_PER_USER`), i den ordning man
 * gick med. Ordningen är densamma som servern använder när ett anrop saknar
 * `p_circle_id` (`resolve_my_circle`), så "den första" betyder samma sak på
 * båda sidor.
 */
export async function getMyCircles(userId: string): Promise<MyCircle[]> {
  let { data, error } = await supabase
    .from('circle_members')
    .select(`circle_id, role, joined_at, chat_read_at, circle:circles!circle_id(${CIRCLE_COLUMNS})`)
    .eq('user_id', userId)
    .order('joined_at', { ascending: true });

  // Inställningskolumnerna kommer med circles.sql. En databas där filen inte
  // körts än svarar med fel på hela frågan — och ett fel här ser ut som "inte
  // med i någon krets", så alla kretsar försvann ur fliken. Då frågar vi om
  // utan dem, och kretsarna får förvalen (ingen belöning, dygnet runt).
  if (error && /column/i.test(error.message)) {
    console.log('[circles] getMyCircles: settings columns missing, run circles.sql:', error.message);
    const retry = await supabase
      .from('circle_members')
      .select('circle_id, role, joined_at, chat_read_at, circle:circles!circle_id(name, created_at)')
      .eq('user_id', userId)
      .order('joined_at', { ascending: true });
    data = retry.data as any;
    error = retry.error;
  }

  // Ett tyst fel här är omöjligt att skilja från "inte med i någon cirkel",
  // och det är precis den förväxlingen som gör RLS-problem osynliga: skärmen
  // visar "No circle yet" medan create_circle (security definer, förbi RLS)
  // svarar att man redan är med i en.
  if (error) {
    console.log('[circles] getMyCircles error:', error.message);
    return [];
  }
  return (data ?? []).map((r: any) => ({
    id: r.circle_id,
    name: r.circle?.name ?? 'Circle',
    role: r.role,
    joined_at: r.joined_at,
    chat_read_at: r.chat_read_at ?? null,
    settings: settingsFromRow(r.circle),
    created_at: r.circle?.created_at ?? null,
  }));
}

export async function getMyCircleId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) return null;
  return (await getMyCircles(userId))[0]?.id ?? null;
}

// ── Vilken krets fliken visar ─────────────────────────────────────────────
// Per enhet, som temat: det är var man stod senast, inte något om kontot.
// Pekar nyckeln på en krets man inte längre är med i faller fliken tillbaka
// på den första.
const SELECTED_CIRCLE_KEY = 'circle_tab_selected';

export async function getSelectedCircleId(): Promise<string | null> {
  try { return await AsyncStorage.getItem(SELECTED_CIRCLE_KEY); } catch { return null; }
}

export async function setSelectedCircleId(circleId: string): Promise<void> {
  try { await AsyncStorage.setItem(SELECTED_CIRCLE_KEY, circleId); } catch {}
}

// En annan skärm (circle-create) vill att fliken visar en viss krets när man
// kommer tillbaka. Fliken avmonteras inte och har sitt val i minnet, så det
// räcker inte att skriva AsyncStorage — den plockar upp det här i load().
let requestedCircleId: string | null = null;

export function requestCircleSelection(circleId: string): void {
  requestedCircleId = circleId;
  setSelectedCircleId(circleId);
}

export function takeRequestedCircleSelection(): string | null {
  const id = requestedCircleId;
  requestedCircleId = null;
  return id;
}

/**
 * Räknar in en avslutad paus i cirkelns vecka och i stegen, och lägger den i
 * aktivitetsflödet. Anropas efter varje avslutad paus — både det lådlösa
 * flödet i app/pausing.tsx och lådflödets lib/sessionOutbox.ts — och no-opar
 * tyst om användaren inte är med i någon cirkel.
 *
 * Skickar bara sessionens id: RPC:n läser längd och sluttid ur pause_sessions
 * själv, så ingen kan skriva in timmar som inte finns i den egna loggen.
 * Dubblettskyddet sitter på session_id server-side, vilket gör det ofarligt
 * att anropa om — outboxen gör det när en köad låd-session skickas om.
 */
export async function recordPauseInCircle(sessionId: string, category?: string | null) {
  try {
    await supabase.rpc('record_circle_pause', {
      p_session_id: sessionId,
      p_category: category ?? null,
      // Kretsar med ett räknefönster räknar i medlemmens egen tid.
      p_tz_offset_minutes: new Date().getTimezoneOffset(),
    });
  } catch (e) {
    console.log('[circles] recordPauseInCircle error:', e);
  }

  // Kan den här pausen ha tagit användaren över sitt dagsmål? Frågan ställs
  // till servern, som räknar själv — klienten skickar bara sin tidszon, och
  // RPC:n läser summan ur `circle_pause_ledger` och målet ur `profiles`. Ingen
  // kan alltså påstå en bedrift som inte finns, samma princip som
  // `record_circle_pause` ovan bara tar emot ett id.
  //
  // Efter och inte före: bedriften räknas ur ledgern, och det är raden ovan
  // som lägger pausen där. Byter man ordning missar notisen just den paus som
  // tog användaren över strecket.
  //
  // Här och inte i de två pausflödena ([app/pausing.tsx](app/pausing.tsx) och
  // [lib/sessionOutbox.ts](lib/sessionOutbox.ts)) av samma skäl som den här
  // funktionen finns: två anrop hade kunnat glida isär, och det ena flödet
  // hade tappat notisen utan att något felar.
  //
  // Ett eget anrop och inte en gren inne i `record_circle_pause` — skälet
  // står i supabase/circle_goal_notify.sql: en ny parameter där hade krävt
  // ett `drop function`, och därmed en kopia av hela kroppen i en andra fil.
  //
  // Notisen är hela utfallet, så ett fel är inget att rädda: pausen är redan
  // räknad, och det enda som går förlorat är att kretsen inte får veta.
  try {
    await supabase.rpc('record_daily_goal_reached', {
      p_tz_offset_minutes: new Date().getTimezoneOffset(),
    });
  } catch (e) {
    console.log('[circles] record_daily_goal_reached error:', e);
  }
}

/** Hela cirkelfliken i ett anrop. null = inte med i den kretsen (eller i någon). */
export async function getCircleProgress(circleId: string): Promise<CircleProgress | null> {
  // Klientens tidszonsavvikelse avgör vad "idag" betyder i dagssiffran.
  const { data, error } = await supabase.rpc('get_circle_progress', {
    p_tz_offset_minutes: new Date().getTimezoneOffset(),
    p_circle_id: circleId,
  });
  if (error) {
    console.log('[circles] getCircleProgress error:', error.message);
    return null;
  }
  return (data as CircleProgress) ?? null;
}

/**
 * En gången vecka (`date` = veckans måndag) eller dag (`date` = det lokala
 * datumet), för bakåtbläddringen i kretsens ring. Pågående period läses
 * fortfarande med `getCircleProgress`.
 */
export async function getCirclePeriod(
  circleId: string, mode: 'week' | 'day', date: string,
): Promise<CirclePeriod | null> {
  const { data, error } = await supabase.rpc('get_circle_period', {
    p_circle_id: circleId,
    p_mode: mode,
    p_date: date,
    p_tz_offset_minutes: new Date().getTimezoneOffset(),
  });
  if (error) {
    console.log('[circles] getCirclePeriod error:', error.message);
    return null;
  }
  return (data as CirclePeriod) ?? null;
}

/**
 * Sätter dagsmålet. Gäller genast, åt båda håll — ändringen syns i
 * aktivitetsflödet i stället för att parkeras till nästa vecka.
 *
 * **Kräver ingen krets.** Talet bor på `profiles.daily_target_seconds` och är
 * personligt; RPC:n loggar och utvärderar kretsen bara om man är med i en. Det
 * är därför den här funktionen bor i circles.ts trots att den inte handlar om
 * kretsar: den och `GOAL_OPTIONS` och `nearestGoalIndex` är ett och samma
 * API, och att dela dem över två filer vore värre än att den ligger fel.
 */
export async function setDailyGoal(seconds: number): Promise<void> {
  const { error } = await supabase.rpc('set_daily_goal', { p_seconds: seconds });
  if (error) throw new Error(error.message);
  // Här och inte i de två skärmar som öppnar ratten: Hem och Kretsen sätter
  // samma tal genom samma funktion, och två anrop hade kunnat glida isär på
  // samma sätt som två kopior av ratten själv.
  track('daily_goal_set', { seconds });

  // Dagspåminnelsen räknar ner mot just det här talet, så den måste läggas om
  // när talet ändras. Det är också enda stället appen frågar om
  // notisbehörighet — se huvudkommentaren i lib/notifications.ts. Av samma
  // skäl som `track` ovan ligger anropet här och inte i de två skärmarna.
  //
  // Väntas inte in: RPC:n har gått igenom, målet är sparat, och en
  // behörighetsdialog som skärmen står och blockerar på vore värre än en
  // påminnelse som läggs ut en halv sekund senare. `enableDailyReminder`
  // kastar aldrig, men `.catch` står kvar som skydd mot en avvisad promise
  // som ingen väntar på.
  //
  // Sänkningar behöver ingen egen gren. En sänkning parkeras i
  // `pending_target_seconds` och lämnar `profiles.daily_target_seconds`
  // orörd till veckoskiftet, så `get_daily_goal_progress` — som påminnelsen
  // läser — svarar med det mål som faktiskt gäller. En höjning gäller genast
  // och syns på samma sätt. Siffran i notisen följer alltså ribban av sig
  // själv, utan att den här filen behöver känna till reglerna.
  enableDailyReminder().catch(() => {});
}

/**
 * Dagens siffra och dagens mål för den inloggade — utan krets.
 *
 * Ringen på Hem visas för alla, och den som pausar ensam har ingen
 * `get_circle_progress()` att hämta talen ur: det finns ingen medlemsrad och
 * ingen ledger. Den här läser dagen ur de egna `pause_sessions` i stället.
 *
 * Hem använder den numera med och utan krets: med upp till tre kretsar finns
 * ingen enskild "kretsens dag" att visa, och ringen är ens eget tal. Samma
 * källa räknar dagsmålsnotisen (`record_daily_goal_reached`).
 *
 * `null` betyder att anropet föll (nät, utloggad), inte att målet saknas —
 * det senare kommer som `daily_target_seconds: null` i ett svar som finns.
 */
export async function getDailyGoalProgress(): Promise<DailyGoalProgress | null> {
  const { data, error } = await supabase.rpc('get_daily_goal_progress', {
    p_tz_offset_minutes: new Date().getTimezoneOffset(),
  });
  if (error) {
    console.log('[circles] getDailyGoalProgress error:', error.message);
    return null;
  }
  return (data as DailyGoalProgress) ?? null;
}
