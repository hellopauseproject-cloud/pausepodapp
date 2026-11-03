import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';

/**
 * Ljuset bakom PAUSE (Hem och Global Pause-rummet): knappen står i ett eget
 * sken och inte på en tom botten.
 *
 * Två mjuka ellipser: en bred och svag i pausens ljusa blå som ger rymd, och
 * en tätare i accenten precis bakom knappen som ger lyster. De andas, 6 s, som
 * designsystemets andning, och står still med reducerad rörelse.
 *
 * Läggs som första barn i knappens rad, centrerad bakom knappen; `width` och
 * `height` är skenets mått, inte knappens.
 */

const BREATH_MS = 6000;

export function PauseAmbience({ width = 360, height = 170, color = '#2F88E0', light = '#8CC4FF' }: {
  width?: number; height?: number; color?: string; light?: string;
}) {
  const reduceMotion = useReducedMotion();
  const breath = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) { cancelAnimation(breath); breath.value = 1; return; }
    breath.value = 0.72;
    breath.value = withRepeat(withTiming(1, { duration: BREATH_MS / 2, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(breath);
  }, [reduceMotion, breath]);

  const style = useAnimatedStyle(() => ({
    opacity: breath.value,
    transform: [{ scale: 0.94 + 0.08 * breath.value }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, { width, height, marginLeft: -width / 2, marginTop: -height / 2 }, style]}
    >
      <Svg width={width} height={height}>
        <Defs>
          <RadialGradient id="ambienceWide" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={light} stopOpacity={0.32} />
            <Stop offset="1" stopColor={light} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="ambienceCore" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color} stopOpacity={0.7} />
            <Stop offset="0.6" stopColor={color} stopOpacity={0.18} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx={width / 2} cy={height / 2} rx={width / 2} ry={height / 2} fill="url(#ambienceWide)" />
        <Ellipse cx={width / 2} cy={height / 2} rx={width * 0.33} ry={height * 0.3} fill="url(#ambienceCore)" />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: '50%', top: '50%' },
});
