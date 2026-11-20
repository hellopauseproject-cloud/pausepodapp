import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { router, Stack, useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { AppThemeProvider, usePalette, useTheme } from '../contexts/ThemeContext';
import { BLEProvider, useBLEControl } from '../context/BLEContext';
import { SessionProvider, useSession } from '../context/SessionContext';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { initAnalytics, track } from '../lib/analytics';
import { isIntroDeferred } from '../lib/introPrefs';
import { normalizePairCode, setPendingPairCode, takePendingPairCode } from '../lib/tagPairing';
import {
  CIRCLE_CHAT_TYPE, CIRCLE_GOAL_TYPE, GLOBAL_PAUSE_TYPE, PAUSE_INVITE_TYPE, SUPPORT_RECEIVED_TYPE, SUPPORT_REQUEST_TYPE,
  cancelDailyReminder, initNotifications,
  registerPushToken, syncDailyReminder,
} from '../lib/notifications';
import { supabase } from '../lib/supabase';
import { reportGlobalPause } from '../lib/globalPause';
import { closePauseInvites, finishPauseInvite } from '../lib/pauseInvites';
import { clearStalePausingFlag, setPausingFlag } from '../lib/pausingFlag';
import { markNightEnded, nextMidnight } from '../lib/homeMode';
import { saveSleepSession } from '../lib/sleep';
import { clearSessionCheckpoint, findCategoryById, loadSessionCheckpoint, logPause } from './pauseLogger';

// Hur färskt ett notistryck måste vara för att få styra vart appen landar vid
// en kallstart. `getLastNotificationResponseAsync` minns det senaste trycket
// hur länge som helst, så utan en gräns hade ett enda tryck skickat appen till
// kretsens chatt vid varje start därefter. En minut räcker för den
// långsammaste kallstarten och är kort nog att aldrig gälla av misstag.
const COLD_START_TAP_MAX_MS = 60_000;

export const unstable_settings = {
  anchor: '(tabs)',
};

function InnerLayout() {
  // Navigationstemat och statusraden följer appens eget läge, inte
  // telefonens: väljer man ljust i inställningarna medan systemet står mörkt
  // ska ramen runt skärmarna byta med resten.
  const { mode } = useTheme();
  const Palette = usePalette();
  const { connectToPausePod } = useBLEControl();
  const { state: sessionState, dispatch: sessionDispatch } = useSession();
  const { user, loading, onboardingCompleted } = useAuth();

  // Introduktionen kan vara uppskjuten i stället för körd — se `deferIntro` i
  // [lib/introPrefs.ts](../lib/introPrefs.ts) för varför det krävs en egen
  // flagga och inte bara `onboarding_completed`. `null` betyder "inte läst
  // ännu" och har samma roll som serverflaggans `null`: grinden nedan väntar
  // på båda, annars hinner den skicka till /intro innan svaret kommit.
  //
  // Läsningen hänger på enheten och inte på användaren, precis som nyckeln
  // gör, så den körs en gång per appstart.
  const [introDeferred, setIntroDeferred] = useState<boolean | null>(null);
  useEffect(() => {
    isIntroDeferred().then(setIntroDeferred);
  }, []);

  // `app/auth/callback.tsx` är mitt uppe i att växla en OAuth-kod mot en
  // session. Under de hundradelarna finns ingen användare ännu, och grinden
  // nedan skulle annars läsa det som "utloggad" och kasta ut skärmen till
  // inloggningen medan inloggningen pågår.
  const segments = useSegments();
  const onAuthCallback = segments[0] === 'auth' && segments[1] === 'callback';
  // En QR-kod från lådan (`pauseapp://pair?code=…`) som öppnade appen.
  // Grinden nedan byter rutt till flikarna vid start, så koden plockas upp
  // här och läggs tillbaka ovanpå flikarna — se app/pair.tsx.
  const globalParams = useGlobalSearchParams<{ code?: string }>();
  const linkPairCodeRef = useRef<string | null>(null);
  linkPairCodeRef.current =
    segments[0] === 'pair' && typeof globalParams.code === 'string'
      ? normalizePairCode(globalParams.code) || null
      : null;

  // Skärmvisningarna räknas härifrån och ingen annanstans. Varje skärm hade
  // kunnat ropa själv, men då saknar varje ny skärm sin rad tills någon
  // kommer ihåg att lägga till anropet — en rutt-lyssnare täcker dem alla,
  // också de som läggs till efter den här raden.
  const pathname = usePathname();

  const hasRoutedRef = useRef(false);
  const recoveryDoneRef = useRef(false);
  const pausingFlagResetRef = useRef(false);
  const coldStartNotificationRef = useRef(false);
  // Ett notistryck som kom innan grinden routat. Vid kallstart hinner trycket
  // navigera först, och grindens `replace('/(tabs)')` tog sedan användaren
  // tillbaka till Hem. Trycket väntar därför här och spelas upp av grinden.
  type NotificationTap = { type?: string; circle_id?: string; shared_id?: string } | null;
  const pendingTapRef = useRef<NotificationTap>(null);
  const openFromNotificationRef = useRef<((data: NotificationTap) => void) | null>(null);
  const summaryHandledSeqRef = useRef<string | null>(null);
  useEffect(() => {
    connectToPausePod();
  }, []);

  // ── Händelseloggen ────────────────────────────────────────────────────────
  // Kön startas före allt annat så att även det som händer under de första
  // hundradelarna hamnar i den. Raderna saknar user_id tills AuthContext
  // hunnit avgöra sessionen, och fylls i av setAnalyticsUser efteråt — se
  // lib/analytics.ts.
  useEffect(() => {
    initAnalytics();
    track('app_opened');

    const sub = AppState.addEventListener('change', next => {
      // Bara de två ytterlägena. 'inactive' på iOS är varje halvt
      // nedsvepande gest och varje inkommande samtal, och skulle fördubbla
      // raderna utan att betyda att någon lämnade appen.
      if (next === 'active') track('app_foregrounded');
      else if (next === 'background') track('app_backgrounded');
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!pathname) return;
    track('screen_view', { screen: pathname });
  }, [pathname]);

  // ── Dagspåminnelsen ───────────────────────────────────────────────────────
  // Den ena av appens två notiser, och den **lokala** av dem — den andra är
  // kretsens dagsmål och ligger i effekterna strax nedanför. Här låg förr en
  // AppState-lyssnare som la om en dagsnotis; den revs med resten av
  // notiskedjan, och den här är inte samma sak: den gamla hörde till en
  // uppsättning med push-token, trigger och edge-funktion, den här rör bara
  // det som redan ligger på telefonen.
  //
  // Tre tillfällen att räkna om härifrån (det fjärde är sparningen av ett
  // dagsmål, och det sitter i `setDailyGoal` i lib/circles.ts):
  //
  // - **Vid start.** AppState-lyssnaren fyrar inte på monteringen, och appen
  //   kan ha legat död över ett dygnsskifte.
  // - **Vid 'active'.** Dygnet kan ha vänt medan appen låg i bakgrunden, och
  //   då är dagens rest hela målet igen.
  // - **Vid 'background'.** Det är här pauserna har hunnit landa. 'inactive'
  //   hoppas över av samma skäl som i händelseloggen ovan.
  //
  // Den globala `phase === 'ended'`-effekten längre ner vore den uppenbara
  // fjärde platsen — den ser slutet på varje paus — men raden i
  // `pause_sessions` är inte skriven än i det ögonblicket (pausing.tsx
  // skriver den), så en synk där hade räknat med
  // en paus som inte syns i RPC:n. 'background' kommer efter den, och är
  // dessutom det enda som behöver stämma: notisen går klockan 20.
  //
  // Behörighet begärs inte här, bara läses. Den frågan hör till det ögonblick
  // ett dagsmål sparas — se `enableDailyReminder` i lib/notifications.ts.
  useEffect(() => {
    initNotifications();
  }, []);

  useEffect(() => {
    // Utloggad — och det gäller både den som loggat ut och de första
    // hundradelarna innan AuthContext avgjort sessionen. Fönstret ligger kvar
    // i systemet tills något tar bort det, så utan den här grenen hade en
    // utloggad telefon fortsatt räkna ner mot ett mål som inte längre är
    // någons. Att den också körs vid start är ofarligt: synken nedan börjar
    // ändå med att avboka allt.
    if (!user?.id) {
      cancelDailyReminder().catch(() => {});
      return;
    }

    syncDailyReminder();

    const sub = AppState.addEventListener('change', next => {
      if (next === 'active' || next === 'background') syncDailyReminder();
    });
    return () => sub.remove();
  }, [user?.id]);

  // ── Kretsens dagsmålsnotis ────────────────────────────────────────────────
  // Push, till skillnad från påminnelsen ovan: händelsen inträffar på någon
  // annans telefon. Allt beslutsfattande ligger i SQL
  // (supabase/circle_goal_notify.sql); appen bidrar med en token att skicka
  // till och med vad ett tryck ska leda till.
  //
  // Token skrivs vid varje appstart och inte en gång: OS:et kan rotera den,
  // och `tz_offset_minutes` — som bär nattfönstret 08–21 — ska följa
  // telefonen och inte sessionen, eftersom den som reser byter tidszon utan
  // att logga om. `registerPushToken` frågar aldrig om behörighet; det gör
  // `enablePushNotifications` när någon går med i en krets, ber om stöd
  // eller får en vän.
  useEffect(() => {
    if (!user?.id) return;
    registerPushToken(user.id);
  }, [user?.id]);

  // Ett tryck ska landa i kretsens chatt, för det är vad notisen ber om ("Say
  // well done in the chat") och det enda stället i appen man kan säga något
  // till en kretsmedlem. Namnet skickas inte med — circle-chat.tsx hämtar det
  // själv när parametern saknas, så notisen behöver inte bära en sträng som
  // kan ha hunnit ändras.
  //
  // Chattnotisen landar på samma ställe av uppenbara skäl. De två
  // stödnotiserna landar i Friends, där både story-raden (en förfrågan) och
  // kuvertet och luren (ett svar) står — svaret öppnas inte direkt, för
  // öppningsritualen är en del av svaret. Pausinbjudan landar där också:
  // kortet *Join* står i Friends, och har värden hunnit sluta sedan notisen
  // kom är kortet borta — dörren stängs i SQL, inte i notisen.
  //
  // Här låg förr en lyssnare som tog varje notistryck till `/pause`, och den
  // revs med notiserna. Den här är smalare med flit: bara de egna typerna, och
  // bara när en användare finns. Grinden längre ner äger routningen vid start
  // och ska inte behöva slåss med en navigering härifrån.
  useEffect(() => {
    if (!user?.id) return;

    const openFromNotification = (data: NotificationTap) => {
      switch (data?.type) {
        case CIRCLE_GOAL_TYPE:
        case CIRCLE_CHAT_TYPE:
          router.push({
            pathname: '/circle-chat',
            params: { circleId: data.circle_id ?? '' },
          } as never);
          return;
        case SUPPORT_REQUEST_TYPE:
          router.navigate('/(tabs)/friends' as never);
          return;
        // Rakt till kuvertet: det är öppningen som är ritualen, och den
        // sker där — inte på låsskärmen.
        case SUPPORT_RECEIVED_TYPE:
          router.navigate('/(tabs)/friends' as never);
          router.push('/support-arrived' as never);
          return;
        case GLOBAL_PAUSE_TYPE:
          router.push('/global-pause' as never);
          return;
        // Pausens id följer med, så att Friends kan säga att värden hunnit
        // sluta i stället för att bara inte visa något kort.
        case PAUSE_INVITE_TYPE:
          router.navigate({
            pathname: '/(tabs)/friends',
            params: { pauseInvite: data.shared_id ?? '' },
          } as never);
          return;
      }
    };

    openFromNotificationRef.current = openFromNotification;
    const handleTap = (data: NotificationTap) => {
      if (hasRoutedRef.current) openFromNotification(data);
      else pendingTapRef.current = data;
    };

    const sub = Notifications.addNotificationResponseReceivedListener(resp => {
      handleTap(resp.notification.request.content.data as never);
    });

    // Kallstart: lyssnaren ovan fyrar bara för tryck som sker medan den är
    // uppsatt, så ett tryck som STARTADE appen måste hämtas separat.
    // Färskhetsfönstret är nödvändigt — `getLastNotificationResponseAsync`
    // svarar med det senaste trycket oavsett hur gammalt det är, och utan
    // gränsen hade appen hoppat till chatten vid varje start i evighet efter
    // ett enda tryck.
    if (!coldStartNotificationRef.current) {
      coldStartNotificationRef.current = true;
      Notifications.getLastNotificationResponseAsync()
        .then(resp => {
          if (!resp) return;
          if (Date.now() - resp.notification.date > COLD_START_TAP_MAX_MS) return;
          handleTap(resp.notification.request.content.data as never);
        })
        .catch(() => {});
    }

    return () => sub.remove();
  }, [user?.id]);

  // Appen rör aldrig skärmens ljusstyrka. Här låg förr ett skyddsnät som
  // återställde placeinbox-dimningen; både den och dimningen är borta, och
  // ljusstyrkan är helt och hållet systemets inställning.
  //
  // Här låg också två saker som försvann med lådflödet: en tömning av
  // `lib/sessionOutbox.ts` vid varje appstart, och en routning som hoppade
  // rakt in i pausskärmen när lådan hörde av sig med en pågående session
  // (`state:` → RESTORE). Lådan laddar upp sina egna pauser över WiFi sedan
  // firmware v8.5, så det finns ingen kö att tömma och ingen paus att hoppa
  // in i — en app som gjorde det skulle lägga sig i en paus den inte äger.

  // Sessionen är slut — oavsett vilken skärm som råkar vara monterad.
  // Pausens rad i pause_sessions skrivs i pausing.tsx (se där), men reset +
  // navigering till summeringen hör hemma globalt: skärmen kan ha hunnit
  // avmonteras, och krasch-återställningen nedan avslutar pauser utan att
  // någon pausing.tsx finns.
  useEffect(() => {
    const { phase, lastEnded } = sessionState;
    if (phase !== 'ended' || !lastEnded) return;
    if (summaryHandledSeqRef.current === lastEnded.seq) return;
    summaryHandledSeqRef.current = lastEnded.seq;

    // En natt är ingen paus: ingen sammanfattning, inget pause_completed i
    // tratten (lib/sleep.ts loggar sitt eget). Den slutar på Hem i dagläge —
    // det är morgon, och natten själv står i statistiken.
    if (sessionState.pauseType === 'sleep' || lastEnded.night) {
      sessionDispatch({ type: 'RESET' });
      markNightEnded();
      router.replace('/(tabs)' as never);
      return;
    }

    const duration = String(Math.round(lastEnded.durationMs / 1000));
    const category = sessionState.category ?? '';
    const sharedWithName = sessionState.sharedWithName ?? '';
    const sharedSessionId = sessionState.sharedSessionId ?? '';

    // Tratten i analytics.pause_funnel jämför "startade" med "slutförde".
    // Fältet `with_pod` är borta: appens pauser är alltid telefonens egna,
    // och lådans pauser passerar aldrig appen (de skrivs av `box-session`).
    track('pause_completed', {
      duration_seconds: Number(duration),
      completed: lastEnded.completed,
      category: sessionState.category ?? null,
      shared: !!sessionState.sharedSessionId,
    });

    sessionDispatch({ type: 'RESET' });

    router.replace({
      pathname: '/pausesummary',
      params: { duration, category, sharedWithName, sharedSessionId },
    } as never);
  }, [sessionState.phase, sessionState.lastEnded, sessionState.category, sessionState.sharedWithName, sessionState.sharedSessionId, sessionState.pauseType, sessionDispatch]);

  // Här låg den globala lyft-detekteringen: en DeviceMotion-prenumeration
  // som skickade `phone_up` till lådan när telefonen rest sig stabilt under
  // en pågående lådsession. Den är borta med lådflödet — lådan avgör själv
  // att telefonen lyfts (taggen försvinner, `TAG_GONE_MS` i .ino) och
  // behöver ingen hjälp av appen. Den lådlösa pausens egen frysning vid
  // lyft sitter kvar där den hör hemma, i app/pausing.tsx.

  // ── Fastnad is_pausing-flagga ─────────────────────────────────────────────
  //
  // Tvångsstängs appen mitt i en paus körs aldrig cleanup:en i pausing.tsx, och
  // `profiles.is_pausing` stod kvar på `true` — vännen visades som pausande i
  // Community i all evighet. (Det fanns förr ett andra skäl: en flagga som
  // stod kvar på `true` gjorde övergången false → true omöjlig och tystade
  // därmed vän-notisen. Notiserna är borta, så det skälet är det också —
  // den felvisade statusen i Community räcker gott.)
  //
  // Städningen fanns bara i återställningen nedan, och räckte inte på tre sätt:
  // den krävde en checkpoint (som bara pausskärmen skriver), den låg efter
  // `if (duration < 5) return` så en kort krasch
  // hoppade över den, och den gjorde ingenting för en flagga som fastnat utan
  // att någon session behövde återställas.
  //
  // Nollningen ligger därför här, villkorslöst och en gång per appstart: vid
  // start pausar man inte, och det är sant oavsett hur appen dog. Alla
  // skrivningar av flaggan går ändå genom den delade kön i
  // lib/pausingFlag.ts, så en nollning och en paus som startas i samma
  // andetag kan inte landa i omvänd ordning.
  //
  // En känd lucka, som kom med att lådans pauser numera också syns som
  // "pausing now" (flaggan sätts då av `record_box_session_start()` i
  // databasen, inte av appen): startar appen på samma konto medan en
  // lådpaus pågår nollas flaggan här, och vännen slutar se pausen. I
  // praktiken ligger telefonen i lådan under en lådpaus — att öppna appen
  // kräver att man lyfter den, vilket avslutar pausen — så det här gäller
  // bara en bakgrundsstart som OS:et gör av sig själv. Ska det täppas till
  // behöver nollningen fråga servern om det finns en öppen rad i
  // `box_session_starts`, och den tabellen har med flit inga grants.
  //
  // En känd följd, och den är avsiktlig: är samma konto inloggat på två
  // telefoner nollar en appstart på den ena flaggan som den andra satt.
  // Flaggan är en per användare, inte en per enhet, och det är den
  // begränsningen som visar sig.
  //
  // Här stod förr en andra följd — att en återupptagen lådpaus går false →
  // true igen och alltså kunde pinga vännerna en andra gång, med en strypning
  // i SQL (6 h, max 2/dygn) som skyddsnät. Både vän-notisen och strypningen
  // är droppade (supabase/notifications-teardown.sql), så övergången false →
  // true bär ingenting längre än "pausing now" i Friends. Dagspåminnelsen rör
  // inte den här flaggan.
  useEffect(() => {
    if (!user?.id || pausingFlagResetRef.current) return;
    pausingFlagResetRef.current = true;
    setPausingFlag(user.id, false);
  }, [user?.id]);

  // Samma nollning varje gång appen kommer fram, inte bara vid kallstart. iOS
  // låter en app ligga i bakgrunden i dagar, så en nollning som föll vid
  // starten (nät, token som inte hunnit förnyas) stod annars kvar till nästa
  // kallstart — en vän stod som pausande ett helt dygn så. Två villkor, och
  // båda behövs: `/pausing` är den lådlösa pausen, och reducerns fas är
  // lådans, som kan pågå medan appen står på en helt annan skärm.
  // `clearStalePausingFlag` skriver bara när flaggan inte redan bekräftats
  // `false`, så de flesta återkomster kostar ingenting.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const sessionPhaseRef = useRef(sessionState.phase);
  sessionPhaseRef.current = sessionState.phase;
  useEffect(() => {
    if (!user?.id) return;
    const uid = user.id;
    const sub = AppState.addEventListener('change', next => {
      if (next !== 'active') return;
      if (pathnameRef.current === '/pausing' || sessionPhaseRef.current !== 'idle') return;
      clearStalePausingFlag(uid);
    });
    return () => sub.remove();
  }, [user?.id]);

  // Recover any session that was interrupted by the app being killed
  useEffect(() => {
    if (!user?.id || recoveryDoneRef.current) return;
    recoveryDoneRef.current = true;

    (async () => {
      const checkpoint = await loadSessionCheckpoint();
      if (!checkpoint || checkpoint.userId !== user.id) return;

      await clearSessionCheckpoint();

      // En natt återställs för sig (lib/sleep.ts) — som en sömnrad, utan
      // krets och utan pauslogg. Till skillnad från en paus slutar den inte
      // nödvändigtvis vid sista pulsen: lämnades appen med telefonen nedåt
      // och still (`runningAtLeave`) sov användaren vidare efter den, och
      // iOS dödar gärna en app i bakgrunden under natten. Då räknas natten
      // fram till nu, alltså tills appen öppnades igen — samma gräns som en
      // natt som inte dödats får, eftersom inte heller den ser lyftet förrän
      // appen är framme. Taket i `saveSleepSession` tar resten.
      if (checkpoint.pauseType === 'sleep') {
        const lastAlive = new Date(checkpoint.lastAliveAt ?? checkpoint.startedAt).getTime();
        const end = checkpoint.runningAtLeave ? Date.now() : lastAlive;
        const sleptMs = (checkpoint.elapsedMs ?? 0) + (end - lastAlive);
        const firstRest = checkpoint.firstRestAt ? new Date(checkpoint.firstRestAt).getTime() : end - sleptMs;
        track('sleep_recovered', { running_at_leave: !!checkpoint.runningAtLeave });
        await saveSleepSession({
          userId: user.id,
          startedAt: new Date(firstRest),
          endedAt: new Date(end),
          durationSeconds: sleptMs / 1000,
          wakeCount: checkpoint.wakeCount ?? 0,
          awakeSeconds: (checkpoint.awakeMs ?? 0) / 1000,
        });
        return;
      }

      // Slutar när appen senast bevisligen levde, inte nu. Appen kan ha legat
      // död i timmar innan den öppnades igen, och den tiden pausade ingen —
      // pulsen i pausing.tsx är det enda vi faktiskt sett. Pausen räknas som
      // genomförd, bara kortare. Längden läses ur pulsen i stället för att
      // räknas fram ur tidsstämplarna, eftersom klockan kan ha stått frusen
      // medan telefonen låg uppåtvänd. Saknas fälten är checkpointen från en
      // äldre version: då vet vi ingenting om längden och låter den falla
      // bort på minimigränsen nedan i stället för att hitta på en.
      let endedAt = checkpoint.lastAliveAt ? new Date(checkpoint.lastAliveAt) : new Date(checkpoint.startedAt);
      let duration = Math.max(0, Math.floor((checkpoint.elapsedMs ?? 0) / 1000));

      // Midnatt (lib/homeMode.ts): en dagpaus slutar en sekund före den. Blev
      // den en natt (`nightStartAt`) sparas natten för sig, räknad som en
      // natt räknas ovan — till nu om telefonen låg nedåt och still när appen
      // lämnades, annars till sista pulsen. Passerade den midnatt utan att
      // hinna bli en natt kapas den där, och tiden efter räknas inte alls.
      const midnight = nextMidnight(new Date(checkpoint.startedAt).getTime());
      if (checkpoint.nightStartAt) {
        const nightStart = new Date(checkpoint.nightStartAt).getTime();
        const lastAlive = endedAt.getTime();
        const nightEnd = checkpoint.runningAtLeave ? Date.now() : lastAlive;
        track('pause_night_recovered', { running_at_leave: !!checkpoint.runningAtLeave });
        await saveSleepSession({
          userId: user.id,
          startedAt: new Date(nightStart),
          endedAt: new Date(nightEnd),
          durationSeconds: (nightEnd - nightStart) / 1000,
          wakeCount: 0,
          awakeSeconds: 0,
        });
        duration = Math.max(0, Math.floor((checkpoint.dayMs ?? 0) / 1000));
        endedAt = new Date(midnight - 1000);
      } else if (endedAt.getTime() >= midnight) {
        duration = Math.max(0, duration - Math.floor((endedAt.getTime() - midnight) / 1000));
        endedAt = new Date(midnight - 1000);
      }
      const startedAt = new Date(endedAt.getTime() - duration * 1000);

      // Står annars kvar som *pausing* i rummet tills den globala pausen slutar.
      reportGlobalPause('finished');

      if (duration < 5) {
        // Räknas som ett bortfall och inte som en paus: raden skrivs inte,
        // så den syns aldrig i pause_sessions. Utan händelsen vore en
        // kraschad kort paus osynlig på alla ytor.
        track('pause_recovery_discarded', { duration_seconds: duration });
        // Värden stänger dörren, gästen kliver ur — båda utan längd, samma
        // som när en paus övergavs. Utan gästens gren stod hen kvar som
        // "still pausing" hos de andra för alltid.
        if (checkpoint.sharedSessionId && checkpoint.sharedRole === 'host') {
          await closePauseInvites(checkpoint.sharedSessionId, null);
        } else if (checkpoint.sharedSessionId) {
          await finishPauseInvite(checkpoint.sharedSessionId, null);
        }
        return;
      }

      track('pause_recovered', {
        duration_seconds: duration,
        shared: !!checkpoint.sharedSessionId,
      });

      await logPause(duration, 'session', checkpoint.category);

      let intentionLabel: string | null = null;
      if (checkpoint.category) {
        const cat = await findCategoryById(checkpoint.category);
        intentionLabel = cat?.label ?? null;
      }

      // En delad paus skrivs som en vanlig, med sitt gemensamma id — samma
      // som pausskärmen gör (supabase/pause_invites.sql). Inbjudningarna
      // stängs efteråt: värdens app är det enda som kan säga att dörren ska
      // stängas, och `expires_at` hade annars fått göra det.
      await supabase.from('pause_sessions').insert({
        user_id: user.id,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        duration_seconds: duration,
        intention: intentionLabel,
        is_shared: !!checkpoint.sharedSessionId,
        shared_session_id: checkpoint.sharedSessionId ?? null,
        with_pod: false,
        completed: true,
      });
      if (checkpoint.sharedSessionId) {
        // Utan roll (en checkpoint från före pause_invites) blir anropet en
        // tyst no-op: det finns ingen inbjudningsrad med det id:t.
        if (checkpoint.sharedRole === 'host') await closePauseInvites(checkpoint.sharedSessionId, duration);
        else await finishPauseInvite(checkpoint.sharedSessionId, duration);
      }

      // Ingen is_pausing-skrivning här: effekten ovan nollar flaggan vid varje
      // appstart, alltså även när ingen checkpoint finns och även när den här
      // återställningen faller bort på minimigränsen.
    })();
  }, [user?.id]);

  useEffect(() => {
    if (loading) return;

    if (!user) {
      hasRoutedRef.current = false;
      // Callback-skärmen äger sin egen väg vidare, och skickar själv till
      // inloggningen om växlingen faller.
      if (!onAuthCallback) router.replace('/auth/login' as never);
      return;
    }

    if (onboardingCompleted === null || introDeferred === null) return;

    if (hasRoutedRef.current) return;
    hasRoutedRef.current = true;

    // Introduktionen ligger i app/intro.tsx och ersatte de gamla
    // onboarding-flow/-complete-skärmarna. Flaggan som avgör är fortfarande
    // `profiles.onboarding_completed`, och den sätts först i sista steget.
    //
    // Uppskjutet släpps förbi likaväl som färdigt, men de två betyder olika
    // saker och hålls därför isär: serverflaggan säger att kvittot skrivits,
    // `introDeferred` att användaren bett att få göra det senare. Hem visar
    // en väg tillbaka så länge bara den andra är satt.
    const pendingTap = pendingTapRef.current;
    pendingTapRef.current = null;
    const linkPairCode = linkPairCodeRef.current;
    if (!onboardingCompleted && !introDeferred) {
      // Introduktionen går före; ett tryck därifrån släpps. En lådkod parkeras
      // i stället — den gäller i fem minuter och kan matas in i Settings.
      if (linkPairCode) setPendingPairCode(linkPairCode);
      router.replace('/intro' as never);
    } else {
      router.replace('/(tabs)' as never);
      // Ett tick senare, så att flikarna hunnit monteras innan trycket
      // navigerar vidare in i dem.
      if (pendingTap) setTimeout(() => openFromNotificationRef.current?.(pendingTap), 0);
      // Lådans kod: från länken som startade appen, eller parkerad av
      // app/pair.tsx medan ingen var inloggad.
      takePendingPairCode().then(saved => {
        const code = linkPairCode ?? saved;
        if (code) setTimeout(() => router.push({ pathname: '/pair', params: { code } } as never), 0);
      });
    }
  }, [loading, user, onboardingCompleted, introDeferred, onAuthCallback]);

  const showOverlay =
    loading || (!!user && (onboardingCompleted === null || introDeferred === null));

  /**
   * React Navigations egna teman bär `background: rgb(242,242,242)` respektive
   * `rgb(1,1,1)` — varken appens varma papper eller dess plommon. Den färgen
   * ligger under varje stack-skärm och syns genom varje genomskinlig lucka en
   * skärm lämnar.
   *
   * Så länge varje skärm målade sin egen opaka `Palette.bg` var det en
   * teoretisk risk. Sedan flikarnas och valskärmens `container` blev
   * `'transparent'` (botten ritas av `<ScreenBackground>`) blev den en synlig
   * ljusgrå kant så fort någonting inte täckte ända ut. Navigatorn ska känna
   * appens botten, så den får den.
   *
   * Basens `bg` och inte rummets med flit: det här är lagret *under* alla
   * skärmar, och rummen målar sin egen ovanpå.
   */
  const navTheme = useMemo(() => {
    const base = mode === 'dark' ? DarkTheme : DefaultTheme;
    return { ...base, colors: { ...base.colors, background: Palette.bg } };
  }, [mode, Palette.bg]);

  return (
    <ThemeProvider value={navTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="auth" options={{ headerShown: false }} />
        <Stack.Screen name="intro" options={{ headerShown: false }} />
        {/* Stödsvaren öppnas ur ett kuvert (support-arrived) och brevet
            tonar över i visningsskärmen — därför fade på alla fyra. */}
        <Stack.Screen name="support-arrived" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="voice" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="video" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        <Stack.Screen name="pause" options={{ headerShown: false }} />
        <Stack.Screen name="pausesummary" options={{ headerShown: false }} />
        <Stack.Screen name="pausing" options={{ headerShown: false }} />
        <Stack.Screen name="stats" options={{ headerShown: false }} />
        <Stack.Screen name="profile" options={{ headerShown: false }} />
        <Stack.Screen name="add-friend" options={{ headerShown: false }} />
        <Stack.Screen name="support-history" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ headerShown: false }} />
        <Stack.Screen name="pod" options={{ headerShown: false }} />
        <Stack.Screen name="pod-network" options={{ headerShown: false }} />
        <Stack.Screen name="global-pause" options={{ headerShown: false }} />
        <Stack.Screen name="friend-wrapped" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="my-wrapped" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="circle-wrapped" options={{ headerShown: false, animation: 'fade' }} />
        {/* Båda ritar sin egen rubrik och sin egen bakåtknapp — utan de här
            raderna lägger Stack en navigeringslist ovanför dem. */}
        <Stack.Screen name="circle-create" options={{ headerShown: false }} />
        <Stack.Screen name="circle-welcome" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="circle-invite" options={{ headerShown: false }} />
        <Stack.Screen name="circle-chat" options={{ headerShown: false }} />
        {/* support-story-create är pensionerad: dess två steg — vad och
            vilken sorts stöd — bor numera i lakanet bakom "+" i Community,
            tillsammans med punkterna från listan. Filen ligger kvar men
            ingenting leder dit. */}
        <Stack.Screen name="support-respond-text" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="support-respond-voice" options={{ headerShown: false }} />
        <Stack.Screen name="support-respond-video" options={{ headerShown: false }} />
        <Stack.Screen name="support-respond-photo" options={{ headerShown: false }} />
        <Stack.Screen name="support-view-text" options={{ headerShown: false }} />
        <Stack.Screen name="support-view-photo" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="text-message" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      {showOverlay && (
        <View
          style={{ position: 'absolute', inset: 0, backgroundColor: Palette.bg }}
          pointerEvents="none"
        />
      )}
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppThemeProvider>
        <AuthProvider>
          <BLEProvider>
            <SessionProvider>
              <InnerLayout />
            </SessionProvider>
          </BLEProvider>
        </AuthProvider>
      </AppThemeProvider>
    </GestureHandlerRootView>
  );
}
