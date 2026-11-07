import { FontAwesome5 } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, AppState, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import Animated, {
  cancelAnimation, Easing, FadeIn, FadeOut, useAnimatedStyle, useReducedMotion, useSharedValue,
  withRepeat, withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { GlobeGrid } from '../components/globe-grid';
import { HoldToStartButton } from '../components/hold-to-start-button';
import { PauseAmbience } from '../components/pause-ambience';
import { PauseButtonFace } from '../components/pause-button-face';
import { intentionTone } from '../components/pause-tag-chips';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { alpha, AppPalette, Radius, roomPalette, Spacing } from '../constants/appTheme';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { safeBottom } from '../lib/bottomInset';
import { formatDuration } from '../lib/circles';
import {
  DemoPhase, fetchGlobalPause, formatCountdown, formatGlobalPauseWhen, GLOBAL_PAUSE_DEMO, GlobalPause,
  GlobalPausePerson, joinGlobalPause, setDemoPhase, wasSummarized,
} from '../lib/globalPause';
import { GLOBAL_PAUSE_NAME, notificationsBlocked, scheduleGlobalPauseReminder } from '../lib/notifications';
import { HOLD_TO_START_MS, startPhonePause } from '../lib/pauseFlow';
import { Category, DEFAULT_CATEGORIES, getSelectedCategories } from './pauseLogger';

/**
 * Rummet för den globala pausen (lib/globalPause.ts).
 *
 * **En skärm, en sak.** En mjuk gloria med det som gäller just nu, under den
 * ansikten och en rad som byter person, och längst ner ett enda val. Sidan
 * rullar inte. Alla som är med finns bakom ansiktena. *I'll join* anmäler
 * direkt, och intentionen väljs först i stunden pausen startas.
 *
 * **Inga statusord.** Skärmen säger aldrig *on hold* eller *done* om någon;
 * klockan på en person står bara still.
 *
 * Hör till **nattrummet**, samma rum som pausen själv pågår i. Hämtas var femte
 * sekund medan skärmen står framme. Den globala pausen blir DONE vid sitt
 * slut, och pausen man själv har igång rörs aldrig.
 */

const POLL_MS = 5000;
const LINE_MS = 4200;
const FACES_SHOWN = 5;
const FACE_H = 44;
// Rutnätet i arket har ett tak: det är ett rum att titta in i, inte en lista.
const PEOPLE_SHOWN = 24;
const HALO = 340;
const GLOBE = 300;
// Hur högt de nedre knapparna står: flikradens höjd (60 + TAB_LIFT i
// app/(tabs)/_layout.tsx) plus Hems luft under PAUSE, så att PAUSE här står i
// ungefär samma höjd som på Hem.
const ACTIONS_BOTTOM = 70 + 58;
// Samma mått som PAUSE på Hem (PAUSE_BTN_H och paddingen i `pauseButton`).
const PAUSE_BTN_H = 58;
const BREATH_MS = 5600;

/** Vad någon gör, i rummets meningar. Egna intentioner står som *pausing*. */
const INTENTION_VERBS: Record<string, string> = {
  focus: 'focusing',
  walk: 'walking',
  workout: 'working out',
  social: 'with people',
  clean: 'cleaning',
  meditate: 'meditating',
  read: 'reading',
  study: 'studying',
  rest: 'resting',
  create: 'creating',
  music: 'with music',
  nature: 'in nature',
};

/** `7 more`, `20 more`, `+100 more`. Avrundat nedåt: en ungefärlig känsla räcker. */
function moreLabel(n: number): string {
  if (n < 10) return `${n} more`;
  if (n < 100) return `${Math.floor(n / 10) * 10} more`;
  return `+${Math.floor(n / 100) * 100} more`;
}

const displayName = (p: GlobalPausePerson) => (p.relation === 'me' ? 'You' : p.name ?? 'Someone');

function personLine(p: GlobalPausePerson, live: boolean): string {
  const verb = (p.intention_id && INTENTION_VERBS[p.intention_id]) || 'pausing';
  if (!live) return `${displayName(p)} ${p.relation === 'me' ? "are" : 'is'} joining`;
  return `${displayName(p)} ${p.relation === 'me' ? 'are' : 'is'} ${verb}`;
}

const clockText = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export default function GlobalPauseRoom() {
  return (
    <RoomProvider room="night">
      <View style={roomShell}>
        <StatusBar style="light" />
        <ScreenBackground room="night" />
        <GlobalPauseScreen />
      </View>
    </RoomProvider>
  );
}

/** Glorian. En enda mjuk toning, som andas medan pausen pågår. */
function Halo({ color, breathing }: { color: string; breathing: boolean }) {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);

  useEffect(() => {
    if (!breathing || reduceMotion) {
      cancelAnimation(scale);
      scale.value = withTiming(1, { duration: 600 });
      return;
    }
    scale.value = withRepeat(
      withTiming(1.1, { duration: BREATH_MS, easing: Easing.inOut(Easing.sin) }), -1, true,
    );
    return () => cancelAnimation(scale);
  }, [breathing, reduceMotion, scale]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={[styles.halo, style]} pointerEvents="none">
      <Svg width={HALO} height={HALO}>
        <Defs>
          <RadialGradient id="globalHalo" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color} stopOpacity={0.34} />
            <Stop offset="0.45" stopColor={color} stopOpacity={0.14} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={HALO / 2} cy={HALO / 2} r={HALO / 2} fill="url(#globalHalo)" />
      </Svg>
    </Animated.View>
  );
}

function GlobalPauseScreen() {
  const Palette = usePalette();
  const s = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();

  const [pause, setPause] = useState<GlobalPause | null>(null);
  const [failed, setFailed] = useState(false);
  const [focused, setFocused] = useState(true);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [picking, setPicking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [selected, setSelected] = useState<GlobalPausePerson | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await fetchGlobalPause().catch(() => null);
    if (next) {
      setPause(next);
      setFetchedAt(Date.now());
      setFailed(false);
    } else {
      setFailed(true);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    setFocused(true);
    load();
    const id = setInterval(load, POLL_MS);
    return () => { clearInterval(id); setFocused(false); };
  }, [load]));

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    getSelectedCategories().then(c => { if (c.length > 0) setCategories(c); }).catch(() => {});
  }, []);

  // Avstängda notiser: anmälan står sig, men påminnelsen kan inte läggas ut.
  // Läses vid fokus och när appen kommer tillbaka — tillbaka från
  // inställningarna fyrar ingen fokushändelse. Har notiserna slagits på läggs
  // påminnelsen ut där och då, annars hade raden försvunnit utan att något
  // hänt.
  const [notifsOff, setNotifsOff] = useState(false);
  const signedUpFor = pause?.me ? pause.starts_at : null;
  useEffect(() => {
    if (!signedUpFor) return;
    let wasOff = false;
    const check = async () => {
      const off = await notificationsBlocked();
      setNotifsOff(off);
      if (wasOff && !off) scheduleGlobalPauseReminder(new Date(signedUpFor));
      wasOff = off;
    };
    check();
    const sub = AppState.addEventListener('change', state => { if (state === 'active') check(); });
    return () => sub.remove();
  }, [signedUpFor]);

  const secondsOf = (p: GlobalPausePerson) => {
    if (!p.running || !pause) return p.seconds;
    const until = Math.min(now, new Date(pause.ends_at).getTime());
    return p.seconds + Math.max(0, Math.floor((until - fetchedAt) / 1000));
  };

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await joinGlobalPause(null);
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Could not join. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // Intentionen sparas före starten, så att rummet visar den direkt. Faller
  // sparningen startar pausen ändå: en paus ska aldrig hänga på rummet.
  const startWith = async (intention: string | null) => {
    setBusy(true);
    await joinGlobalPause(intention).catch(() => {});
    setPicking(false);
    setBusy(false);
    startPhonePause('replace', intention ?? '');
  };

  const closePeople = () => { setPeopleOpen(false); setSelected(null); setShowAll(false); };


  const header = (
    <View style={s.header}>
      <TouchableOpacity
        style={s.back}
        onPress={() => router.back()}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <FontAwesome5 name="chevron-left" size={15} color={Palette.textSecondary} />
      </TouchableOpacity>
      {GLOBAL_PAUSE_DEMO && (
        <View style={s.demoRow}>
          {(['before', 'live', 'done'] as DemoPhase[]).map(p => (
            <TouchableOpacity key={p} onPress={() => { setDemoPhase(p); load(); }} hitSlop={6}>
              <Text style={s.demoText}>{p}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      <View style={s.back} />
    </View>
  );

  if (!pause) {
    return (
      <View style={[s.screen, { paddingTop: insets.top + 6 }]}>
        {header}
        <View style={s.heroArea}>
          {failed ? (
            <TouchableOpacity onPress={load} activeOpacity={0.7}>
              <Text style={s.quiet}>Couldn&apos;t reach the room. Tap to try again.</Text>
            </TouchableOpacity>
          ) : (
            <ActivityIndicator color={Palette.hue} />
          )}
        </View>
      </View>
    );
  }

  const starts = new Date(pause.starts_at).getTime();
  const opens = new Date(pause.opens_at).getTime();
  const closes = new Date(pause.closes_at).getTime();
  const ends = new Date(pause.ends_at).getTime();
  const doorOpen = now >= opens && now <= closes;
  const live = now >= starts && now < ends;
  const closed = now > closes;
  // Den som redan sett sammanfattningen efter sin paus möts av nästa, inte av
  // DONE (lib/globalPause.ts `wasSummarized`).
  const done = !!pause.last && !wasSummarized(pause.last.starts_at);
  const mine = pause.me;

  const others = pause.people.filter(p => p.relation !== 'me' && p.state !== 'done');
  const featured = others.length > 0 ? others[Math.floor(now / LINE_MS) % others.length] : null;
  const faces = others.slice(0, FACES_SHOWN);
  const rest = pause.people.length - faces.length;

  return (
    <View style={[s.screen, { paddingTop: insets.top + 6, paddingBottom: safeBottom(insets.bottom) + ACTIONS_BOTTOM }]}>
      {header}

      <View style={s.heroArea}>
        <GlobeGrid size={GLOBE} active={focused} fade={Palette.bg} />
        <Halo color={done ? Palette.success : Palette.hue} breathing={live} />
        {done ? (
          <>
            <Text style={[s.heroBig, s.heroDone]}>Done</Text>
            <Text style={s.heroSub}>
              {pause.last!.people} of you · {formatDuration(pause.last!.total_seconds)} together
            </Text>
          </>
        ) : live ? (
          <>
            <Text style={s.heroBig}>{pause.counts.pausing}</Text>
            <Text style={s.heroSub}>pausing together</Text>
          </>
        ) : (
          <>
            <Text style={s.heroBig}>{timeOf(pause.starts_at)}</Text>
            <Text style={s.heroSub}>{GLOBAL_PAUSE_NAME} in {formatCountdown(starts - now)}</Text>
          </>
        )}
        {!done && (
          <View style={s.lineArea}>
            <View style={s.lineSlot}>
              {featured && (
                <Animated.Text
                  key={featured.key}
                  entering={FadeIn.duration(800)}
                  exiting={FadeOut.duration(500)}
                  style={s.line}
                  numberOfLines={1}
                >
                  {personLine(featured, live)}
                </Animated.Text>
              )}
            </View>
            {faces.length > 0 && (
              <TouchableOpacity
                style={s.faces}
                onPress={() => setPeopleOpen(true)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={`See the ${pause.people.length} people here`}
              >
                {faces.map((p, i) => (
                  <View key={p.key} style={[s.faceWrap, i > 0 && s.faceOverlap, { zIndex: FACES_SHOWN - i }]}>
                    <Face person={p} size={FACE_H} />
                  </View>
                ))}
                {rest > 0 && <Text style={s.more}>+{rest}</Text>}
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>


      <View style={s.actions}>
        {error && <Text style={s.error}>{error}</Text>}

        {done && !mine && <Text style={s.quiet}>Next · {formatGlobalPauseWhen(pause.starts_at)}</Text>}

        {!mine && !closed && (
          <TouchableOpacity style={s.join} onPress={join} disabled={busy} activeOpacity={0.75}>
            <Text style={s.joinText} numberOfLines={1} adjustsFontSizeToFit>{done ? "I'll join the next" : "I'll join"}</Text>
          </TouchableOpacity>
        )}

        {closed && !mine && <Text style={s.quiet}>Joining has closed for this one.</Text>}

        {done && pause.last?.was_there && <Text style={s.inLine}>You were there.</Text>}

        {mine && !mine.started && !done && (
          <>
            {doorOpen ? (
              <View style={s.pauseWrap}>
              <PauseAmbience />
              <HoldToStartButton
                onComplete={() => setPicking(true)}
                background={<PauseButtonFace radius={PAUSE_BTN_H / 2} />}
                holdMs={HOLD_TO_START_MS}
                style={s.pauseBtn}
                borderRadius={PAUSE_BTN_H / 2}
                accessibilityLabel="Start your pause"
                hintStyle={s.quiet}
              >
                <View style={s.glyph}>
                  <View style={s.glyphBar} />
                  <View style={s.glyphBar} />
                </View>
                <Text style={s.primaryText}>PAUSE</Text>
              </HoldToStartButton>
              </View>
            ) : (
              <>
                <Text style={s.inLine}>You&apos;re in</Text>
                {notifsOff && (
                  <TouchableOpacity
                    onPress={() => Linking.openSettings().catch(() => {})}
                    hitSlop={8}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Notifications are off, so there is no reminder. Turn them on in settings."
                  >
                    <Text style={s.notifsOff}>
                      Notifications are off · <Text style={s.notifsOn}>Turn on</Text>
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </>
        )}
      </View>

      <Modal visible={picking} transparent animationType="slide" onRequestClose={() => setPicking(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPicking(false)} accessibilityLabel="Close" />
          <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 24) + 16 }]}>
            <Text style={s.sheetTitle}>What will you do?</Text>
            <View style={s.options}>
              {categories.slice(0, 12).map(c => (
                <TouchableOpacity
                  key={c.id}
                  style={[s.option, { backgroundColor: alpha(intentionTone(Palette, c.id), 0.14) }]}
                  onPress={() => startWith(c.id)}
                  disabled={busy}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel={c.label}
                >
                  <Text style={s.optionEmoji}>{c.emoji}</Text>
                  <Text style={s.optionText} numberOfLines={1}>{c.label.toLowerCase()}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={() => startWith(null)} disabled={busy} hitSlop={8} style={s.justPause}>
              <Text style={s.link}>Just pause</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={peopleOpen} transparent animationType="slide" onRequestClose={closePeople}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closePeople} accessibilityLabel="Close" />
          <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 24) + 16 }]}>
            {selected ? (
              <Animated.View key={selected.key} entering={FadeIn.duration(300)} style={s.selected}>
                <Text style={s.selectedName} numberOfLines={1}>{personLine(selected, live)}</Text>
                {selected.state !== 'signed_up' && <Text style={s.selectedTime}>{clockText(secondsOf(selected))}</Text>}
              </Animated.View>
            ) : (
              <Text style={s.sheetTitle}>
                {pause.people.length === 1 ? '1 person here' : `${pause.people.length} people here`}
              </Text>
            )}
            <ScrollView style={s.gridScroll} contentContainerStyle={s.grid} showsVerticalScrollIndicator={false}>
              {(showAll ? pause.people : pause.people.slice(0, PEOPLE_SHOWN)).map(p => (
                <TouchableOpacity
                  key={p.key}
                  style={s.gridCell}
                  onPress={() => setSelected(p)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={personLine(p, live)}
                >
                  <Face person={p} size={52} />
                  <Text
                    style={[s.gridName, p.relation !== 'stranger' && p.relation !== 'me' && { color: relationColor(p) }]}
                    numberOfLines={1}
                  >
                    {displayName(p)}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {!showAll && pause.people.length > PEOPLE_SHOWN && (
              <TouchableOpacity onPress={() => setShowAll(true)} hitSlop={8} style={s.justPause} accessibilityRole="button">
                <Text style={s.link}>{moreLabel(pause.people.length - PEOPLE_SHOWN)}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function relationColor(p: GlobalPausePerson): string {
  return roomPalette('dark', p.relation === 'circle' ? 'circle' : 'friends').hue;
}

/** Fotot, annars initialen på intentionens ton. Ingen ram. */
function Face({ person, size }: { person: GlobalPausePerson; size: number }) {
  const Palette = usePalette();
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (person.avatar_url?.startsWith('https://')) {
    return <Image source={{ uri: person.avatar_url }} style={round} />;
  }
  const tone = person.intention_id ? intentionTone(Palette, person.intention_id) : Palette.hue;
  return (
    <View style={[round, { backgroundColor: alpha(tone, 0.3), alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={{ color: Palette.textPrimary, fontSize: Math.round(size * 0.4), fontWeight: '600' }}>
        {displayName(person)[0]?.toUpperCase() ?? '?'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  halo: { position: 'absolute', width: HALO, height: HALO, alignSelf: 'center' },
});

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent', paddingHorizontal: Spacing.xl },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: -Spacing.sm },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  demoRow: { flexDirection: 'row', gap: 16 },
  demoText: { fontSize: 12, color: Palette.textTertiary },

  heroArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // Designsystemets display: Arial Black 900, −0.03em.
  heroBig: { fontSize: 68, lineHeight: 76, fontWeight: '900', letterSpacing: -2, color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  // Grönt på begäran — se grönregelns sjunde undantag i CLAUDE.md.
  heroDone: { color: Palette.success },
  heroSub: { fontSize: 16, color: Palette.textSecondary, marginTop: 2, textAlign: 'center' },

  // Absolut i nederkanten av glorians yta: tar ingen höjd, så att klotet står
  // på samma plats i alla lägen (som när pausen är slut).
  lineArea: { position: 'absolute', left: 0, right: 0, bottom: 8, alignItems: 'center', gap: 14 },
  lineSlot: { height: 28, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  line: { fontSize: 18, fontWeight: '400', color: Palette.textPrimary },
  faces: { flexDirection: 'row', alignItems: 'center', minHeight: FACE_H + 4 },
  faceWrap: { borderRadius: (FACE_H + 4) / 2, borderWidth: 2, borderColor: Palette.bg },
  faceOverlap: { marginLeft: -12 },
  more: { fontSize: 14, color: Palette.textSecondary, marginLeft: 10 },

  actions: { gap: 14, minHeight: 90, justifyContent: 'flex-end' },
  // Samma knapp som PAUSE på Hem, med en starkare glöd: här är den skärmens
  // enda val, mot en mörk botten.
  // `stretch`: HoldToStartButton centrerar annars knappen i sin egen bredd.
  primary: {
    alignSelf: 'stretch',
    height: 62, borderRadius: Radius.pill, backgroundColor: Palette.accent,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    shadowColor: Palette.accent, shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.7, shadowRadius: 24, elevation: 14,
  },
  // Ett tryck, och därför inte samma knapp som PAUSE, som hålls in. Ingen
  // fyllning: fyllt är det som startar något. Ingen fast höjd, så att texten
  // aldrig klipps med större textstorlek.
  // Lika bred och hög som PAUSE (som tar sin bredd ur innehållet, ≈196 med
  // märket och 44 i padding på var sida), men utan fyllning: den trycks.
  join: {
    alignSelf: 'center',
    width: 196,
    minHeight: PAUSE_BTN_H,
    paddingHorizontal: 14,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: alpha(Palette.hue, 0.55),
    alignItems: 'center',
    justifyContent: 'center',
  },
  joinText: { fontSize: 16, lineHeight: 22, fontWeight: '600', color: Palette.hue },
  primaryText: { color: Palette.onAccent, fontSize: 17, fontWeight: '700', letterSpacing: 3.4 },
  pauseWrap: { alignSelf: 'stretch', alignItems: 'center' },
  // PAUSE som på Hem: bredden ur innehållet, inte ur raden.
  pauseBtn: {
    alignSelf: 'center',
    height: PAUSE_BTN_H, paddingHorizontal: 44, borderRadius: PAUSE_BTN_H / 2,
    backgroundColor: Palette.accent,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    shadowColor: Palette.accent, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.55, shadowRadius: 22, elevation: 12,
  },
  glyph: { flexDirection: 'row', gap: 5 },
  glyphBar: { width: 6, height: 18, borderRadius: 3, backgroundColor: Palette.onAccent },
  inLine: { fontSize: 17, color: Palette.textPrimary, textAlign: 'center' },
  quiet: { fontSize: 14, lineHeight: 20, color: Palette.textSecondary, textAlign: 'center' },
  notifsOff: { fontSize: 13, lineHeight: 18, color: Palette.textTertiary, textAlign: 'center' },
  notifsOn: { color: Palette.hue, fontWeight: '700' },
  links: { flexDirection: 'row', justifyContent: 'center', gap: 32 },
  link: { fontSize: 14, color: Palette.textSecondary },
  error: { fontSize: 14, color: Palette.danger, textAlign: 'center' },

  overlay: { flex: 1, backgroundColor: Palette.scrim, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Palette.modalSurface,
    borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.xl, paddingTop: 26, gap: 18,
  },
  sheetTitle: { fontSize: 20, fontWeight: '600', color: Palette.textPrimary, textAlign: 'center' },
  options: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 },
  option: { width: '31.5%', paddingVertical: 14, borderRadius: Radius.lg, alignItems: 'center', gap: 6 },
  optionEmoji: { fontSize: 24 },
  optionText: { fontSize: 13, color: Palette.textPrimary },
  justPause: { alignSelf: 'center', paddingVertical: 4 },

  selected: { alignItems: 'center', minHeight: 62 },
  selectedName: { fontSize: 17, color: Palette.textPrimary },
  selectedTime: { fontSize: 28, fontWeight: '200', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  gridScroll: { maxHeight: 420, flexGrow: 0 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 16 },
  gridCell: { width: '25%', alignItems: 'center', gap: 6 },
  gridName: { fontSize: 12, color: Palette.textSecondary, maxWidth: '92%' },
});
