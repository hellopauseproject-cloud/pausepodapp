import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation, Easing, SharedValue, useAnimatedProps, useReducedMotion, useSharedValue,
  withRepeat, withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

/**
 * Ett jordklot av linjer bakom glorian i Global Pause-rummet: hela världen,
 * pausande samtidigt.
 *
 * - **Gradnätet** är meridianer och breddgrader, ritat som ellipser i en svag
 *   lutning så att klotet läses i tre dimensioner och inte som en tavla.
 * - **Linjerna är designsystemets ribbon** (blått → grönt → orange) och svaga:
 *   nätet är en bakgrund, och glorian och siffran ska stå framför det.
 * - **Klotet tonar bort mot kanten** genom en radiell toning ovanpå, så att
 *   det inte slutar i en hård cirkel.
 * - **Det roterar, långsamt**: ett varv på `TURN_MS` (90 s), bara meridianerna
 *   rör sig, på UI-tråden. Designsystemets rörelse är lugn och aldrig hastig.
 *   Med reducerad rörelse står det still, och det stannar när skärmen tappar
 *   fokus (`active`).
 * - **Pausens märke kan stå i mitten** (`mark`), samma två streck som
 *   logotypen, i mörkblått med en ljus glöd bakom — glöden är det som bär
 *   strecken mot ett mörkt kort. Bara de små märkena har det (statistiken,
 *   veckans kort); i rummet stod det en kort tid och togs bort på begäran.
 *   Pulsen går bara med `pulse`, på `PULSE_MS`, och aldrig med reducerad
 *   rörelse.
 */

const TURN_MS = 90_000;
const MERIDIANS = 9;            // var 20:e grad; en ellips är två meridianer
const PARALLELS = [-60, -40, -20, 0, 20, 40, 60];
const TILT = 0.2;               // hur mycket breddgraderna lutar mot betraktaren
// Ribbon, mättare än flikarnas ljusa toner så att nätet bär färg.
const RIBBON = ['#5aa9f5', '#4fd193', '#f9a25e'] as const;

// Märket: logotypens proportioner (streck 0.4 × 1.15, glapp 0.22). Höjden är
// en andel av klotet (`markSize`).
const MARK_W_PER_H = 0.4 / 1.15;
const MARK_GAP_PER_H = 0.22 / 1.15;
const MARK_TOP = '#173f8a';     // samma mörkblå som veckans korts klot
const MARK_BOTTOM = '#0f2a63';
const MARK_GLOW = '#BFDDFF';    // designsystemets Sky 200
const PULSE_MS = 6000;
// [botten, topp] i andningen.
const MARK_BARS = [0.85, 1] as const;
const MARK_GLOW_LEVELS = [0.4, 0.65] as const;

const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);
const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * `fade` är bottnens färg, som klotet tonar bort mot. Utan den tonar det inte,
 * som i statistikens lilla märke, där kortet har sin egen ton.
 */
export function GlobeGrid({ size, active, fade, tint, mark = false, markSize = 0.24, pulse = false }: {
  size: number; active: boolean; fade?: string;
  /** En enda linjefärg i stället för ribbon, för ett klot på en ribbonyta. */
  tint?: string;
  /** Pausens märke i mitten; se filens kommentar. */
  mark?: boolean;
  /** Strecken höjd som andel av klotet. */
  markSize?: number;
  /** Låter märket andas. */
  pulse?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const turn = useSharedValue(0);
  const breath = useSharedValue(0);

  useEffect(() => {
    if (!mark || !pulse || reduceMotion) { cancelAnimation(breath); breath.value = 0.5; return; }
    breath.value = 0;
    breath.value = withRepeat(
      withTiming(1, { duration: PULSE_MS / 2, easing: Easing.inOut(Easing.sin) }), -1, true,
    );
    return () => cancelAnimation(breath);
  }, [mark, pulse, reduceMotion, breath]);

  const markH = markSize * size;
  const markW = markH * MARK_W_PER_H;
  const markGap = markH * MARK_GAP_PER_H;
  const glowR = Math.min(size / 2, markH * 1.25);
  const barsProps = useAnimatedProps(() => ({
    opacity: MARK_BARS[0] + (MARK_BARS[1] - MARK_BARS[0]) * breath.value,
  }));
  const glowProps = useAnimatedProps(() => ({
    opacity: MARK_GLOW_LEVELS[0] + (MARK_GLOW_LEVELS[1] - MARK_GLOW_LEVELS[0]) * breath.value,
    r: glowR * (0.86 + 0.14 * breath.value),
  }));

  useEffect(() => {
    if (!active || reduceMotion) { cancelAnimation(turn); return; }
    // Från noll varje gång: ett varv flyttar varje meridian exakt ett halvt
    // klot (π), och då är bilden densamma, så omstarten syns inte.
    turn.value = 0;
    turn.value = withRepeat(withTiming(1, { duration: TURN_MS, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(turn);
  }, [active, reduceMotion, turn]);

  const c = size / 2;
  const r = size / 2 - 1;

  return (
    <View style={[styles.wrap, { width: size, height: size }]} pointerEvents="none">
      <Svg width={size} height={size}>
        <Defs>
          <LinearGradient id="globeRibbon" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={RIBBON[0]} />
            <Stop offset="0.55" stopColor={RIBBON[1]} />
            <Stop offset="1" stopColor={RIBBON[2]} />
          </LinearGradient>
          {/* Mitten öppen, kanten i rummets botten: klotet tonar bort. */}
          {fade && (
            <RadialGradient id="globeFade" cx="50%" cy="50%" r="50%">
              <Stop offset="0.55" stopColor={fade} stopOpacity={0} />
              <Stop offset="1" stopColor={fade} stopOpacity={0.85} />
            </RadialGradient>
          )}
          {mark && (
            <>
              {/* Med `tint` ligger klotet på en ljus ribbonyta, och där är
                  glöden vit i stället för himmelsblå. */}
              <RadialGradient id="globeMarkGlow" cx="50%" cy="50%" r="50%">
                <Stop offset="0" stopColor={tint ? '#ffffff' : MARK_GLOW} stopOpacity={0.95} />
                <Stop offset="0.5" stopColor={tint ? '#ffffff' : MARK_GLOW} stopOpacity={0.4} />
                <Stop offset="1" stopColor={tint ? '#ffffff' : MARK_GLOW} stopOpacity={0} />
              </RadialGradient>
              <LinearGradient id="globeMarkBar" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={tint ?? MARK_TOP} />
                <Stop offset="1" stopColor={tint ?? MARK_BOTTOM} />
              </LinearGradient>
            </>
          )}
        </Defs>

        <G stroke={tint ?? 'url(#globeRibbon)'} fill="none">
          <Circle cx={c} cy={c} r={r} strokeWidth={1.3} strokeOpacity={0.7} />
          {PARALLELS.map(lat => {
            const rad = (lat * Math.PI) / 180;
            const rx = r * Math.cos(rad);
            return (
              <Ellipse
                key={lat}
                cx={c}
                cy={c - r * Math.sin(rad)}
                rx={rx}
                ry={rx * TILT}
                strokeWidth={lat === 0 ? 1.1 : 0.8}
                strokeOpacity={lat === 0 ? 0.6 : 0.38}
              />
            );
          })}
          {Array.from({ length: MERIDIANS }, (_, i) => (
            <Meridian key={i} index={i} c={c} r={r} turn={turn} />
          ))}
        </G>

        {fade && <Circle cx={c} cy={c} r={r + 1} fill="url(#globeFade)" />}

        {mark && (
          <>
            <AnimatedCircle cx={c} cy={c} r={glowR} fill="url(#globeMarkGlow)" animatedProps={glowProps} />
            <AnimatedG animatedProps={barsProps}>
              {[-1, 1].map(side => (
                <Rect
                  key={side}
                  x={c + (side * markGap) / 2 - (side < 0 ? markW : 0)}
                  y={c - markH / 2}
                  width={markW}
                  height={markH}
                  rx={markW / 2}
                  fill="url(#globeMarkBar)"
                />
              ))}
            </AnimatedG>
          </>
        )}
      </Svg>
    </View>
  );
}

function Meridian({ index, c, r, turn }: { index: number; c: number; r: number; turn: SharedValue<number> }) {
  const props = useAnimatedProps(() => {
    const angle = (index / MERIDIANS + turn.value) * Math.PI;
    const rx = r * Math.abs(Math.sin(angle));
    // Meridianen som vetter mot betraktaren är starkast, de vid kanten svagast.
    return { rx, strokeOpacity: 0.16 + 0.32 * Math.abs(Math.sin(angle)) };
  });
  return <AnimatedEllipse cx={c} cy={c} ry={r} strokeWidth={0.8} animatedProps={props} />;
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', alignSelf: 'center' },
});
