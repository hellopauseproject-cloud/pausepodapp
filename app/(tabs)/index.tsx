import { FontAwesome, FontAwesome5 } from '@expo/vector-icons';
import { useAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useIsFocused } from '@react-navigation/native';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Animated, Easing, Image, Keyboard, Modal, Platform, Pressable, StyleSheet, Text,
  TouchableOpacity, useWindowDimensions, View,
} from 'react-native';
import Reanimated, {
  Easing as REasing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming,
} from 'react-native-reanimated';
import { CelebrationBurst } from '../../components/celebration-burst';
import { DurationWheel } from '../../components/duration-wheel';
import { HabitGoalsEditor, HabitPicker } from '../../components/habit-goals-editor';
import { HoldToStartButton } from '../../components/hold-to-start-button';
import { LiquidBars } from '../../components/liquid-bars';
import { ProgressArc } from '../../components/progress-arc';
import { GLOBAL_PAUSE_LINE_H, GlobalPauseLine } from '../../components/global-pause-line';
import { PauseAmbience } from '../../components/pause-ambience';
import { PausePodLogo } from '../../components/pause-pod-logo';
import { PauseButtonFace } from '../../components/pause-button-face';
import { PauseInviteRow } from '../../components/pause-invite-row';
import { PauseTagSheet } from '../../components/pause-tag-sheet';
import { roomShell, ScreenBackground } from '../../components/screen-background';
import { NoteRect, TodoPostIt, TodoSheet } from '../../components/todo-sheet';
import { AppPalette, Radius, Spacing } from '../../constants/appTheme';
import { useAuth } from '../../contexts/AuthContext';
import { RoomProvider, usePalette } from '../../contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  formatDuration, getDailyGoalProgress, getMyCircles,
  GOAL_OPTIONS, nearestGoalIndex, setDailyGoal,
} from '../../lib/circles';
import { applyPendingDailyGoal, isIntroDeferred } from '../../lib/introPrefs';
import { HOLD_TO_START_MS, SHOW_PAUSE_SETUP_VIEW, startPhonePause } from '../../lib/pauseFlow';
import { PendingPauseTag, takePendingPauseTag } from '../../lib/pauseTags';
import { chooseHomeMode, HomeMode, isNightHours, refreshHomeMode, useHomeMode } from '../../lib/homeMode';
import { startSleep } from '../../lib/sleep';
import { NightMoon } from '../../components/night-moon';
import { SegmentedPill } from '../../components/segmented-pill';
import { supabase } from '../../lib/supabase';
import { setCachedMyProfile } from '../../lib/myProfile';
import { getTodos, Todo } from '../../lib/todos';
import { getHabitProgress, HabitGoal, habitsChanged, setHabitGoals } from '../../lib/habits';
import { Category, getAllCategories, getSelectedCategories } from '../pauseLogger';
import { countReadyEnvelopes } from '../../lib/supportSealed';
import type { DailyGoalProgress } from '../../types/database';

// Att göra-listan är tillbaka, men som en lapp som sticker upp i nedre
// vänstra hörnet i stället för lakanet som tog hela botten (se
// components/todo-sheet.tsx). Den ligger under PAUSE-knappens golv, så
// heronens räkning nedan behöver inte veta om den.

// ── Taggkortet efter en paus ──────────────────────────────────────────────
// En ensam paus slutar här (app/pausesummary.tsx lämnar en lapp och byter sig
// själv mot Hem, se lib/pauseTags.ts). Kortet glider upp underifrån och heron
// lyfts så mycket som behövs för att siffran och målraden ska synas ovanför
// det — aldrig mer än luften ovanför heron räcker till.
const TAG_SLIDE_MS = 550;
const TAG_EASING = REasing.bezier(0.2, 0.8, 0.2, 1);
// Minsta luft mellan målraden och kortets överkant när heron lyfts.
const TAG_CLEARANCE = 12;
// Hur länge efter att lappen lästs dagens siffra hämtas om. Pausens rad
// skrivs av pausskärmen i samma stund som rutten byts, så den första
// läsningen vid fokus kan komma före raden.
const DAILY_REFRESH_MS = 1500;
// Kortet frågar bara om pauser på minst en minut — samma gräns som
// sammanfattningen hade.
const TAG_MIN_SECONDS = 60;
// Hur länge siffran räknar upp efter en paus. Lite längre än ringens egen
// glidning (`UPDATE_MS` 600 i progress-arc), så att siffran landar sist och
// skuren går när allt stått still.
const COUNT_UP_MS = 900;

// ── Heronens mått räknas ur den yta som faktiskt finns ────────────────────
// Ringen (numera två streck) är sidans huvudsak, men hur stor den FÅR vara
// avgörs av höjden: under den står PAUSE-knappen, och under knappen
// flikraden.
//
// Talen stod förr fast (ring 280, stroke 14, gap 56, `HERO_DROP` 74) med ett
// enda hopp vid 760 px fönster, och räkningen var gjord för hand mot en
// 844 px skärm, utan att dra av flikraden — och därför hamnade PAUSE-knappen
// under det dåvarande lakanet på varje iPhone. Nu mäts containern i stället
// (`onLayout`): flikraden, hemstrecket och statusfältet är redan borträknade
// av den som vet, alltså layouten. Knappen och golvet får sitt FÖRST, och
// strecken tar vad som blir kvar, aldrig mer än `RING_MAX`.
// Containerns paddingTop på Android. På iPhone växer den med statusfältet
// (47–62 pt mot Androids ~24–32), se `topPad` i skärmen.
const TOP_PAD = 60;
const BOTTOM_PAD = 40;     // containerns paddingBottom
const TOPBAR_H = 44;       // ikonknapparnas höjd, alltså topbarens
// Luft mellan "HI NAMN" och ringen. Var 8 och höjdes så att hälsningen
// står en bit ovanför ringen och inte klistrad mot den.
const EYEBROW_GAP = 22;
const EYEBROW_H = 16 + EYEBROW_GAP; // "HI NAMN" + dess marginal
const PAUSE_BTN_H = 58;    // utskriven höjd, se `pauseButton`
const GOAL_MET_H = 28;     // `GOAL REACHED` + dess marginal
const NIGHT_TITLE_H = 44;  // *Ready for bed?* under månen: 28 + marginTop 16
const SET_GOAL_BTN_H = 46; // `Set a daily goal` / `Finish setting up`
// Blocket står inte exakt i mitten av ytan: PAUSE ska inte hamna för långt ner,
// så ytan räknas så här mycket kortare nedtill.
const BLOCK_LIFT = 64;
// Luften mellan topbaren och platsen för Global Pause-raden.
const GLOBAL_LINE_GAP = 12;
const RING_MAX = 280;
// Golvet är läsbarhetens: under det är siffran inte ett mått längre.
const RING_MIN = 150;
// Sista utvägen på de allra kortaste skärmarna, hellre än att blocket spiller
// ut under flikraden.
const RING_FLOOR = 120;
// Luften mellan målraden och PAUSE-knappen. Sedan att göra-lakanet försvann
// finns höjden att ge, och blocket står CENTRERAT med jämnare luft mellan
// strecken, siffran, målraden och knappen — knappen ska vara sitt eget steg,
// inte klistrad mot målraden. Gapet växer med skärmen inom spannet.
const HERO_GAP_MAX = 56;
const HERO_GAP_MIN = 36;
// Minsta luft mellan PAUSE-knappen och flikraden — golvet, inte ett läge:
// blocket står centrerat och luften som blir över delas lika över och under.
const MIN_BOTTOM_GAP = 16;
// Minsta luft mellan topbaren och hälsningen.
const MIN_TOP_GAP = 8;

// Siffrans rad under strecken. `hero.ring` är hela blockets höjd — strecken
// plus siffran plus målraden — så de här talen måste stämma med `dailyBig`
// och `goalStepper`, annars blir blocket högre än räkningen tror.
const READOUT_GAP = 18;    // luft mellan strecken och siffran
const BIG_LINE = 1.15;     // siffrans lineHeight som andel av fontSize
const STEPPER_TOP = 14;    // luft mellan siffran och målraden
const STEPPER_H = 32 + STEPPER_TOP; // `goalStepper`: knapparna 32 + marginTop
// Hur länge målet väntar efter sista trycket på − eller + innan det sparas.
const GOAL_SAVE_DELAY_MS = 700;
// Designens streck: 78 breda, 214 höga, och ett streck isär som appikonen.
const BAR_W_RATIO = 78 / 214;
const BAR_GAP_RATIO = 78 / 214;
// Golvet för strecken: under det är de ett tecken och inte ett mått.
const BARS_MIN_H = 80;

// Ringen i stället för strecken — samma ring som Kretsens (`HeroRing` i
// app/(tabs)/circle.tsx), med siffran inuti. `false` ger tillbaka strecken.
const HOME_RING_VIEW = true;
// Ett tryck på ringen öppnar målratten, och då står målet INUTI ringen
// (`of 1h`) och raden `− 1h +` under den visas inte. `false` ger tillbaka
// raden. Gäller bara ringen; strecken har alltid raden.
const RING_OPENS_GOAL = true;
const ringOpensGoal = HOME_RING_VIEW && RING_OPENS_GOAL;
// Kretsens ring är 210 med strecket 14 och siffran 34 / enheten 17; Hem
// skalar samma proportioner med sin uppmätta storlek.
const RING_STROKE_RATIO = 14 / 210;
const RING_BIG_RATIO = 34 / 210;
const RING_UNIT_RATIO = 17 / 210;
// Ringen tar inte hela blocket: den fick en gång allt och kändes för stor.
// Andelen av den plats som finns, och ett tak på de största skärmarna.
const HOME_RING_SCALE = 0.8;
const HOME_RING_MAX = 230;

// ── Dag och natt ──────────────────────────────────────────────────────────
// Kapseln ovanför hälsningen byter Hem mellan dagsmålet och nattmålet
// (lib/homeMode.ts, lib/sleep.ts). Den står alltid där, så den räknas in i
// heronens extras som vilken rad som helst — annars äter den golvet.
const MODE_PILL_W = 200;
const MODE_PILL_GAP = 18;
const MODE_PILL_H = 38 + MODE_PILL_GAP; // segmented-pill.tsx: HEIGHT 38
const MODE_OPTIONS: [{ key: HomeMode; label: string }, { key: HomeMode; label: string }] = [
  { key: 'day', label: 'Day' },
  { key: 'night', label: 'Night' },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type HeroMetrics = {
  area: number; ring: number; gap: number;
  /** Luft som blir över ovanför hälsningen — det heron kan lyftas med. */
  slack: number;
  bigFont: number; unitFont: number;
};

/**
 * `measuredArea` är ytan mellan topbaren och containerns innerkant nedtill,
 * `extras` höjden på de rader som bara finns ibland. Extras ingår med flit:
 * utan dem äter `GOAL REACHED` eller puffen just den luft som golvet är.
 */
function heroMetrics(measuredArea: number, frameW: number, extras: number): HeroMetrics {
  const area = Math.max(0, measuredArea);
  // Vad strecken och gapet får dela på när golvet uppåt och nedåt är betalt.
  const budget = area - MIN_TOP_GAP - MIN_BOTTOM_GAP - EYEBROW_H - PAUSE_BTN_H - extras;
  // Gapet krymper före strecken: strecken är det man kom för.
  const gap = clamp(budget - RING_MIN, HERO_GAP_MIN, HERO_GAP_MAX);
  // Höjden avgör nästan alltid, men spalten är det andra taket.
  const column = Math.max(RING_FLOOR, frameW - 2 * Spacing.xl);
  let ring = Math.min(clamp(budget - gap, RING_MIN, RING_MAX), column);
  let slack = area - (MIN_TOP_GAP + EYEBROW_H + ring + gap + PAUSE_BTN_H + extras + MIN_BOTTOM_GAP);
  if (slack < 0) {
    // Kortare skärm än blocket. Strecken betalar, ner till `RING_FLOOR`.
    const shrunk = Math.max(RING_FLOOR, ring + slack);
    slack += ring - shrunk;
    ring = shrunk;
  }
  return {
    area,
    ring,
    gap,
    slack: Math.max(0, slack),
    // Siffran skalar med blocket (42 vid 280). Golvet ligger långt över
    // typskalans 11.
    bigFont: clamp(Math.round(ring * 0.15), 23, 42),
    unitFont: clamp(Math.round(ring * 0.057), 12, 16),
  };
}

// Siffran ska gå att läsa som ett tal och inte som en mening: värdet i
// displayvikt, enheten liten bredvid. `formatDuration` ger dessutom "0s" för
// en dag som inte börjat — ett svar som ser ut som ett fel.
function heroAmount(seconds: number): { value: string; unit: string } {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return { value: String(m), unit: 'min' };
  if (m === 0) return { value: String(h), unit: 'h' };
  return { value: `${h}h ${m}`, unit: 'min' };
}

/**
 * Rummet ligger i ett eget skal runt skärmen och inte inne i den, av två skäl.
 *
 * Det ena är att en komponent inte kan läsa sin egen provider, och
 * `HomeScreen` behöver paletten för det blå rummet redan på sin första rad.
 *
 * Det andra är att bakgrunden hör till rummet och inte till skärmen: ligger
 * den här täcker den **varje** gren skärmen kan returnera — laddning, tomvy,
 * innehåll — utan att någon av dem behöver minnas att rita den. Samma mönster
 * i alla tre flikarna.
 */
export default function HomeRoom() {
  // Nattläget flyttar Hem till `night`-rummet — samma rum som pausen och
  // natten själv pågår i, mörkt i båda lägena (se lib/homeMode.ts).
  const room = useHomeMode() === 'night' ? 'night' : 'pause';
  // Statusraden tvingas ljus i nattrummet, som på pausskärmen. Bara medan
  // fliken har fokus: flikar avmonteras inte, och en kvarlämnad ljus
  // statusrad hade gjort den osynlig över Kretsen i ljust läge.
  const focused = useIsFocused();
  return (
    <RoomProvider room={room}>
      <View style={roomShell}>
        {room === 'night' && focused && <StatusBar style="light" />}
        <ScreenBackground room={room} />
        <HomeScreen />
      </View>
    </RoomProvider>
  );
}

function HomeScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const { user } = useAuth();
  const [userName, setUserName] = useState('');
  // Bara HTTPS-URLer duger som avatar: en lokal sökväg är enhetsspecifik och
  // pekar på ingenting på en annan installation. Samma kontroll som
  // app/profile.tsx gör när den läser samma kolumn.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // Dagens siffra och dagens mål. Strecken visas för alla som satt ett mål,
  // med eller utan krets — se `loadDaily` för var talen kommer ifrån i de
  // två lägena. Null betyder att hämtningen inte gick igenom (nät, utloggad);
  // ett svar med `daily_target_seconds: null` betyder att inget mål är satt.
  // I båda fallen står rubriken kvar i stället för tomma streck.
  const [daily, setDaily] = useState<DailyGoalProgress | null>(null);
  // Bara till för uppmaningen under rubriken: den som är med i en krets får
  // samma uppmaning på kretsfliken, och två av dem hade varit en för många.
  const [inCircle, setInCircle] = useState(false);
  const [circleCount, setCircleCount] = useState(0);
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [goalIndex, setGoalIndex] = useState(() => nearestGoalIndex(3600));
  const [savingGoal, setSavingGoal] = useState(false);
  // Vanorna i samma ruta (lib/habits.ts). `savedHabits` är det som låg i
  // basen när rutan öppnades, så att knappen bara skriver dem när något
  // ändrats; `habitDays` är veckans räkning för de sparade.
  const [habitDraft, setHabitDraft] = useState<HabitGoal[]>([]);
  const [savedHabits, setSavedHabits] = useState<HabitGoal[]>([]);
  const [habitDays, setHabitDays] = useState<Record<string, number>>({});
  const [habitCats, setHabitCats] = useState<Category[]>([]);
  // Väljaren byter rutans innehåll, se `HabitPicker`.
  const [habitPicking, setHabitPicking] = useState(false);
  // *Your own* har textfält, och rutan står mitt på skärmen där tangentbordet
  // annars lägger sig över den. Höjden ur `Keyboard`-händelserna, som
  // att göra-arket: med `edgeToEdgeEnabled` gör KeyboardAvoidingView
  // ingenting på Android.
  const [goalKeyboardH, setGoalKeyboardH] = useState(0);
  useEffect(() => {
    if (!showGoalModal) return;
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      e => setGoalKeyboardH(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setGoalKeyboardH(0),
    );
    return () => { show.remove(); hide.remove(); setGoalKeyboardH(0); };
  }, [showGoalModal]);

  const { height: windowH, width: windowW } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topPad = Math.max(TOP_PAD, insets.top + 8);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(24)).current;
  const greetingAnim = useRef(new Animated.Value(0)).current;
  const floatAnim = useRef(new Animated.Value(0)).current;

  useFocusEffect(
    useCallback(() => {
      if (!user?.id) return;
      const loadProfile = async () => {
        const { data } = await supabase
          .from('profiles')
          .select('username, avatar_url')
          .eq('id', user.id)
          .maybeSingle();
        setUserName(data?.username ?? '');
        setAvatarUrl(data?.avatar_url?.startsWith('https://') ? data.avatar_url : null);
        if (data) setCachedMyProfile(user.id, { username: data.username ?? '', avatar_url: data.avatar_url ?? null });
      };
      loadProfile();
    }, [user?.id])
  );

  /**
   * Dagens två tal, ur `get_daily_goal_progress()` — de egna `pause_sessions`
   * mot `profiles.daily_target_seconds`.
   *
   * Med krets kom dagen förr ur `get_circle_progress()` (alltså ur
   * `circle_pause_ledger`), så att Hem och kretsfliken aldrig kunde säga olika.
   * Sedan man kan vara med i upp till tre kretsar finns ingen enskild
   * "kretsens dag" att visa här, och ringen är ändå ens eget tal. Den enda
   * skillnaden mot en krets brickor är dagen man går med: ledgern räknar bara
   * det som hänt som medlem. Dagsmålsnotisen räknar på samma källa som ringen.
   *
   * Kretsen avgör fortfarande en sak: om *Set a daily goal* syns (`inCircle`).
   */
  const loadDaily = useCallback(async () => {
    if (!user?.id) return;

    const read = async (): Promise<DailyGoalProgress | null> => {
      const [d, circles] = await Promise.all([getDailyGoalProgress(), getMyCircles(user.id)]);
      setInCircle(circles.length > 0);
      setCircleCount(circles.length);
      setDaily(d);
      return d;
    };

    const d = await read();

    // Målet som introduktionen frågade om ligger parkerat lokalt tills det
    // finns någonstans att skriva det (lib/introPrefs.ts). Ett omtag, och
    // bara när något faktiskt skrevs.
    if (d && d.daily_target_seconds === null && (await applyPendingDailyGoal(null))) {
      return read();
    }
    return d;
  }, [user?.id]);
  const dailyRef = useRef(daily);
  dailyRef.current = daily;

  useFocusEffect(useCallback(() => { loadDaily(); }, [loadDaily]));

  // ── Natten ───────────────────────────────────────────────────────────────
  // Nattläget visar ingenting om natten som gått — det bor i statistiken
  // (SLEEP-sektionen och nattkorten). Sidan finns för SLEEP-knappen, och
  // månen ovanför den säger vilken sida man står på (components/night-moon.tsx).
  //
  // Läget följer klockan vid varje fokus, om inget eget val är färskt.
  const homeMode = useHomeMode();
  const isNight = homeMode === 'night';
  // Mellan midnatt och fem går det inte att välja dagen (lib/homeMode.ts).
  // Läget prövas också en gång i minuten medan Hem har fokus, så att en
  // skärm som står öppen över midnatt byter av sig själv.
  const nightLocked = isNightHours();
  useFocusEffect(useCallback(() => {
    refreshHomeMode();
    const id = setInterval(refreshHomeMode, 60_000);
    return () => clearInterval(id);
  }, []));

  // Den egna listan, för lappen. Arket hämtar själv när det öppnas och
  // skickar tillbaka varje ändring, så de två visar alltid samma lista.
  const [todos, setTodos] = useState<Todo[]>([]);
  const [showTodos, setShowTodos] = useState(false);
  // Lappens ruta vid trycket — arket växer fram ur den.
  const [todoOrigin, setTodoOrigin] = useState<NoteRect | null>(null);
  useFocusEffect(useCallback(() => {
    if (!user?.id) return;
    getTodos(user.id).then(setTodos).catch(() => {});
  }, [user?.id]));

  /**
   * Vägen tillbaka in i introduktionen för den som sköt upp den. Läses vid
   * varje fokus, för fliken avmonteras inte när man byter flik.
   */
  const [introDeferred, setIntroDeferred] = useState(false);
  useFocusEffect(useCallback(() => {
    isIntroDeferred().then(setIntroDeferred);
  }, []));

  /**
   * *Your envelope is ready*: förseglat stöd som en paus just låst upp
   * (supabase/support_sealed.sql). Läses vid fokus och en gång till efter
   * 2,5 s — Hem får fokus direkt efter pausen, innan pausens rad landat och
   * triggern hunnit låsa upp kuvertet.
   */
  const [envelopesReady, setEnvelopesReady] = useState(0);
  useFocusEffect(useCallback(() => {
    if (!user?.id) return;
    let alive = true;
    const check = () => countReadyEnvelopes(user.id).then(n => { if (alive) setEnvelopesReady(n); });
    check();
    const t = setTimeout(check, 2500);
    return () => { alive = false; clearTimeout(t); };
  }, [user?.id]));

  // ── Efter en paus ────────────────────────────────────────────────────────
  // Lappen från sammanfattningen läses vid fokus, en gång. Klockan ringer
  // (den ringde förr på sammanfattningen), dagens siffra hämtas om när
  // pausens rad hunnit landa — strecken stiger med det man vann tillbaka —
  // och kortet öppnas om pausen saknar intention.
  const bellPlayer = useAudioPlayer(require('../../assets/images/Bell.mp3'));
  const [tag, setTag] = useState<PendingPauseTag | null>(null);
  const [tagSheetH, setTagSheetH] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useReducedMotion();

  // ── Belöningen när man kommer tillbaka ──
  // Användarna tyckte att återkomsten var platt: siffran bytte tyst. Nu står
  // dagens förra summa kvar (`countHold`) tills pausens rad landat, och
  // sedan räknar siffran upp till den nya medan ringen glider efter. När
  // räkningen landar kommer en haptik och en skur ur ringen — en större om
  // pausen tog en över dagsmålet, den enda verkliga milstolpen här. Med
  // reducerad rörelse hoppar siffran direkt och skuren uteblir; haptiken
  // står kvar.
  //
  // Startvärdet är `daily` som det stod när Hem senast visades, alltså före
  // pausen — flikar avmonteras inte. Finns inget (första visningen) räknas
  // ingenting upp.
  const [countHold, setCountHold] = useState<number | null>(null);
  const [countShown, setCountShown] = useState<number | null>(null);
  const [homeBurst, setHomeBurst] = useState(0);
  const [burstBig, setBurstBig] = useState(false);
  const countRaf = useRef<number | null>(null);
  const celebrate = useCallback((from: number | null, d: DailyGoalProgress | null) => {
    setCountHold(null);
    if (countRaf.current != null) cancelAnimationFrame(countRaf.current);
    const finish = (crossed: boolean) => {
      setCountShown(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setBurstBig(crossed);
      setHomeBurst(k => k + 1);
    };
    if (from == null || !d || d.today_seconds <= from) {
      setCountShown(null);
      if (d) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      return;
    }
    const to = d.today_seconds;
    const target = d.daily_target_seconds;
    const crossed = !!target && from < target && to >= target;
    if (reduceMotion) { finish(crossed); return; }
    const start = Date.now();
    const tick = () => {
      const k = Math.min(1, (Date.now() - start) / COUNT_UP_MS);
      const eased = 1 - Math.pow(1 - k, 3);
      setCountShown(Math.round(from + (to - from) * eased));
      if (k < 1) countRaf.current = requestAnimationFrame(tick);
      else { countRaf.current = null; finish(crossed); }
    };
    countRaf.current = requestAnimationFrame(tick);
  }, [reduceMotion]);
  useEffect(() => () => { if (countRaf.current != null) cancelAnimationFrame(countRaf.current); }, []);

  useFocusEffect(useCallback(() => {
    const p = takePendingPauseTag();
    if (!p) return;
    // Efter en delad paus har klockan redan ringt på sammanfattningen.
    if (p.bell) {
      try { bellPlayer.seekTo(0); bellPlayer.play(); } catch { /* ljudet är en bonus */ }
    }
    const from = dailyRef.current?.today_seconds ?? null;
    setCountHold(from);
    setCountShown(from);
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      loadDaily().then(d => celebrate(from, d ?? null)).catch(() => celebrate(null, null));
    }, DAILY_REFRESH_MS);
    if (!p.alreadyTagged && p.durationSeconds >= TAG_MIN_SECONDS) setTag(p);
  }, [bellPlayer, loadDaily, celebrate]));
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  const tagIn = useSharedValue(0);
  useEffect(() => {
    if (!tag) return;
    tagIn.value = reduceMotion ? 1 : withTiming(1, { duration: TAG_SLIDE_MS, easing: TAG_EASING });
  }, [tag, reduceMotion, tagIn]);
  const closeTag = useCallback(() => {
    if (reduceMotion) { tagIn.value = 0; setTag(null); return; }
    tagIn.value = withTiming(0, { duration: TAG_SLIDE_MS * 0.7, easing: TAG_EASING });
    setTimeout(() => setTag(null), TAG_SLIDE_MS * 0.7);
  }, [reduceMotion, tagIn]);

  // ── Målet i steg ─────────────────────────────────────────────────────────
  // Ett tryck på − eller + byter siffran och strecken direkt (`goalDraft`),
  // men sparar först när trycken slutat komma: fem snabba tryck är EN
  // skrivning, inte fem RPC:er och fem omräknade dagspåminnelser. Sparningen
  // går genom samma `setDailyGoal()` som ratten, så spårningen och
  // påminnelsen följer med av sig själva.
  const [goalDraft, setGoalDraft] = useState<number | null>(null);
  const goalDraftRef = useRef<number | null>(null);
  const goalSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownTarget = goalDraft ?? daily?.daily_target_seconds ?? null;

  const saveGoalDraft = useCallback(async () => {
    goalSaveTimer.current = null;
    const seconds = goalDraftRef.current;
    if (seconds === null) return;
    try {
      await setDailyGoal(seconds);
      await loadDaily();
    } catch (e: any) {
      Alert.alert('Could not save goal', e.message);
    } finally {
      // Har fingret hunnit trycka igen under sparningen står det nya utkastet
      // kvar och sparas av sin egen timer.
      if (goalDraftRef.current === seconds && !goalSaveTimer.current) {
        goalDraftRef.current = null;
        setGoalDraft(null);
      }
    }
  }, [loadDaily]);

  // Nästa steg uppåt eller nedåt från det som visas — inte från närmaste
  // steg, så att ett äldre mål mellan två steg (1h 30min) går till 1h eller
  // 2h och aldrig hoppar över ett.
  const stepGoal = (dir: 1 | -1) => {
    const current = goalDraftRef.current ?? daily?.daily_target_seconds;
    if (!current) return;
    const next = dir > 0
      ? GOAL_OPTIONS.find(s => s > current)
      : [...GOAL_OPTIONS].reverse().find(s => s < current);
    if (next === undefined) return;
    Haptics.selectionAsync();
    goalDraftRef.current = next;
    setGoalDraft(next);
    if (goalSaveTimer.current) clearTimeout(goalSaveTimer.current);
    goalSaveTimer.current = setTimeout(saveGoalDraft, GOAL_SAVE_DELAY_MS);
  };

  // Lämnas skärmen medan en sparning väntar skickas den direkt i stället för
  // att tappas.
  useEffect(() => () => {
    if (!goalSaveTimer.current) return;
    clearTimeout(goalSaveTimer.current);
    const seconds = goalDraftRef.current;
    if (seconds) setDailyGoal(seconds).catch(() => {});
  }, []);

  const canLowerGoal = !!shownTarget && GOAL_OPTIONS.some(s => s < shownTarget);
  const canRaiseGoal = !!shownTarget && GOAL_OPTIONS.some(s => s > shownTarget);

  // Ringen och bocken står kvar på dagens förra summa medan belöningen väntar
  // på pausens rad; siffran följer räkningen uppåt (se `celebrate`).
  const todayRing = countHold ?? daily?.today_seconds ?? 0;
  const todayShown = countShown ?? daily?.today_seconds ?? 0;
  const dailyFraction = daily && shownTarget ? todayRing / shownTarget : 0;
  const goalMet = !!daily && !!shownTarget && todayRing >= shownTarget;

  // Containerns uppmätta mått. Noll tills första layouten landat, och det är
  // ofarligt: heron ligger bakom `greetingAnim`, som står på 0 tills
  // inledningens 800 ms är över.
  const [frameH, setFrameH] = useState(0);
  const [frameW, setFrameW] = useState(0);
  // *Keep holding* svävar under PAUSE och tar ingen plats, så den räknas
  // inte in här (se components/hold-to-start-button.tsx).
  // Inbjudningsraden ovanför PAUSE har fast höjd och står bara i dagläge —
  // natten är privat och har ingen inbjudan.
  const showInviteRow = !isNight && !!user?.id;
  const heroExtras = MODE_PILL_H
    + (isNight ? NIGHT_TITLE_H : goalMet ? GOAL_MET_H : 0)
    + (introDeferred ? SET_GOAL_BTN_H : 0)
    + (envelopesReady > 0 && !isNight ? SET_GOAL_BTN_H : 0);
  // Ytan mäts från blockets egen överkant (`centerY`) ner till containerns
  // innerkant. Innan båda landat gäller en räkning ur fönstret.
  const [centerY, setCenterY] = useState(0);
  const heroArea = centerY && frameH
    ? frameH - BOTTOM_PAD - centerY - BLOCK_LIFT
    : Math.round(windowH * 0.82) - topPad - TOPBAR_H - BOTTOM_PAD - BLOCK_LIFT;
  const hero = useMemo(
    () => heroMetrics(heroArea, frameW || windowW, heroExtras),
    [heroArea, frameW, windowW, heroExtras],
  );

  // Strecken ovanför siffran: blockets höjd minus siffrans rad och målraden.
  // Bredd och mellanrum skalar med höjden i designens proportioner.
  const heroBars = useMemo(() => {
    const readout = READOUT_GAP + Math.round(hero.bigFont * BIG_LINE) + STEPPER_H;
    const height = Math.max(BARS_MIN_H, hero.ring - readout);
    return {
      height,
      width: Math.round(height * BAR_W_RATIO),
      gap: Math.round(height * BAR_GAP_RATIO),
    };
  }, [hero.ring, hero.bigFont]);

  // Ringen: siffran står inuti, så ringen får en del (`HOME_RING_SCALE`) av
  // blocket utom målraden —
  // och aldrig bredare än spalten.
  const heroRing = useMemo(() => {
    const column = Math.max(RING_FLOOR, (frameW || windowW) - 2 * Spacing.xl);
    const room = Math.min(hero.ring - (ringOpensGoal ? 0 : STEPPER_H), column);
    const size = Math.max(BARS_MIN_H, Math.min(Math.round(room * HOME_RING_SCALE), HOME_RING_MAX));
    return {
      size,
      stroke: Math.max(8, Math.round(size * RING_STROKE_RATIO)),
      bigFont: clamp(Math.round(size * RING_BIG_RATIO), 23, 40),
      unitFont: clamp(Math.round(size * RING_UNIT_RATIO), 12, 20),
    };
  }, [hero.ring, frameW, windowW]);

  // Hur mycket heron lyfts medan taggkortet står uppe: så att målraden står
  // `TAG_CLEARANCE` ovanför kortets överkant, och aldrig mer än luften
  // ovanför hälsningen. Blocket står centrerat, så dess överkant ligger halva
  // överskottet in i ytan; målradens underkant är blockets nederkant minus
  // knappen, hållraden och gapet.
  // Ringen fyller inte blocket, så blockets verkliga höjd räknas ur den.
  const bodyH = HOME_RING_VIEW ? heroRing.size + (ringOpensGoal ? 0 : STEPPER_H) : hero.ring;
  const blockH = EYEBROW_H + bodyH + hero.gap + PAUSE_BTN_H + heroExtras;
  const blockTop = centerY + Math.max(0, (hero.area - blockH) / 2);
  // Global Pause-raden står mitt emellan topbaren och Day/Night (blockets
  // överkant). Platsen den tar i flödet (`globalLine`) står kvar, så att
  // blocket under inte flyttar sig; raden själv svävar i mitten av luften.
  const topbarBottom = centerY - GLOBAL_PAUSE_LINE_H - GLOBAL_LINE_GAP;
  const bannerTop = centerY
    ? Math.max(topbarBottom, (topbarBottom + blockTop) / 2 - GLOBAL_PAUSE_LINE_H / 2)
    : topbarBottom + GLOBAL_LINE_GAP;
  // Inbjudningsraden står mellan målraden och knappen, så den räknas bort här
  // också — annars lyfts heron raden högre än den behöver.
  const readoutBottom = blockTop + blockH - PAUSE_BTN_H - hero.gap;
  const roomAbove = Math.max(0, blockTop - centerY - MIN_TOP_GAP);
  const tagTop = frameH - tagSheetH;
  const tagLift = tag && tagSheetH ? clamp(readoutBottom + TAG_CLEARANCE - tagTop, 0, roomAbove) : 0;

  const heroLiftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -tagLift * tagIn.value }],
  }), [tagLift]);
  const pauseFadeStyle = useAnimatedStyle(() => ({ opacity: 1 - tagIn.value }));
  const tagSheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - tagIn.value) * (tagSheetH + 40) }],
  }), [tagSheetH]);

  // Ratten finns kvar på Hem för det FÖRSTA målet (*Set a daily goal*): utan
  // mål finns inget tal att stega ifrån. Därefter är det − och + under
  // siffran som ändrar det. Utan mål än öppnar ratten på en timme.
  const openGoalModal = () => {
    setGoalIndex(nearestGoalIndex(daily?.daily_target_seconds ?? 3600));
    setHabitPicking(false);
    setShowGoalModal(true);
    // Vanorna hämtas när rutan öppnas, inte vid fokus: de syns bara här.
    // Valbara är de intentioner pausskärmen erbjuder, plus de som redan är
    // en vana även om de valts bort i profilen sedan — annars saknade raden
    // sin emoji.
    Promise.all([getHabitProgress(), getSelectedCategories(), getAllCategories()])
      .then(([progress, offered, all]) => {
        const goals = progress.map(({ category_id, label, times_per_week }) => ({ category_id, label, times_per_week }));
        setSavedHabits(goals);
        setHabitDraft(goals);
        setHabitDays(Object.fromEntries(progress.map(p => [p.category_id, p.done_this_week])));
        const extra = all.filter(c => goals.some(g => g.category_id === c.id) && !offered.some(o => o.id === c.id));
        setHabitCats([...offered, ...extra]);
      })
      .catch(() => {});
  };

  const handleSaveGoal = async () => {
    if (savingGoal) return;
    setSavingGoal(true);
    try {
      // Samma RPC som Kretsen sparar med. Den kräver ingen krets: talet bor på
      // profilen, och kretsloggen skrivs bara om det finns en krets att logga i.
      await setDailyGoal(GOAL_OPTIONS[goalIndex]);
      if (habitsChanged(habitDraft, savedHabits)) await setHabitGoals(habitDraft);
      setShowGoalModal(false);
      loadDaily();
    } catch (e: any) {
      Alert.alert('Could not save goal', e.message);
    } finally {
      setSavingGoal(false);
    }
  };

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 800, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
    ]).start(() => {
      Animated.timing(greetingAnim, { toValue: 1, duration: 600, useNativeDriver: true, easing: Easing.out(Easing.cubic) }).start();
    });
  }, []);

  // Knappens svävning. Med reducerad rörelse står den still — den är det enda
  // på sidan som rör sig utan att något hänt.
  useEffect(() => {
    if (reduceMotion) { floatAnim.setValue(0); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, { toValue: -6, duration: 2200, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
        Animated.timing(floatAnim, { toValue: 0, duration: 2200, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, floatAnim]);

  return (
    // Ytterskalet saknar padding, så att taggkortet kan stå kant i kant och
    // dess position inte beror på hur Yoga räknar ett absolut barn mot en
    // förälder med padding. Containern fyller skalet, så de delar koordinater.
    <View style={styles.shell}>
    <View
      style={[styles.container, { paddingTop: topPad }]}
      // Mäter innerhöjden i stället för att räkna fram den ur fönstret: det
      // här talet har flikraden, hemstrecket och statusfältet borträknade.
      onLayout={e => {
        const { height, width } = e.nativeEvent.layout;
        const h = Math.round(height);
        const w = Math.round(width);
        setFrameH(prev => (Math.abs(prev - h) > 1 ? h : prev));
        setFrameW(prev => (Math.abs(prev - w) > 1 ? w : prev));
      }}
    >
      <Animated.View style={[styles.topBar, { opacity: fadeAnim }]}>
        <PausePodLogo />

        <View style={styles.rightButtons}>
          <TouchableOpacity style={styles.iconButton} onPress={() => router.push('/stats')}>
            <FontAwesome name="bar-chart" size={18} color={Palette.accent} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconButton}
            accessibilityLabel="Settings"
            onPress={() => router.push('/onboarding')}
          >
            <FontAwesome name="cog" size={21} color={Palette.accent} />
          </TouchableOpacity>
          {/* Egen profil sist i raden, och bilden är knappen: finns det ett
              ansikte är det den snabbaste ledtråden om vems konto man tittar
              på. Utan uppladdad bild faller den tillbaka på silhuetten. */}
          <TouchableOpacity
            style={styles.iconButton}
            accessibilityLabel="My profile"
            onPress={() => router.push('/profile')}
          >
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatarThumb} />
            ) : (
              <FontAwesome5 name="user-circle" size={18} color={Palette.accent} solid />
            )}
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* Raden för den globala pausen. Platsen står kvar i nattläge, så att
          blocket inte hoppar när läget byts. Den ligger över blocket och inte
          i det: `centerY` mäts under den, så ytan räknas rätt av sig själv. */}
      <View style={styles.globalLine} />
      {showInviteRow && centerY > 0 && (
        <Reanimated.View
          style={[styles.globalLineFloat, { top: bannerTop }, pauseFadeStyle]}
          pointerEvents={tag ? 'none' : 'box-none'}
        >
          <GlobalPauseLine />
        </Reanimated.View>
      )}

      {/* Höjden är ytan mellan topbaren och containerns nederkant, uppmätt och
          inte gissad. Blocket står centrerat i den, så luften som blir över
          delas lika över och under. Medan taggkortet står uppe lyfts det. */}
      <Reanimated.View
        style={[
          styles.center,
          frameH
            ? { height: hero.area, justifyContent: 'center' }
            : { flex: 1 },
          { gap: hero.gap },
          heroLiftStyle,
        ]}
        // Bara överkanten läses: höjden sätts av räkningen ovan, så att
        // läsa den här vore en slinga. Transformen påverkar inte måttet.
        onLayout={e => {
          const y = Math.round(e.nativeEvent.layout.y);
          setCenterY(prev => (Math.abs(prev - y) > 1 ? y : prev));
        }}
      >
        <Animated.View style={{
          alignItems: 'center',
          opacity: greetingAnim,
          transform: [{ translateY: Animated.multiply(greetingAnim, new Animated.Value(-1)).interpolate({ inputRange: [-1, 0], outputRange: [12, 0] }) }]
        }}>
          {/* Dag eller natt. Ett val och inte en etikett — samma kapsel som
              Kretsens *This week / Today*. */}
          {/* Efter midnatt finns inget val (lib/homeMode.ts `isNightHours`):
              kapseln står kvar men har bara natten, så att sidan inte hoppar. */}
          <View style={styles.modePill}>
            <SegmentedPill
              options={MODE_OPTIONS}
              value={homeMode}
              onChange={chooseHomeMode}
              width={MODE_PILL_W}
              disabled={nightLocked ? ['day'] : undefined}
            />
          </View>
          {userName ? (
            <Text style={styles.eyebrow}>HI {userName.toUpperCase()}</Text>
          ) : null}
          {/* Natten: en måne och en fråga. Ingen siffra, ingen klocka och
              inga uppvaknanden — det står i statistiken. Sidan finns för
              SLEEP-knappen under, och natten är privat (supabase/sleep.sql). */}
          {isNight ? (
            <>
              <NightMoon size={heroRing.size} color={Palette.textPrimary} glow={Palette.hue} />
              {/* Höjden ingår i extras (`NIGHT_TITLE_H`). */}
              <Text style={styles.nightTitle}>Ready for bed?</Text>
            </>
          ) : /* Strecken ERSÄTTER rubriken, staplas inte under den. Krets
                 spelar ingen roll här: målet är personligt
                 (supabase/dailygoal.sql). Utan mål står rubriken kvar, så
                 ingen möts av tomma streck. */
          daily && shownTarget ? (
            <>
              <View
                // När ringen är knappen bär den etiketten själv.
                accessible={!ringOpensGoal}
                accessibilityLabel={`${formatDuration(daily.today_seconds)} of ${formatDuration(shownTarget)} today.${goalMet ? ' Goal reached.' : ''}`}
              >
                {/* Pausens två streck, fyllda med dagen. `hero.ring` är
                    blockets höjd, och strecken får det som blir kvar när
                    siffran och målraden fått sitt (se `heroBars`). */}
                {HOME_RING_VIEW ? (
                  // Samma ring som Kretsen: rummets kulör på ett tonat spår,
                  // fylls från tomt när fliken öppnas. Siffran inuti; målet
                  // står i raden under — eller, när ringen öppnar ratten
                  // (`RING_OPENS_GOAL`), inuti den som `of 1h`.
                  <TouchableOpacity
                    onPress={openGoalModal}
                    disabled={!ringOpensGoal}
                    activeOpacity={0.75}
                    accessibilityRole={ringOpensGoal ? 'button' : undefined}
                    accessibilityLabel={`${formatDuration(daily.today_seconds)} of ${formatDuration(shownTarget)} today.${goalMet ? ' Goal reached.' : ''}`}
                    accessibilityHint={ringOpensGoal ? 'Change your daily goal.' : undefined}
                  >
                  <ProgressArc
                    fraction={dailyFraction}
                    size={heroRing.size}
                    stroke={heroRing.stroke}
                    color={Palette.hue}
                    trackColor={Palette.hueTrack}
                    glow
                  >
                    <View style={[styles.ringCenter, { width: heroRing.size - 2 * (heroRing.stroke + 10) }]}>
                      <Text
                        style={[styles.dailyBig, { fontSize: heroRing.bigFont, lineHeight: Math.round(heroRing.bigFont * BIG_LINE) }]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.6}
                      >
                        {heroAmount(todayShown).value}
                        <Text style={[styles.dailyUnit, { fontSize: heroRing.unitFont }]}>
                          {' '}{heroAmount(todayShown).unit}
                        </Text>
                      </Text>
                      {ringOpensGoal ? (
                        <View style={styles.ringSubRow}>
                          <Text style={styles.ringSub}>of {formatDuration(shownTarget)}</Text>
                          {goalMet && <FontAwesome5 name="check" size={12} color={Palette.hue} />}
                        </View>
                      ) : (
                        goalMet && <FontAwesome5 name="check" size={13} color={Palette.hue} />
                      )}
                    </View>
                  </ProgressArc>
                  </TouchableOpacity>
                ) : (
                <View style={styles.heroBlock}>
                  <LiquidBars
                    fraction={dailyFraction}
                    count={2}
                    barWidth={heroBars.width}
                    height={heroBars.height}
                    gap={heroBars.gap}
                  />
                  <Text
                    style={[
                      styles.dailyBig,
                      { fontSize: hero.bigFont, lineHeight: Math.round(hero.bigFont * BIG_LINE), marginTop: READOUT_GAP },
                    ]}
                  >
                    {heroAmount(todayShown).value}
                    <Text style={[styles.dailyUnit, { fontSize: hero.unitFont }]}>
                      {' '}{heroAmount(todayShown).unit}
                    </Text>
                  </Text>
                </View>
                )}
                {/* Skuren efter en paus, ur ringens mitt. Ligger ovanpå men
                    tar inga tryck och ingen plats (se `celebrate`). */}
                <View pointerEvents="none" style={styles.burstLayer}>
                  <CelebrationBurst
                    burstKey={homeBurst}
                    size={Math.round((HOME_RING_VIEW ? heroRing.size : heroBars.height) * (burstBig ? 1.9 : 1.45))}
                    count={burstBig ? 34 : 22}
                  />
                </View>
              </View>
              {/* Målet ändras här, i steg (`GOAL_OPTIONS`: 30 min, sedan hela
                  timmar till 12 h). Siffran och strecken följer med direkt;
                  sparningen väntar tills fingret slutat trycka, se
                  `stepGoal`. För skärmläsare är raden EN justerbar kontroll.
                  Visas inte när ringen själv öppnar ratten. */}
              {!ringOpensGoal && (
              <View
                style={styles.goalStepper}
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel="Daily goal"
                accessibilityValue={{ text: formatDuration(shownTarget) }}
                accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                onAccessibilityAction={e => stepGoal(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
              >
                <TouchableOpacity
                  style={[styles.goalStep, !canLowerGoal && styles.goalStepOff]}
                  onPress={() => stepGoal(-1)}
                  disabled={!canLowerGoal}
                  hitSlop={8}
                  activeOpacity={0.6}
                >
                  <FontAwesome name="minus" size={11} color={Palette.hue} />
                </TouchableOpacity>
                <Text style={styles.goalStepValue}>{formatDuration(shownTarget)}</Text>
                <TouchableOpacity
                  style={[styles.goalStep, !canRaiseGoal && styles.goalStepOff]}
                  onPress={() => stepGoal(1)}
                  disabled={!canRaiseGoal}
                  hitSlop={8}
                  activeOpacity={0.6}
                >
                  <FontAwesome name="plus" size={11} color={Palette.hue} />
                </TouchableOpacity>
              </View>
              )}
              {goalMet && <Text style={styles.goalMet}>GOAL REACHED</Text>}
            </>
          ) : HOME_RING_VIEW ? (
            // Utan mål står ringen ändå, tom, och är vägen till det första
            // målet. Testare med nytt konto hittade annars inte ringen alls:
            // länken under rubriken döljs med krets och efter *Set up later*,
            // och då gick målet bara att sätta från kretsfliken.
            <TouchableOpacity
              onPress={openGoalModal}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Set a daily goal"
            >
              <ProgressArc
                fraction={0}
                size={heroRing.size}
                stroke={heroRing.stroke}
                color={Palette.hue}
                trackColor={Palette.hueTrack}
              >
                <View style={[styles.ringCenter, { width: heroRing.size - 2 * (heroRing.stroke + 10) }]}>
                  <Text
                    style={[styles.dailyBig, { fontSize: heroRing.bigFont, lineHeight: Math.round(heroRing.bigFont * BIG_LINE) }]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.6}
                  >
                    {heroAmount(todayShown).value}
                    <Text style={[styles.dailyUnit, { fontSize: heroRing.unitFont }]}>
                      {' '}{heroAmount(todayShown).unit}
                    </Text>
                  </Text>
                  <Text style={[styles.ringSub, { color: Palette.hue, fontWeight: '700' }]}>Set a goal</Text>
                </View>
              </ProgressArc>
            </TouchableOpacity>
          ) : (
            <>
              <Text style={styles.headline}>Ready for a pause?</Text>
              {/* Uppmaningen visas bara utan krets — kretsfliken ber redan om
                  samma sak, och där räknas den in i veckans bedrift. */}
              {!inCircle && !introDeferred && (
                <TouchableOpacity onPress={openGoalModal} activeOpacity={0.6} style={styles.setGoalBtn}>
                  <Text style={styles.setGoalBtnText}>Set a daily goal</Text>
                </TouchableOpacity>
              )}
            </>
          )}

          {/* Puffen ligger utanför de två grenarna med flit: den som sköt upp
              introduktionen kan ha satt ett mål här under tiden. */}
          {/* Samma plats och form som puffarna ovan. Inte i nattläge: natten
              är privat och har bara SLEEP. */}
          {envelopesReady > 0 && !isNight && (
            <TouchableOpacity
              onPress={() => router.push('/support-arrived' as never)}
              activeOpacity={0.6}
              style={[styles.setGoalBtn, styles.envelopeBtn]}
              accessibilityLabel="Your envelope is ready. Open it."
            >
              <FontAwesome5 name="envelope-open-text" size={13} color={Palette.accent} />
              <Text style={styles.setGoalBtnText}>
                {envelopesReady === 1 ? 'Your envelope is ready' : `${envelopesReady} envelopes are ready`}
              </Text>
            </TouchableOpacity>
          )}

          {introDeferred && (
            <TouchableOpacity
              onPress={() => router.push('/intro' as never)}
              activeOpacity={0.6}
              style={styles.setGoalBtn}
              accessibilityLabel="Finish setting up your profile"
            >
              <Text style={styles.setGoalBtnText}>Finish setting up</Text>
            </TouchableOpacity>
          )}
        </Animated.View>

        <View style={styles.pauseButtonWrap}>
        {/* Vilka som bjuds in när pausen startar (lib/pauseInvites.ts). Den
            svävar inte med knappen — den är ett val, inte knappen — men
            tonar bort med den medan taggkortet står uppe. Höjden ingår i
            heronens extras (`INVITE_ROW_H`). */}
        <Animated.View style={[styles.pauseButtonWrap, { transform: [{ translateY: floatAnim }] }]}>
          {/* Tonar bort medan taggkortet står uppe — kortet ligger ovanpå
              den platsen, och en knapp under ett kort ska inte gå att nå. */}
          <Reanimated.View style={[styles.pauseButtonRow, pauseFadeStyle]} pointerEvents={tag ? 'none' : 'auto'}>
            {/* Lika breda sidor, så att PAUSE står kvar i mitten. */}
            {/* Skenet bakom knappen. Absolut, så att det inte tar plats i raden. */}
            <PauseAmbience />
            <View style={styles.pauseSide} />
            {/* Med valskärmen påslagen öppnar ett tryck den, som förut. Utan
                den är det här enda stället en paus startar, och då hålls
                knappen in — samma knapp och samma tal som CHECK IN, och samma
                lådlösa start som valskärmen gör (lib/pauseFlow.ts). */}
            {/* Natten startar med SLEEP: samma knapp och samma håll som en
                paus, aldrig via valskärmen — en natt har ingen intention och
                inget läge att välja. */}
            {isNight ? (
              <HoldToStartButton
                style={styles.pauseButton}
                onComplete={startSleep}
                holdMs={HOLD_TO_START_MS}
                borderRadius={PAUSE_BTN_H / 2}
                background={<PauseButtonFace radius={PAUSE_BTN_H / 2} />}
                accessibilityLabel="Start the night"
                hintStyle={styles.holdHint}
              >
                <FontAwesome name="moon-o" size={20} color={Palette.onAccent} />
                <Text style={styles.pauseButtonText}>SLEEP</Text>
              </HoldToStartButton>
            ) : SHOW_PAUSE_SETUP_VIEW ? (
              <TouchableOpacity
                style={styles.pauseButton}
                onPress={() => router.push('/pause')}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Pause"
              >
                {/* Pausens symbol som två rundade streck — samma form som
                    strecken ovanför, i stället för ikonfontens kantiga glyf. */}
                <View style={styles.pauseGlyph}>
                  <View style={styles.pauseGlyphBar} />
                  <View style={styles.pauseGlyphBar} />
                </View>
                <Text style={styles.pauseButtonText}>PAUSE</Text>
              </TouchableOpacity>
            ) : (
              <HoldToStartButton
                style={styles.pauseButton}
                onComplete={() => startPhonePause('push')}
                holdMs={HOLD_TO_START_MS}
                borderRadius={PAUSE_BTN_H / 2}
                background={<PauseButtonFace radius={PAUSE_BTN_H / 2} />}
                accessibilityLabel="Start a pause"
                hintStyle={styles.holdHint}
              >
                <View style={styles.pauseGlyph}>
                  <View style={styles.pauseGlyphBar} />
                  <View style={styles.pauseGlyphBar} />
                </View>
                <Text style={styles.pauseButtonText}>PAUSE</Text>
              </HoldToStartButton>
            )}
            <View style={styles.pauseSide}>
              {showInviteRow && <PauseInviteRow userId={user!.id} />}
            </View>
          </Reanimated.View>
        </Animated.View>
        </View>
      </Reanimated.View>

      {/* Dagsmålet. Samma ratt och samma ord som i Kretsen — det är ett och
          samma tal. */}
      <Modal
        visible={showGoalModal}
        transparent
        animationType="fade"
        onRequestClose={() => (habitPicking ? setHabitPicking(false) : setShowGoalModal(false))}
      >
        <View style={[styles.backdrop, goalKeyboardH > 0 && { paddingBottom: goalKeyboardH + Spacing.lg }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowGoalModal(false)} />
          <View style={styles.card}>
            {habitPicking ? (
              <HabitPicker
                categories={habitCats}
                habits={habitDraft}
                onPick={h => { setHabitDraft(d => [...d, h]); setHabitPicking(false); }}
                onBack={() => setHabitPicking(false)}
                onCreated={cat => setHabitCats(c => [...c, cat])}
              />
            ) : (<>
            <Text style={styles.cardTitle}>Your goals</Text>

            {/* Tid per dag, vanor per vecka — orden *a day* och *days a
                week* bär skillnaden. Ratten är oförändrad. */}
            <View style={styles.goalHead}>
              <Text style={styles.goalEyebrow}>TIME</Text>
              <Text style={styles.goalNote}>a day</Text>
            </View>
            <DurationWheel index={goalIndex} onIndexChange={setGoalIndex} />

            <View style={styles.goalDivider} />
            <HabitGoalsEditor
              habits={habitDraft}
              onChange={setHabitDraft}
              onAdd={() => setHabitPicking(true)}
              categories={habitCats}
              progress={habitDays}
            />

            <TouchableOpacity style={styles.primaryBtn} onPress={handleSaveGoal} disabled={savingGoal}>
              <Text style={styles.primaryBtnText}>{savingGoal ? 'Saving…' : 'Save goals'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowGoalModal(false)} style={styles.cancelLink}>
              <Text style={styles.cancelLinkText}>Cancel</Text>
            </TouchableOpacity>
            </>)}
          </View>
        </View>
      </Modal>
    </View>

      {/* Lappen. Utanför containern av samma skäl som taggkortet, och borta
          medan kortet står uppe — det ligger över samma hörn. Borta i
          nattläge också: att göra hör till dagen, och nattsidan är bara
          månen och SLEEP. */}
      {!tag && !isNight && user?.id && (
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: fadeAnim }]} pointerEvents="box-none">
          <TodoPostIt
            todos={todos}
            lifted={showTodos}
            onPress={from => { setTodoOrigin(from); setShowTodos(true); }}
          />
        </Animated.View>
      )}
      {user?.id && (
        <TodoSheet
          visible={showTodos}
          userId={user.id}
          inCircle={inCircle}
          circleCount={circleCount}
          origin={todoOrigin}
          onClose={() => setShowTodos(false)}
          onChanged={setTodos}
        />
      )}

      {/* Taggkortet efter en ensam paus. Utanför containern, kant i kant mot
          flikraden. */}
      {tag && (
        <Reanimated.View style={[styles.tagSheetWrap, tagSheetStyle]}>
          <PauseTagSheet
            durationSeconds={tag.durationSeconds}
            sleepable={tag.sleepable}
            onClose={closeTag}
            onSlept={() => { loadDaily().catch(() => {}); }}
            onHeight={h => setTagSheetH(prev => (Math.abs(prev - h) > 1 ? h : prev))}
            bottomPadding={Spacing.lg}
          />
        </Reanimated.View>
      )}
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  shell: { flex: 1 },
  container: {
    flex: 1,
    // Botten ritas av <ScreenBackground>, som ligger absolut bakom allt här
    // inne och äger rummets bg. Stod färgen kvar här hade den lagt sig ovanpå
    // lagren.
    backgroundColor: 'transparent',
    paddingHorizontal: Spacing.xl,
    paddingBottom: BOTTOM_PAD,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rightButtons: {
    flexDirection: 'row',
    gap: Spacing.sm,
    alignItems: 'center',
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
  },
  avatarThumb: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: Palette.surface,
  },
  center: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    // Höjden och gapet sätts inline ur `heroMetrics`: de beror på den
    // uppmätta containern och kan därför inte bo i en StyleSheet. Blocket
    // står i nederkanten och `paddingBottom` är luften ner till flikraden.
  },

  // Taggkortets plats: kant i kant längst ner, över flikraden.
  tagSheetWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  burstLayer: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },

  dailyBig: { fontSize: 42, fontWeight: '900', color: Palette.textPrimary, letterSpacing: -1 },
  dailyUnit: { fontSize: 16, fontWeight: '700', color: Palette.textSecondary, letterSpacing: 0 },
  goalMet: {
    fontSize: 12, fontWeight: '900', color: Palette.accent,
    letterSpacing: 1.2, marginTop: Spacing.md,
  },
  goalStepper: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: STEPPER_TOP, height: 32 },
  // En ikon i rummets kulör på rummets ton. Träffytan växer till 48 med
  // `hitSlop`.
  goalStep: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Palette.hueTint,
  },
  // Vid 30 min respektive 12 h. Synlig men dämpad: en knapp som försvinner
  // flyttar siffran i sidled.
  goalStepOff: { opacity: 0.35 },
  goalStepValue: {
    minWidth: 64, textAlign: 'center',
    fontSize: 17, lineHeight: 22, fontWeight: '700', color: Palette.textSecondary,
  },
  heroBlock: { alignItems: 'center' },
  // Luften under kapseln ingår i `MODE_PILL_H`.
  modePill: { marginBottom: MODE_PILL_GAP },
  // Nattläget: frågan under månen. Höjd + marginal = `NIGHT_TITLE_H`.
  nightTitle: {
    fontSize: 24, lineHeight: 28, fontWeight: '800', color: Palette.textPrimary,
    textAlign: 'center', marginTop: 16, letterSpacing: 0.2,
  },
  ringCenter: { alignItems: 'center', gap: 4 },
  ringSubRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  ringSub: { fontSize: 14, lineHeight: 18, color: Palette.textSecondary, textAlign: 'center' },
  setGoalBtn: { marginTop: Spacing.lg, paddingVertical: 6, paddingHorizontal: 4 },
  setGoalBtnText: { fontSize: 14, fontWeight: '700', color: Palette.accent },
  envelopeBtn: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  backdrop: {
    flex: 1, backgroundColor: Palette.scrim,
    alignItems: 'center', justifyContent: 'center', padding: Spacing.xl,
  },
  card: {
    width: '100%', backgroundColor: Palette.modalSurface, borderRadius: Radius.xl,
    padding: Spacing.xl, gap: Spacing.md,
  },
  cardTitle: { fontSize: 18, fontWeight: '700', color: Palette.textPrimary, textAlign: 'center' },
  // Samma rubrikrad som vanornas (components/habit-goals-editor.tsx).
  goalHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: -Spacing.xs },
  goalEyebrow: { ...Palette.eyebrow },
  goalNote: { fontSize: 12, lineHeight: 16, color: Palette.textTertiary },
  goalDivider: { height: StyleSheet.hairlineWidth, backgroundColor: Palette.ink10 },
  primaryBtn: { backgroundColor: Palette.accent, paddingVertical: 14, borderRadius: Radius.pill, alignItems: 'center' },
  primaryBtnText: { color: Palette.onAccent, fontSize: 15, fontWeight: '700' },
  cancelLink: { alignItems: 'center', paddingVertical: 6 },
  cancelLinkText: { color: Palette.textTertiary, fontSize: 14 },
  eyebrow: {
    ...Palette.eyebrow,
    textAlign: 'center',
    // Luften under hälsningen ingår i `EYEBROW_H` — ändras den ena ska den
    // andra följa med.
    marginBottom: EYEBROW_GAP,
  },
  headline: {
    fontSize: 32,
    fontWeight: '800',
    color: Palette.textPrimary,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  pauseButtonWrap: {
    alignItems: 'center',
    width: '100%',
  },
  pauseButtonRow: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  pauseSide: { flex: 1, alignItems: 'flex-start', paddingLeft: 12 },
  // Platsen Global Pause-raden tar i flödet; raden själv svävar (`bannerTop`).
  globalLine: { height: GLOBAL_PAUSE_LINE_H, alignSelf: 'stretch', marginTop: GLOBAL_LINE_GAP },
  globalLineFloat: { position: 'absolute', left: 0, right: 0 },
  // Knappen tar sin bredd ur sitt innehåll, inte ur spalten: en pille som
  // slutar där ordet slutar läses som en knapp och låter strecken vara sidans
  // huvudsak. Höjden är utskriven (58, `PAUSE_BTN_H`): heronens räkning högst
  // upp räknar med den. Skuggan är knappens EGEN accent — det enda som ska se
  // ut att sväva.
  pauseButton: {
    backgroundColor: Palette.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    height: PAUSE_BTN_H,
    paddingHorizontal: 44,
    borderRadius: Radius.pill,
    // Designsystemets glöd: för det som är viktigast, och på Hem är det PAUSE.
    shadowColor: Palette.accent,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.55,
    shadowRadius: 22,
    elevation: 12,
  },
  pauseGlyph: { flexDirection: 'row', gap: 6 },
  pauseGlyphBar: { width: 6, height: 18, borderRadius: 3, backgroundColor: Palette.onAccent },
  // *Keep holding* under PAUSE efter ett för kort tryck. Svävar under
  // knappen (komponenten placerar den) och tar ingen plats i räkningen.
  holdHint: { fontSize: 13, lineHeight: 18, marginTop: 8, color: Palette.textSecondary, textAlign: 'center' },
  pauseButtonText: {
    color: Palette.onAccent,
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 3.4,
  },
});
