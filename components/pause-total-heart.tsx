import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PixelRatio, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { AppPalette } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';

/**
 * Statistikens hjärta: all tid man pausat, någonsin, som sidans stora rubrik —
 * *TOTAL TIME* och `10h 32 min`, alltid timmar och minuter. Talet växer bara
 * och rörs inte av diagrammets bläddring under.
 *
 * **Ett tal fritt på sidan, som tonar mörkare nedåt** (`FADE`): från en
 * ljusare accent upptill, via accenten en aning mörkare (`TOTAL_INK_LIGHT`),
 * till djup marin nedtill, och en mjuk skugga rakt ner som ger det tyngd.
 * Toningen är byggd av band om `BAND_PT` kopior av samma RN-text, var och en klippt
 * till sin remsa i sin egen ton — RN-text kan inte fyllas med en toning utan
 * masked-view (en native-modul). Kopiorna ligger exakt på varandra eftersom
 * de är samma text i samma storlek; därför räknas storleken ut i stället för
 * `adjustsFontSizeToFit`, som hade kunnat krympa kopiorna olika. Det kommer
 * mjukt: tonar fram och glider upp (`BLOOM_MS`), en mjuk haptik. Känslan ska
 * vara *mmm*, inte *ta-da*.
 *
 * **Vanlig RN-text, inte svg.** Talet var två gånger svg-text med en toning,
 * och båda gick fel: en yta lika bred som en RN-mätning klippte slutet
 * (`10h 0`), och i en bred yta centrerade `textAnchor="middle"` fel när
 * spannen hade olika storlek. Gå inte tillbaka till svg-text här.
 *
 * Det som föll på begäran, i ordning: en ring mot milstolpar (för mycket
 * siffror), ett räkneverk (för stökigt), svart text (för skarpt), en ljus
 * toning (smälte in), ett mörkt nattkort med klot och ljusreflex (för stor
 * ruta för ett tal), och en glans i talet.
 *
 * Bara pauser räknas; en natt hade gjort talet till ett sömnkonto.
 */

const BLOOM_MS = 1600;
const EASE = Easing.bezier(0.22, 1, 0.36, 1);
/**
 * Talet i ljust läge: accentens kulör (`#2e86de`) en aning mörkare. Bara här
 * — en mörkare accent i hela appen prövades och togs tillbaka.
 */
const TOTAL_INK_LIGHT = '#217bd4';

/**
 * Bandens höjd. 14 band (6–7 pt var) gav synliga trappsteg; med 1,5 pt och
 * kanter på hela pixlar är steget mellan två band för litet för att synas.
 */
const BAND_PT = 1.5;

const mix = (a: string, b: string, t: number) => {
  const p = (c: string, i: number) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  const ch = (i: number) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, '0');
  return `#${ch(0)}${ch(1)}${ch(2)}`;
};
/** Toningen uppifrån och ner: `t` 0 är talets topp, 1 dess botten. */
const fadeOf = (stops: [number, string][]) => (t: number) => {
  const k = stops.findIndex(([at]) => at >= t);
  if (k <= 0) return stops[k === 0 ? 0 : stops.length - 1][1];
  const [a0, c0] = stops[k - 1];
  const [a1, c1] = stops[k];
  return mix(c0, c1, (t - a0) / (a1 - a0));
};
const FADE = {
  // Ljust: från en ljusare accent upptill, via TOTAL_INK_LIGHT, till djup marin.
  light: fadeOf([[0, '#4a9fee'], [0.45, TOTAL_INK_LIGHT], [1, '#123f80']]),
  dark: fadeOf([[0, '#e3f1ff'], [0.45, '#9ccbff'], [1, '#4a97e6']]),
};

/** `10h 32 min`, också under en timme (`0h 12 min`). */
function format(secs: number) {
  const mins = Math.floor(secs / 60);
  return { h: String(Math.floor(mins / 60)), m: String(mins % 60) };
}

export function PauseTotalHeart({ totalSecs, loaded }: {
  totalSecs: number;
  /** Talet tonar fram först när raderna landat, inte medan de hämtas. */
  loaded: boolean;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const { width } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const { h, m } = format(totalSecs);

  // Storleken räknas ut i stället för `adjustsFontSizeToFit`: banden är
  // kopior av samma text, och varje kopia måste få exakt samma storlek. En
  // siffra är ungefär 0.62 em bred i 900, enheterna (`h `, ` min`, sex tecken)
  // ungefär 0.2 em var i sin mindre storlek.
  const avail = width - 2 * 32;
  const font = Math.floor(Math.min(76, avail / ((h.length + m.length) * 0.62 + 6 * 0.2)));
  const unitFont = Math.round(font * 0.36);

  const a = useSharedValue(0);
  const [focusCount, setFocusCount] = useState(0);
  useFocusEffect(useCallback(() => { setFocusCount(c => c + 1); }, []));

  useEffect(() => {
    if (!loaded) { a.value = 0; return; }
    if (reduceMotion) { a.value = 1; return; }
    a.value = 0;
    a.value = withTiming(1, { duration: BLOOM_MS, easing: EASE });
    const t = setTimeout(
      () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => {}); },
      BLOOM_MS * 0.6,
    );
    return () => clearTimeout(t);
  }, [loaded, focusCount, reduceMotion, a]);

  const numberStyle = useAnimatedStyle(() => ({
    opacity: a.value,
    transform: [{ translateY: (1 - a.value) * 14 }, { scale: 0.97 + 0.03 * a.value }],
  }));

  const lh = Math.round(font * 1.2);
  const fade = FADE[Palette.mode === 'dark' ? 'dark' : 'light'];
  // Ett lager per band; bandet klipper sin kopia av talet till sin remsa.
  // Kanterna på hela pixlar, annars ger halva pixlar ljusa sömmar.
  const band = PixelRatio.roundToNearestPixel(BAND_PT);
  const bands = Math.ceil(lh / band);
  const number = (color: string, shadow: boolean) => (
    <Text
      style={[styles.big, !shadow && styles.noShadow, { fontSize: font, lineHeight: lh, color }]}
      numberOfLines={1}
    >
      {h}
      <Text style={{ fontSize: unitFont }}>h </Text>
      {m}
      <Text style={{ fontSize: unitFont }}> min</Text>
    </Text>
  );

  return (
    <View style={styles.wrap} accessible accessibilityLabel={`Total time paused: ${h} hours ${m} minutes`}>
      <Text style={styles.kicker}>TOTAL TIME</Text>
      <Animated.View style={[styles.number, { height: lh }, numberStyle]}>
        {/* Botten: hela talet med skuggan. Banden målar över det. */}
        {number(fade(0), true)}
        {Array.from({ length: bands }, (_, i) => (
          <View
            key={i}
            pointerEvents="none"
            style={[styles.band, { top: i * band, height: band }]}
          >
            <View style={{ position: 'absolute', left: 0, right: 0, top: -i * band }}>
              {number(fade((i + 0.5) / bands), false)}
            </View>
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => {
  const dark = Palette.mode === 'dark';
  return StyleSheet.create({
    wrap: { alignItems: 'center', marginTop: 4, marginBottom: 36, paddingHorizontal: 8 },
    // Designsystemets kicker: versaler, +0.2em.
    kicker: {
      fontSize: 12, lineHeight: 15, fontWeight: '900', letterSpacing: 3,
      color: Palette.textTertiary, marginBottom: 6,
    },
    number: { alignSelf: 'stretch' },
    big: {
      fontWeight: '900', letterSpacing: -2, textAlign: 'center',
      // Djupet: en mjuk skugga rakt ner, som lyfter talet från sidan.
      textShadowColor: dark ? 'rgba(0,0,0,0.45)' : 'rgba(11,42,92,0.22)',
      textShadowOffset: { width: 0, height: 4 },
      textShadowRadius: 10,
    },
    // Banden bär ingen skugga — den hade ritats en gång per band.
    noShadow: { textShadowColor: 'transparent', textShadowRadius: 0 },
    band: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
  });
};
