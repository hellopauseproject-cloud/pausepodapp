import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PodBoxStage, PodStageState } from '../components/pod-box-stage';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { SegmentedPill } from '../components/segmented-pill';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { supabase } from '../lib/supabase';

/**
 * Hör till **pause-rummet**, se ROOMS i constants/appTheme.ts.
 *
 * Lådsidan: vad PausePod är, och hur den ställs in. Den är två saker på en
 * gång, med flit — en presentation för den som inte har en låda, och en
 * bruksanvisning för den som just fått en. Ingången är PausePod-delen i
 * Settings ([app/onboarding.tsx](onboarding.tsx)).
 *
 * **Bilden bär stegen, inte texten.** Lådan spelar upp varje moment
 * ([components/pod-box-stage.tsx](../components/pod-box-stage.tsx)) och
 * displayen säger exakt det lådan säger; raderna under är tre till fyra ord
 * med en mening under. Ett tryck på en rad hoppar dit, och uppspelningen
 * fortsätter därifrån. Samma tanke som det gamla lådsteget i introduktionen
 * ([components/intro/step-box.tsx](../components/intro/step-box.tsx)), men
 * för v8: taggen och locket, inga tummar.
 *
 * **Bara NFC-pausen visas.** Appens lådväg (`set_mode`, `phone_down`) går
 * bara att nå från valskärmen, som är avstängd, och två sätt att starta samma
 * sak hade gjort berättelsen dubbelt så lång.
 *
 * Inställningen följer firmwaren: utan känt nät visar lådan **NO WIFI ·
 * SCAN TO SET UP**, startar ett eget öppet nät och öppnar en sida där man
 * väljer WiFi; en okänd tagg ger **NEW TAG · SCAN TO PAIR** och koden som
 * [app/pair.tsx](pair.tsx) tar emot.
 */
export default function PodRoom() {
  return (
    <RoomProvider room="pause">
      <View style={roomShell}>
        <ScreenBackground room="pause" />
        <PodScreen />
      </View>
    </RoomProvider>
  );
}

/** Namnet lådan hälsar med innan användarnamnet hämtats, eller utan konto. */
const FALLBACK_NAME = 'you';

type Frame = { ms: number; set: Partial<PodStageState> };
type Step = { title: string; sub: string; frames: Frame[] };
type Tab = 'use' | 'setup';

const USE_START: PodStageState = { lid: 0, phone: 'away', screen: 'logo', zoom: 'none', side: 'tag', sticker: true, app: 'none' };

/**
 * Taggen klistras på: telefonen med ryggen upp, kameran går fram till dess
 * nedre ände där skenet visar platsen, och dekalen trycks fast där.
 */
const STICK_ON: Frame[] = [
  { ms: 1300, set: { phone: 'hover' } },
  { ms: 1600, set: { zoom: 'phone' } },
  { ms: 2400, set: { sticker: true } },
  { ms: 1000, set: { zoom: 'none' } },
];

const USE: Step[] = [
  {
    title: 'Lid off',
    sub: 'The box is awake and waiting.',
    frames: [
      { ms: 900, set: USE_START },
      { ms: 900, set: { lid: 1 } },
      { ms: 1100, set: { lid: 2 } },
    ],
  },
  {
    title: 'Phone in',
    sub: 'Tag down, screen up.',
    frames: [
      { ms: 1300, set: { phone: 'hover' } },
      { ms: 1100, set: { side: 'screen' } },
      { ms: 1300, set: { phone: 'in' } },
      { ms: 1300, set: { screen: 'checking' } },
      { ms: 2400, set: { screen: 'hello' } },
    ],
  },
  {
    title: 'Lid on',
    sub: 'That’s the start button. The clock runs.',
    frames: [
      { ms: 1800, set: { lid: 0 } },
      { ms: 1400, set: { screen: 'check' } },
      { ms: 1400, set: { screen: 'clockOn' } },
      { ms: 3200, set: { screen: 'count' } },
      { ms: 2600, set: { screen: 'active' } },
    ],
  },
  {
    title: 'Phone out',
    sub: 'Lid off. Phone out. Pause done.',
    frames: [
      { ms: 900, set: { lid: 1, screen: 'hold' } },
      { ms: 1300, set: { lid: 2 } },
      { ms: 1300, set: { phone: 'hover', screen: 'done' } },
      { ms: 1100, set: { phone: 'away' } },
      { ms: 1500, set: {} },
      { ms: 1900, set: { lid: 0, screen: 'logo' } },
    ],
  },
  {
    title: 'Saved.',
    sub: 'The pause is in your stats.',
    frames: [
      { ms: 4600, set: { app: 'ring' } },
      { ms: 7000, set: { app: 'stats' } },
      { ms: 900, set: { app: 'none' } },
    ],
  },
];

const SETUP_START: PodStageState = { lid: 0, phone: 'away', screen: 'off', zoom: 'none', side: 'tag', sticker: false, app: 'none' };
const SETUP: Step[] = [
  {
    title: 'Wake it up',
    sub: 'The box looks for WiFi.',
    frames: [
      { ms: 1400, set: SETUP_START },
      { ms: 1200, set: { screen: 'logo' } },
      { ms: 1200, set: { screen: 'wifi' } },
    ],
  },
  {
    title: 'Scan the code',
    sub: 'Choose your WiFi, type the password. Connected.',
    frames: [
      { ms: 3600, set: {} },
      { ms: 3000, set: { screen: 'connected' } },
      { ms: 1200, set: { screen: 'logo' } },
    ],
  },
  {
    title: 'Tag on, phone in',
    sub: 'Place the tag on the far bottom of the phone. Tag down in the box, and it gets a code.',
    frames: [
      { ms: 900, set: { lid: 1 } },
      { ms: 900, set: { lid: 2 } },
      ...STICK_ON,
      { ms: 1100, set: { side: 'screen' } },
      { ms: 1300, set: { phone: 'in' } },
      { ms: 1300, set: { screen: 'checking' } },
      { ms: 2800, set: { screen: 'pair' } },
    ],
  },
  {
    title: 'Scan QR and confirm',
    sub: 'Phone out, camera on. Confirm in the app, then phone back in.',
    frames: [
      { ms: 1400, set: { phone: 'hover' } },
      { ms: 3400, set: { app: 'camera' } },
      { ms: 2800, set: { app: 'confirm' } },
      { ms: 2200, set: { app: 'registered' } },
      // Telefonen börjar ner i lådan precis när attrappen lagt sig (MORPH_MS 1000).
      { ms: 850, set: { app: 'none' } },
      { ms: 1400, set: { phone: 'in' } },
    ],
  },
  {
    title: 'Lid on. Done.',
    sub: 'The box knows you now. Your first pause starts.',
    // Telefonen ligger kvar efter HI: locket på startar pausen, som i ritualen.
    frames: [
      { ms: 3400, set: { screen: 'paired' } },
      { ms: 1800, set: { lid: 0 } },
      { ms: 1400, set: { screen: 'check' } },
      { ms: 1400, set: { screen: 'clockOn' } },
      { ms: 3200, set: { screen: 'count' } },
      { ms: 2600, set: { screen: 'active' } },
    ],
  },
];

const SCRIPTS: Record<Tab, { start: PodStageState; steps: Step[] }> = {
  use: { start: USE_START, steps: USE },
  setup: { start: SETUP_START, steps: SETUP },
};

/** Läget när steg `i` börjar: allt före det, spelat färdigt. */
function stateBefore(tab: Tab, i: number): PodStageState {
  const { start, steps } = SCRIPTS[tab];
  let s = start;
  for (const step of steps.slice(0, i)) for (const fr of step.frames) s = { ...s, ...fr.set };
  return s;
}

/**
 * Spelar upp en tidslinje: läget byts ruta för ruta, steget rullar vidare och
 * börjar om efter sista. Står still medan skärmen inte har fokus.
 */
function usePodPlayer(tab: Tab) {
  const [stage, setStage] = useState<PodStageState>(SCRIPTS[tab].start);
  const [cursor, setCursor] = useState({ step: 0, frame: 0, run: 0 });
  const [focused, setFocused] = useState(true);

  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));

  // Ett nytt manus börjar från början.
  const tabRef = useRef(tab);
  useEffect(() => {
    if (tabRef.current === tab) return;
    tabRef.current = tab;
    setStage(SCRIPTS[tab].start);
    setCursor(c => ({ step: 0, frame: 0, run: c.run + 1 }));
  }, [tab]);

  const steps = SCRIPTS[tab].steps;
  const step = steps[Math.min(cursor.step, steps.length - 1)];

  useEffect(() => {
    if (!focused) return;
    // Ett manusbyte hinner rendera en gång med det gamla stegets plats.
    const fr = step.frames[cursor.frame];
    if (!fr) return;
    setStage(s => ({ ...s, ...fr.set }));
    const t = setTimeout(() => {
      setCursor(c => {
        if (c.frame + 1 < step.frames.length) return { ...c, frame: c.frame + 1 };
        return { step: (c.step + 1) % steps.length, frame: 0, run: c.run };
      });
    }, fr.ms);
    return () => clearTimeout(t);
  }, [cursor, focused, step, steps.length]);

  const jump = (i: number) => {
    setStage(stateBefore(tab, i));
    setCursor(c => ({ step: i, frame: 0, run: c.run + 1 }));
  };

  return { stage, active: cursor.step, jump };
}

function PodScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState<Tab>('use');
  const { stage, active, jump } = usePodPlayer(tab);
  const { user } = useAuth();
  const [name, setName] = useState(FALLBACK_NAME);

  // Lådan säger HI med användarnamnet, samma som Hem (`profiles.username`)
  // och samma som lådan själv visar för taggens ägare. Inte den lokala
  // profilens namn: det kan skilja sig från användarnamnet.
  useEffect(() => {
    if (!user?.id) return;
    let alive = true;
    supabase.from('profiles').select('username').eq('id', user.id).maybeSingle()
      .then(({ data }) => { if (alive && data?.username) setName(data.username); });
    return () => { alive = false; };
  }, [user?.id]);
  const steps = SCRIPTS[tab].steps;

  const stageWidth = Math.min(width, 520);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 40 }}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.gutter}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7} accessibilityLabel="Back">
          <FontAwesome5 name="arrow-left" size={16} color={Palette.hue} />
        </TouchableOpacity>
        <Text style={styles.kicker}>PAUSEPOD</Text>
        <Text style={styles.title}>{'Phone in.\nLid on.'}</Text>
        <Text style={styles.lead}>
          Your phone finally has its own place. And you get yours back.
        </Text>
      </View>

      <View style={styles.pillWrap}>
        <SegmentedPill<Tab>
          options={[{ key: 'use', label: 'How it works' }, { key: 'setup', label: 'Set it up' }]}
          value={tab}
          onChange={setTab}
          width={Math.min(width - Spacing.xl * 2, 320)}
        />
      </View>

      <View style={styles.stageWrap}>
        <PodBoxStage width={stageWidth} state={stage} name={name} />
      </View>

      <View style={styles.gutter}>
        {steps.map((s, i) => {
          const on = i === active;
          return (
            <TouchableOpacity
              key={`${tab}${i}`}
              style={styles.step}
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                jump(i);
              }}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`Step ${i + 1}. ${s.title}. ${s.sub}`}
            >
              <View style={[styles.num, on && styles.numOn]}>
                <Text style={[styles.numText, on && styles.numTextOn]}>{i + 1}</Text>
              </View>
              <View style={styles.stepText}>
                <Text style={[styles.stepTitle, !on && styles.dim]}>{s.title}</Text>
                <Text style={[styles.stepSub, !on && styles.dim]}>{s.sub}</Text>
              </View>
            </TouchableOpacity>
          );
        })}

        {tab === 'setup' && (
          <TouchableOpacity
            style={styles.cta}
            onPress={() => router.push('/pair' as never)}
            activeOpacity={0.85}
            accessibilityRole="button"
          >
            <FontAwesome5 name="tag" size={14} color={Palette.onAccent} />
            <Text style={styles.ctaText}>Register a Pause tag</Text>
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  gutter: { paddingHorizontal: Spacing.xl },
  backBtn: { alignSelf: 'flex-start', paddingVertical: 12, paddingRight: 12, marginBottom: 4 },
  kicker: { ...Palette.eyebrow, marginBottom: Spacing.sm },
  title: {
    fontSize: 34, lineHeight: 38, fontWeight: '900', letterSpacing: -0.6,
    color: Palette.textPrimary, textTransform: 'uppercase',
  },
  lead: { fontSize: 16, lineHeight: 23, color: Palette.textSecondary, marginTop: Spacing.md },
  pillWrap: { alignItems: 'center', marginTop: Spacing.xl },
  stageWrap: { alignItems: 'center', marginTop: Spacing.sm, marginBottom: Spacing.md },
  step: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: Spacing.sm + 2, gap: Spacing.md },
  num: {
    width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: Palette.ink20, marginTop: 1,
  },
  numOn: { backgroundColor: Palette.accent, borderColor: Palette.accent },
  numText: { fontSize: 13, fontWeight: '900', color: Palette.textTertiary },
  numTextOn: { color: Palette.onAccent },
  stepText: { flex: 1 },
  stepTitle: { fontSize: 17, lineHeight: 22, fontWeight: '700', color: Palette.textPrimary },
  stepSub: { fontSize: 14, lineHeight: 20, color: Palette.textSecondary, marginTop: 2 },
  dim: { opacity: 0.55 },
  cta: {
    marginTop: Spacing.xl, height: 52, borderRadius: Radius.pill, backgroundColor: Palette.accent,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
  },
  ctaText: { fontSize: 16, fontWeight: '700', color: Palette.onAccent },
});
