import * as Haptics from 'expo-haptics';
import { useEffect, useId, useMemo, useRef } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing, useAnimatedProps, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { alpha, AppPalette } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { formatDuration, GOAL_OPTIONS } from '../lib/circles';

/**
 * Dagsmålets ratt på Hem: ringen själv är reglaget. Man drar en knopp runt
 * ringen, bågen är målet — från 10 min (en liten båge) till 12 h (hela
 * varvet) — och talet i mitten följer fingret. Samma form som Hems ring, och
 * samma idé som iOS läggdagsratt.
 *
 * Den ersatte en lista att rulla med en kopia av Hems ring ovanför, som
 * visade dagens tid mot målet. Vid 0 minuter stod den ringen tom och gjorde
 * ingenting — den här ser likadan ut vilken tid på dagen det än är, och visar
 * med flit inte dagens tid.
 *
 * Bågen följer fingret mjukt; när fingret släpper glider den till närmaste
 * steg (`GOAL_OPTIONS`). Haptik per steg, som ratten den ersatte. Bågen kan
 * inte slå runt: drar man förbi tolv står den kvar vid toppen eller botten.
 * Med skärmläsare är den en justerbar kontroll (öka/minska ett steg).
 */

const STEPS = GOAL_OPTIONS.length;
const EASE = Easing.out(Easing.cubic);
const SNAP_MS = 220;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Steg → vinkel i grader från klockan tolv, medurs. Första steget är en liten båge, sista hela varvet. */
const angleOf = (i: number) => ((i + 1) / STEPS) * 360;
const indexOf = (deg: number) => Math.max(0, Math.min(STEPS - 1, Math.round((deg / 360) * STEPS) - 1));

export function GoalDial({
  index, onIndexChange, size = 220, stroke = 16,
}: {
  index: number;
  onIndexChange: (i: number) => void;
  size?: number;
  stroke?: number;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const reduceMotion = useReducedMotion();
  const gradId = useId().replace(/:/g, '');

  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const knob = stroke + 14;
  // Ringen ritas med luft runt om för skenet och knoppen.
  const pad = knob / 2 + 6;
  const box = size + 2 * pad;
  const mid = box / 2;

  const deg = useSharedValue(angleOf(index));
  const degRef = useRef(angleOf(index));
  const indexRef = useRef(index);
  const changeRef = useRef(onIndexChange);
  changeRef.current = onIndexChange;

  // Ett värde utifrån (rutan öppnas på ett annat mål) flyttar bågen.
  useEffect(() => {
    if (index === indexRef.current) return;
    indexRef.current = index;
    degRef.current = angleOf(index);
    deg.value = reduceMotion ? degRef.current : withTiming(degRef.current, { duration: SNAP_MS, easing: EASE });
  }, [index, reduceMotion, deg]);

  const responder = useMemo(() => {
    const track = (x: number, y: number, first: boolean) => {
      // Vinkeln från klockan tolv, medurs, 0–360.
      let a = (Math.atan2(x - mid, -(y - mid)) * 180) / Math.PI;
      if (a < 0) a += 360;
      const prev = degRef.current;
      // Ingen omslagning förbi tolv: från nära toppen till nära noll (eller
      // tvärtom) står bågen kvar i sin ände.
      if (!first) {
        if (prev > 270 && a < 90) a = 360;
        else if (prev < 90 && a > 270) a = 0;
      }
      // Bågen är aldrig kortare än första steget.
      a = Math.max(angleOf(0), a);
      degRef.current = a;
      deg.value = a;
      const i = indexOf(a);
      if (i !== indexRef.current) {
        indexRef.current = i;
        Haptics.selectionAsync();
        changeRef.current(i);
      }
    };
    const settle = () => {
      const target = angleOf(indexRef.current);
      degRef.current = target;
      deg.value = reduceMotion ? target : withTiming(target, { duration: SNAP_MS, easing: EASE });
    };
    // `locationX` är pålitlig vid första beröringen men inte under draget på
    // Android (den kan räknas mot ett annat barn). Förskjutningen mot
    // `pageX` tas därför vid starten och används sedan.
    const origin = { x: 0, y: 0 };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Rutan ligger i en modal; ett drag ska inte lämnas bort mitt i.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: e => {
        const { locationX, locationY, pageX, pageY } = e.nativeEvent;
        origin.x = pageX - locationX;
        origin.y = pageY - locationY;
        track(locationX, locationY, true);
      },
      onPanResponderMove: e => track(e.nativeEvent.pageX - origin.x, e.nativeEvent.pageY - origin.y, false),
      onPanResponderRelease: settle,
      onPanResponderTerminate: settle,
    });
  }, [mid, deg, reduceMotion]);

  const arcProps = useAnimatedProps(() => ({ strokeDashoffset: c * (1 - deg.value / 360) }));
  const knobStyle = useAnimatedStyle(() => {
    const a = (deg.value * Math.PI) / 180;
    return {
      transform: [
        { translateX: mid + r * Math.sin(a) - knob / 2 },
        { translateY: mid - r * Math.cos(a) - knob / 2 },
      ],
    };
  });

  const step = (dir: 1 | -1) => {
    const i = Math.max(0, Math.min(STEPS - 1, indexRef.current + dir));
    if (i === indexRef.current) return;
    Haptics.selectionAsync();
    onIndexChange(i);
  };

  const goal = GOAL_OPTIONS[index];

  return (
    <View
      style={{ width: box, height: box, alignSelf: 'center' }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Daily goal"
      accessibilityValue={{ text: formatDuration(goal) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={e => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
      {...responder.panHandlers}
    >
      <Svg width={box} height={box} style={styles.rotated} pointerEvents="none">
        <Defs>
          <RadialGradient id={gradId} cx={mid} cy={mid} r={mid} gradientUnits="userSpaceOnUse">
            <Stop offset="0.55" stopColor={Palette.hue} stopOpacity={0} />
            <Stop offset="0.8" stopColor={Palette.hue} stopOpacity={Palette.mode === 'dark' ? 0.22 : 0.14} />
            <Stop offset="1" stopColor={Palette.hue} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        {/* Skenet längs ringen. */}
        <Circle cx={mid} cy={mid} r={mid} fill={`url(#${gradId})`} />
        <Circle cx={mid} cy={mid} r={r} stroke={Palette.hueTrack} strokeWidth={stroke} fill="none" />
        {/* En bredare, svag båge under den skarpa — glöden. */}
        <AnimatedCircle
          cx={mid} cy={mid} r={r}
          stroke={alpha(Palette.hue, 0.22)} strokeWidth={stroke * 2} fill="none"
          strokeLinecap="round" strokeDasharray={`${c} ${c}`}
          animatedProps={arcProps}
        />
        <AnimatedCircle
          cx={mid} cy={mid} r={r}
          stroke={Palette.hue} strokeWidth={stroke} fill="none"
          strokeLinecap="round" strokeDasharray={`${c} ${c}`}
          animatedProps={arcProps}
        />
      </Svg>

      <View pointerEvents="none" style={styles.center}>
        <Text style={styles.big} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {formatDuration(goal)}
        </Text>
        <Text style={styles.sub}>a day</Text>
      </View>

      <Animated.View
        pointerEvents="none"
        style={[
          styles.knob,
          { width: knob, height: knob, borderRadius: knob / 2, borderColor: Palette.hue },
          knobStyle,
        ]}
      />
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  rotated: { position: 'absolute', transform: [{ rotate: '-90deg' }] },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  big: { fontSize: 38, fontWeight: '900', color: Palette.textPrimary, letterSpacing: -1, maxWidth: '60%' },
  sub: { fontSize: 14, lineHeight: 18, color: Palette.textSecondary, marginTop: 2 },
  // Knoppen: ljus med en kant i rummets kulör och en skugga, så att den ser
  // ut att ligga ovanpå ringen och gå att ta i.
  knob: {
    position: 'absolute', left: 0, top: 0,
    backgroundColor: Palette.mode === 'dark' ? '#f4f7ff' : '#ffffff',
    borderWidth: 3,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6,
    elevation: 5,
  },
});
