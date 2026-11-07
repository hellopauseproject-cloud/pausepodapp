import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Reanimated, {
  Easing, interpolate, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue,
  withDelay, withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, Line, Path, RadialGradient, Stop } from 'react-native-svg';
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
 * persikofärgad glöd bakom. Sigillet är pausens två streck i ljust på
 * terrakotta, inte ett hjärta: det är en paus någon skickat.
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
  glow: '#f0a882',
  seal: '#c9714b',
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

const KIND_LABEL: Record<SupportKind, string> = {
  text: 'A few words',
  voice: 'A voice message',
  video: 'A video',
  photo: 'A photo',
};
const KIND_ICON: Record<SupportKind, string> = {
  text: 'feather-alt',
  voice: 'microphone',
  video: 'video',
  photo: 'camera',
};

const FLAP_MS = 420;
const LETTER_MS = 620;
const SINK_MS = 420;

export function SupportEnvelope({
  width, senderName, senderAvatarUrl, kind, previewText, photoUrl, open, onOpened,
}: {
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
  const H = Math.round(width * 0.64);
  const FLAP_H = Math.round(H * 0.56);
  const LETTER_INSET = Math.round(W * 0.06);
  const LETTER_H = Math.round(H * 1.15);
  // Hur högt brevet glider: tillräckligt för att det mesta av det står fritt
  // ovanför kuvertet, och resten fortfarande ser instoppat ut.
  const LETTER_RISE = Math.round(H * 0.95);

  const styles = useMemo(() => makeStyles(Palette, W, H, FLAP_H, LETTER_INSET, LETTER_H), [Palette, W, H, FLAP_H, LETTER_INSET, LETTER_H]);

  const flap = useSharedValue(0);
  const letter = useSharedValue(0);
  const sink = useSharedValue(0);
  const bob = useSharedValue(0);

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
      flap.value = 1; letter.value = 1; sink.value = 1;
      onOpened();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    flap.value = withTiming(1, { duration: FLAP_MS, easing: Easing.inOut(Easing.cubic) });
    letter.value = withDelay(FLAP_MS - 60, withTiming(1, { duration: LETTER_MS, easing: Easing.out(Easing.cubic) }, done => {
      if (done) runOnJS(lettered)();
    }));
    sink.value = withDelay(FLAP_MS + LETTER_MS - 120, withTiming(1, { duration: SINK_MS, easing: Easing.in(Easing.cubic) }, done => {
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
  const sealStyle = useAnimatedStyle(() => ({
    opacity: interpolate(flap.value, [0, 0.25], [1, 0], 'clamp'),
    transform: [{ scale: interpolate(flap.value, [0, 0.25], [1, 0.6], 'clamp') }],
  }));
  const letterStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(letter.value, [0, 1], [0, -LETTER_RISE]) + interpolate(sink.value, [0, 1], [0, H * 0.35]) },
      { scale: interpolate(sink.value, [0, 1], [1, 1.08]) },
    ],
  }));
  const envelopeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(sink.value, [0, 1], [1, 0]),
    transform: [{ translateY: interpolate(sink.value, [0, 1], [0, H * 0.9]) }],
  }));

  const firstName = senderName.split(' ')[0];

  const GLOW = Math.round(W * 1.7);

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
          <Path d={`M0.5 ${FLAP_H} L${W / 2} 0.5 L${W - 0.5} ${FLAP_H}`} fill={ENVELOPE.flap} stroke={ENVELOPE.edge} strokeWidth={1} />
        </Svg>
      </Reanimated.View>

      {/* Brevet. */}
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

      {/* Fickan framför brevet och fliken som är stängd. */}
      <Reanimated.View style={[StyleSheet.absoluteFill, envelopeStyle]} pointerEvents="none">
        <Svg width={W} height={H}>
          <Path d={`M0 0 L${W / 2} ${FLAP_H} L${W} 0 L${W} ${H - 10} Q${W} ${H} ${W - 10} ${H} L10 ${H} Q0 ${H} 0 ${H - 10} Z`} fill={ENVELOPE.pocket} stroke={ENVELOPE.edge} strokeWidth={1} />
          <Line x1={0} y1={H} x2={W / 2} y2={H * 0.5} stroke={ENVELOPE.fold} strokeWidth={1.2} />
          <Line x1={W} y1={H} x2={W / 2} y2={H * 0.5} stroke={ENVELOPE.fold} strokeWidth={1.2} />
        </Svg>
      </Reanimated.View>
      <Reanimated.View style={[styles.frontFlap, frontFlapStyle]} pointerEvents="none">
        <Svg width={W} height={FLAP_H + 2}>
          <Path d={`M0.5 0.5 L${W - 0.5} 0.5 L${W / 2} ${FLAP_H} Z`} fill={ENVELOPE.flap} stroke={ENVELOPE.edge} strokeWidth={1} />
        </Svg>
      </Reanimated.View>

      {/* Sigillet: pausens två streck där flikens spets möter fickan. */}
      <Reanimated.View style={[styles.seal, { top: FLAP_H - 24 }, sealStyle]} pointerEvents="none">
        <View style={styles.sealBar} />
        <View style={styles.sealBar} />
      </Reanimated.View>
    </Reanimated.View>
  );
}

const makeStyles = (
  Palette: AppPalette, W: number, H: number, FLAP_H: number, inset: number, letterH: number,
) => StyleSheet.create({
  glow: { position: 'absolute' },
  body: {
    flex: 1, backgroundColor: ENVELOPE.body, borderRadius: 10,
    borderWidth: 1, borderColor: ENVELOPE.edge,
    ...Palette.cardShadow,
  },
  backFlap: {
    position: 'absolute', left: 0, top: -FLAP_H + 1, width: W, height: FLAP_H,
    transformOrigin: 'bottom',
  },
  frontFlap: {
    position: 'absolute', left: 0, top: 0, width: W, height: FLAP_H + 2,
    transformOrigin: 'top',
  },
  letter: {
    position: 'absolute', left: inset, right: inset, top: 8, height: letterH,
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
    left: W / 2 - 24, width: 48, height: 48, borderRadius: 24,
    backgroundColor: ENVELOPE.seal,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    borderWidth: 2, borderColor: alpha('#ffffff', 0.7),
  },
  sealBar: { width: 5, height: 18, borderRadius: 2.5, backgroundColor: ENVELOPE.sealMark },
});
