import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppPalette } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { formatDuration } from '../lib/circles';
import { intentionCategory, IntentionKey, UNTAGGED_KEY } from '../lib/circleIntentions';
import { TallyRod } from './tally-rod';

/**
 * Vad kretsen gjorde med sina pauser: en rad per intention med emoji, namn,
 * ett platt rundat streck i rummets kulör (samma stav som Hems hörn) och
 * tiden. Ersatte medlemmarnas att göra-lappar.
 *
 * **Tid och inte antal**: kretsen är byggd kring en pott av tid, och med upp
 * till tio personer hade antalet streck sprungit iväg. Talen är ledgerns
 * räknade sekunder (supabase/circle_intentions.sql), så fördelningen säger
 * aldrig mer än ringen. Egna intentioner står som *Other*, och **otaggade
 * pauser står sist som *Untagged*, i ljusgrått och utan emoji** — som på
 * Hem — så att raderna tillsammans blir samma tal som potten.
 *
 * Sektionen heter *Habits* i fliken (november 2026, på begäran); ordet
 * *intention* står kvar där man väljer en före pausen.
 *
 * Alla streck är i rummets kulör: emojin och namnet säger vilken intention
 * det är, och en kulör per rad bredvid ringen hade gjort sidan rörig.
 */

// Taggade rader; *Untagged* kommer till efter dem.
const MAX_ROWS = 5;
const BAR_H = 8;
// Det kortaste strecket som syns som ett streck och inte en prick.
const BAR_MIN = 10;

export function CircleIntentions({ rows }: { rows: { key: IntentionKey; seconds: number }[] }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const untagged = rows.find(r => r.key === UNTAGGED_KEY);
  const shown = [...rows.filter(r => r.key !== UNTAGGED_KEY).slice(0, MAX_ROWS), ...(untagged ? [untagged] : [])];
  const max = Math.max(0, ...shown.map(r => r.seconds));

  if (shown.length === 0) {
    return <Text style={styles.empty}>No pauses yet.</Text>;
  }

  return (
    <View style={styles.list}>
      {shown.map(r => {
        const cat = intentionCategory(r.key);
        const label = cat.label.charAt(0) + cat.label.slice(1).toLowerCase();
        const faded = r.key === UNTAGGED_KEY;
        return (
          <View key={r.key} style={styles.row} accessible accessibilityLabel={`${label}, ${formatDuration(r.seconds)}`}>
            {/* Ingen emoji för de otaggade — platsen står kvar så att raderna linjerar. */}
            <Text style={styles.emoji}>{faded ? '' : cat.emoji}</Text>
            <Text style={[styles.label, faded && styles.fadedText]} numberOfLines={1}>{label}</Text>
            <Bar
              fraction={max ? r.seconds / max : 0}
              trackStyle={styles.track}
              color={faded ? Palette.ink20 : Palette.hue}
            />
            <Text style={[styles.time, faded && styles.fadedText]}>{formatDuration(r.seconds)}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** Strecket mäts mot sin bana, så att längden är en andel av den verkliga bredden. */
function Bar({ fraction, trackStyle, color }: { fraction: number; trackStyle: object; color: string }) {
  const [w, setW] = useState(0);
  const len = w ? Math.max(BAR_MIN, Math.round(w * Math.min(1, fraction))) : 0;
  return (
    <View style={trackStyle} onLayout={e => setW(Math.round(e.nativeEvent.layout.width))}>
      {len > 0 && <TallyRod width={len} height={BAR_H} color={color} />}
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  list: { gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 24 },
  emoji: { fontSize: 16, width: 22, textAlign: 'center' },
  label: { width: 92, fontSize: 14, lineHeight: 18, fontWeight: '700', color: Palette.textPrimary },
  track: { flex: 1, height: BAR_H, borderRadius: BAR_H / 2, backgroundColor: Palette.hueTrack },
  time: { minWidth: 56, textAlign: 'right', fontSize: 13, lineHeight: 18, fontWeight: '700', color: Palette.textSecondary },
  empty: { fontSize: 14, lineHeight: 20, color: Palette.textTertiary },
  // De otaggade i ljusgrått: ink40 är det ljusaste steget som fortfarande är text.
  fadedText: { color: Palette.ink40 },
});
