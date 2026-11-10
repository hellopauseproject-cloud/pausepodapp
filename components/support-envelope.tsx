import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Reanimated, {
  Easing, interpolate, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue,
  withDelay, withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, Ellipse, Line, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';
import { AppPalette, alpha } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { useHand } from '../lib/handFont';

export type SupportKind = 'text' | 'voice' | 'video' | 'photo';

/**
 * Kuvertet som ett stödsvar landar i ([app/support-arrived.tsx](../app/support-arrived.tsx)).
 * Det ersatte en samtalsskärm med ringsignal, vibration och en grön och en röd
 * lur: den var så lik telefonens egen att den kändes påträngande, och ett
 * stödsvar är något man öppnar när man vill — inte något som ringer.
 *
 * Kuvertet är nästan vitt med en aning persika och terrakotta, inte
 * palettstyrt, och samma i båda lägena. Ett krämvitt kuvert utan kant smälte
 * in i Friends-rummets varma botten, och ett blått prövades och föll på
 * begäran. Det som lyfter det är en tunn terrakottakant, skuggan och en
 * persikofärgad glöd bakom. Sigillet är ett hjärta i ljust på terrakotta
 * (november 2026, på begäran; det var pausens två streck).
 * Brevet är krämvitt papper (`LETTER_PAPER`), samma som text-message.tsx
 * visar texten på, så att brevet som glider ut är det man sedan läser.
 *
 * Öppningen är tre steg: fliken viker sig upp (två flikar, en framför brevet
 * som krymper mot överkanten och en bakom som växer uppåt — en `scaleY` och
 * inte en 3D-vridning, som renderas olika på iOS och Android), brevet glider
 * upp, och kuvertet sjunker undan. `onOpened` anropas när brevet står fritt.
 */

export const ENVELOPE = {
  body: '#f1d3bf',
  pocket: '#fffaf6',
  flap: '#fbe9dc',
  edge: 'rgba(184,106,68,0.32)',
  fold: 'rgba(184,106,68,0.24)',
  // Papperets toningar och de mjuka kanterna (kuvertet här; det lilla
  // kuvertet i opens-picker.tsx använder fortfarande edge/fold).
  flapLight: '#fdf3ea',
  flapDeep: '#f3d9c6',
  pocketDeep: '#fbefe5',
  hairline: 'rgba(150,85,50,0.16)',
  shade: '#6e3719',
  foldInk: '#9a5a34',
  glow: '#f0a882',
  seal: '#c9714b',
  // Sigillet på ett kuvert som öppnas efter en paus: appens accent, samma blå
  // som PAUSE-knappen.
  pauseSeal: '#2e86de',
  // Sigillens glas (SealFace): en ljus punkt uppe till vänster, grundtonen,
  // och en djup ton i kanten — terrakotta för hjärtat, blått för pausen.
  sealLight: '#f2b08e',
  sealDeep: '#8a3f22',
  pauseSealLight: '#a8d4ff',
  pauseSealDeep: '#134a87',
  sealMark: '#fff7f0',
};

/** Brevpappret, delat med text-message.tsx. */
export const LETTER_PAPER = {
  paper: '#fffaf2',
  edge: 'rgba(80,55,30,0.14)',
  rule: 'rgba(184,106,68,0.16)',
  ink: '#2a1f28',
  inkSoft: 'rgba(42,31,40,0.62)',
};

export const KIND_LABEL: Record<SupportKind, string> = {
  text: 'A few words',
  voice: 'A voice message',
  video: 'A video',
  photo: 'A photo',
};
export const KIND_ICON: Record<SupportKind, string> = {
  text: 'feather-alt',
  voice: 'microphone',
  video: 'video',
  photo: 'camera',
};

// Sigillet bryts först: det sväller (POP), spricker i två halvor som faller
// isär (CRACK), och fliken börjar vika sig upp medan halvorna faller.
const SEAL_POP_MS = 160;
const SEAL_CRACK_MS = 420;
const SEAL_LEAD_MS = SEAL_POP_MS + 140;
// Kuvertets hörn och flikens spets, rundade så att det läses som papper och
// inte som en ritad triangel.
const CORNER_R = 12;
const TIP_R = 9;
// Hur långt under fliken dess mjuka skugga når.
const FLAP_SHADOW = 4;
// Sigillets mjuka skugga är större än sigillet, så att den tonar ut runt det.
const SEAL_SHADOW = 64;

type Pt = [number, number];

/**
 * En sluten form genom `points` där varje hörn rundas med sin radie: linjen
 * stannar `r` före hörnet och svänger runt det med en kvadratisk kurva.
 * Radien krymps om kanterna är för korta för den.
 */
function roundedPath(points: Pt[], radii: number[]): string {
  const n = points.length;
  const corner = (i: number) => {
    const p = points[i];
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const toward = (q: Pt, r: number): Pt => {
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      return [p[0] + (dx / len) * r, p[1] + (dy / len) * r];
    };
    const r = Math.min(
      radii[i] ?? 0,
      Math.hypot(prev[0] - p[0], prev[1] - p[1]) / 2,
      Math.hypot(next[0] - p[0], next[1] - p[1]) / 2,
    );
    return { p, a: toward(prev, r), b: toward(next, r) };
  };
  const cs = points.map((_, i) => corner(i));
  const f = (q: Pt) => `${q[0].toFixed(2)} ${q[1].toFixed(2)}`;
  let d = `M${f(cs[0].b)}`;
  for (let i = 1; i <= n; i++) {
    const c = cs[i % n];
    d += ` L${f(c.a)} Q${f(c.p)} ${f(c.b)}`;
  }
  return `${d} Z`;
}

// Brevets ram (`letterClip`): luft på sidorna och över brevets högsta läge.
const CLIP_SIDE = 40;
const CLIP_TOP = 40;
const FLAP_MS = 420;
const LETTER_MS = 620;
const SINK_MS = 420;

/**
 * Kuvertets höjd och luften ovanför det (`rise`), som komponenten reserverar
 * i sin egen höjd för brevet att glida upp i. Den som placerar kuvertet ska
 * räkna med dem härifrån — luften är osynlig, men den flyttar kuvertet nedåt.
 */
export function envelopeMetrics(width: number) {
  const H = Math.round(width * 0.64);
  return { H, rise: Math.round(H * 0.95) };
}

export function SupportEnvelope({
  width, senderName, senderAvatarUrl, kind, previewText, photoUrl, open, onOpened, sealed = false,
  invite = false,
}: {
  /** Öppnas efter en paus: blått sigill med pausens två streck. Går inte att
   *  bryta här; ett tryck tar fram PAUSE-knappen (app/support-arrived.tsx). */
  sealed?: boolean;
  /** Kuvertet står i mitten och väntar på ett tryck: sigillet slår ett
   *  hjärtslag med jämna mellanrum och en ring slår ut ur det — det är
   *  kuvertet som är knappen, och sigillet säger var man trycker. */
  invite?: boolean;
  width: number;
  senderName: string;
  senderAvatarUrl: string | null;
  kind: SupportKind;
  /** Textsvarets början, skrivet på brevet. */
  previewText?: string | null;
  /** Fotosvarets bild, på brevet. */
  photoUrl?: string | null;
  open: boolean;
  onOpened: () => void;
}) {
  const Palette = usePalette();
  const hand = useHand();
  const reduceMotion = useReducedMotion();

  const W = width;
  // Hur högt brevet glider (`rise`): tillräckligt för att det mesta av det
  // står fritt ovanför kuvertet, och resten fortfarande ser instoppat ut.
  const { H, rise: LETTER_RISE } = envelopeMetrics(width);
  const FLAP_H = Math.round(H * 0.56);
  const LETTER_INSET = Math.round(W * 0.06);
  const LETTER_H = Math.round(H * 1.15);

  const styles = useMemo(
    () => makeStyles(Palette, W, H, FLAP_H, LETTER_INSET, LETTER_H, LETTER_RISE),
    [Palette, W, H, FLAP_H, LETTER_INSET, LETTER_H, LETTER_RISE],
  );

  const flap = useSharedValue(0);
  const letter = useSharedValue(0);
  const sink = useSharedValue(0);
  const bob = useSharedValue(0);
  const sealPop = useSharedValue(0);
  const crack = useSharedValue(0);
  const beat = useSharedValue(0);
  const halo = useSharedValue(0);

  // Hjärtslaget: två slag (dunk-dunk) och sedan vila, med en ring som slår ut
  // ur sigillet på första slaget. Bara på det kuvert som väntar på ett tryck —
  // också det förseglade, vars sigill tar fram PAUSE-knappen.
  const beckon = invite && !open && !reduceMotion;
  useEffect(() => {
    if (!beckon) {
      beat.value = withTiming(0, { duration: 150 });
      halo.value = 0;
      return;
    }
    beat.value = withDelay(500, withRepeat(
      withSequence(
        withTiming(1, { duration: 150, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 170, easing: Easing.in(Easing.quad) }),
        withTiming(0.6, { duration: 130, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 220, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 1700 }),
      ),
      -1,
    ));
    halo.value = withDelay(500, withRepeat(
      withSequence(
        withTiming(1, { duration: 1100, easing: Easing.out(Easing.cubic) }),
        withTiming(0, { duration: 0 }),
        withTiming(0, { duration: 1270 }),
      ),
      -1,
    ));
  }, [beckon, beat, halo]);

  // Ett lugnt gupp medan kuvertet väntar. Det är det enda som säger "öppna
  // mig" utan en ringsignal, och det stannar när öppningen börjar.
  useEffect(() => {
    if (reduceMotion || open) { bob.value = withTiming(0, { duration: 200 }); return; }
    bob.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 1600, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
    );
  }, [open, reduceMotion, bob]);

  useEffect(() => {
    if (!open) return;
    if (reduceMotion) {
      sealPop.value = 1; crack.value = 1; flap.value = 1; letter.value = 1; sink.value = 1;
      onOpened();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    sealPop.value = withTiming(1, { duration: SEAL_POP_MS, easing: Easing.out(Easing.back(3)) });
    crack.value = withDelay(SEAL_POP_MS, withTiming(1, { duration: SEAL_CRACK_MS, easing: Easing.in(Easing.quad) }));
    // Knäppen när sigillet spricker.
    setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(() => {}), SEAL_POP_MS);
    flap.value = withDelay(SEAL_LEAD_MS, withTiming(1, { duration: FLAP_MS, easing: Easing.inOut(Easing.cubic) }));
    letter.value = withDelay(SEAL_LEAD_MS + FLAP_MS - 60, withTiming(1, { duration: LETTER_MS, easing: Easing.out(Easing.cubic) }, done => {
      if (done) runOnJS(lettered)();
    }));
    sink.value = withDelay(SEAL_LEAD_MS + FLAP_MS + LETTER_MS - 120, withTiming(1, { duration: SINK_MS, easing: Easing.in(Easing.cubic) }, done => {
      if (done) runOnJS(onOpened)();
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function lettered() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => {});
  }

  const wholeStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(bob.value, [0, 1], [0, -6]) }],
  }));
  const frontFlapStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: interpolate(flap.value, [0, 0.5, 1], [1, 0, 0]) }],
    opacity: flap.value < 0.5 ? 1 : 0,
  }));
  const backFlapStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: interpolate(flap.value, [0, 0.5, 1], [0, 0, 1]) }],
    opacity: interpolate(sink.value, [0, 1], [1, 0]),
  }));
  // Hela sigillet sväller, och de två halvorna faller sedan isär åt var sitt
  // håll: utåt, nedåt, vridna, och tonar bort.
  const sealStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (0.18 * sealPop.value + 0.12 * beat.value) * (1 - crack.value) }],
  }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: interpolate(halo.value, [0, 0.1, 1], [0, 0.55, 0]) * (1 - sealPop.value),
    transform: [{ scale: interpolate(halo.value, [0, 1], [0.9, 1.9]) }],
  }));
  // Skuggan under sigillet, som får det att ligga ovanpå fliken; den följer
  // med slaget och försvinner när sigillet spricker.
  const sealShadowStyle = useAnimatedStyle(() => ({
    opacity: 1 - crack.value,
    transform: [{ scale: 1 + 0.12 * beat.value }],
  }));
  const halfLeftStyle = useAnimatedStyle(() => ({
    opacity: interpolate(crack.value, [0, 0.15, 1], [1, 1, 0]),
    transform: [
      { translateX: interpolate(crack.value, [0, 1], [0, -22]) },
      { translateY: interpolate(crack.value, [0, 1], [0, 34]) },
      { rotate: `${interpolate(crack.value, [0, 1], [0, -28])}deg` },
    ],
  }));
  const halfRightStyle = useAnimatedStyle(() => ({
    opacity: interpolate(crack.value, [0, 0.15, 1], [1, 1, 0]),
    transform: [
      { translateX: interpolate(crack.value, [0, 1], [0, 22]) },
      { translateY: interpolate(crack.value, [0, 1], [0, 30]) },
      { rotate: `${interpolate(crack.value, [0, 1], [0, 24])}deg` },
    ],
  }));
  const letterStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(letter.value, [0, 1], [0, -LETTER_RISE]) + interpolate(sink.value, [0, 1], [0, H * 0.35]) },
      { scale: interpolate(sink.value, [0, 1], [1, 1.16]) },
    ],
  }));
  const envelopeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(sink.value, [0, 1], [1, 0]),
    transform: [{ translateY: interpolate(sink.value, [0, 1], [0, H * 0.9]) }],
  }));

  const firstName = senderName.split(' ')[0];

  const GLOW = Math.round(W * 1.7);
  // Hjärtat på ett kuvert som går att öppna; pausens två streck i blått på
  // ett som öppnas efter en paus — samma blå som PAUSE-knappen under det.
  const sealMark = sealed ? (
    <View style={styles.pauseMark}>
      <View style={styles.pauseMarkBar} />
      <View style={styles.pauseMarkBar} />
    </View>
  ) : (
    <FontAwesome5 name="heart" solid size={19} color={ENVELOPE.sealMark} style={styles.sealHeart} />
  );
  const flapPath = roundedPath([[0, 0.5], [W, 0.5], [W / 2, FLAP_H]], [CORNER_R, CORNER_R, TIP_R]);

  return (
    <Reanimated.View style={[{ width: W, height: H, marginTop: LETTER_RISE }, wholeStyle]}>
      {/* Glöden bakom kuvertet — det som lyfter det ur rummets botten. */}
      <Reanimated.View
        style={[styles.glow, { width: GLOW, height: GLOW, left: (W - GLOW) / 2, top: (H - GLOW) / 2 }, envelopeStyle]}
        pointerEvents="none"
      >
        <Svg width={GLOW} height={GLOW}>
          <Defs>
            <RadialGradient id="envGlow" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={ENVELOPE.glow} stopOpacity={0.5} />
              <Stop offset="0.55" stopColor={ENVELOPE.glow} stopOpacity={0.14} />
              <Stop offset="1" stopColor={ENVELOPE.glow} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={GLOW / 2} cy={GLOW / 2} r={GLOW / 2} fill="url(#envGlow)" />
        </Svg>
      </Reanimated.View>

      {/* Kuvertets baksida och fliken som vikts upp — bakom brevet. */}
      <Reanimated.View style={[StyleSheet.absoluteFill, envelopeStyle]} pointerEvents="none">
        <View style={styles.body} />
      </Reanimated.View>
      <Reanimated.View style={[styles.backFlap, backFlapStyle]} pointerEvents="none">
        <Svg width={W} height={FLAP_H}>
          <Defs>
            {/* Flikens insida, sedd framifrån: mörkare mot spetsen. */}
            <LinearGradient id="backFlapFill" x1="0" y1="1" x2="0" y2="0">
              <Stop offset="0" stopColor={ENVELOPE.flap} />
              <Stop offset="1" stopColor={ENVELOPE.flapDeep} />
            </LinearGradient>
          </Defs>
          <Path
            d={roundedPath([[0, FLAP_H], [W / 2, 0.5], [W, FLAP_H]], [CORNER_R * 0.6, TIP_R, CORNER_R * 0.6])}
            fill="url(#backFlapFill)" stroke={ENVELOPE.hairline} strokeWidth={0.75}
          />
        </Svg>
      </Reanimated.View>

      {/* Brevet, i en ram som slutar vid kuvertets nederkant och är öppen
          uppåt: brevet är högre än kuvertet, och utan ramen stack dess nedre
          del ut under fickan. Ramen är lite bredare än kuvertet, så att
          brevet får växa när det glider fram. */}
      <View style={styles.letterClip} pointerEvents="none">
      <Reanimated.View style={[styles.letter, letterStyle]} pointerEvents="none">
        <View style={styles.letterHead}>
          {senderAvatarUrl ? (
            <Image source={{ uri: senderAvatarUrl }} style={styles.letterAvatar} />
          ) : (
            <View style={[styles.letterAvatar, styles.letterAvatarFallback]}>
              <Text style={styles.letterAvatarLetter}>{firstName[0]?.toUpperCase() ?? '?'}</Text>
            </View>
          )}
          <Text style={[styles.letterFrom, hand(17, true)]} numberOfLines={1}>From {firstName}</Text>
        </View>
        {kind === 'photo' && photoUrl ? (
          <Image source={{ uri: photoUrl }} style={styles.letterPhoto} resizeMode="cover" />
        ) : kind === 'text' && previewText ? (
          <Text style={[styles.letterText, hand(16)]} numberOfLines={4}>{previewText}</Text>
        ) : (
          <View style={styles.letterKind}>
            <FontAwesome5 name={KIND_ICON[kind]} size={22} color={ENVELOPE.seal} />
            <Text style={[styles.letterKindText, hand(16)]}>{KIND_LABEL[kind]}</Text>
          </View>
        )}
      </Reanimated.View>
      </View>

      {/* Fickan framför brevet och fliken som är stängd. */}
      <Reanimated.View style={[StyleSheet.absoluteFill, envelopeStyle]} pointerEvents="none">
        <Svg width={W} height={H}>
          <Defs>
            <LinearGradient id="pocketFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={ENVELOPE.pocket} />
              <Stop offset="1" stopColor={ENVELOPE.pocketDeep} />
            </LinearGradient>
            {/* Vecken tonar bort mot mitten, som ett pappersveck gör. */}
            <LinearGradient id="foldL" x1="0" y1="1" x2="1" y2="0">
              <Stop offset="0" stopColor={ENVELOPE.foldInk} stopOpacity={0.22} />
              <Stop offset="1" stopColor={ENVELOPE.foldInk} stopOpacity={0} />
            </LinearGradient>
            <LinearGradient id="foldR" x1="1" y1="1" x2="0" y2="0">
              <Stop offset="0" stopColor={ENVELOPE.foldInk} stopOpacity={0.22} />
              <Stop offset="1" stopColor={ENVELOPE.foldInk} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Path
            d={roundedPath(
              [[0, 0], [W / 2, FLAP_H], [W, 0], [W, H], [0, H]],
              [CORNER_R, TIP_R, CORNER_R, CORNER_R, CORNER_R],
            )}
            fill="url(#pocketFill)" stroke={ENVELOPE.hairline} strokeWidth={0.75}
          />
          <Line x1={4} y1={H - 3} x2={W / 2} y2={H * 0.5} stroke="url(#foldL)" strokeWidth={1} strokeLinecap="round" />
          <Line x1={W - 4} y1={H - 3} x2={W / 2} y2={H * 0.5} stroke="url(#foldR)" strokeWidth={1} strokeLinecap="round" />
        </Svg>
      </Reanimated.View>
      <Reanimated.View style={[styles.frontFlap, frontFlapStyle]} pointerEvents="none">
        <Svg width={W} height={FLAP_H + FLAP_SHADOW}>
          <Defs>
            <LinearGradient id="flapFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={ENVELOPE.flapLight} />
              <Stop offset="1" stopColor={ENVELOPE.flap} />
            </LinearGradient>
          </Defs>
          {/* Flikens skugga på fickan: samma form, förskjuten nedåt i två
              steg. Den mjuka kanten är det som får fliken att ligga på
              pappret i stället för att vara ritad på det. */}
          <Path d={flapPath} fill={ENVELOPE.shade} fillOpacity={0.05} translateY={FLAP_SHADOW} />
          <Path d={flapPath} fill={ENVELOPE.shade} fillOpacity={0.09} translateY={FLAP_SHADOW / 2} />
          <Path d={flapPath} fill="url(#flapFill)" stroke={ENVELOPE.hairline} strokeWidth={0.75} />
        </Svg>
      </Reanimated.View>

      {/* Sigillet: ett hjärta där flikens spets möter fickan. Det är ritat
          två gånger, var och en klippt till sin halva, så att det kan spricka
          mitt itu när kuvertet öppnas. */}
      <Reanimated.View style={[styles.sealShadow, { top: FLAP_H - 24 + 3 }, sealShadowStyle]} pointerEvents="none">
        <Svg width={SEAL_SHADOW} height={SEAL_SHADOW}>
          <Defs>
            <RadialGradient id="sealShadow" cx="50%" cy="50%" r="50%">
              <Stop offset="0.55" stopColor={ENVELOPE.shade} stopOpacity={0.32} />
              <Stop offset="1" stopColor={ENVELOPE.shade} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={SEAL_SHADOW / 2} cy={SEAL_SHADOW / 2} r={SEAL_SHADOW / 2} fill="url(#sealShadow)" />
        </Svg>
      </Reanimated.View>
      <Reanimated.View
        style={[styles.sealHalo, { top: FLAP_H - 24, borderColor: sealed ? ENVELOPE.pauseSeal : ENVELOPE.seal }, haloStyle]}
        pointerEvents="none"
      />
      <Reanimated.View style={[styles.seal, { top: FLAP_H - 24 }, sealStyle]} pointerEvents="none">
        <Reanimated.View style={[styles.sealHalf, halfLeftStyle]}>
          <View style={[styles.sealDisc, sealed && styles.sealDiscPause]}>
            <SealFace sealed={sealed} />{sealMark}
          </View>
        </Reanimated.View>
        <Reanimated.View style={[styles.sealHalf, halfRightStyle]}>
          <View style={[styles.sealDisc, sealed && styles.sealDiscPause, { left: -24 }]}>
            <SealFace sealed={sealed} />{sealMark}
          </View>
        </Reanimated.View>
      </Reanimated.View>
    </Reanimated.View>
  );
}

/**
 * Sigillets yta, så att det läser som en blank knapp och inte som en platt
 * skiva: en radiell toning från en ljus punkt uppe till vänster till en djup
 * kant, en kant som är ljus upptill och mörk nedtill, en svag fasning innanför
 * den, en glans över övre halvan och en liten skarp reflex — samma recept som
 * nivåmärkena (components/circle-level-badge.tsx). Terrakotta på hjärtat,
 * blått på pausens sigill.
 */
function SealFace({ sealed }: { sealed: boolean }) {
  const light = sealed ? ENVELOPE.pauseSealLight : ENVELOPE.sealLight;
  const base = sealed ? ENVELOPE.pauseSeal : ENVELOPE.seal;
  const deep = sealed ? ENVELOPE.pauseSealDeep : ENVELOPE.sealDeep;
  return (
    <Svg width={48} height={48} style={StyleSheet.absoluteFill}>
      <Defs>
        <RadialGradient id="pauseSealBody" cx="34%" cy="28%" r="78%">
          <Stop offset="0" stopColor={light} />
          <Stop offset="0.42" stopColor={base} />
          <Stop offset="1" stopColor={deep} />
        </RadialGradient>
        <LinearGradient id="pauseSealRim" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#ffffff" stopOpacity={0.75} />
          <Stop offset="1" stopColor={deep} stopOpacity={0.9} />
        </LinearGradient>
        <LinearGradient id="pauseSealGloss" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#ffffff" stopOpacity={0.6} />
          <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Circle cx={24} cy={24} r={24} fill="url(#pauseSealBody)" />
      <Circle cx={24} cy={24} r={23} fill="none" stroke="url(#pauseSealRim)" strokeWidth={2} />
      <Circle cx={24} cy={24} r={19.5} fill="none" stroke="#ffffff" strokeOpacity={0.28} strokeWidth={1} />
      <Ellipse cx={24} cy={14} rx={15} ry={9} fill="url(#pauseSealGloss)" />
      <Circle cx={14.5} cy={12.5} r={2.4} fill="#ffffff" fillOpacity={0.9} />
    </Svg>
  );
}

const makeStyles = (
  Palette: AppPalette, W: number, H: number, FLAP_H: number, inset: number, letterH: number, rise: number,
) => StyleSheet.create({
  // Från brevets högsta läge ner till strax innanför kuvertets nederkant;
  // CLIP_SIDE på var sida, för brevet växer 16 % när det glider fram.
  letterClip: {
    position: 'absolute', overflow: 'hidden',
    left: -CLIP_SIDE, right: -CLIP_SIDE,
    top: -rise - CLIP_TOP, height: rise + CLIP_TOP + H - 2,
  },
  glow: { position: 'absolute' },
  body: {
    flex: 1, backgroundColor: ENVELOPE.body, borderRadius: CORNER_R,
    borderWidth: StyleSheet.hairlineWidth, borderColor: ENVELOPE.hairline,
    ...Palette.cardShadow,
  },
  backFlap: {
    position: 'absolute', left: 0, top: -FLAP_H + 1, width: W, height: FLAP_H,
    transformOrigin: 'bottom',
  },
  frontFlap: {
    position: 'absolute', left: 0, top: 0, width: W, height: FLAP_H + FLAP_SHADOW,
    transformOrigin: 'top',
  },
  letter: {
    position: 'absolute', left: inset + CLIP_SIDE, right: inset + CLIP_SIDE,
    top: rise + CLIP_TOP + 8, height: letterH,
    backgroundColor: LETTER_PAPER.paper, borderRadius: 8,
    paddingHorizontal: 16, paddingTop: 14, gap: 10,
    borderWidth: 1, borderColor: LETTER_PAPER.edge,
  },
  letterHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  letterAvatar: { width: 34, height: 34, borderRadius: 17 },
  letterAvatarFallback: { backgroundColor: alpha(ENVELOPE.seal, 0.16), alignItems: 'center', justifyContent: 'center' },
  letterAvatarLetter: { color: ENVELOPE.seal, fontSize: 15, fontWeight: '700' },
  letterFrom: { flex: 1, color: LETTER_PAPER.ink },
  letterText: { color: LETTER_PAPER.ink, lineHeight: 24 },
  letterPhoto: { width: '100%', height: Math.round(H * 0.62), borderRadius: 6 },
  letterKind: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 4 },
  letterKindText: { color: LETTER_PAPER.inkSoft },
  seal: {
    position: 'absolute',
    left: W / 2 - 24, width: 48, height: 48,
    flexDirection: 'row',
  },
  sealShadow: {
    position: 'absolute', left: W / 2 - SEAL_SHADOW / 2,
    width: SEAL_SHADOW, height: SEAL_SHADOW, marginTop: -(SEAL_SHADOW - 48) / 2,
  },
  sealHalo: {
    position: 'absolute', left: W / 2 - 24, width: 48, height: 48, borderRadius: 24,
    borderWidth: 2,
  },
  sealHalf: { width: 24, height: 48, overflow: 'hidden' },
  // Kanten ritas av SealFace; en ram här hade lagt sig utanför glaset.
  sealDisc: {
    position: 'absolute', top: 0, left: 0,
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: ENVELOPE.seal,
    alignItems: 'center', justifyContent: 'center',
  },
  // Hjärtats tyngd ligger lågt i glyfen; en punkt upp står det mitt i skivan.
  sealHeart: {
    marginTop: 1,
    textShadowColor: alpha(ENVELOPE.sealDeep, 0.7), textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
  sealDiscPause: { backgroundColor: ENVELOPE.pauseSeal },
  pauseMark: { flexDirection: 'row', gap: 5 },
  pauseMarkBar: {
    width: 5, height: 17, borderRadius: 2.5, backgroundColor: ENVELOPE.sealMark,
    shadowColor: ENVELOPE.pauseSealDeep, shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.6, shadowRadius: 1.5,
  },
});
