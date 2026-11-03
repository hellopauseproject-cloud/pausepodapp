import * as Haptics from 'expo-haptics';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { usePalette } from '../contexts/ThemeContext';

/**
 * En knapp som måste hållas in för att utlösa — för det enda trycket i
 * appen som startar något man inte ångrar med ett tryck till: en paus.
 *
 * - **Fyllningen** växer från vänster under `holdMs`, på UI-tråden.
 * - **Utlösningen** är en JS-timer och inte en animationscallback, så att
 *   `onComplete` körs exakt en gång och på JS-tråden. Släpps knappen innan
 *   timern gått rensas den, fyllningen går tillbaka, och raden under säger
 *   *Keep holding*.
 * - **Haptik:** en lätt knack när trycket börjar, en fast när det gått igenom.
 * - **Skärmläsare och brytarstyrning** kan inte hålla in. För dem är knappens
 *   standardåtgärd (`activate` — dubbeltryck i TalkBack/VoiceOver, välj i
 *   brytarstyrning) en direkt utlösning, och `accessibilityHint` säger det.
 *
 * Fyllningen följer INTE inställningen för reducerad rörelse
 * (`ReduceMotion.Never`). Den är inte dekoration utan återkopplingen för
 * hållningen; med rörelsen avstängd hade den hoppat till full direkt och sett
 * ut som att pausen redan startat.
 */

// Hur länge raden under säger *Keep holding* efter ett för kort tryck.
const KEEP_HOLDING_MS = 2200;

type Props = {
  onComplete: () => void;
  holdMs: number;
  disabled?: boolean;
  style: StyleProp<ViewStyle>;
  /** Fyllningens kulör. Förval: halvgenomskinligt vitt ovanpå knappen. */
  fillColor?: string;
  /** Radien som fyllningen klipps mot — samma som knappens. */
  borderRadius: number;
  accessibilityLabel: string;
  /** Ritas under hållfyllningen, t.ex. PAUSE-knappens yta. */
  background?: ReactNode;
  /** Typografin för *Keep holding* (placeringen sätter komponenten själv). */
  hintStyle: StyleProp<any>;
  children: ReactNode;
};

export function HoldToStartButton({
  onComplete, holdMs, disabled, style, fillColor, borderRadius,
  accessibilityLabel, hintStyle, children, background,
}: Props) {
  const Palette = usePalette();
  const progress = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);
  const [keepHolding, setKeepHolding] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  const fire = () => {
    if (firedRef.current) return;
    firedRef.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    onComplete();
    // Står skärmen kvar (t.ex. en Alert om att lådan inte är ansluten) ska
    // knappen gå att hålla igen.
    setTimeout(() => {
      firedRef.current = false;
      progress.value = 0;
    }, 400);
  };

  const onPressIn = () => {
    if (disabled) return;
    if (hintTimer.current) clearTimeout(hintTimer.current);
    setKeepHolding(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    progress.value = withTiming(1, {
      duration: holdMs,
      easing: Easing.linear,
      reduceMotion: ReduceMotion.Never,
    });
    timer.current = setTimeout(() => {
      timer.current = null;
      fire();
    }, holdMs);
  };

  const onPressOut = () => {
    if (!timer.current) return; // redan utlöst, eller aldrig startad
    clearTimeout(timer.current);
    timer.current = null;
    cancelAnimation(progress);
    progress.value = withTiming(0, { duration: 180, reduceMotion: ReduceMotion.Never });
    setKeepHolding(true);
    hintTimer.current = setTimeout(() => setKeepHolding(false), KEEP_HOLDING_MS);
  };

  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: progress.value }] }));

  return (
    // Skalet sträcker sig över förälderns bredd och centrerar knappen, så att
    // både en fullbreddsknapp (CHECK IN) och en som tar sin bredd ur innehållet
    // (PAUSE på Hem) står som förut.
    <View style={styles.wrap}>
      <Pressable
        style={style}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled: !!disabled }}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint="Double tap to start."
        accessibilityActions={[{ name: 'activate' }]}
        onAccessibilityAction={e => {
          if (e.nativeEvent.actionName === 'activate' && !disabled) fire();
        }}
      >
        {background}
        {/* Klippningen ligger på ett eget lager, så att knappens skugga inte
            klipps bort på iOS av `overflow: hidden`. */}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius, overflow: 'hidden' }]}>
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: fillColor ?? 'rgba(255,255,255,0.3)', transformOrigin: 'left' },
              fillStyle,
            ]}
          />
        </View>
        {children}
      </Pressable>
      {/* Tyst tills något gått fel: ingen instruktion står under knappen
          hela tiden — fyllningen säger själv att det är ett håll. Först efter
          ett för kort tryck syns *Keep holding*, en stund. Raden ligger
          absolut under knappen och tar ingen plats i layouten, så ingenting
          flyttar sig när den dyker upp. */}
      {keepHolding && (
        <Text
          style={[hintStyle, styles.hint, { color: Palette.textPrimary }]}
          accessibilityLiveRegion="polite"
          pointerEvents="none"
        >
          Keep holding
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', alignItems: 'center' },
  hint: { position: 'absolute', top: '100%', left: 0, right: 0, textAlign: 'center' },
});
