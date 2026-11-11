import { FontAwesome5 } from '@expo/vector-icons';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

/**
 * Pause-taggen sedd rakt framifrån: samma dekal som lådsidan ritar
 * ([lib/podBoxArt.ts](../lib/podBoxArt.ts), `tag`) — ljus kant, marinblå
 * skiva, pausens två streck. Ändras dekalen där ska den ändras här.
 *
 * Används av [app/pair.tsx](../app/pair.tsx) som kvittot på skanningen:
 * taggen poppar fram och en bock landar i hörnet, så att man ser *vad* man
 * just hittade innan man tar ställning till det.
 */
export function PauseTagBadge({ size = 120, checked }: { size?: number; checked: boolean }) {
  const reduceMotion = useReducedMotion();
  const pop = useSharedValue(reduceMotion ? 1 : 0);
  const check = useSharedValue(reduceMotion && checked ? 1 : 0);
  const glow = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    pop.value = withSpring(1, { damping: 11, stiffness: 160 });
    glow.value = withRepeat(withSequence(withTiming(1, { duration: 1400 }), withTiming(0, { duration: 1400 })), -1);
  }, [reduceMotion, pop, glow]);

  useEffect(() => {
    if (!checked) {
      check.value = 0;
      return;
    }
    check.value = reduceMotion ? 1 : withDelay(260, withSpring(1, { damping: 9, stiffness: 220 }));
  }, [checked, reduceMotion, check]);

  const tagStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, pop.value * 1.5),
    transform: [{ scale: 0.6 + 0.4 * pop.value }],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.35 + 0.35 * glow.value,
    transform: [{ scale: 1 + 0.06 * glow.value }],
  }));
  const checkStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, check.value * 2),
    transform: [{ scale: check.value }],
  }));

  const halo = size * 1.5;
  const badge = Math.round(size * 0.34);
  const bar = { w: size * 0.12, h: size * 0.36, r: size * 0.04 };

  return (
    <View style={{ width: halo, height: halo, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[StyleSheet.absoluteFill, glowStyle]} pointerEvents="none">
        <Svg width={halo} height={halo}>
          <Defs>
            <RadialGradient id="ptbHalo" cx="50%" cy="50%" r="50%">
              <Stop offset="0.45" stopColor="#4f86c6" stopOpacity={0.55} />
              <Stop offset="1" stopColor="#4f86c6" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={halo / 2} cy={halo / 2} r={halo / 2} fill="url(#ptbHalo)" />
        </Svg>
      </Animated.View>

      <Animated.View style={[{ width: size, height: size }, tagStyle]}>
        <Svg width={size} height={size}>
          <Defs>
            <LinearGradient id="ptbRim" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#f4f8ff" />
              <Stop offset="1" stopColor="#9fb3cf" />
            </LinearGradient>
            <LinearGradient id="ptbDisc" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#2b4b98" />
              <Stop offset="0.55" stopColor="#1a3172" />
              <Stop offset="1" stopColor="#0b1636" />
            </LinearGradient>
            <RadialGradient id="ptbInner" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#4f86c6" stopOpacity={0.75} />
              <Stop offset="1" stopColor="#4f86c6" stopOpacity={0} />
            </RadialGradient>
            <LinearGradient id="ptbBar" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#e6f2ff" />
              <Stop offset="0.45" stopColor="#a6d0ff" />
              <Stop offset="1" stopColor="#5e9de6" />
            </LinearGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#ptbRim)" />
          <Circle cx={size / 2} cy={size / 2} r={size * 0.46} fill="url(#ptbDisc)" />
          <Circle cx={size / 2} cy={size / 2} r={size * 0.34} fill="url(#ptbInner)" />
          <Rect x={size / 2 - bar.w * 1.6} y={size / 2 - bar.h / 2} width={bar.w} height={bar.h} rx={bar.r} fill="url(#ptbBar)" />
          <Rect x={size / 2 + bar.w * 0.6} y={size / 2 - bar.h / 2} width={bar.w} height={bar.h} rx={bar.r} fill="url(#ptbBar)" />
          <Circle cx={size / 2} cy={size / 2} r={size * 0.46} fill="none" stroke="#8cbcff" strokeWidth={1} strokeOpacity={0.45} />
        </Svg>
      </Animated.View>

      <Animated.View
        style={[
          styles.check,
          {
            width: badge,
            height: badge,
            borderRadius: badge / 2,
            right: (halo - size) / 2 - badge * 0.1,
            bottom: (halo - size) / 2 - badge * 0.1,
          },
          checkStyle,
        ]}
      >
        <FontAwesome5 name="check" size={badge * 0.45} color="#ffffff" />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  check: {
    position: 'absolute',
    // Appens accent och inte grönt: bekräftelsegrönt hör till lådan.
    backgroundColor: '#2e86de',
    borderWidth: 3,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
