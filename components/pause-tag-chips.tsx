import { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { FontAwesome } from '@expo/vector-icons';

import { alpha, AppPalette, Radius, roomPalette } from '../constants/appTheme';
import { usePalette, useTheme } from '../contexts/ThemeContext';
import { type Category } from '../app/pauseLogger';

/**
 * Taggarna man kan sätta på en paus i efterhand — samma intentioner som
 * pausskärmen erbjuder före pausen (`getSelectedCategories()`), så att en
 * taggad och en förvald paus är samma sorts paus.
 *
 * Delad mellan sammanfattningen (direkt efter pausen) och statistiken
 * (senare), så att de två ser likadana ut. Den valda tagg-en markeras
 * ifylld; ett tryck på den igen gör ingenting här — att ta bort en tagg är
 * statistikens sak.
 *
 * **`colorful`** (taggkortet på Hem och taggarna under pausens kort i
 * statistiken): varje intention får sin egen ton (`intentionTone`), chippen
 * är större, och den valda studsar till när den fylls. Utan flaggan står
 * chippen i rummets ton.
 */
/**
 * Varje inbyggd intention har en egen kulör, vald en och en — inte en
 * turordning runt ett spektrum, som förut gav NATURE lila och REST rosa.
 *
 * Mörkt läge är pastell: ljusa, mjuka toner som bär mörk text när chippet är
 * ifyllt. Ljust läge är samma kulörer djupare, för tonen är också etikettens
 * text och en pastell på ljus botten går inte att läsa (se *Grå text har ett
 * kontrastgolv* i CLAUDE.md) — de är dämpade snarare än mättade, så att de
 * läser som samma familj.
 *
 * READING och NATURE är gröna, och det är ett undantag från grönregeln på
 * begäran — se den i CLAUDE.md.
 */
const INTENTION_TONES: Record<string, { dark: string; light: string }> = {
  focus:    { dark: '#7fd6cb', light: '#1d7a72' }, // turkos
  walk:     { dark: '#b3a0f2', light: '#6449c0' }, // lila, åt blått
  workout:  { dark: '#f5b17e', light: '#b05414' }, // orange
  social:   { dark: '#f1d67f', light: '#856500' }, // gul
  clean:    { dark: '#a7dff0', light: '#1b7b9e' }, // ljusblå, åt cyan
  meditate: { dark: '#d7a7ea', light: '#8c45a6' }, // lila, åt rosa
  read:     { dark: '#bcdca4', light: '#4e7a36' }, // mjukt grön, åt gult
  study:    { dark: '#929cec', light: '#3348aa' }, // mörkblå
  rest:     { dark: '#8ec3f5', light: '#2a70bd' }, // himmelsblå
  create:   { dark: '#f5a8cb', light: '#b03c76' }, // rosa
  music:    { dark: '#f19a96', light: '#bb3a30' }, // röd
  nature:   { dark: '#86d39e', light: '#2c7a47' }, // grön
};
const TONE_LIST = Object.values(INTENTION_TONES);

/**
 * En intentions egen ton — samma på taggkortet efter pausen och på pausens
 * kort i statistiken, så att en FOCUS-paus är turkos på båda ställena.
 * Tonen följer kategorins **id** och inte dess plats i listan: annars hade
 * den bytt färg så fort någon ändrat sina val i Settings. Egna intentioner
 * får en av de tolv ur sitt id.
 */
export function intentionTone(Palette: AppPalette, id: string): string {
  let tone = INTENTION_TONES[id];
  if (!tone) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    tone = TONE_LIST[Math.abs(h) % TONE_LIST.length];
  }
  return Palette.mode === 'dark' ? tone.dark : tone.light;
}

export function PauseTagChips({
  categories, selectedLabel, onPick, disabled, colorful = false, onPickSleep, sleepOn = false,
}: {
  categories: Category[];
  /** Den tagg pausen har nu, som etikett (`FOCUS`), eller null. */
  selectedLabel?: string | null;
  onPick: (cat: Category) => void;
  disabled?: boolean;
  colorful?: boolean;
  /**
   * *Sleep* sist i raden: pausen blir en natt (lib/pauseTags.ts). Utan
   * pilen syns den inte — bara en ensam lådpaus kan bli en natt.
   */
  onPickSleep?: () => void;
  sleepOn?: boolean;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  return (
    <View style={styles.row}>
      {categories.map(cat => (
        <Chip
          key={cat.id}
          cat={cat}
          on={!!selectedLabel && selectedLabel === cat.label}
          tone={colorful ? intentionTone(Palette, cat.id) : null}
          onPick={onPick}
          disabled={disabled}
          styles={styles}
        />
      ))}
      {onPickSleep && (
        <SleepChip on={sleepOn} big={colorful} onPick={onPickSleep} disabled={disabled} styles={styles} />
      )}
    </View>
  );
}

/**
 * *Sleep* är inte en intention utan ett annat slags paus, och ser därför ut
 * som natten: nattrummets marinblå med månen, i båda lägena — samma himmel
 * som nattens kort i statistiken (sleep-session-card.tsx).
 */
function SleepChip({ on, big, onPick, disabled, styles }: {
  on: boolean; big: boolean; onPick: () => void; disabled?: boolean;
  styles: ReturnType<typeof makeStyles>;
}) {
  const { mode } = useTheme();
  const Night = roomPalette(mode, 'night');
  return (
    <TouchableOpacity
      style={[
        styles.chip, big && styles.chipBig,
        { backgroundColor: Night.bg, borderColor: on ? Night.hue : alpha(Night.hue, 0.45) },
      ]}
      onPress={onPick}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled: !!disabled }}
      accessibilityLabel="Tag as sleep. The pause becomes a night."
    >
      <FontAwesome name="moon-o" size={big ? 16 : 14} color={Night.hue} />
      <Text style={[styles.label, { color: Night.hue }]}>SLEEP</Text>
    </TouchableOpacity>
  );
}

function Chip({ cat, on, tone, onPick, disabled, styles }: {
  cat: Category; on: boolean; tone: string | null;
  onPick: (cat: Category) => void; disabled?: boolean;
  styles: ReturnType<typeof makeStyles>;
}) {
  const Palette = usePalette();
  const pop = useRef(new Animated.Value(1)).current;
  const wasOn = useRef(on);
  useEffect(() => {
    if (tone && on && !wasOn.current) {
      pop.setValue(0.8);
      Animated.spring(pop, { toValue: 1, friction: 3, tension: 180, useNativeDriver: true }).start();
    }
    wasOn.current = on;
  }, [on, tone, pop]);

  const toneStyle = tone
    ? on
      ? { backgroundColor: tone, borderColor: tone }
      : { backgroundColor: alpha(tone, Palette.mode === 'dark' ? 0.16 : 0.12), borderColor: alpha(tone, 0.45) }
    : null;

  return (
    <Animated.View style={{ transform: [{ scale: pop }] }}>
      <TouchableOpacity
        style={[styles.chip, tone && styles.chipBig, on && styles.chipOn, toneStyle]}
        onPress={() => onPick(cat)}
        disabled={disabled}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ selected: on, disabled: !!disabled }}
        accessibilityLabel={`Tag as ${cat.label.toLowerCase()}`}
      >
        <Text style={[styles.emoji, tone && styles.emojiBig]}>{cat.emoji}</Text>
        <Text style={[styles.label, tone && { color: tone }, on && (tone ? styles.labelOnTone : styles.labelOn)]}>{cat.label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // Tonad som rummets andra val (kapselns ena halva, lakanets plus), och
  // ifylld i accenten när den är vald — ifyllt är accentens.
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    height: 40, paddingHorizontal: 14,
    borderRadius: Radius.pill,
    backgroundColor: Palette.hueTint,
    borderWidth: 1.5, borderColor: Palette.hueTrack,
  },
  chipBig: { height: 44, paddingHorizontal: 15, gap: 7 },
  chipOn: { backgroundColor: Palette.accent, borderColor: Palette.accent },
  emoji: { fontSize: 15 },
  emojiBig: { fontSize: 18 },
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 0.8, color: Palette.hue },
  labelOn: { color: Palette.onAccent },
  // En ifylld ton: i mörkt läge är tonerna ljusa (guldet nästan gult), så
  // vitt försvinner på dem — där står rummets mörkaste ton som text, samma
  // grepp som Kretsens kapsel. I ljust läge är tonerna mörka och vitt bär.
  labelOnTone: { color: Palette.mode === 'dark' ? Palette.sunken : Palette.onAccent },
});
