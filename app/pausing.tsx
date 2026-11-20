import { FontAwesome } from '@expo/vector-icons';
// `AudioPlayer` är bara en typ här — expo-audio re-exporterar den med
// `export type *`, så en vanlig värdeimport av den skulle inte hålla.
import { useAudioPlayer, type AudioPlayer } from 'expo-audio';
import { Stack, useLocalSearchParams } from 'expo-router';
import { DeviceMotion } from 'expo-sensors';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, AppState, BackHandler, StyleSheet, Text, View } from 'react-native';
import { HoldToStartButton } from '../components/hold-to-start-button';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { alpha, AppPalette } from '../constants/appTheme';
import { useSession } from '../context/SessionContext';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { track } from '../lib/analytics';
import { recordPauseInCircle } from '../lib/circles';
import { ASK_ASLEEP_MIN_MS, isNightHours, nightOverlap } from '../lib/homeMode';
import { reportGlobalPause } from '../lib/globalPause';
import { HOLD_TO_START_MS } from '../lib/pauseFlow';
import {
  closePauseInvites, finishPauseInvite, newSharedId, sendPauseInvites, takePauseInviteSelection,
} from '../lib/pauseInvites';
import { setPausingFlag, setPausingState } from '../lib/pausingFlag';
import { PauseType } from '../lib/sessionMachine';
import { saveSleepSession, SLEEP_AUTO_END_MS, SLEEP_MAX_SECONDS } from '../lib/sleep';
import { supabase } from '../lib/supabase';
import { isFaceDown } from '../lib/tilt';
import { hideNavBar, onNavBarShown, showNavBar } from '../lib/pauseNavBar';
import { clearSessionCheckpoint, findCategoryById, logPause, saveSessionCheckpoint } from './pauseLogger';

// Finish-knappens radie, delad med hållknappens fyllning så att den klipps
// i samma rundning som knappen (16 + 16 + textens ~24 ≈ 56).
const DONE_BTN_RADIUS = 28;

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
    pauseType,
    targetSeconds,
  } = useLocalSearchParams<{
    category: string;
    /** Bara för en gäst som hängt på en väns paus (Friends). Värdens id
     *  skapas här, ur valet på Hem — se `sharedRef`. */
    sharedSessionId: string;
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

  // Skärmen bar förr två flöden: lådans (där lådan ägde start och slut och
  // skärmen bara visade dem) och telefonens eget. Vilket det var avgjordes
  // av navigeringsparametern `withPod`, läst i `isPodFlowRef` /
  // `isManualOriginRef`. Sedan firmware v8.5 startar appen aldrig en
  // lådpaus, så den här skärmen är alltid telefonens egen — den startar
  // pausen, driver vilan och skriver raden själv, och alla de gamla
  // grenarna är borta i stället för att stå kvar som alltid-sanna.
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

  // ── Natten (lib/homeMode.ts `nightOverlap`) ──
  // En paus får gå förbi midnatt och startas efter den. Låg minst
  // `ASK_ASLEEP_MIN_MS` av den mellan 00 och 05 i telefonens tid frågar
  // avslutet *Were you asleep?* innan något sparas — annars hinner kretsens
  // dagsmålsnotis gå ut för en natts sömn. *Yes* delar den: tiden före natten
  // blir en paus, resten en natt från midnatt (eller från starten, om den
  // började efter midnatt) till lyftet, utan uppvaknanden. *No* sparar den
  // som en paus hela vägen.
  //
  // Bara en vanlig paus. En natt är redan en natt, och regulate har ett
  // eget slut. Dör appen frågar ingen: återställningen i _layout.tsx kapar
  // pausen vid midnatt.
  const asksAsleep = !isSleep && pauseType !== 'regulate';
  const runStartRef = useRef<number | null>(null);
  /** Svaret *Yes*: var natten började och slutade. Läses av avslutet. */
  const nightSplitRef = useRef<{ startMs: number; endMs: number; dayMs: number } | null>(null);

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

  // ── Starta pausen ──
  useEffect(() => {
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
    // Pausens start i tratten (analytics.pause_funnel). Lådans pauser
    // räknas inte här: de passerar aldrig appen.
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
  // Höll skärmen vaken, men bara i lådflödet: där låg telefonen i en låda
  // och skärmen behövde inte spara batteri. En telefonpaus ska tvärtom
  // släcka skärmen av sig själv, så med lådflödet borta finns ingen som
  // håller den vaken — och det är rätt.


  // ── Lämnas skärmen utan att pausen avslutats (bakåtknappen) är den
  // övergiven, och måste städas bort. Annars ligger fasen kvar i
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
    if (endedHandledRef.current) return;
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
    if (isSleep || !hasRestedRef.current) return;
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

  // ── is_pausing-flaggan ──
  //
  // Skärmens montering ÄR pausen: hit navigerar man när den startar, och
  // härifrån lämnar man när den slutar. Därför sätts flaggan här och ingen
  // annanstans i appen. (En lådpaus sätter den på servern i stället, i
  // `record_box_session_start()` — lådan har ingen skärm här.)
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
    if (!isNightHours()) setPausingFlag(uid, true);
    return () => { setPausingFlag(uid, false); };
  }, [user?.id, isSleep]);

  // Flaggans utgångsdatum följer klockan (supabase/pausing_flag.sql): går den
  // gäller flaggan till midnatt, står den fryst i tio minuter. Dör appen
  // släcks den då av sig själv. Mellan 00 och 05 skrivs den inte alls: ingen
  // vet om pausen är en natt förrän den slutar, och natten är privat. En paus
  // som går förbi midnatt släcks där av servern, och en som startar efter
  // midnatt syns först efter fem, vid nästa fasbyte.
  useEffect(() => {
    if (!user?.id || isSleep) return;
    if (isNightHours()) setPausingState(user.id, 'off');
    else if (state.phase === 'active') setPausingState(user.id, 'running');
    else if (state.phase === 'respite') setPausingState(user.id, 'frozen');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // ── Krasch-checkpoint. En lådpaus behöver ingen: lådan räknar den själv
  // och laddar upp den när den är klar, oberoende av appen.
  //
  // Skrivs om som en puls, inte en enda gång vid start. En tvångsstängd app
  // får aldrig köra någon kod — ingen städning, inget slutvärde — så utan
  // pulsen kunde återställningen bara anta att pausen pågått ända fram till
  // nästa appstart, och en paus som dödades efter två minuter loggades som
  // timmar. Sista skrivningen sker när appen lämnar förgrunden, eftersom JS
  // fryser strax därefter och intervallet då slutar ticka. ──
  useEffect(() => {
    if (!user?.id || state.phase !== 'active') return;

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
      });
    };

    write();
    const interval = setInterval(() => write(), HEARTBEAT_MS);
    const appStateSub = AppState.addEventListener('change', next => {
      if (next !== 'active') write(restingRef.current);
    });

    return () => { clearInterval(interval); appStateSub.remove(); };
  }, [user?.id, state.phase, state.startedAt]);

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


  // Här bokades förr en notis som gick av när nedräkningen tog slut. Appen
  // skickar inga notiser längre, så en nedräkning som löper ut med skärmen
  // släckt når ingen förrän appen väcks igen — auto-avslutet nedan kör först
  // då. Det är en känd följd av borttagningen, inte en lucka.

  // ── Regulate-nedräkningen tar slut av sig själv ──
  useEffect(() => {
    if (!isRegulate || autoEndFiredRef.current) return;
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

  // ── Sessionen är slut. Bara det lådlösa flödets Supabase-skrivningar sker
  // här — box-ursprung är redan sparat (SessionContext skrev till outboxen
  // och ackade innan den dispatchade SESSION_ENDED). Reset och navigering
  // till /pausesummary sköts globalt i _layout.tsx, oavsett vilken skärm
  // som råkar vara monterad när lådan säger att sessionen är slut. ──
  useEffect(() => {
    if (state.phase !== 'ended' || !state.lastEnded || endedHandledRef.current) return;
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
      // Svaret *Yes*: pausdelen slutar en sekund före natten, så att den
      // hamnar på dagen den hör till (dagen räknas på `ended_at`).
      const night = nightSplitRef.current;
      const endMs = night ? night.startMs - 1000 : Date.now();
      const now = new Date(endMs).toISOString();
      // Cirkelns ledger dedupar på pause_sessions-id, så raden måste skrivas
      // klart innan pausen kan räknas in i veckan och i stegen.
      let sessionId: string | null = null;

      // En delad paus skrivs som vilken paus som helst, bara med sitt
      // gemensamma id. Raden finns inte i förväg — inbjudan bor i
      // `pause_invites`, inte i `pause_sessions` (supabase/pause_invites.sql).
      const shared = sharedRef.current;
      // En paus som var natt hela vägen har ingen pausdel att skriva.
      if (user?.id && !state.lastEnded!.night) {
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
          // Appens pauser är alltid telefonens egna. `with_pod = true`
          // skrivs bara av `record_box_session()` på servern.
          with_pod: false,
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
      if (!state.lastEnded!.night) await logPause(durationSeconds, 'session', state.category || undefined);
      // Natten: en sömnrad från midnatt (eller starten) till lyftet. Inga
      // uppvaknanden — lyftet avslutade den. Kortare än SLEEP_MIN_SECONDS
      // sparas inte (saveSleepSession).
      if (night && user?.id) {
        await saveSleepSession({
          userId: user.id,
          startedAt: new Date(night.startMs),
          endedAt: new Date(night.endMs),
          durationSeconds: (night.endMs - night.startMs) / 1000,
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

  const finishPause = (how: 'manual' | 'auto' | 'cap' = 'manual') => {
    if (autoEndFiredRef.current) return;
    autoEndFiredRef.current = true;
    // Ett tryck på Finish, till skillnad från en regulate-paus som tar slut
    // av sig själv. Båda ger ett pause_completed i _layout.tsx; bara det ena
    // var ett beslut.
    if (isSleep) track('sleep_finished', { how, duration_seconds: Math.round(elapsedMs / 1000) });
    else track('pause_finished_manually', { duration_seconds: Math.round(elapsedMs / 1000) });

    const end = (durationMs: number, night?: boolean) => dispatch({
      type: 'SESSION_ENDED',
      seq: state.seq ?? '',
      durationMs,
      completed: true,
      night,
    });

    // Natten (se `asksAsleep`). Lyftet är slutet, inte trycket: med Finish
    // hålls telefonen redan uppe, och klockan har stått sedan lyftet.
    const startMs = state.startedAt ?? Date.now();
    const liftMs = state.phase === 'respite' && state.respiteStartedAt ? state.respiteStartedAt : Date.now();
    const overlap = asksAsleep ? nightOverlap(startMs, liftMs) : null;
    if (!overlap || overlap.ms < ASK_ASLEEP_MIN_MS) { end(elapsedMs); return; }

    const elapsedAtFinish = elapsedMs;
    Alert.alert(
      'Were you asleep?',
      'Part of this pause was at night.',
      [
        {
          text: 'No',
          onPress: () => {
            track('pause_asleep_answered', { asleep: false, night_minutes: Math.round(overlap.ms / 60_000) });
            end(elapsedAtFinish);
          },
        },
        {
          text: 'Yes',
          onPress: () => {
            // Natten börjar vid midnatt, eller vid starten om pausen började
            // efter den. Pausdelen räknas bakåt från natten: klockans tid
            // minus nattens, som den alltid gjorts.
            const nightStart = Math.max(startMs, overlap.firstStartMs);
            const dayMs = Math.max(0, elapsedAtFinish - (liftMs - nightStart));
            nightSplitRef.current = { startMs: nightStart, endMs: liftMs, dayMs };
            track('pause_asleep_answered', { asleep: true, night_minutes: Math.round(overlap.ms / 60_000) });
            // Under fem sekunder är det ingen paus — samma golv som återställningen.
            end(dayMs, dayMs < 5000);
          },
        },
      ],
      { cancelable: false },
    );
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
    if (!restingRef.current || !hasRestedRef.current) return;
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
    navBarToggledAtRef.current = Date.now();
    if (state.phase === 'active' && hasRestedRef.current) hideNavBar();
    else showNavBar();
  }, [state.phase]);
  useEffect(() => {
    const off = onNavBarShown(() => {
      if (!appActiveRef.current) return;
      if (Date.now() - navBarToggledAtRef.current < NAV_BAR_SETTLE_MS) return;
      freezeInHand('nav_bar');
    });
    return () => { off(); showNavBar(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const titleText = isSleep ? 'Sleeping...' : isRegulate ? 'Regulate in progress...' : 'Pausing...';
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

      {/* Finish hålls in, som PAUSE: att avsluta är lika avsiktligt som att
          börja, och ett snuddat tryck ska inte ta slut på en paus. */}
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

      {/* Vilan: instruktionen ÄR gesten. Klockan syns kvar så det framgår
          att ingenting gått förlorat, bara stannat. */}
      {state.phase === 'respite' && (
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
