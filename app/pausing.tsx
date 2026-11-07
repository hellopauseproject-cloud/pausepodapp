import { FontAwesome } from '@expo/vector-icons';
// `AudioPlayer` är bara en typ här — expo-audio re-exporterar den med
// `export type *`, så en vanlig värdeimport av den skulle inte hålla.
import { useAudioPlayer, type AudioPlayer } from 'expo-audio';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Stack, useLocalSearchParams } from 'expo-router';
import { DeviceMotion } from 'expo-sensors';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, BackHandler, StyleSheet, Text, View } from 'react-native';
import { HoldToStartButton } from '../components/hold-to-start-button';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { alpha, AppPalette } from '../constants/appTheme';
import { useSession } from '../context/SessionContext';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { track } from '../lib/analytics';
import { recordPauseInCircle } from '../lib/circles';
import { nextMidnight } from '../lib/homeMode';
import { reportGlobalPause } from '../lib/globalPause';
import { HOLD_TO_START_MS } from '../lib/pauseFlow';
import {
  closePauseInvites, finishPauseInvite, newSharedId, sendPauseInvites, takePauseInviteSelection,
} from '../lib/pauseInvites';
import { setPausingFlag } from '../lib/pausingFlag';
import { PauseType } from '../lib/sessionMachine';
import { saveSleepSession, SLEEP_AUTO_END_MS, SLEEP_MAX_SECONDS } from '../lib/sleep';
import { supabase } from '../lib/supabase';
import { isFaceDown } from '../lib/tilt';
import { hideNavBar, onNavBarShown, showNavBar } from '../lib/pauseNavBar';
import { clearSessionCheckpoint, findCategoryById, logPause, saveSessionCheckpoint } from './pauseLogger';

// Finish-knappens radie, delad med hållknappens fyllning så att den klipps
// i samma rundning som knappen (16 + 16 + textens ~24 ≈ 56).
const DONE_BTN_RADIUS = 28;

const RESPITE_SECONDS = 30;
const KEEP_AWAKE_TAG = 'pausing';
// Hur nära sanningen en tvångsstängd paus hamnar: pulsen är det enda som
// begränsar felet, och 10 s är omärkligt mot en paus som mäts i minuter.
const HEARTBEAT_MS = 10000;
// 100 och inte 200: stillhetsfönstret nedan ska hinna se svepet bort ur
// appen, och ett snabbt svep ryms annars mellan två avläsningar.
const MOTION_INTERVAL_MS = 100;
// Ett nytt läge måste hålla i sig innan klockan påverkas — annars flimrar
// den när telefonen läggs ner, stöts till eller glider på bordet.
const FACE_STABLE_MS = 600;
// Nedläggningen får ett kortare fönster: det är den som startar klockan och
// spelar ljudet, och 600 ms kändes som en fördröjning. En telefon som glider
// på bordet är fortfarande nedåtvänd, så flimret som fönstret skyddar mot är
// främst lyftets.
const FACE_DOWN_STABLE_MS = 300;

// ── Stillhet: vad ett bord har som en hand inte har ──
//
// Nedåtvänd är en vinkel, och en vinkel skiljer inte ett bord från en hand
// som håller telefonen skärmen nedåt ovanför ansiktet. Det var hålet: håll
// den så, byt app, och klockan gick medan man scrollade, eftersom sensorn
// tystnar i bakgrunden och lyftet aldrig kom. En telefon på ett bord står
// däremot nästan helt still, och en hand gör det aldrig — och svepet bort
// ur appen är en tydlig topp.
//
// Trösklarna är startvärden och ska kalibreras på riktiga telefoner (se
// loggraden `FaceDown:` och händelsen `pause_left_app`). Båda plattformarna
// rapporterar rotationRate i grader/s (expo-sensors räknar om), och
// `acceleration` i m/s² utan tyngdkraften.
const STILL_WINDOW_MS = 1000;
const STILL_MAX_ROTATION_DEG_S = 1.5;
const STILL_MAX_ACCEL_M_S2 = 0.25;
// Färre avläsningar än så i fönstret går inte att döma på — då räknas
// telefonen som rörd. Ett ärligt lås kommer aldrig så tätt inpå en återkomst.
const STILL_MIN_SAMPLES = 4;

// Hur länge efter att appen själv gömt eller visat navigeringsfältet en
// "fältet syns"-händelse anses vara appens egen och inte en hands.
const NAV_BAR_SETTLE_MS = 1000;

type MotionSample = { t: number; rot: number | null; acc: number | null };

const magnitude3 = (a: number, b: number, c: number) => Math.sqrt(a * a + b * b + c * c);

/** Har telefonen stått still under det senaste fönstret? Saknas en sensor
 *  (ingen gyro) döms på den andra; saknas båda räknas den som still, för
 *  då är grinden ingenting appen kan hålla och det ärliga flödet ska inte
 *  betala för det. */
function assessStillness(samples: MotionSample[], now: number) {
  const recent = samples.filter(s => now - s.t <= STILL_WINDOW_MS);
  let maxRot: number | null = null;
  let maxAcc: number | null = null;
  for (const s of recent) {
    if (s.rot !== null) maxRot = Math.max(maxRot ?? 0, s.rot);
    if (s.acc !== null) maxAcc = Math.max(maxAcc ?? 0, s.acc);
  }
  const sensorless = recent.length > 0 && maxRot === null && maxAcc === null;
  const still = sensorless || (
    recent.length >= STILL_MIN_SAMPLES &&
    (maxRot === null || maxRot <= STILL_MAX_ROTATION_DEG_S) &&
    (maxAcc === null || maxAcc <= STILL_MAX_ACCEL_M_S2)
  );
  return { still, maxRot, maxAcc, samples: recent.length };
}

// ── Har telefonen lagt sig, efter att appen lämnats? ──
//
// Kortare fönster än STILL_WINDOW_MS, för sensorn hinner bara leverera
// 0,3–1 s efter att appen lämnats. Bara rotationen räknas: accelerometern
// brusar på en del Android-telefoner över STILL_MAX_ACCEL_M_S2 även på ett
// bord (0,3–0,6 m/s² vid 0,02°/s), medan gyrot skiljer bord från hand med
// marginal (≈0,02 mot 6–55°/s). Accelerationen används bara där gyro saknas.
const SETTLE_WINDOW_MS = 400;
const SETTLE_MIN_SAMPLES = 3;

function assessSettled(samples: MotionSample[], now: number) {
  const recent = samples.filter(s => now - s.t <= SETTLE_WINDOW_MS);
  let maxRot: number | null = null;
  let maxAcc: number | null = null;
  for (const s of recent) {
    if (s.rot !== null) maxRot = Math.max(maxRot ?? 0, s.rot);
    if (s.acc !== null) maxAcc = Math.max(maxAcc ?? 0, s.acc);
  }
  const settled = recent.length >= SETTLE_MIN_SAMPLES && (
    maxRot !== null ? maxRot <= STILL_MAX_ROTATION_DEG_S
    : maxAcc !== null ? maxAcc <= STILL_MAX_ACCEL_M_S2
    : true
  );
  return { settled, maxRot, samples: recent.length };
}

// ── Hur länge klockan får ha stått frusen och ändå starta i bakgrunden ──
//
// Omstarten ovan är till för ett kort avbrott — telefonen stöttes till på
// bordet, flyttades, låstes i samma rörelse som den lades ner. Utan tak
// startade den också timmar senare: en paus som frös 21:56 när telefonen
// lyftes gick igen 01:04, när iOS väckte appen en stund i bakgrunden och
// telefonen låg på nattduksbordet. Natten räknades då som paus. Har klockan
// stått frusen längre än så här startar den bara om appen öppnas och
// telefonen läggs ner igen. Gäller inte natten: där är ett uppvaknande vid
// tre och en telefon som läggs tillbaka precis vad omstarten finns för.
const BACKGROUND_RESTART_MAX_FROZEN_MS = 10 * 60 * 1000;

function generateLocalSeq(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Hör till **nattrummet** — det enda rummet som är mörkt i båda lägena, se
 * NIGHT i [constants/appTheme.ts](../constants/appTheme.ts). Skalet är
 * identiskt med de andra rummens: en komponent kan inte läsa sin egen
 * provider, och en bakgrund i skalet täcker varje gren skärmen returnerar.
 *
 * Statusraden tvingas ljus av samma skäl: i ljusläget sätter roten den mörk,
 * och mörk text på nattbotten syns inte. expo-status-bar staplar, så roten
 * gäller igen när skärmen lämnas.
 */
export default function PausingRoom() {
  return (
    <RoomProvider room="night">
      <View style={roomShell}>
        <StatusBar style="light" />
        <ScreenBackground room="night" />
        <PausingScreen />
      </View>
    </RoomProvider>
  );
}

function PausingScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const { user } = useAuth();
  const { state, dispatch } = useSession();
  // Sensorlyssnaren monteras en gång och ser annars bara första renderns state.
  const respiteStartedAtRef = useRef(state.respiteStartedAt);
  respiteStartedAtRef.current = state.respiteStartedAt;
  const restartBlockedForRef = useRef<number | null>(null);
  const {
    category,
    sharedSessionId,
    sharedWithName,
    withPod,
    pauseType,
    targetSeconds,
  } = useLocalSearchParams<{
    category: string;
    /** Bara för en gäst som hängt på en väns paus (Friends). Värdens id
     *  skapas här, ur valet på Hem — se `sharedRef`. */
    sharedSessionId: string;
    withPod: string;
    sharedWithName: string;
    pauseType: string;
    targetSeconds: string;
  }>();

  // ── En delad paus (lib/pauseInvites.ts) ──
  // Gäst: kom hit med `sharedSessionId` från en inbjudan. Värd: valde vänner
  // på Hem, och inbjudningarna går ut när pausen startar (mount-effekten
  // nedan). Rollen avgör bara hur pausen avslutas — värden stänger dörren,
  // gästen markerar sin egen rad — och båda skriver sin paus som vanligt.
  const sharedRef = useRef<{ id: string; role: 'host' | 'guest' } | null>(
    sharedSessionId ? { id: sharedSessionId, role: 'guest' } : null,
  );

  // Vilket flöde skärmen visar avgörs av navigeringsparametern, inte av
  // sessionstillståndet. Tidigare lästes `state.phase === 'idle'` respektive
  // `state.withPod` vid montering, och det gick sönder så fort en tidigare
  // paus lämnat skräp efter sig: gick man ur en lådpaus med bakåtknappen låg
  // `withPod: true` och en icke-idle fas kvar i det globala tillståndet, och
  // nästa lådlösa paus ärvde dem. Skärmen trodde då att lådan ägde sessionen
  // — ingen Finish-knapp, och hela vilodetekteringen nedan hoppades över.
  // Parametern är känd synkront vid montering och kan inte bli inaktuell.
  //
  // De två är varandras motsatser: äger lådan sessionen driver den start och
  // slut själv, annars är det den här skärmen som gör det (lådlöst, eller en
  // delad paus med en vän som aldrig gick via ritualen — de skickar ingen
  // withPod alls, vilket är rätt: de är också lådlösa).
  const isPodFlowRef = useRef(withPod === 'true');
  const isManualOriginRef = useRef(withPod !== 'true');
  const endedHandledRef = useRef(false);
  const autoEndFiredRef = useRef(false);

  // ── En natt (lib/sleep.ts) ──
  // Samma skärm och samma frysning vid lyft, men ett lyft efter att telefonen
  // en gång legat ner är ett UPPVAKNANDE: det räknas när telefonen läggs ner
  // igen, och lyftet som avslutar natten räknas inte alls. `liftedAtRef` är
  // det pågående lyftets början — och, om natten slutar medan det pågår, den
  // tid natten slutade.
  const isSleep = pauseType === 'sleep';
  const firstRestAtRef = useRef<number | null>(null);
  const liftedAtRef = useRef<number | null>(null);
  const wakeCountRef = useRef(0);
  const awakeMsRef = useRef(0);
  // När appen senast kom fram. Fristen före natten tar slut av sig själv
  // räknas härifrån och inte från lyftet: öppnas appen på morgonen efter ett
  // lyft vid tre (till en annan app) ska den inte avsluta natten i samma
  // ögonblick, utan ge användaren chansen att lägga ner telefonen eller
  // trycka själv.
  const activeSinceRef = useRef(Date.now());

  // ── Midnatt (lib/homeMode.ts `isNightHours`) ──
  // En dagpaus som fortfarande går vid midnatt blir en natt där. Ligger
  // telefonen nedåt när midnatt passerat sparas dagdelen (tiden före) som en
  // paus och resten blir en natt som slutar vid första lyftet — utan
  // uppvaknanden, för lyftet ÄR slutet. Står klockan frusen vid midnatt
  // (telefonen uppe) slutar pausen som en vanlig paus i stället.
  //
  // Det upptäcks när JS kör, alltså vid nästa tick eller när appen kommer
  // fram — samma gräns som natten har, och den ger rätt tal ändå: dagdelen
  // räknas bakåt från tidpunkten, och natten börjar vid midnatt eller vid
  // läggningen efter den (`runStartRef`), det som är senast.
  //
  // Bara en vanlig lådlös paus. En natt är redan en natt, regulate har ett
  // eget slut, och lådans session ägs av lådan.
  const midnightAtRef = useRef<number | null>(
    !isSleep && withPod !== 'true' && pauseType !== 'regulate' ? nextMidnight(Date.now()) : null,
  );
  const runStartRef = useRef<number | null>(null);
  const nightRef = useRef<{ startMs: number; dayMs: number } | null>(null);
  const nightEndRef = useRef<number | null>(null);
  /** Dagradens sluttid: en sekund före midnatt om midnatt passerats, så att
   *  dagdelen hamnar på dagen den hör till (dagen räknas på `ended_at`). */
  const dayEndMs = () => {
    const m = midnightAtRef.current;
    return m !== null && Date.now() >= m ? m - 1000 : Date.now();
  };

  const noteRested = (now: number) => {
    runStartRef.current = now;
    if (!isSleep) return;
    if (firstRestAtRef.current === null) { firstRestAtRef.current = now; return; }
    if (liftedAtRef.current !== null) {
      wakeCountRef.current += 1;
      awakeMsRef.current += now - liftedAtRef.current;
      liftedAtRef.current = null;
    }
  };
  const noteLifted = (now: number) => {
    if (!isSleep || firstRestAtRef.current === null || liftedAtRef.current !== null) return;
    liftedAtRef.current = now;
  };

  // Natten går inte att backa ur. En övergiven paus kastas (se städningen
  // nedan), och det är rätt för en paus — men en kastad natt vore åtta
  // timmar borta på ett snedsteg. Vägen ut är *Good morning*.
  useEffect(() => {
    if (!isSleep) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [isSleep]);

  // Vad klockan just nu tror om telefonens läge. Sessionen startar i 'active'
  // (SESSION_STARTED), men telefonen ligger per definition i handen i det
  // ögonblicket — första avläsningen fryser alltså klockan tills den läggs
  // ner, vilket är precis rätt: pausen börjar när telefonen gör det.
  const restingRef = useRef(true);
  const rawFaceDownRef = useRef(false);
  const faceChangedAtRef = useRef<number | null>(null);
  const lastFaceLogMsRef = useRef(0);
  // Har telefonen legat nedåt någon gång under den här pausen? Grinden för
  // uppåtljudet, och inte en optimering: `restingRef` startar `true` fast
  // telefonen per definition ligger i handen, så den första riktiga
  // avläsningen är alltid en PHONE_LIFTED. Utan flaggan hade appen pipt
  // "upp" i samma andetag som pausen startade — innan någon lagt ner
  // någonting, vilket är motsatsen till återkoppling.
  const hasRestedRef = useRef(false);
  // Den senaste sekunden av rörelse, för stillhetsgrinden vid appbyte.
  const motionWindowRef = useRef<MotionSample[]>([]);
  // Avgörs en gång per lämnande: iOS skickar `inactive` och sedan
  // `background`, och sensorn kan ha tystnat mellan dem — ett andra omdöme
  // över ett tomt fönster hade fryst en ärlig paus.
  const leaveDecidedRef = useRef(false);
  // Ligger appen framme? Sensorn lever en stund efter att appen lämnats, och
  // i bakgrunden får den starta klockan bara om telefonen lagt sig still — se
  // vägen in i vilan i sensorlyssnaren.
  const appActiveRef = useRef(AppState.currentState === 'active');
  // Satt av en beröring medan klockan går, och släppt först när telefonen
  // vänts upp. Utan spärren hade en telefon som hålls nedåtvänd gått igen
  // efter FACE_DOWN_STABLE_MS, och beröringen hade bara kostat 300 ms.
  const touchLockRef = useRef(false);

  // ── Återkopplingen på att lägesbytet gick fram ──
  //
  // Ljuden ligger på samma övergång som dispatchen, alltså bakom
  // FACE_STABLE_MS: ett ljud per rå avläsning hade gjort en telefon som
  // glider på bordet hörbar. De är de enda ljuden i det lådlösa flödet, och
  // de bär det lådans display annars säger — att lådan registrerat läget.
  //
  // **Inget `setAudioModeAsync`**, till skillnad från samtalsskärmarna:
  // ljudet ska tiga när telefonen är tystad. En app vars löfte är lättnad
  // ska inte vara den som kringgår ljudlösknappen, och den som lagt sin
  // telefon nedåt för att bli ostörd har redan sagt vad hen vill.
  const faceDownPlayer = useAudioPlayer(require('../assets/images/Facedown.mp3'));
  const faceUpPlayer = useAudioPlayer(require('../assets/images/Faceup.mp3'));
  // En natt börjar med en godnatt i stället för nedläggningens klick, och
  // bara första gången: efter ett uppvaknande är natten redan igång.
  const goodnightPlayer = useAudioPlayer(require('../assets/images/goodnight.mp3'));

  // `seekTo(0)` före `play()`, för samma spelare används många gånger per
  // paus och står kvar vid klippets slut efter första vändningen — utan
  // spolningen hörs bara det första. Kedjad i promisen och inte parallellt,
  // så att en sen spolning inte hoppar tillbaka i ett klipp som redan
  // börjat. Och den får aldrig kasta: det här är återkoppling, och en paus
  // som dog på ett ljud som inte gick att spela vore värd mycket mer än
  // ljudet.
  const playCue = (player: AudioPlayer) => {
    player.seekTo(0).then(() => player.play()).catch(() => {});
  };

  const [, forceTick] = useState(0);

  const pulse1 = useRef(new Animated.Value(1)).current;
  const pulse2 = useRef(new Animated.Value(1)).current;
  const pulse3 = useRef(new Animated.Value(1)).current;

  // ── Starta manuellt om vi kom hit utan att ha gått via lådans ritual ──
  useEffect(() => {
    if (!isManualOriginRef.current) return;
    const isRegulate = pauseType === 'regulate';
    // Vännerna valda på Hem bjuds in nu, i samma stund som pausen börjar.
    // Valet tas (och töms) här och inte på Hem, så att det följer med vilken
    // väg pausen än startades. En natt tar inget: den är privat, och valet
    // ligger kvar till nästa paus. Inbjudningarna väntas inte in — se
    // `sendPauseInvites`.
    if (!isSleep && !sharedRef.current) {
      const invitees = takePauseInviteSelection();
      if (invitees.length > 0) {
        const id = newSharedId();
        sharedRef.current = { id, role: 'host' };
        sendPauseInvites(id, invitees.map(f => f.id));
      }
    }
    const shared = sharedRef.current;
    // Det lådlösa flödets motsvarighet till placeinbox.tsx `pause_started`.
    // Samma namn med flit: tratten ska kunna räkna starter utan att bry sig
    // om vilket flöde det var, och `with_pod` skiljer dem när det behövs.
    // En natt är ingen start i pausens tratt — `startSleep()` loggar sin egen.
    if (!isSleep) {
      track('pause_started', {
        with_pod: false,
        pause_type: isRegulate ? 'regulate' : 'session',
        category: category || null,
        shared: !!shared,
        shared_role: shared?.role ?? null,
      });
    }
    dispatch({
      type: 'SESSION_STARTED',
      seq: generateLocalSeq(),
      withPod: withPod === 'true',
      pauseType: (isSleep ? 'sleep' : isRegulate ? 'regulate' : 'session') as PauseType,
      targetSeconds: isRegulate ? parseInt(targetSeconds ?? '0', 10) : undefined,
      category: category || undefined,
      sharedSessionId: shared?.id,
      sharedWithName: sharedWithName || undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Skärmen under pausen. Lådflödet MÅSTE hålla den vaken: den globala
  // lyft-detekteringen i _layout.tsx läser DeviceMotion, och sensorn slutar
  // leverera avläsningar så fort skärmen släcks — då kan telefonen aldrig
  // avsluta pausen genom att lyftas ur lådan. Det lådlösa flödet har inget
  // sådant beroende, och där är en släckt skärm både lugnare och det
  // överlägset billigaste batteriläget. Så: låt telefonen låsa sig som
  // vanligt. Appen rör aldrig systemets ljusstyrka — den inställningen är
  // användarens. Klockan påverkas inte av att JS fryser — computeElapsedMs
  // räknar från state.startedAt, inte från tickarna, så tiden stämmer när
  // skärmen väcks igen. ──
  useEffect(() => {
    if (!isPodFlowRef.current) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => { deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {}); };
  }, []);

  // ── Lämnas skärmen utan att pausen avslutats (bakåtknappen) är den
  // övergiven, och måste städas bort. Annars ligger fasen och withPod kvar i
  // det globala tillståndet och ärvs av nästa paus — det var så en lådlös
  // paus kunde starta utan Finish-knapp och utan vilodetektering, och det
  // hade slagit lika hårt åt andra hållet: ENTER_CHECKIN no-opar om fasen
  // inte är 'idle', så nästa LÅDpaus hade inte heller kunnat starta.
  //
  // Checkpointen städas med, annars återuppstår den övergivna pausen som en
  // färdig paus i statistiken vid nästa appstart. Bara det lådlösa flödet:
  // en lådsession lever vidare i lådan även när skärmen lämnas, och ägs av
  // _layout ända fram till session_ended. ──
  useEffect(() => () => {
    if (!isManualOriginRef.current || endedHandledRef.current) return;
    clearSessionCheckpoint().catch(() => {});
    // En övergiven delad paus stänger dörren (värd) eller kliver ur (gäst),
    // utan att påstå någon längd — pausen sparas ju inte.
    const shared = sharedRef.current;
    if (shared?.role === 'host') closePauseInvites(shared.id, null);
    else if (shared?.role === 'guest') finishPauseInvite(shared.id, null);
    if (!isSleep) reportGlobalPause('finished');
    dispatch({ type: 'RESET' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Den globala pausen (lib/globalPause.ts) ──
  // Rummet visar klockan som den står här: den går när telefonen ligger nedåt
  // och står still *on hold* när den lyfts. Utan anmälan händer ingenting i
  // SQL. `hasRestedRef`, för fasen är 'active' en stund innan telefonen lagts
  // ner. Lådans paus räknas när den sparas, av en trigger.
  useEffect(() => {
    if (!isManualOriginRef.current || isSleep || !hasRestedRef.current) return;
    if (state.phase === 'active') reportGlobalPause('running');
    else if (state.phase === 'respite') reportGlobalPause('held');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // ── Lådlöst: skärmen nedåt ÄR vilan. Klockan går bara medan telefonen
  // ligger nedåtvänd; vänds den upp eller lyfts den, fryser den och skärmen
  // säger till. Samma regel som lådans lock, och den har den fina egenskapen
  // att den aldrig behöver veta om användaren låste skärmen eller bytte app:
  // en telefon som ligger nedåtvänd går inte att scrolla i. Plattformarna
  // rapporterar g.z spegelvänt — se isFaceDown i lib/tilt.ts. ──
  useEffect(() => {
    console.log('FaceDown: effekt kör, isPodFlow=', isPodFlowRef.current, 'param withPod=', withPod);
    if (isPodFlowRef.current) return;
    let cancelled = false;
    let sub: { remove: () => void } | null = null;

    (async () => {
      // Får aldrig stoppa prenumerationen. Accelerometern kräver ingen
      // runtime-permission på Android, och ett avslag eller ett kast här
      // skulle annars döda hela IIFE:n tyst — inget kast, inget lyssnande,
      // ingen logg att felsöka på.
      try {
        await DeviceMotion.requestPermissionsAsync();
      } catch (e) {
        console.log('FaceDown: permission-anrop kastade (fortsätter ändå):', e);
      }
      if (cancelled) return;
      DeviceMotion.setUpdateInterval(MOTION_INTERVAL_MS);
      console.log('FaceDown: prenumererar på DeviceMotion');

      sub = DeviceMotion.addListener(({ accelerationIncludingGravity: g, acceleration, rotationRate }) => {
        if (!g) return;
        const nowMs = Date.now();

        // Före nedåt-kollen: en skakig avläsning ska in i fönstret även när
        // den inte säger något om vinkeln.
        const win = motionWindowRef.current;
        win.push({
          t: nowMs,
          rot: rotationRate ? magnitude3(rotationRate.alpha, rotationRate.beta, rotationRate.gamma) : null,
          acc: acceleration ? magnitude3(acceleration.x, acceleration.y, acceleration.z) : null,
        });
        while (win.length > 0 && nowMs - win[0].t > STILL_WINDOW_MS) win.shift();

        const down = isFaceDown(g);
        if (down === null) return;

        // Råvärdet, utan stabilitetsfönster — det är det AppState-lyssnaren
        // nedan måste gå på i det ögonblick appen lämnas.
        rawFaceDownRef.current = down;
        if (!down) touchLockRef.current = false;

        // Högst en rad i sekunden; tickarna dränker annars konsolen. Rot och
        // acc är fönstrets toppar — det är dem trösklarna ska kalibreras mot.
        if (nowMs - lastFaceLogMsRef.current > 1000) {
          lastFaceLogMsRef.current = nowMs;
          const s = assessStillness(win, nowMs);
          console.log(
            'FaceDown: z=', g.z.toFixed(2), 'nedåt=', down, 'vilar=', restingRef.current,
            'rot=', s.maxRot?.toFixed(2) ?? '–', 'acc=', s.maxAcc?.toFixed(3) ?? '–', 'still=', s.still,
          );
        }

        if (down === restingRef.current) { faceChangedAtRef.current = null; return; }
        // Vägen in i vilan har två extra villkor, och vägen ut inga — att
        // frysa är alltid ofarligt.
        //  - En beröring har fryst klockan och telefonen har inte vänts upp
        //    sedan dess (touchLockRef).
        if (down && touchLockRef.current) {
          faceChangedAtRef.current = null;
          return;
        }
        if (faceChangedAtRef.current === null) { faceChangedAtRef.current = Date.now(); return; }
        if (Date.now() - faceChangedAtRef.current < (down ? FACE_DOWN_STABLE_MS : FACE_STABLE_MS)) return;
        //  - Appen ligger inte framme. Sensorn levererar en kort stund efter
        //    att appen lämnats (0,3–1 s i loggarna), och det är sista chansen
        //    att se telefonen. Där får klockan gå igen bara om telefonen har
        //    lagt sig still (SETTLE_*). Två ärliga mönster hänger på det: en
        //    telefon på bordet vars accelerometer brusar över stillhetsgrinden,
        //    och en som låses i samma rörelse som den läggs ner — båda fryses
        //    när appen lämnas och landar stilla en halv sekund senare. En
        //    telefon som hålls nedåtvänd i en hand blir aldrig så still, och
        //    då står klockan frusen tills appen öppnas igen. Utan villkoret
        //    "lades den ner igen" 400 ms efter hemknappen, och klockan gick
        //    medan man scrollade i en annan app.
        //    Faller provet ligger faceChangedAtRef kvar, så att varje ny
        //    avläsning prövar igen tills telefonen lagt sig eller sensorn
        //    tystnat.
        if (down && !appActiveRef.current) {
          //    Och bara efter ett kort avbrott (BACKGROUND_RESTART_MAX_FROZEN_MS).
          //    Händelsen loggas en gång per frysning, så att taket kan prövas
          //    mot hur ofta det slår till.
          const frozenAt = respiteStartedAtRef.current;
          if (!isSleep && frozenAt !== null && nowMs - frozenAt > BACKGROUND_RESTART_MAX_FROZEN_MS) {
            if (restartBlockedForRef.current !== frozenAt) {
              restartBlockedForRef.current = frozenAt;
              track('pause_restart_blocked', { frozen_minutes: Math.round((nowMs - frozenAt) / 60000) });
            }
            return;
          }
          const settle = assessSettled(win, nowMs);
          if (!settle.settled) return;
          console.log('FaceDown: lade sig still efter att appen lämnats, rot=',
            settle.maxRot?.toFixed(2) ?? '–', '→ PHONE_RESTED');
          track('pause_settled_after_leave', {
            kind: isSleep ? 'sleep' : 'pause',
            max_rotation_deg_s: settle.maxRot === null ? null : Math.round(settle.maxRot * 100) / 100,
            samples: settle.samples,
          });
        }

        faceChangedAtRef.current = null;
        restingRef.current = down;
        if (down) {
          if (!isSleep) playCue(faceDownPlayer);
          else if (!hasRestedRef.current) playCue(goodnightPlayer);
          hasRestedRef.current = true;
          noteRested(nowMs);
        } else if (hasRestedRef.current) {
          // Inget uppåtljud under en natt: ett pip när någon tar telefonen
          // klockan tre väcker den som ligger bredvid.
          if (!isSleep) playCue(faceUpPlayer);
          noteLifted(nowMs);
        }
        console.log('FaceDown: →', down ? 'PHONE_RESTED' : 'PHONE_LIFTED');
        // Hur ofta klockan fryser under en lådlös paus. Många avbrott per
        // paus är det närmaste appen kommer ett mått på hur svårt själva
        // löftet är att hålla utan ett lock. En natt räknar sina uppvaknanden
        // på raden i stället, och hör inte hemma i pausens siffror.
        if (!isSleep) track(down ? 'phone_rested' : 'phone_lifted_during_pause', { with_pod: false });
        dispatch({ type: down ? 'PHONE_RESTED' : 'PHONE_LIFTED' });
      });
    })();

    return () => { cancelled = true; sub?.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Ögonblicket appen lämnas är det sista vi ser innan sensorn tystnar,
  // och det avgör allt:
  //
  //   nedåtvänd och still → låst skärm över en telefon som ligger på
  //                något. Ingen frysning, klockan går vidare.
  //   annars     → telefonen är i handen. Frys direkt, utan att invänta
  //                stabilitetsfönstret — ett appbyte hinner annars igenom
  //                med klockan igång om det sker inom 600 ms efter lyftet.
  //
  // "Still" är det som stänger hålet med en telefon som hålls nedåtvänd i
  // luften medan man byter app — se STILL_WINDOW_MS. Omdömet fälls en gång
  // per lämnande och gäller tills appen är aktiv igen; därefter prövas nästa
  // lämnande på nytt.
  //
  // Återkomsten mäts inte. Frånvaron räknades förr fram här och visades som
  // "Away 00:42" i vilovyn, men en frusen klocka säger redan att ingenting
  // gått förlorat — och siffran dök bara upp när appen lämnats, inte när
  // telefonen vänts upp och lagts ner igen. Samma avsteg fick alltså ett tal
  // eller inget tal beroende på om AppState råkade fyra. ──
  useEffect(() => {
    if (isPodFlowRef.current) return;
    const sub = AppState.addEventListener('change', next => {
      appActiveRef.current = next === 'active';
      if (next === 'active') {
        leaveDecidedRef.current = false;
        activeSinceRef.current = Date.now();
        return;
      }
      if (leaveDecidedRef.current) return;
      leaveDecidedRef.current = true;

      const faceDown = rawFaceDownRef.current;
      const s = assessStillness(motionWindowRef.current, Date.now());
      const keepRunning = faceDown && s.still;
      console.log('FaceDown: appen lämnas, nedåt=', faceDown, 'still=', s.still,
        'rot=', s.maxRot?.toFixed(2) ?? '–', 'acc=', s.maxAcc?.toFixed(3) ?? '–', 'n=', s.samples,
        '→', keepRunning ? 'går vidare' : 'fryser');
      // Underlaget för trösklarna: hur ofta en nedåtvänd telefon fryses för
      // att den inte stod still är precis den siffra som säger om en ärlig
      // paus i en soffa råkar ut för grinden.
      track('pause_left_app', {
        with_pod: false,
        face_down: faceDown,
        still: s.still,
        max_rotation_deg_s: s.maxRot === null ? null : Math.round(s.maxRot * 100) / 100,
        max_accel_m_s2: s.maxAcc === null ? null : Math.round(s.maxAcc * 1000) / 1000,
        samples: s.samples,
        frozen: !keepRunning,
        kind: isSleep ? 'sleep' : 'pause',
      });

      if (keepRunning) return;
      restingRef.current = false;
      faceChangedAtRef.current = null;
      noteLifted(Date.now());
      dispatch({ type: 'PHONE_LIFTED' });
    });
    return () => sub.remove();
  }, []);

  // ── is_pausing-flaggan, oavsett flöde ──
  //
  // Skärmens montering ÄR pausen, för båda flödena: det lådlösa navigerar hit
  // själv, och lådflödet hamnar här via placeinbox eller _layout:s
  // återanslutningsrutt. Därför sätts flaggan här och ingen annanstans.
  //
  // Ordningen mellan `true` och `false` — och mot nollningen vid appstart i
  // [app/_layout.tsx](_layout.tsx) — ligger i [lib/pausingFlag.ts](../lib/pausingFlag.ts).
  // Skrivningarna sköts förr med tre lösa `.update()` som inte inväntade
  // varandra, och ett `false` kunde landa efter det `true` det skulle ha
  // föregått.
  //
  // Inte under en natt: natten är privat, och "pausing now" under någons namn
  // från elva till sju vore just det den inte ska säga.
  useEffect(() => {
    if (!user?.id || isSleep) return;
    const uid = user.id;
    setPausingFlag(uid, true);
    return () => { setPausingFlag(uid, false); };
  }, [user?.id, isSleep]);

  // ── Krasch-checkpoint — bara för det manuella flödet. Lådans egen
  // state-synk vid återanslutning (se _layout.tsx) täcker box-flödet.
  //
  // Skrivs om som en puls, inte en enda gång vid start. En tvångsstängd app
  // får aldrig köra någon kod — ingen städning, inget slutvärde — så utan
  // pulsen kunde återställningen bara anta att pausen pågått ända fram till
  // nästa appstart, och en paus som dödades efter två minuter loggades som
  // timmar. Sista skrivningen sker när appen lämnar förgrunden, eftersom JS
  // fryser strax därefter och intervallet då slutar ticka. ──
  useEffect(() => {
    if (!isManualOriginRef.current || !user?.id || state.phase !== 'active') return;

    // `runningAtLeave` är bara sant i skrivningen när appen lämnas, och bara
    // om klockan fortfarande går då (nedåtvänd och still — frysningen ovan
    // har redan avgjort det när den här lyssnaren kör). Pulsen skriver
    // `false`: dödas appen medan den ligger framme vet vi ingenting efter
    // pulsen, och då ska återställningen stanna där.
    const write = (runningAtLeave = false) => {
      saveSessionCheckpoint({
        startedAt: new Date(state.startedAt ?? Date.now()).toISOString(),
        lastAliveAt: new Date().toISOString(),
        elapsedMs: computeElapsedMs(),
        userId: user.id,
        category: state.category || undefined,
        pauseType: state.pauseType,
        targetSeconds: state.pauseType === 'regulate' ? state.targetSeconds : undefined,
        sharedSessionId: state.sharedSessionId || undefined,
        sharedRole: sharedRef.current?.role,
        ...(isSleep && {
          firstRestAt: firstRestAtRef.current ? new Date(firstRestAtRef.current).toISOString() : undefined,
          wakeCount: wakeCountRef.current,
          awakeMs: awakeMsRef.current,
          runningAtLeave,
        }),
        // En dagpaus som blivit en natt: återställningen sparar dagdelen och
        // natten var för sig, och natten räknas som en natt (runningAtLeave).
        ...(nightRef.current && {
          nightStartAt: new Date(nightRef.current.startMs).toISOString(),
          dayMs: nightRef.current.dayMs,
          runningAtLeave,
        }),
      });
    };

    write();
    const interval = setInterval(() => write(), HEARTBEAT_MS);
    const appStateSub = AppState.addEventListener('change', next => {
      if (next !== 'active') write(restingRef.current);
    });

    return () => { clearInterval(interval); appStateSub.remove(); };
  }, [isManualOriginRef.current, user?.id, state.phase, state.startedAt]);

  // ── Pulsanimation ──
  useEffect(() => {
    const createPulse = (anim: Animated.Value, delay: number) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 2.5, duration: 1500, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 1, duration: 1500, useNativeDriver: true }),
        ])
      ).start();
    };
    createPulse(pulse1, 0);
    createPulse(pulse2, 500);
    createPulse(pulse3, 1000);
  }, []);

  // ── Sekundvisning — tickar bara om för att trigga omrendering; faktiskt
  // elapsed räknas ut vid varje render från state, se computeElapsedMs. ──
  useEffect(() => {
    const interval = setInterval(() => forceTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const computeElapsedMs = (): number => {
    if (!state.startedAt) return 0;
    const now = state.phase === 'respite' && state.respiteStartedAt ? state.respiteStartedAt : Date.now();
    return Math.max(0, now - state.startedAt - state.pausedMs + state.elapsedBaselineMs);
  };

  const elapsedMs = computeElapsedMs();
  const isRegulate = state.pauseType === 'regulate' && !!state.targetSeconds;
  const seconds = isRegulate
    ? Math.max(0, (state.targetSeconds ?? 0) - Math.floor(elapsedMs / 1000))
    : Math.floor(elapsedMs / 1000);

  const respiteSecondsLeft = state.respiteStartedAt
    ? Math.max(0, RESPITE_SECONDS - Math.floor((Date.now() - state.respiteStartedAt) / 1000))
    : RESPITE_SECONDS;

  // Här bokades förr en notis som gick av när nedräkningen tog slut. Appen
  // skickar inga notiser längre, så en nedräkning som löper ut med skärmen
  // släckt når ingen förrän appen väcks igen — auto-avslutet nedan kör först
  // då. Det är en känd följd av borttagningen, inte en lucka.

  // ── Regulate-nedräkning (bara lådlöst) tar slut av sig själv ──
  useEffect(() => {
    if (!isManualOriginRef.current || !isRegulate || autoEndFiredRef.current) return;
    if (seconds > 0) return;
    autoEndFiredRef.current = true;
    dispatch({
      type: 'SESSION_ENDED',
      seq: state.seq ?? '',
      durationMs: (state.targetSeconds ?? 0) * 1000,
      completed: true,
    });
  }, [seconds, isRegulate]);

  // ── En natt tar slut av sig själv ──
  // när telefonen varit uppe i `SLEEP_AUTO_END_MS` med appen framme — då är
  // det morgon och inte ett uppvaknande. Natten slutar vid lyftet (se
  // `liftedAtRef` i avslutet nedan), så minuterna med telefonen i handen
  // räknas inte som sömn. Och ett tak: en natt som "pågått" längre än
  // `SLEEP_MAX_SECONDS` avslutas där.
  useEffect(() => {
    if (!isSleep || autoEndFiredRef.current) return;
    if (seconds >= SLEEP_MAX_SECONDS) { finishPause('cap'); return; }
    if (state.phase !== 'respite' || liftedAtRef.current === null) return;
    const since = Math.max(liftedAtRef.current, activeSinceRef.current);
    if (Date.now() - since >= SLEEP_AUTO_END_MS) finishPause('auto');
  });

  // ── Midnatt passerad: dagpausen blir en natt, eller slutar ──
  // Körs vid varje render (klockan tickar varje sekund medan JS lever).
  useEffect(() => {
    const m = midnightAtRef.current;
    if (m === null || nightRef.current || autoEndFiredRef.current) return;
    if (!state.startedAt || state.phase === 'ended') return;
    const now = Date.now();
    if (now < m) return;
    // Hur länge klockan gick efter midnatt. Antingen går den nu, eller så
    // har JS sovit genom midnatt och lyftet hann registreras före den här
    // kollen (telefonen togs upp på morgonen) — då gick den fram till lyftet,
    // och natten är redan slut. Utan den andra grenen hade hela natten
    // sparats som en dagpaus.
    const runningNow = state.phase === 'active' && restingRef.current && hasRestedRef.current;
    const liftedAfter = state.phase === 'respite' && hasRestedRef.current
      && state.respiteStartedAt !== null && state.respiteStartedAt !== undefined && state.respiteStartedAt > m;
    if (runningNow || liftedAfter) {
      const until = runningNow ? now : state.respiteStartedAt!;
      const startMs = Math.max(m, runStartRef.current ?? m);
      const dayMs = Math.max(0, computeElapsedMs() - (until - startMs));
      nightRef.current = { startMs, dayMs };
      track('pause_became_night', { day_seconds: Math.round(dayMs / 1000) });
      // "Pausing now" hör till dagen; natten är privat.
      if (user?.id) setPausingFlag(user.id, false);
      if (liftedAfter) {
        nightEndRef.current = until;
        finishPause('night', dayMs);
      }
      return;
    }
    // Uppe sedan före midnatt: ingen natt, pausen slutar som den stod.
    finishPause('midnight');
  });

  // ── Natten (efter midnatt) slutar vid första lyftet ──
  useEffect(() => {
    const night = nightRef.current;
    if (!night || autoEndFiredRef.current) return;
    if (state.phase !== 'respite' || !state.respiteStartedAt) return;
    nightEndRef.current = state.respiteStartedAt;
    finishPause('night', night.dayMs);
  }, [state.phase, state.respiteStartedAt]);

  // ── Sessionen är slut. Bara det lådlösa flödets Supabase-skrivningar sker
  // här — box-ursprung är redan sparat (SessionContext skrev till outboxen
  // och ackade innan den dispatchade SESSION_ENDED). Reset och navigering
  // till /pausesummary sköts globalt i _layout.tsx, oavsett vilken skärm
  // som råkar vara monterad när lådan säger att sessionen är slut. ──
  useEffect(() => {
    if (state.phase !== 'ended' || !state.lastEnded || !isManualOriginRef.current || endedHandledRef.current) return;
    endedHandledRef.current = true;

    // En natt skrivs som en sömnrad och ingenting annat: ingen krets, ingen
    // lokal pauslogg (lib/sleep.ts). Den slutar vid lyftet om ett pågår —
    // det är då natten tog slut, inte när knappen hölls eller fristen gick.
    if (isSleep) {
      if (!user?.id) return;
      const uid = user.id;
      const durationSeconds = Math.round(state.lastEnded.durationMs / 1000);
      const endedAt = liftedAtRef.current ?? Date.now();
      const startedAt = firstRestAtRef.current ?? endedAt - durationSeconds * 1000;
      (async () => {
        await saveSleepSession({
          userId: uid,
          startedAt: new Date(startedAt),
          endedAt: new Date(endedAt),
          durationSeconds,
          wakeCount: wakeCountRef.current,
          awakeSeconds: awakeMsRef.current / 1000,
        });
        await clearSessionCheckpoint();
      })();
      return;
    }

    (async () => {
      const durationSeconds = Math.round(state.lastEnded!.durationMs / 1000);
      // En sekund före midnatt om pausen passerade den (`dayEndMs`).
      const endMs = dayEndMs();
      const now = new Date(endMs).toISOString();
      // Cirkelns ledger dedupar på pause_sessions-id, så raden måste skrivas
      // klart innan pausen kan räknas in i veckan och i stegen.
      let sessionId: string | null = null;

      // En delad paus skrivs som vilken paus som helst, bara med sitt
      // gemensamma id. Raden finns inte i förväg — inbjudan bor i
      // `pause_invites`, inte i `pause_sessions` (supabase/pause_invites.sql).
      const shared = sharedRef.current;
      if (user?.id) {
        let intentionLabel: string | null = null;
        if (state.category) {
          const cat = await findCategoryById(state.category);
          intentionLabel = cat?.label ?? null;
        }
        const { data: inserted, error } = await supabase.from('pause_sessions').insert({
          user_id: user.id,
          started_at: new Date(endMs - durationSeconds * 1000).toISOString(),
          ended_at: now,
          duration_seconds: durationSeconds,
          intention: intentionLabel,
          is_shared: !!shared,
          shared_session_id: shared?.id ?? null,
          with_pod: state.withPod,
          completed: state.lastEnded!.completed,
        }).select('id').single();
        if (error) console.log('pause_sessions insert error:', JSON.stringify(error));
        sessionId = inserted?.id ?? null;
      }
      // Efter raden, så att den som läser sammanfattningen och ser "paused
      // 5 min" också hittar pausen hos den andra.
      if (shared?.role === 'host') await closePauseInvites(shared.id, durationSeconds);
      else if (shared?.role === 'guest') await finishPauseInvite(shared.id, durationSeconds);
      reportGlobalPause('finished');
      await logPause(durationSeconds, 'session', state.category || undefined);
      // Natten efter midnatt: en sömnrad från midnatt (eller läggningen) till
      // lyftet. Inga uppvaknanden — lyftet avslutade den. Kortare än
      // SLEEP_MIN_SECONDS sparas inte (saveSleepSession).
      const night = nightRef.current;
      if (night && user?.id) {
        const nightEnd = nightEndRef.current ?? Date.now();
        await saveSleepSession({
          userId: user.id,
          startedAt: new Date(night.startMs),
          endedAt: new Date(nightEnd),
          durationSeconds: (nightEnd - night.startMs) / 1000,
          wakeCount: 0,
          awakeSeconds: 0,
        });
      }
      await clearSessionCheckpoint();
      if (state.lastEnded!.completed && sessionId) recordPauseInCircle(sessionId, state.category);
    })();
  }, [state.phase]);

  // Timmar först från en timme: en natt i minuter blev `480:00`.
  const formatTime = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
  };

  // `durationMs` skrivs bara över av natten efter midnatt: då är pausens
  // längd dagdelen, och natten sparas för sig (se avslutet ovan).
  const finishPause = (how: 'manual' | 'auto' | 'cap' | 'midnight' | 'night' = 'manual', durationMs = elapsedMs) => {
    if (autoEndFiredRef.current) return;
    autoEndFiredRef.current = true;
    // Ett tryck på Finish, till skillnad från en regulate-paus som tar slut
    // av sig själv. Båda ger ett pause_completed i _layout.tsx; bara det ena
    // var ett beslut.
    if (isSleep) track('sleep_finished', { how, duration_seconds: Math.round(elapsedMs / 1000) });
    else if (how === 'midnight' || how === 'night') track('pause_ended_at_midnight', { how, duration_seconds: Math.round(durationMs / 1000) });
    else track('pause_finished_manually', { duration_seconds: Math.round(elapsedMs / 1000) });
    dispatch({
      type: 'SESSION_ENDED',
      seq: state.seq ?? '',
      durationMs,
      completed: true,
    });
  };

  // ── Ett bord rör aldrig skärmen ──
  //
  // Medan klockan går ligger en ärlig telefon nedåt mot något, och ingen
  // trycker på den eller sveper fram navigeringsfältet. Båda är alltså bevis
  // på att telefonen är i en hand, och klockan fryser som vid ett lyft. Den
  // går igen först när telefonen vänts upp och lagts ner på nytt
  // (touchLockRef).
  //
  // Beröringen fångas i capture-fasen och svarar `false`, så den ser varje
  // tryck utan att ta det från knappen under. Systemknapparna ligger utanför
  // fönstret och syns inte här — därför är fältet gömt medan klockan går
  // (lib/pauseNavBar.ts), och svepet som tar fram det är det som fångas.
  const freezeInHand = (source: 'touch' | 'nav_bar') => {
    if (isPodFlowRef.current || !restingRef.current || !hasRestedRef.current) return;
    const now = Date.now();
    touchLockRef.current = true;
    restingRef.current = false;
    faceChangedAtRef.current = null;
    if (!isSleep) playCue(faceUpPlayer);
    noteLifted(now);
    console.log('FaceDown: hand medan klockan gick (', source, ') → PHONE_LIFTED');
    track('pause_touched', { kind: isSleep ? 'sleep' : 'pause', source });
    dispatch({ type: 'PHONE_LIFTED' });
  };
  const freezeOnTouch = () => { freezeInHand('touch'); return false; };

  // ── Navigeringsfältet (bara Android) ──
  // Gömt medan klockan går, framme annars — vid vila, efter ett lyft och när
  // skärmen lämnas. Fram kommer det bara på två sätt: appen visar det, eller
  // en hand sveper fram det. Appens egna växlingar ger samma händelse, så
  // en händelse inom NAV_BAR_SETTLE_MS från en växling räknas inte.
  const navBarToggledAtRef = useRef(0);
  useEffect(() => {
    if (isPodFlowRef.current) return;
    navBarToggledAtRef.current = Date.now();
    if (state.phase === 'active' && hasRestedRef.current) hideNavBar();
    else showNavBar();
  }, [state.phase]);
  useEffect(() => {
    if (isPodFlowRef.current) return;
    const off = onNavBarShown(() => {
      if (!appActiveRef.current) return;
      if (Date.now() - navBarToggledAtRef.current < NAV_BAR_SETTLE_MS) return;
      freezeInHand('nav_bar');
    });
    return () => { off(); showNavBar(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Efter midnatt är en dagpaus en natt, och skärmen säger det.
  const titleText = isSleep || nightRef.current ? 'Sleeping...' : isRegulate ? 'Regulate in progress...' : 'Pausing...';
  // Samma ord, samma röda knapp och samma håll för natten som för pausen —
  // att avsluta ska inte se ut som att börja. Bara skärmläsaren får veta
  // vad det är som avslutas.
  const finishLabel = 'Finish';
  const finishA11y = isSleep ? 'Finish the night' : 'Finish pause';

  return (
    <View style={styles.container} onStartShouldSetResponderCapture={freezeOnTouch}>
      {/* Ingen svepning bakåt under en natt — se BackHandler ovan. */}
      {isSleep && <Stack.Screen options={{ gestureEnabled: false }} />}
      <View style={styles.pulseContainer}>
        <Animated.View style={[styles.ring, styles.ring3, { transform: [{ scale: pulse3 }] }]} />
        <Animated.View style={[styles.ring, styles.ring2, { transform: [{ scale: pulse2 }] }]} />
        <Animated.View style={[styles.ring, styles.ring1, { transform: [{ scale: pulse1 }] }]} />
        <View style={styles.center}>
          <FontAwesome name={isSleep ? 'moon-o' : 'pause'} size={40} color={Palette.onAccent} />
        </View>
      </View>

      <Text style={styles.title}>{titleText}</Text>
      <Text style={styles.subtitle}> </Text>

      <View style={styles.timerWrap}>
        <Text style={styles.timer}>{formatTime(seconds)}</Text>
        {isRegulate && (
          <Text style={styles.timerLabel}>left</Text>
        )}
      </View>

      {/* Lådan äger avslutet i box-flödet — ingen "Klar"-knapp där.
          Finish hålls in, som PAUSE: att avsluta är lika avsiktligt som att
          börja, och ett snuddat tryck ska inte ta slut på en paus. Samma
          `finishPause` som förut — bara gesten och färgen är nya. */}
      {isManualOriginRef.current && (
        <HoldToStartButton
          style={styles.doneButton}
          onComplete={() => finishPause()}
          holdMs={HOLD_TO_START_MS}
          borderRadius={DONE_BTN_RADIUS}
          accessibilityLabel={finishA11y}
          hintStyle={styles.holdHint}
        >
          <Text style={styles.doneText}>{finishLabel}</Text>
        </HoldToStartButton>
      )}

      {state.phase === 'respite' && isPodFlowRef.current && (
        <View style={styles.lidOpenOverlay}>
          <Text style={styles.lidOpenTitle}>{respiteSecondsLeft}</Text>
          <Text style={styles.lidOpenSubtitle}>
            Close the lid{'\n'}to continue
          </Text>
        </View>
      )}

      {/* Lådlös vila: instruktionen ÄR gesten. Klockan syns kvar så det
          framgår att ingenting gått förlorat, bara stannat. */}
      {state.phase === 'respite' && !isPodFlowRef.current && (
        <View style={styles.lidOpenOverlay}>
          <Text style={styles.restTitle}>PUT PHONE{'\n'}FACE DOWN</Text>
          <Text style={styles.restTimer}>{formatTime(seconds)}</Text>
          <Text style={styles.lidOpenSubtitle}>
            {/* Före första nedläggningen har natten inte börjat. Efteråt står
                bara att klockan står — att natten tar slut av sig själv
                efter `SLEEP_AUTO_END_MS` uppe sades förr här och togs bort
                på begäran; funktionen är kvar. */}
            {isSleep && firstRestAtRef.current === null
              // Låser man telefonen i handen och lägger ner den sedan ser
              // appen ett lyft när den lämnas, och klockan står frusen
              // tills den öppnas igen — hela natten. Därför säger raden hur.
              ? 'Goodnight'
              : 'Clock paused'}
          </Text>
          <HoldToStartButton
            style={styles.doneButton}
            onComplete={() => finishPause()}
            holdMs={HOLD_TO_START_MS}
            borderRadius={DONE_BTN_RADIUS}
            accessibilityLabel={finishA11y}
            hintStyle={styles.holdHint}
          >
            <Text style={styles.doneText}>{finishLabel}</Text>
          </HoldToStartButton>
        </View>
      )}
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    marginTop: -45,
  },
  pulseContainer: {
    width: 200,
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    borderRadius: 100,
    borderWidth: 2,
  },
  ring1: { width: 100, height: 100, borderColor: alpha(Palette.accent, 0.6) },
  ring2: { width: 100, height: 100, borderColor: alpha(Palette.accent, 0.4) },
  ring3: { width: 100, height: 100, borderColor: alpha(Palette.accent, 0.2) },
  center: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...Palette.cardShadow,
  },
  title: { fontSize: 32, fontWeight: '800', color: Palette.textPrimary },
  subtitle: { fontSize: 18, color: Palette.textSecondary, textAlign: 'center', paddingHorizontal: 40 },
  timerWrap: {
    alignItems: 'center',
    gap: 4,
  },
  timer: { fontSize: 56, fontWeight: 'bold', color: Palette.textPrimary, letterSpacing: 4 },
  timerLabel: {
    fontSize: 14,
    color: Palette.accent,
    fontWeight: '600',
    letterSpacing: 3,
    textTransform: 'uppercase',
    opacity: 0.8,
  },
  // Röd och inte accent: att avsluta ska inte se ut som knappen man trycker på
  // för att börja. `danger` är samma röd som *Remove* och *Leave circle*.
  // Vit fet text på den rödan klarar AA för stor text (20 px fet), och
  // nattrummet är mörkt i båda lägena, så kontrasten mot botten byter inte.
  doneButton: {
    marginTop: 20,
    backgroundColor: Palette.danger,
    paddingVertical: 16,
    paddingHorizontal: 60,
    borderRadius: DONE_BTN_RADIUS,
    ...Palette.cardShadow,
    shadowColor: Palette.danger,
  },
  doneText: { color: Palette.onAccent, fontSize: 20, fontWeight: 'bold' },
  // *Keep holding* under Finish efter ett för kort tryck.
  holdHint: { fontSize: 13, lineHeight: 18, marginTop: 8, textAlign: 'center' },
  lidOpenOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Palette.bg,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    gap: 16,
  },
  lidOpenTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: Palette.textPrimary,
    textAlign: 'center',
  },
  lidOpenSubtitle: {
    fontSize: 16,
    color: Palette.textSecondary,
    textAlign: 'center',
    lineHeight: 24,
  },
  restTitle: {
    fontSize: 30,
    fontWeight: '900',
    color: Palette.textPrimary,
    textAlign: 'center',
    letterSpacing: 1,
    lineHeight: 38,
  },
  restTimer: {
    fontSize: 40,
    fontWeight: 'bold',
    color: Palette.accent,
    letterSpacing: 3,
  },
});
