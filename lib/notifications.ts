import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { track } from './analytics';
import { supabase } from './supabase';

/**
 * Appens notiser. En lokal och fem push, och de två sorterna är olika hela
 * vägen ner.
 *
 * Filen hette så här förut också, och innehöll då något annat: en lokal
 * dagspåminnelse PLUS push-token-registrering PLUS Android-kanaler för en
 * vän-notis som fyrade på `is_pausing` false → true. Allt det revs (se
 * notisavsnittet i CLAUDE.md och `supabase/notifications-teardown.sql`), och
 * det här är inte ett återställande: taket, strypningen och nattfönstret i
 * den gamla kedjan var avvägningar som görs om från början.
 *
 * ── Notis 1: dagspåminnelsen (lokal) ────────────────────────────────────────
 *
 *   Ready for a pause?
 *   1h 30min left of today's goal.
 *
 * ── Notis 2: kretsens dagsmål (push) ────────────────────────────────────────
 *
 *   Anna hit today's goal
 *   Celebrate in the chat.
 *
 * Den andra är push och ägs av
 * [supabase/circle_goal_notify.sql](../supabase/circle_goal_notify.sql) plus
 * edge-funktionen `notify-circle-goal-reached`. Den här filen gör bara två
 * saker för den: registrerar telefonens token (`registerPushToken`) och
 * bestämmer vad som händer när den landar eller trycks på.
 *
 * ── Notis 3–6: chatten, stöd, pausinbjudan (push) ──────────────────────────
 *
 *   Anna wrote in the chat          Tap to read.
 *   Anna asked for support          Send a few words.
 *   Anna sent you support           Open it now.
 *   Anna invited you to pause       Join in.
 *
 * Ägs av [supabase/social_notify.sql](../supabase/social_notify.sql) — fyra
 * triggers på samma rör som dagsmålet. Ingen av dem bär innehåll.
 *
 * **Varje push har ett tak, och frågan för en sjunde är fortfarande: kan den
 * växa av sig själv?** Dagsmålet: en bedrift per person och dygn. Chatten: en
 * per oläst svit — antalet meddelanden avgör ingenting. Stödförfrågan: en
 * per avsändare och dygn. Stödsvaret: buntat tills öppnat. Pausinbjudan:
 * varje — den är handplockad, så taket är handen. "X pausar nu"
 * hade inget sådant tak, och det är därför den inte finns.
 *
 * ── Varför ingen server ─────────────────────────────────────────────────────
 *
 * Bara appen kan registrera en paus. `pause_sessions` skrivs från det lådlösa
 * flödet (`app/pausing.tsx`), lådflödets kö (`lib/sessionOutbox.ts`) och
 * krasch-återställningen (`app/_layout.tsx`) — alla tre i appen. Resttiden kan
 * alltså **inte ändras medan appen är stängd**, och därför är en text som
 * räknas ut vid schemaläggningen aldrig gammal när den visas. Ingen
 * push-token, ingen trigger, ingen edge-funktion, inget `pg_net`.
 *
 * Samma insikt ger de framtida dagarna gratis: har appen inte varit öppen
 * finns ingen ny session, så resttiden vid klockan 20 i morgon är hela målet.
 * Därför kan ett helt fönster schemaläggas i förväg med korrekta siffror.
 *
 * ── Rubriken speglar Hem ────────────────────────────────────────────────────
 *
 * `Ready for a pause?` står på Hem utan mål, och notisen ska låta som den
 * skärm den öppnar. Den säger med flit inte "Don't forget" — skuld är fel
 * motor i en app vars löfte är lättnad — och är inte versaliserad: versaler
 * är appens displaykonvention, inte notisfältets, och `PAUSE!` bredvid varje
 * annan app läses som skrik.
 *
 * ── Tre tystnader ───────────────────────────────────────────────────────────
 *
 * - **Inget mål satt → ingen notis.** Det finns inget tal att räkna ner, och
 *   den som inte satt ett mål har inte bett om en siffra.
 * - **Målet redan nått → ingen notis den dagen.** Det är den regeln som
 *   skiljer en påminnelse från en gnällspik.
 * - **Behörighet saknas → ingen notis, och ingen klagan.** `syncDailyReminder`
 *   frågar aldrig om behörighet; det gör bara `enableDailyReminder`, som
 *   anropas när ett dagsmål sparas (se `setDailyGoal` i `lib/circles.ts`).
 *   Det är det enda ögonblicket där frågan betyder något: man har just lovat
 *   sig själv ett tal.
 *
 * (Tystnaderna ovan gäller dagspåminnelsen. Pushnotisernas motsvarigheter
 * sitter i SQL: taken ovan, och mottagarens nattfönster 08–21.)
 *
 * ── Av-knappen är systemets ─────────────────────────────────────────────────
 *
 * Det finns ingen rad i Settings, för någon av dem. OS:ets per-app-växel
 * stänger av alla, och på Android har varje push en egen kanal
 * (`PUSH_CHANNELS`) som går att tysta för sig. Kretsnotisen har ingen personlig
 * synlighetsflagga med flit: `profiles.show_stats` ignoreras redan inne i en
 * krets (se `get_circle_progress` i circles.sql), och din andel av ett mål ni
 * satt ihop är hela poängen med att vara med. Ska de kunna styras var för sig
 * är det två växlar och en Settings-sektion, alltså en egen ändring.
 */

/** Klockan 20 lokalt. Sent nog att "du har tid kvar" är sant, tidigt nog att man hinner. */
export const REMINDER_HOUR = 20;

/**
 * Hur många dygn framåt som schemaläggs vid varje synk.
 *
 * Fönstret är också en spärr: ligger appen oöppnad en vecka tystnar
 * påminnelsen av sig själv i stället för att fortsätta knacka i all evighet.
 */
const WINDOW_DAYS = 7;

/**
 * Id:na är deterministiska (`pause-daily-reminder-0` … `-6`) så att
 * avbokningen träffar exakt appens egna notiser.
 * `cancelAllScheduledNotificationsAsync` hade fungerat idag — appen
 * schemalägger ingenting annat — men den hade tystat en framtida andra notis
 * utan att någon förstod varför.
 */
const ID_PREFIX = 'pause-daily-reminder';

const ANDROID_CHANNEL_ID = 'pause-daily-reminder';

const TITLE = 'Ready for a pause?';

/**
 * Kretsnotisens `data.type`. Måste stämma med strängen i
 * `notify_circle_goal_reached` i supabase/circle_goal_notify.sql — den sätts
 * där och läses här, och ingen typkontroll fångar ett stavfel över den
 * gränsen.
 */
export const CIRCLE_GOAL_TYPE = 'circle_goal_reached';

/**
 * De sociala notisernas `data.type`, satta i supabase/social_notify.sql.
 * Samma varning som ovan: strängarna korsar en gräns ingen typkontroll ser.
 */
export const CIRCLE_CHAT_TYPE = 'circle_chat';
export const SUPPORT_REQUEST_TYPE = 'support_request';
export const SUPPORT_RECEIVED_TYPE = 'support_received';
export const PAUSE_INVITE_TYPE = 'pause_invite';

/**
 * Påminnelsen om den globala pausen, 10 minuter före (lib/globalPause.ts).
 * Lokal som dagspåminnelsen: den läggs ut av ens eget "I'll join", så den kan
 * inte växa av sig själv och aldrig gälla något man inte valt. Ett fast id,
 * för man är anmäld till högst en i taget.
 */
export const GLOBAL_PAUSE_TYPE = 'global_pause';
/**
 * Namnet användaren ser, på ett ställe. Bara orden: filer, tabeller och
 * funktioner heter fortfarande global_pause.
 */
export const GLOBAL_PAUSE_NAME = 'Global Pause';
const GLOBAL_PAUSE_REMINDER_ID = 'pause-global-reminder';
const GLOBAL_PAUSE_CHANNEL_ID = 'pause-global-reminder';
const GLOBAL_PAUSE_REMINDER_LEAD_MS = 10 * 60_000;

/** Alla typer som kommer som push, alltså handlar om någon annan. */
const PUSH_TYPES = new Set([
  CIRCLE_GOAL_TYPE, CIRCLE_CHAT_TYPE, SUPPORT_REQUEST_TYPE, SUPPORT_RECEIVED_TYPE, PAUSE_INVITE_TYPE,
]);

/**
 * Androids kanaler för push, en per sort. Samma namn skickas som `channelId`
 * från edge-funktionen (`CHANNELS` där, `p_channel` i SQL) — skapas en inte
 * här hamnar notisen i standardkanalen och tappar sin ton.
 *
 * En kanal per sort och inte en gemensam: Android låter användaren tysta en
 * kanal i taget, och den som vill ha stödsvaren men inte chatten ska kunna
 * välja det där — appen har ingen Settings-rad för notiser.
 */
const PUSH_CHANNELS: { id: string; name: string }[] = [
  { id: 'circle-goal-reached', name: 'Circle goal reached' },
  { id: 'circle-chat', name: 'Circle chat' },
  { id: 'support-request', name: 'Support requests' },
  { id: 'support-received', name: 'Support received' },
  { id: 'pause-invite', name: 'Pause invites' },
];

/**
 * Vilken krets chatt som står framme just nu, eller null. Sätts av
 * app/circle-chat.tsx.
 *
 * Chattnotisen knackar en gång per oläst svit, och läsmärket flyttas först när
 * pollen hämtat meddelandet — alltså kan notisen landa medan man tittar på
 * samma meddelande. Då ska den inte synas. En notis från en ANNAN av ens
 * kretsar visas däremot: den handlar om ett samtal man inte tittar på.
 */
let chatScreenCircleId: string | null = null;

export function setChatScreenOpen(circleId: string | null): void {
  chatScreenCircleId = circleId;
}

/**
 * Hur en notis som landar medan appen ligger framme ska bete sig. Skillnaden
 * är vem notisen handlar om:
 *
 * - **Dagspåminnelsen döljs.** En påminnelse om att öppna appen har
 *   ingenting att säga den som redan är i den, och ett banner över
 *   pausskärmen vore värre än tyst.
 * - **Push visas** — kretsens dagsmål, chatten, stödförfrågan, stödsvaret.
 *   De handlar om någon annan, och den som sitter i appen har inget annat
 *   sätt att få veta just då. Att tysta dem hade gjort funktionerna sämst för
 *   den mest aktiva användaren.
 * - **Utom chatten medan chatten står framme**, se `setChatScreenOpen`.
 *
 * Anropas en gång från `app/_layout.tsx`, samma konvention som `initAnalytics`.
 */
export function initNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async notification => {
      const data = notification.request.content.data as { type?: string; circle_id?: string } | null;
      const type = data?.type ?? '';
      const chatInView = type === CIRCLE_CHAT_TYPE && chatScreenCircleId !== null
        && (!data?.circle_id || data.circle_id === chatScreenCircleId);
      const show = PUSH_TYPES.has(type) && !chatInView;
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: show,
        // Ingen bricka på appikonen, för någon av dem. Ett tal som bara går
        // att nolla genom att öppna appen är en skuld, inte en upplysning —
        // samma skäl som chattens prick saknar siffra.
        shouldSetBadge: false,
      };
    },
  });
}

async function ensurePushChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  for (const channel of PUSH_CHANNELS) {
    await Notifications.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
}

/**
 * Lägger telefonens push-token och tidszon på profilraden, så att
 * `notify_circle_goal_reached` har någon att skicka till och vet om det är
 * natt där mottagaren är.
 *
 * Anropas vid varje appstart när användaren är känd (en token kan roteras av
 * OS:et, så den måste skrivas om och inte bara en gång), och direkt när någon
 * går med i en krets, ber om stöd eller får en vän — se `enablePushNotifications`.
 *
 * **Frågar inte om behörighet.** Utan behörighet finns ingen token att hämta,
 * och ett anrop vid varje appstart som fick visa en systemdialog hade varit
 * precis den sortens tjat som notiserna revs för.
 *
 * `tz_offset_minutes` är den enda kolumnen från den gamla kedjan som kommer
 * tillbaka i bruk. Den skrivs här och inte vid inloggning, eftersom den som
 * reser byter tidszon utan att logga om — nattfönstret ska följa telefonen,
 * inte sessionen.
 */
export async function registerPushToken(userId: string): Promise<void> {
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return;

    await ensurePushChannels();

    // Utan projektets id vet Expo inte vems token det är. Den ligger i
    // app.json under extra.eas.projectId och läses härifrån i stället för att
    // skrivas in på nytt — två kopior av ett id är ett id som kan bli fel.
    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return;

    const { error } = await supabase
      .from('profiles')
      .update({ push_token: token, tz_offset_minutes: new Date().getTimezoneOffset() })
      .eq('id', userId);

    // Läses, inte kastas bort. Ett `.update()` mot profiles vars fel ingen
    // tittar på är samma bugg som profilskärmens tysta namnkrock var — här
    // blir följden i stället att notisen aldrig går ut och ingen vet varför.
    if (error) console.log('[notifications] push_token update error:', error.message);
  } catch (e) {
    // Simulatorer och emulatorer har ingen push-token att ge. Det är inte ett
    // fel, och dagspåminnelsen fungerar ändå där — se filens huvud.
    console.log('[notifications] registerPushToken:', e);
  }
}

/**
 * Nollar tokenraden. Anropas av `signOut` i contexts/AuthContext.tsx, FÖRE
 * `supabase.auth.signOut()` medan sessionen fortfarande finns.
 *
 * Det här är lärdomen ur teardown-filen gjord till kod: en token som ligger
 * kvar på en profilrad fortsätter kunna tas emot push långt efter att
 * klienten slutat bry sig, och det var just därför databasen måste rivas för
 * hand förra gången. En utloggad telefon ska inte få veta att Anna nådde sitt
 * mål.
 */
export async function clearPushToken(userId: string): Promise<void> {
  try {
    await supabase.from('profiles').update({ push_token: null }).eq('id', userId);
  } catch {
    // Faller den får nästa inloggning skriva över raden i stället.
  }
}

/**
 * Resttiden som text. Speglar `formatDuration` i `lib/circles.ts` medvetet —
 * `30 min` med blanksteg, `1h 30min` utan — så att notisen och ringen på Hem
 * skriver samma tal på samma sätt.
 *
 * Tre skillnader, och alla tre är skillnader i uppgift snarare än kopior som
 * glidit isär: den här rundar **uppåt** till hel minut (en rest ska inte se
 * mindre ut än den är), har inget sekundfall (`45s left of today's goal` är
 * inte ett ärligt mått på något) och har ett golv på en minut.
 */
function formatRemaining(seconds: number): string {
  const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

/**
 * Dagens summa och dagens mål, läst med samma RPC som ringen på Hem.
 *
 * Läses här i stället för genom `getDailyGoalProgress()` i `lib/circles.ts`
 * för att hålla beroendet enkelriktat: `circles.ts` anropar härifrån (från
 * `setDailyGoal`), och en import tillbaka hade slutit en cirkel. Dygnsgränsen
 * räknas ändå på ett enda ställe — den sitter i SQL, i
 * `get_daily_goal_progress`, inte i någon av wrapparna.
 */
async function readProgress(): Promise<{ today: number; target: number } | null> {
  const { data, error } = await supabase.rpc('get_daily_goal_progress', {
    p_tz_offset_minutes: new Date().getTimezoneOffset(),
  });
  if (error || !data) return null;

  const target = (data as { daily_target_seconds: number | null }).daily_target_seconds;
  // `null` är inte noll: noll vore ett mål på ingenting, `null` är inget mål.
  if (target == null) return null;

  return { today: (data as { today_seconds: number }).today_seconds ?? 0, target };
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: 'Daily pause reminder',
    importance: Notifications.AndroidImportance.DEFAULT,
    // Ingen vibration. VIBRATE-behörigheten finns för ringsignalen i
    // app/call.tsx, och en påminnelse som skakar telefonen motsäger det den
    // ber om.
    vibrationPattern: null,
  });
}

/** Tar bort allt fönstret kan ha lagt ut. Tål att köras när inget ligger där. */
export async function cancelDailyReminder(): Promise<void> {
  for (let offset = 0; offset < WINDOW_DAYS; offset++) {
    try {
      await Notifications.cancelScheduledNotificationAsync(`${ID_PREFIX}-${offset}`);
    } catch {
      // Ett id som inte finns är inte ett fel.
    }
  }
}

/**
 * Räknar om och lägger ut hela fönstret. Enda vägen in — allt annat i filen
 * är hjälpare till den här.
 *
 * Avbokar **först**, alltid: en synk som bara skrivit över fem av sju id:n
 * hade annars lämnat de två sista kvar med gamla siffror. Att den börjar med
 * att tysta allt är också vad som gör den säker att anropa hur ofta som helst.
 *
 * Kastar aldrig. Den anropas från en AppState-lyssnare och från sparningen av
 * ett mål, och en notis som inte gick att schemalägga får inte välta något av
 * det.
 */
export async function syncDailyReminder(): Promise<void> {
  try {
    await cancelDailyReminder();

    // Frågar inte — se filens huvudkommentar. Den som sagt nej ska inte få
    // dialogen igen varje gång appen öppnas.
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return;

    const progress = await readProgress();
    if (!progress) return;

    await ensureAndroidChannel();

    const now = new Date();
    const remainingToday = progress.target - progress.today;

    for (let offset = 0; offset < WINDOW_DAYS; offset++) {
      const fireAt = new Date(now);
      fireAt.setDate(fireAt.getDate() + offset);
      // setHours efter setDate, så att klockslaget blir 20 lokalt också den
      // natt sommartiden växlar.
      fireAt.setHours(REMINDER_HOUR, 0, 0, 0);
      if (fireAt.getTime() <= now.getTime()) continue;

      // Bara dagens rest är mätt. För kommande dagar är resten hela målet,
      // och det är inte en gissning: en paus kan bara registreras av appen,
      // så har den inte varit öppen har ingenting hänt. Öppnas den ändå körs
      // den här om och siffrorna skrivs över.
      const remaining = offset === 0 ? remainingToday : progress.target;
      if (remaining <= 0) continue;

      await Notifications.scheduleNotificationAsync({
        identifier: `${ID_PREFIX}-${offset}`,
        content: {
          title: TITLE,
          body: `${formatRemaining(remaining)} left of today's goal.`,
        },
        // Kanalen hör till triggern sedan expo-notifications 0.29; i
        // `content` läses den inte, och notisen hamnade i reservkanalen.
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireAt,
          ...(Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : null),
        },
      });
    }
  } catch {
    // Tyst med flit. Se doc-kommentaren ovan.
  }
}

/**
 * Om appens notiser är avstängda. Frågar aldrig — läser bara. Används av
 * Global Pause-rummet, som säger till när en anmälan inte kan få sin
 * påminnelse: har man en gång sagt nej kan appen inte fråga igen, och utan
 * raden trodde man att man skulle bli påmind.
 */
export async function notificationsBlocked(): Promise<boolean> {
  try {
    return !(await Notifications.getPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

export async function cancelGlobalPauseReminder(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(GLOBAL_PAUSE_REMINDER_ID);
  } catch {
    // Ett id som inte finns är inte ett fel.
  }
}

/**
 * Lägger ut påminnelsen när någon trycker *I'll join*. Det är också där
 * frågan om behörighet ställs: man har just bett om att bli påmind. Kastar
 * aldrig — en anmälan ska stå sig även om notisen inte gick att lägga ut.
 * Är det mindre än 10 minuter kvar läggs ingen ut.
 */
export async function scheduleGlobalPauseReminder(startsAt: Date): Promise<void> {
  try {
    await cancelGlobalPauseReminder();
    await requestPermission();
    const permission = await Notifications.getPermissionsAsync();
    // Utfallet loggas, för en påminnelse som uteblev går annars inte att
    // skilja från en som aldrig lades ut.
    if (!permission.granted) { track('global_pause_reminder', { outcome: 'no_permission' }); return; }

    const fireAt = new Date(startsAt.getTime() - GLOBAL_PAUSE_REMINDER_LEAD_MS);
    if (fireAt.getTime() <= Date.now()) { track('global_pause_reminder', { outcome: 'too_late' }); return; }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(GLOBAL_PAUSE_CHANNEL_ID, {
        name: `${GLOBAL_PAUSE_NAME} reminder`,
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: null,
      });
    }
    await Notifications.scheduleNotificationAsync({
      identifier: GLOBAL_PAUSE_REMINDER_ID,
      content: {
        title: `${GLOBAL_PAUSE_NAME} in 10 minutes`,
        body: 'The room is open.',
        data: { type: GLOBAL_PAUSE_TYPE },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: fireAt,
        ...(Platform.OS === 'android' ? { channelId: GLOBAL_PAUSE_CHANNEL_ID } : null),
      },
    });
    track('global_pause_reminder', { outcome: 'scheduled', fire_at: fireAt.toISOString() });
  } catch (e) {
    // Tyst för användaren, se ovan.
    track('global_pause_reminder', { outcome: 'error', message: String(e).slice(0, 120) });
  }
}

/**
 * Begär behörighet om den inte redan är avgjord, och synkar sedan.
 *
 * Anropas från `setDailyGoal` i `lib/circles.ts` — alltså i det enda
 * ögonblick frågan är begriplig: användaren har just satt ett dagsmål, och
 * påminnelsen handlar om precis det talet. Att fråga i introduktionen hade
 * lagt ett femte steg i ett flöde som kortades från åtta till fyra, och att
 * fråga vid appstart hade frågat om ingenting för den som inte satt ett mål.
 */
export async function enableDailyReminder(): Promise<void> {
  await requestPermission();
  await syncDailyReminder();
}

/**
 * Samma fråga för push, ställd i de ögonblick en push-notis blir begriplig —
 * när man just fått de personer den skulle handla om:
 *
 * - **Skapar eller går med i en krets** ([app/circle-create.tsx](../app/circle-create.tsx),
 *   [app/(tabs)/circle.tsx](<../app/(tabs)/circle.tsx>)s `handleAcceptInvite`)
 *   — kretsens dagsmål och chatten.
 * - **Ber om stöd** (`handlePublishStory` i
 *   [app/(tabs)/friends.tsx](<../app/(tabs)/friends.tsx>) och
 *   [app/support-story-create.tsx](../app/support-story-create.tsx)) — man
 *   vill veta när svaret kommer.
 * - **Lägger till eller accepterar en vän** ([app/add-friend.tsx](../app/add-friend.tsx),
 *   `acceptRequest` i friends.tsx) — vänners stödförfrågningar. Utan den
 *   frågan hade den som aldrig själv bett om stöd eller gått med i en krets
 *   aldrig blivit tillfrågad, och frågorna hade inte nått fram.
 *
 * Det är kretsens motsvarighet till målsparningen, och den behövs separat:
 * de här notiserna handlar om ANDRA, så en användare som aldrig satt ett
 * eget dagsmål hade annars aldrig fått frågan.
 *
 * Registrerar token direkt efteråt, så att den som säger ja börjar kunna ta
 * emot utan att först behöva starta om appen.
 *
 * Slår upp användaren själv i stället för att ta emot ett id: inte alla
 * anropare har en `user` till hands, och att tvinga dem att importera
 * AuthContext för ett id de inte annars använder vore att låta den här
 * funktionens signatur bestämma hur en skärm ser ut.
 */
export async function enablePushNotifications(): Promise<void> {
  await requestPermission();
  try {
    const { data } = await supabase.auth.getUser();
    if (data.user?.id) await registerPushToken(data.user.id);
  } catch {
    // Ingen session: nästa appstart registrerar i stället.
  }
}

/**
 * Begär behörighet om den inte redan är avgjord.
 *
 * `canAskAgain` är spärren: har användaren sagt nej en gång ska appen inte
 * fortsätta be. Systemdialogen visas ändå bara en gång, men ett anrop som
 * vet det är lättare att läsa än ett som förlitar sig på det.
 */
async function requestPermission(): Promise<void> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted && current.canAskAgain) {
      await Notifications.requestPermissionsAsync();
    }
  } catch {
    // Faller frågan gör anroparna ingenting — båda läser statusen själva.
  }
}
