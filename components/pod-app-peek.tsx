import { FontAwesome, FontAwesome5, MaterialIcons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';
import { alpha, AppPalette, Radius, Spacing } from '../constants/appTheme';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { GLOBAL_PAUSE_LINE_H } from './global-pause-line';
import { PauseActivityChart, type ChartSession } from './pause-activity-chart';
import { PauseAmbience } from './pause-ambience';
import { PauseButtonFace } from './pause-button-face';
import { PausePodLogo } from './pause-pod-logo';
import { PauseTagBadge } from './pause-tag-badge';
import { PauseTotalHeart } from './pause-total-heart';
import { PodBoxIcon } from './pod-box-icon';
import { QrCode } from './pod-screen';
import { ProgressArc } from './progress-arc';
import { ScreenBackground } from './screen-background';
import { SegmentedPill } from './segmented-pill';

/**
 * Telefonen efter pausen, på lådsidan: Hem med ringen som fylls av pausen,
 * och statistiken som rullar ner till pauskortet med lådan i hörnet.
 *
 * **Skärmarna ska se ut exakt som appens** (på begäran), så de byggs av
 * samma delar — `ProgressArc`, `PauseButtonFace`, `PauseAmbience`,
 * `PausePodLogo`, `SegmentedPill`, `PauseTotalHeart`,
 * `PauseActivityChart`, rummens bakgrund — i telefonens fulla storlek
 * (fönstrets mått) och skalas sedan ner till attrappen. Det som inte går att
 * låna är skrivet av efter skärmarna med samma mått: topbaren, Global
 * Pause-raden i viloläge, flikraden och pauskortet
 * ([app/(tabs)/index.tsx](../app/(tabs)/index.tsx),
 * [app/stats.tsx](../app/stats.tsx)). Ändras de skärmarna ska det ändras här.
 *
 * Talen hänger ihop med lådans display: pausen var 42:18, dagen hade redan
 * 42 minuter, och målet är 2 h.
 */

/**
 * `ring` och `stats` efter en paus; `camera`, `confirm` och `registered`
 * när en ny tagg registreras: kameran läser lådans QR-kod och appen öppnar
 * [app/pair.tsx](../app/pair.tsx).
 */
export type PodAppView = 'ring' | 'stats' | 'camera' | 'confirm' | 'registered';

const BEFORE_MIN = 42;
const PAUSE_MIN = 42;
const GOAL_MIN = 120;
const BEZEL = 5;

/** Var den senaste pausens kort står i statistiken, i skärmens fulla mått. */
type CardRect = { x: number; y: number; w: number; h: number };

export function PodAppPeek({ view, width, name }: { view: PodAppView; width: number; name: string }) {
  const win = useWindowDimensions();
  const height = width * 2.1;
  const innerW = width - 2 * BEZEL;
  const innerH = height - 2 * BEZEL;
  // Skärmarna ritas i telefonens fulla bredd och skalas ner.
  const scale = innerW / win.width;
  const fullH = innerH / scale;
  const r = width * 0.16;
  const [focus, setFocus] = useState<CardRect | null>(null);
  useEffect(() => { setFocus(null); }, [view]);

  // Den lyfta kopian av kortet står i telefonens koordinater: samma punkt som
  // kortet på den nerskalade skärmen, men utanför skärmens kant.
  const lift = useSharedValue(1);
  useEffect(() => {
    if (!focus) { lift.value = 1; return; }
    lift.value = withRepeat(withSequence(
      withTiming(1.14, { duration: 650, easing: Easing.out(Easing.cubic) }),
      withTiming(1.04, { duration: 650, easing: Easing.inOut(Easing.cubic) }),
    ), 2, false);
  }, [focus, lift]);
  const liftStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale * lift.value }] }));
  const at = focus && {
    cx: BEZEL + innerW / 2 + (focus.x + focus.w / 2 - win.width / 2) * scale,
    cy: BEZEL + innerH / 2 + (focus.y + focus.h / 2 - fullH / 2) * scale,
  };

  return (
    <View style={[s.phone, { width, height, borderRadius: r, padding: BEZEL }]}>
      <View style={[s.screen, { borderRadius: r - BEZEL }]}>
        <Animated.View key={view} entering={FadeIn.duration(350)} exiting={FadeOut.duration(250)} style={StyleSheet.absoluteFill}>
          <View
            style={{
              position: 'absolute',
              width: win.width,
              height: fullH,
              left: (innerW - win.width) / 2,
              top: (innerH - fullH) / 2,
              transform: [{ scale }],
            }}
          >
            {view === 'ring' && <MiniHome w={win.width} h={fullH} name={name} />}
            {view === 'stats' && <MiniStats w={win.width} h={fullH} onFocus={setFocus} />}
            {view === 'camera' && <MiniCamera w={win.width} h={fullH} />}
            {(view === 'confirm' || view === 'registered') && <MiniRegister w={win.width} h={fullH} done={view === 'registered'} name={name} />}
          </View>
        </Animated.View>
        {/* Allt utom den senaste pausen mörknar. */}
        {focus && <Animated.View entering={FadeIn.duration(500)} style={[StyleSheet.absoluteFill, s.scrim]} />}
        <View style={[s.island, { width: width * 0.28, height: width * 0.08, top: width * 0.04, borderRadius: width * 0.04 }]} />
      </View>
      {focus && at && (
        <Animated.View
          entering={FadeIn.duration(300)}
          pointerEvents="none"
          style={[
            { position: 'absolute', width: focus.w, height: focus.h, left: at.cx - focus.w / 2, top: at.cy - focus.h / 2 },
            liftStyle,
          ]}
        >
          <RoomProvider room="study">
            <LiftedCard />
          </RoomProvider>
        </Animated.View>
      )}
    </View>
  );
}

const fmt = (min: number) => ({
  value: min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}` : String(min),
  unit: 'min',
});

// Statusfältet och hemstrecket i en telefon utan att fråga systemet.
const STATUS_H = 54;
const HOME_INDICATOR_H = 34;

// ─── Hem ───────────────────────────────────────────────────

function MiniHome({ w, h, name }: { w: number; h: number; name: string }) {
  return (
    <RoomProvider room="pause">
      <View style={{ width: w, height: h }}>
        <ScreenBackground room="pause" />
        <HomeBody name={name} />
      </View>
    </RoomProvider>
  );
}

function HomeBody({ name }: { name: string }) {
  const P = usePalette();
  const st = useMemo(() => makeHome(P), [P]);
  // Ringen står på dagens förra summa och räknar sedan upp med pausen.
  const [min, setMin] = useState(BEFORE_MIN);
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      t = setInterval(() => setMin(m => {
        const next = Math.min(BEFORE_MIN + PAUSE_MIN, m + 1);
        if (next === BEFORE_MIN + PAUSE_MIN && t) clearInterval(t);
        return next;
      }), 30);
    }, 1200);
    return () => { clearTimeout(start); if (t) clearInterval(t); };
  }, []);
  const ring = 230;
  const amount = fmt(min);
  return (
    <View style={{ flex: 1 }}>
      <View style={[st.container, { paddingTop: STATUS_H }]}>
        <View style={st.topBar}>
          <PausePodLogo />
          <View style={st.rightButtons}>
            <View style={st.iconButton}><FontAwesome name="bar-chart" size={18} color={P.accent} /></View>
            <View style={st.iconButton}><FontAwesome name="cog" size={21} color={P.accent} /></View>
            <View style={st.iconButton}><FontAwesome5 name="user-circle" size={18} color={P.accent} solid /></View>
          </View>
        </View>
        <View style={st.globalSlot}>
          <View style={st.globalPill}>
            <FontAwesome5 name="globe-europe" size={14} color={P.textTertiary} />
            <Text style={st.globalText}>Next · 18:00</Text>
          </View>
        </View>

        <View style={st.center}>
          <View style={{ marginBottom: 40 }}>
            <SegmentedPill
              options={[{ key: 'day', label: 'Day' }, { key: 'night', label: 'Night' }]}
              value="day"
              onChange={() => {}}
              width={200}
            />
          </View>
          <Text style={st.eyebrow}>HI {name.toUpperCase()}</Text>
          <ProgressArc fraction={min / GOAL_MIN} size={ring} stroke={ring * (14 / 210)} color={P.hue} trackColor={P.hueTrack} glow>
            <View style={[st.ringCenter, { width: ring - 2 * (ring * (14 / 210) + 10) }]}>
              <Text style={[st.dailyBig, { fontSize: ring * (34 / 210), lineHeight: Math.round(ring * (34 / 210) * 1.1) }]} numberOfLines={1}>
                {amount.value}
                <Text style={st.dailyUnit}>{' '}{amount.unit}</Text>
              </Text>
              <Text style={st.ringSub}>of 2h</Text>
            </View>
          </ProgressArc>

          <View style={st.pauseRow}>
            <PauseAmbience />
            <View style={st.pauseButton}>
              <PauseButtonFace radius={29} />
              <View style={st.pauseGlyph}>
                <View style={st.pauseGlyphBar} />
                <View style={st.pauseGlyphBar} />
              </View>
              <Text style={st.pauseButtonText}>PAUSE</Text>
            </View>
          </View>
        </View>
      </View>
      <TabBar />
    </View>
  );
}

/** Flikraden, som `RoomTabBar` ritar den med Pause vald. */
function TabBar() {
  const P = usePalette();
  const st = useMemo(() => makeHome(P), [P]);
  const tabs: { label: string; icon: React.ReactNode }[] = [
    {
      label: 'PAUSE',
      icon: (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <View style={{ width: 6, height: 19, borderRadius: 3, backgroundColor: P.hue }} />
          <View style={{ width: 6, height: 19, borderRadius: 3, backgroundColor: P.hue }} />
        </View>
      ),
    },
    { label: 'CIRCLE', icon: <FontAwesome5 name="circle" size={19} color={P.textTertiary} /> },
    { label: 'SUPPORT', icon: <FontAwesome5 name="hand-holding-heart" size={18} color={P.textTertiary} /> },
  ];
  return (
    <View style={[st.tabBar, { height: 54 + 10 + HOME_INDICATOR_H, paddingBottom: HOME_INDICATOR_H }]}>
      <View style={st.tabRow}>
        {tabs.map((t, i) => (
          <View key={t.label} style={st.tab}>
            {i === 0 && <View style={st.tabPill} />}
            {t.icon}
            <Text style={[st.tabLabel, { color: i === 0 ? P.hue : P.textTertiary }]}>{t.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const makeHome = (P: AppPalette) => StyleSheet.create({
  container: { flex: 1, paddingHorizontal: Spacing.xl },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rightButtons: { flexDirection: 'row', gap: Spacing.sm, alignItems: 'center' },
  iconButton: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    backgroundColor: P.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: P.surfaceBorder,
  },
  globalSlot: { height: GLOBAL_PAUSE_LINE_H, alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  globalPill: {
    height: 32, flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingLeft: 11, paddingRight: 15, borderRadius: Radius.pill, backgroundColor: P.ink08,
  },
  globalText: { fontSize: 13, fontWeight: '600', color: P.textSecondary },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 30 },
  eyebrow: { ...P.eyebrow, textAlign: 'center', marginBottom: 14 },
  ringCenter: { alignItems: 'center', gap: 4 },
  dailyBig: { fontWeight: '900', color: P.textPrimary, letterSpacing: -1 },
  dailyUnit: { fontSize: 16, fontWeight: '700', color: P.textSecondary, letterSpacing: 0 },
  ringSub: { fontSize: 14, lineHeight: 18, color: P.textSecondary, textAlign: 'center' },
  pauseRow: { marginTop: 48, alignItems: 'center', justifyContent: 'center', width: '100%' },
  pauseButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    height: 58, paddingHorizontal: 44, borderRadius: Radius.pill, backgroundColor: P.accent,
    shadowColor: P.accent, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.55, shadowRadius: 22, elevation: 12,
  },
  pauseGlyph: { flexDirection: 'row', gap: 6 },
  pauseGlyphBar: { width: 6, height: 18, borderRadius: 3, backgroundColor: P.onAccent },
  pauseButtonText: { color: P.onAccent, fontSize: 17, fontWeight: '900', letterSpacing: 3.4 },
  tabBar: { borderTopWidth: 1, borderTopColor: P.divider, paddingTop: 8, backgroundColor: P.bg },
  tabRow: { flex: 1, flexDirection: 'row' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  tabPill: {
    position: 'absolute', top: 0, bottom: 0, left: 6, right: 6, borderRadius: 22,
    backgroundColor: alpha(P.hue, P.mode === 'dark' ? 0.16 : 0.13),
  },
  tabLabel: { fontSize: 12, letterSpacing: 1.5, fontWeight: '700', marginTop: 2 },
});

// ─── Kameran ───────────────────────────────────────────────

/**
 * Telefonens kamera mot lådans display: koden i sökaren, hörnen som drar
 * ihop sig runt den när den hittats, och länken som dyker upp under den.
 * Ett tryck på länken öppnar Register tag i appen.
 */
function MiniCamera({ w, h }: { w: number; h: number }) {
  const qr = w * 0.5;
  const found = useSharedValue(0);
  const tap = useSharedValue(0);
  useEffect(() => {
    found.value = withDelay(900, withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) }));
    tap.value = withDelay(2300, withSequence(withTiming(1, { duration: 180 }), withTiming(0, { duration: 260 })));
  }, [found, tap]);
  // Hörnen börjar vida och drar ihop sig runt koden.
  const frame = useAnimatedStyle(() => {
    const pad = (1 - found.value) * qr * 0.35 + qr * 0.08;
    return { width: qr + 2 * pad, height: qr + 2 * pad, opacity: 0.5 + 0.5 * found.value };
  });
  const chip = useAnimatedStyle(() => ({
    opacity: found.value,
    transform: [{ translateY: (1 - found.value) * 12 }, { scale: 1 - 0.06 * tap.value }],
  }));
  const touch = useAnimatedStyle(() => ({ opacity: tap.value * 0.5, transform: [{ scale: 0.6 + 0.4 * tap.value }] }));
  const corner = { position: 'absolute' as const, width: 34, height: 34, borderColor: '#ffd60a' };
  return (
    <View style={{ width: w, height: h, backgroundColor: '#000' }}>
      {/* Bilden: lådans ek i mörker, och displayen med koden. */}
      <View style={[cam.view, { top: STATUS_H + 40, bottom: 170 }]}>
        <View style={cam.oak} />
        <View style={cam.display}>
          <QrCode size={qr} seed={3} />
        </View>
        <View style={cam.center}>
          <Animated.View style={frame}>
            <View style={[corner, { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 10 }]} />
            <View style={[corner, { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 10 }]} />
            <View style={[corner, { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 10 }]} />
            <View style={[corner, { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 10 }]} />
          </Animated.View>
        </View>
        <Animated.View style={[cam.chip, chip]}>
          <View style={cam.chipIcon}>
            <View style={cam.chipBar} />
            <View style={cam.chipBar} />
          </View>
          <Text style={cam.chipText}>joinpausepod.com</Text>
          <Animated.View style={[cam.touch, touch]} />
        </Animated.View>
      </View>
      {/* Kamerans egen rad: lägena och avtryckaren. */}
      <View style={cam.modes}>
        <Text style={cam.mode}>VIDEO</Text>
        <Text style={[cam.mode, cam.modeOn]}>PHOTO</Text>
        <Text style={cam.mode}>PORTRAIT</Text>
      </View>
      <View style={cam.shutter}><View style={cam.shutterInner} /></View>
    </View>
  );
}

const cam = StyleSheet.create({
  view: { position: 'absolute', left: 0, right: 0, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  oak: { position: 'absolute', left: -40, right: -40, top: '18%', bottom: '18%', backgroundColor: '#5a4630', borderRadius: 24, opacity: 0.85 },
  display: { padding: 18, backgroundColor: '#03060e', borderRadius: 14 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  chip: {
    position: 'absolute', bottom: '14%', flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#ffd60a', borderRadius: 999, paddingVertical: 10, paddingLeft: 10, paddingRight: 16, overflow: 'hidden',
  },
  chipIcon: { width: 26, height: 26, borderRadius: 6, backgroundColor: '#0b1630', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 },
  chipBar: { width: 4, height: 12, borderRadius: 2, backgroundColor: '#8cc4ff' },
  chipText: { fontSize: 16, fontWeight: '600', color: '#000' },
  touch: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: '#000', borderRadius: 999 },
  modes: { position: 'absolute', bottom: 130, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 22 },
  mode: { fontSize: 13, fontWeight: '600', color: '#ffffff', letterSpacing: 1 },
  modeOn: { color: '#ffd60a' },
  shutter: {
    position: 'absolute', bottom: 40, alignSelf: 'center', width: 76, height: 76, borderRadius: 38,
    borderWidth: 4, borderColor: '#ffffff', alignItems: 'center', justifyContent: 'center',
  },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#ffffff' },
});

// ─── Register tag ──────────────────────────────────────────

/**
 * [app/pair.tsx](../app/pair.tsx) som QR-koden öppnar den: *Tag found.*
 * med taggen och knappen som trycks, och sedan *It's yours.* med bocken.
 */
function MiniRegister({ w, h, done, name }: { w: number; h: number; done: boolean; name: string }) {
  return (
    <RoomProvider room="pause">
      <View style={{ width: w, height: h }}>
        <ScreenBackground room="pause" />
        <RegisterBody done={done} name={name} />
      </View>
    </RoomProvider>
  );
}

function RegisterBody({ done, name }: { done: boolean; name: string }) {
  const hi = `HI, ${name.toUpperCase()}`;
  const P = usePalette();
  const st = useMemo(() => makeRegister(P), [P]);
  // Knappen trycks en stund efter att skärmen öppnats.
  const press = useSharedValue(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (done) return;
    press.value = withDelay(1500, withSequence(withTiming(1, { duration: 160 }), withTiming(0, { duration: 240 })));
    const t = setTimeout(() => setBusy(true), 1700);
    return () => clearTimeout(t);
  }, [done, press]);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.04 * press.value }], opacity: 1 - 0.15 * press.value }));
  return (
    <View style={[st.container, { paddingTop: 70 }]}>
      <View style={st.backBtn}>
        <FontAwesome5 name="arrow-left" size={16} color={P.accent} />
      </View>
      {done ? (
        <View style={st.block}>
          <View style={st.badge}><PauseTagBadge checked /></View>
          <Text style={[st.title, st.centered]}>It&apos;s yours.</Text>
          <Text style={[st.subtitle, st.centered]}>Put your phone back in the box. It will say {hi}.</Text>
          <View style={st.primary}><Text style={st.primaryText}>DONE</Text></View>
        </View>
      ) : (
        <View style={st.block}>
          <View style={st.badge}><PauseTagBadge checked={false} /></View>
          <Text style={[st.title, st.centered]}>Tag found.</Text>
          <Text style={[st.subtitle, st.centered]}>
            The sticker on your phone, in PausePod right now. Make it yours and the box will say {hi}.
          </Text>
          <Animated.View style={[st.primary, pressStyle]}>
            {busy ? <ActivityIndicator color={P.onAccent} /> : <Text style={st.primaryText}>MAKE IT MINE</Text>}
          </Animated.View>
          <View style={st.secondary}><Text style={st.secondaryText}>Not my tag</Text></View>
        </View>
      )}
    </View>
  );
}

const makeRegister = (P: AppPalette) => StyleSheet.create({
  container: { flex: 1, paddingHorizontal: Spacing.xl },
  backBtn: { alignSelf: 'flex-start', paddingVertical: 12, paddingHorizontal: 12, marginBottom: 4 },
  block: { gap: 12 },
  badge: { alignSelf: 'center', marginBottom: 4 },
  centered: { textAlign: 'center' },
  title: { fontSize: 36, fontWeight: '800', color: P.textPrimary, letterSpacing: 0.2, lineHeight: 44 },
  subtitle: { fontSize: 15, color: P.textSecondary, letterSpacing: 0.2, marginBottom: 12 },
  primary: {
    minHeight: 56, borderRadius: 999, backgroundColor: P.accent,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24,
  },
  primaryText: { color: P.onAccent, fontSize: 15, fontWeight: '900', letterSpacing: 1.2 },
  secondary: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 16 },
  secondaryText: { fontSize: 15, color: P.textSecondary },
});

// ─── Statistiken ───────────────────────────────────────────

/** En vecka med pauser, och dagens två: den förra och lådans. */
function sampleSessions(): ChartSession[] {
  const out: ChartSession[] = [];
  const now = new Date();
  const mins = [25, 40, 0, 65, 30, 50, 0];
  for (let d = 6; d >= 1; d--) {
    const m = mins[d];
    if (!m) continue;
    const day = new Date(now);
    day.setDate(now.getDate() - d);
    day.setHours(9 + (d % 5), 10, 0, 0);
    out.push({ startedAt: day.toISOString(), durationSecs: m * 60, tag: null });
  }
  const t = new Date(now);
  t.setHours(8, 10, 0, 0);
  out.push({ startedAt: t.toISOString(), durationSecs: BEFORE_MIN * 60, tag: null });
  t.setHours(14, 2, 0, 0);
  out.push({ startedAt: t.toISOString(), durationSecs: 42 * 60 + 18, tag: null });
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d: Date, hh: string) => `${d.getDate()} ${MONTHS[d.getMonth()]} · ${hh}`;

function MiniStats({ w, h, onFocus }: { w: number; h: number; onFocus: (r: CardRect) => void }) {
  return (
    <RoomProvider room="study">
      <View style={{ width: w, height: h, overflow: 'hidden' }}>
        <ScreenBackground room="study" />
        <StatsBody h={h} onFocus={onFocus} />
      </View>
    </RoomProvider>
  );
}

const SCROLL_DELAY_MS = 1400;
const SCROLL_MS = 1100;

function StatsBody({ h, onFocus }: { h: number; onFocus: (r: CardRect) => void }) {
  const P = usePalette();
  const st = useMemo(() => makeStats(P), [P]);
  const sessions = useMemo(sampleSessions, []);
  const total = useMemo(() => 23 * 3600 + 14 * 60 + sessions.reduce((n, x) => n + x.durationSecs, 0), [sessions]);
  const [recentY, setRecentY] = useState(0);
  const [card, setCard] = useState<CardRect | null>(null);
  // Sidan rullar ner till pauserna, som när man drar uppåt, och sedan lyfts
  // den senaste pausen fram (i PodAppPeek, utanför skärmens kant).
  const scroll = useSharedValue(0);
  useEffect(() => {
    if (!recentY || !card) return;
    const to = -(recentY - STATUS_H - 40);
    scroll.value = withDelay(SCROLL_DELAY_MS, withTiming(to, { duration: SCROLL_MS, easing: Easing.inOut(Easing.cubic) }));
    const t = setTimeout(() => onFocus({ ...card, y: card.y + to }), SCROLL_DELAY_MS + SCROLL_MS + 150);
    return () => clearTimeout(t);
  }, [recentY, card, scroll, onFocus]);
  const scrollStyle = useAnimatedStyle(() => ({ transform: [{ translateY: scroll.value }] }));
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  return (
    <Animated.View style={[st.container, { paddingTop: STATUS_H - 12 }, scrollStyle]}>
      <View style={st.backBtn}>
        <FontAwesome name="chevron-left" size={14} color={P.accent} />
        <Text style={st.backText}>Back</Text>
      </View>
      <PauseTotalHeart totalSecs={total} loaded />
      <View style={[st.chartSection, { height: Math.max(440, h - 220) }]}>
        <PauseActivityChart sessions={sessions} />
      </View>
      <View style={st.sectionHeadRow} onLayout={e => setRecentY(Math.round(e.nativeEvent.layout.y))}>
        <Text style={st.sectionLabel}>RECENT PAUSES</Text>
        <View style={st.wrappedBtn}>
          <MaterialIcons name="insights" size={20} color={P.accentSoft} />
        </View>
      </View>
      <View
        style={st.sessionSlot}
        onLayout={e => {
          const { x, y, width, height } = e.nativeEvent.layout;
          setCard(prev => prev ?? { x, y, w: width, h: height });
        }}
      >
        <SessionCard st={st} P={P} dur="42 min" date={fmtDate(today, '14:02')} pod flush />
      </View>
      <SessionCard st={st} P={P} dur="42 min" date={fmtDate(today, '08:10')} />
      <SessionCard st={st} P={P} dur="50 min" date={fmtDate(yesterday, '10:10')} />
    </Animated.View>
  );
}

/** Den senaste pausens kort, lyft ur skärmen. */
function LiftedCard() {
  const P = usePalette();
  const st = useMemo(() => makeStats(P), [P]);
  return (
    <View style={s.lifted}>
      <SessionCard st={st} P={P} dur="42 min" date={fmtDate(new Date(), '14:02')} pod flush />
    </View>
  );
}

/** Pauskortet i statistiken, otaggat: rummets blå och pausens symbol. */
function SessionCard({ st, P, dur, date, pod, flush }: {
  st: ReturnType<typeof makeStats>; P: AppPalette; dur: string; date: string; pod?: boolean;
  /** Utan marginalen under, när en förälder mäter kortet. */
  flush?: boolean;
}) {
  const tone = P.hue;
  const border = alpha(tone, P.mode === 'dark' ? 0.3 : 0.25);
  return (
    <View style={flush ? null : st.sessionSlot}>
      <View style={[st.sessionCard, { borderColor: border }]}>
        <View style={[st.sessionTint, { backgroundColor: alpha(tone, P.mode === 'dark' ? 0.09 : 0.07) }]} />
        <View style={st.sessionCardTop}>
          <View style={[st.sessionBadge, { backgroundColor: alpha(tone, P.mode === 'dark' ? 0.2 : 0.15) }]}>
            <FontAwesome name="pause" size={14} color={tone} />
          </View>
          <View style={st.sessionMain}>
            <Text style={st.sessionDur}>{dur}</Text>
            <Text style={st.sessionDate}>{date}</Text>
          </View>
          {pod && <View style={st.markers}><PodBoxIcon /></View>}
        </View>
        <View style={st.sessionTags}>
          <View style={st.tagAdd}><Text style={st.tagAddText}>+ Add tag</Text></View>
        </View>
      </View>
    </View>
  );
}

const makeStats = (P: AppPalette) => StyleSheet.create({
  container: { padding: Spacing.xl },
  backBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginBottom: 28, marginTop: 30, alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 4,
  },
  backText: { color: P.accent, fontSize: 15 },
  chartSection: { marginBottom: 28 },
  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, marginTop: 4 },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: P.ink30, letterSpacing: 3, textTransform: 'uppercase' },
  wrappedBtn: {
    alignItems: 'center', justifyContent: 'center', backgroundColor: P.surface,
    borderRadius: 12, borderWidth: 1, borderColor: P.accentSoftTint, width: 44, height: 44,
  },
  sessionSlot: { marginBottom: 10 },
  sessionCard: {
    backgroundColor: P.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: P.surfaceBorder,
    padding: 16, gap: 12, ...P.cardShadow,
  },
  sessionTint: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: Radius.lg - 1 },
  sessionCardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sessionBadge: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  sessionMain: { flex: 1, gap: 2 },
  markers: { alignItems: 'center', gap: 6 },
  sessionDur: { fontSize: 26, lineHeight: 30, fontWeight: '900', color: P.textPrimary, letterSpacing: -0.5 },
  sessionDate: { fontSize: 12, color: P.textTertiary, letterSpacing: 0.3 },
  sessionTags: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  tagAdd: {
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: alpha(P.hue, 0.45), borderStyle: 'dashed',
  },
  tagAddText: { fontSize: 12, color: P.hue, fontWeight: '700' },
});

const s = StyleSheet.create({
  phone: {
    backgroundColor: '#15171b',
    borderWidth: 1, borderColor: '#4a5058',
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  screen: { flex: 1, overflow: 'hidden', backgroundColor: '#000' },
  island: { position: 'absolute', alignSelf: 'center', backgroundColor: '#000' },
  scrim: { backgroundColor: '#000', opacity: 0.62 },
  lifted: {
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
});
