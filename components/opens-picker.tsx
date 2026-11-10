import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Reanimated, {
  Easing, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue,
  withDelay, withSequence, withSpring, withTiming,
} from 'react-native-reanimated';
import Svg, { Line, Path } from 'react-native-svg';
import { AppPalette, Radius, alpha } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { ENVELOPE } from './support-envelope';

/**
 * *Opens: Now / After a pause* på de fyra svarsskärmarna. Den som skickar
 * väljer — stödet är en gåva, och när den öppnas är en del av den. *After a
 * pause* försluter svaret (`support_responses.opens_after_pause`,
 * supabase/support_sealed.sql) tills mottagaren gjort en paus: belöningen kommer
 * efter pausen, och stödet blir ett skäl att ta den.
 *
 * Bara två lägen med flit. Tider (*Tonight*) vore ett beslut till för den som
 * skickar, och de är inte belöningen. Raden under valet saknar pronomen (se
 * CLAUDE.md): *Opens when Dag finishes a pause.*
 *
 * `onDark` är för kameraskärmarna, där botten är bilden och inte paletten.
 */
export function OpensPicker({ sealed, onChange, ownerName, onDark = false, centered = false }: {
  sealed: boolean;
  onChange: (sealed: boolean) => void;
  ownerName: string;
  onDark?: boolean;
  /** Mitt över knapparna under (fotoskärmens *Retake* / *Send*). */
  centered?: boolean;
}) {
  const Palette = usePalette();
  const s = useMemo(() => makeStyles(Palette, onDark, centered), [Palette, onDark, centered]);
  const firstName = (ownerName || 'they').split(' ')[0];
  const pick = (next: boolean) => {
    if (next === sealed) return;
    Haptics.selectionAsync().catch(() => {});
    onChange(next);
  };
  // Diskret med flit: en liten rubrik som är själva frågan, och ett smalt
  // tvåläges-reglage under. Det var två stora piller under *OPENS* och en rad
  // till, och det tog mer plats än svaret man skickar.
  const muted = onDark ? 'rgba(255,255,255,0.8)' : Palette.textSecondary;
  return (
    <View style={s.wrap}>
      <Text style={s.label} numberOfLines={1}>CHOOSE WHEN {firstName.toUpperCase()} CAN OPEN IT</Text>
      <View style={s.track} accessibilityRole="radiogroup">
        <TouchableOpacity
          style={[s.opt, !sealed && s.optOn]}
          onPress={() => pick(false)}
          activeOpacity={0.8}
          accessibilityRole="radio"
          accessibilityState={{ selected: !sealed }}
        >
          <Text style={[s.optText, !sealed && s.optTextOn]}>Now</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.opt, sealed && s.optOn]}
          onPress={() => pick(true)}
          activeOpacity={0.8}
          accessibilityRole="radio"
          accessibilityState={{ selected: sealed }}
          accessibilityLabel={`After ${firstName}'s next pause`}
        >
          <FontAwesome5 name="pause" size={9} color={sealed ? Palette.communitySoft : muted} />
          <Text style={[s.optText, sealed && s.optTextOn]}>After a pause</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * Det förseglade kuvertet som glider iväg när ett *After a pause*-svar
 * skickats: kuvertet kommer upp, sigillet trycks på med en studs, och det
 * flyger uppåt. Ca 1,5 s, och skärmen stänger sig efteråt (`SEALED_SEND_MS`).
 * Samma papper och sigill som kuvertet mottagaren sedan öppnar.
 */
export const SEALED_SEND_MS = 1600;

export function SealedSendOverlay() {
  const reduceMotion = useReducedMotion();
  const W = 168;
  const H = Math.round(W * 0.64);
  const FLAP_H = Math.round(H * 0.56);
  const enter = useSharedValue(reduceMotion ? 1 : 0);
  const seal = useSharedValue(reduceMotion ? 1 : 0);
  const fly = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    enter.value = withTiming(1, { duration: 320, easing: Easing.out(Easing.cubic) });
    seal.value = withDelay(380, withSequence(
      withTiming(1.25, { duration: 140 }),
      withSpring(1, { damping: 8, stiffness: 180 }),
    ));
    const t = setTimeout(() => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }, 400);
    fly.value = withDelay(1000, withTiming(1, { duration: 520, easing: Easing.in(Easing.cubic) }));
    return () => clearTimeout(t);
  }, [reduceMotion, enter, seal, fly]);

  const envStyle = useAnimatedStyle(() => ({
    opacity: interpolate(enter.value, [0, 1], [0, 1]) * interpolate(fly.value, [0, 0.8, 1], [1, 1, 0]),
    transform: [
      { translateY: interpolate(enter.value, [0, 1], [40, 0]) + interpolate(fly.value, [0, 1], [0, -260]) },
      { scale: interpolate(fly.value, [0, 1], [1, 0.6]) },
      { rotate: `${interpolate(fly.value, [0, 1], [0, -8])}deg` },
    ],
  }));
  const sealStyle = useAnimatedStyle(() => ({
    opacity: seal.value > 0 ? 1 : 0,
    transform: [{ scale: seal.value }],
  }));

  return (
    <View style={[StyleSheet.absoluteFill, overlay.root]} pointerEvents="none">
      <Reanimated.View style={[{ width: W, height: H }, envStyle]}>
        <View style={[StyleSheet.absoluteFill, overlay.body]} />
        <Svg width={W} height={H} style={StyleSheet.absoluteFill}>
          <Path d={`M0 0 L${W / 2} ${FLAP_H} L${W} 0 L${W} ${H} L0 ${H} Z`} fill={ENVELOPE.pocket} stroke={ENVELOPE.edge} strokeWidth={1} />
          <Line x1={0} y1={H} x2={W / 2} y2={H * 0.5} stroke={ENVELOPE.fold} strokeWidth={1} />
          <Line x1={W} y1={H} x2={W / 2} y2={H * 0.5} stroke={ENVELOPE.fold} strokeWidth={1} />
          <Path d={`M0.5 0.5 L${W - 0.5} 0.5 L${W / 2} ${FLAP_H} Z`} fill={ENVELOPE.flap} stroke={ENVELOPE.edge} strokeWidth={1} />
        </Svg>
        <Reanimated.View style={[overlay.seal, { left: W / 2 - 18, top: FLAP_H - 18 }, sealStyle]}>
          <View style={overlay.sealBar} />
          <View style={overlay.sealBar} />
        </Reanimated.View>
      </Reanimated.View>
    </View>
  );
}

const overlay = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  body: { backgroundColor: ENVELOPE.body, borderRadius: 8, borderWidth: 1, borderColor: ENVELOPE.edge },
  seal: {
    position: 'absolute', width: 36, height: 36, borderRadius: 18,
    backgroundColor: ENVELOPE.seal,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.7)',
  },
  sealBar: { width: 4, height: 13, borderRadius: 2, backgroundColor: ENVELOPE.sealMark },
});

const makeStyles = (Palette: AppPalette, onDark: boolean, centered: boolean) => StyleSheet.create({
  wrap: { gap: 8, alignSelf: 'stretch', alignItems: centered ? 'center' : 'stretch' },
  label: {
    fontSize: 11, fontWeight: '700', letterSpacing: 1.4,
    textAlign: centered ? 'center' : 'left',
    color: onDark ? 'rgba(255,255,255,0.7)' : Palette.textTertiary,
  },
  // Ett smalt spår med två lägen, inte två knappar: valet ska inte se ut som
  // något man måste göra.
  track: {
    flexDirection: 'row', alignSelf: centered ? 'center' : 'flex-start',
    padding: 3, borderRadius: Radius.pill,
    backgroundColor: onDark ? 'rgba(0,0,0,0.4)' : Palette.ink07,
  },
  opt: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 7, paddingHorizontal: 14, borderRadius: Radius.pill,
  },
  optOn: {
    backgroundColor: onDark ? 'rgba(255,255,255,0.18)' : alpha(Palette.community, 0.18),
  },
  optText: { fontSize: 13, fontWeight: '600', color: onDark ? 'rgba(255,255,255,0.8)' : Palette.textSecondary },
  optTextOn: { color: onDark ? '#fff' : Palette.communitySoft, fontWeight: '700' },
});
