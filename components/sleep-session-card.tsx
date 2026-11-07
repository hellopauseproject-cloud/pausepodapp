import { FontAwesome } from '@expo/vector-icons';
import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { AppPalette, alpha, Radius, roomPalette } from '../constants/appTheme';
import { useTheme } from '../contexts/ThemeContext';
import { NightSky } from './night-sky';

/**
 * En natt i statistikens lista (app/stats.tsx) — ett kort med natthimmel.
 *
 * **Himlen är nattrummets egen** (`roomPalette(mode, 'night')`), alltså samma
 * marinblå som pausskärmen och Hem i nattläge, och den är mörk i båda
 * lägena — se NIGHT i constants/appTheme.ts. Därför läses ALL text på kortet
 * ur nattpaletten och inte ur statistikens: ljuslägets plommonbruna bläck
 * hade varit osynligt på marinblått. Samma regel som flikraden följer i
 * nattläge.
 *
 * Himlen ritas av [night-sky.tsx](night-sky.tsx), med radens id som frö:
 * två nätter har inte samma himmel, och en natt ser likadan ut nästa gång.
 *
 * Inga taggar att redigera, ingen vän och inget meddelande: en natt har
 * ingen intention och är aldrig delad.
 */

type Props = {
  id: string;
  durationText: string;
  dateText: string;
  /**
   * En lådpaus som taggats som natt i efterhand: SLEEP går att trycka på och
   * öppnar intentionerna under kortet, så att natten kan bli en paus igen
   * (supabase/sleep_tag.sql). En natt som startades med SLEEP har ingen.
   */
  onPressTag?: () => void;
  tagExpanded?: boolean;
};

export function SleepSessionCard({ id, durationText, dateText, onPressTag, tagExpanded = false }: Props) {
  const { mode } = useTheme();
  const Night = roomPalette(mode, 'night');
  const styles = useMemo(() => makeStyles(Night), [Night]);

  return (
    <View style={styles.card}>
      <NightSky seed={id} />

      <View style={styles.top}>
        <Text style={styles.duration}>{durationText}</Text>
        <Text style={styles.date}>{dateText}</Text>
      </View>

      <View style={styles.tags}>
        {onPressTag ? (
          <TouchableOpacity
            style={styles.sleepTag}
            onPress={onPressTag}
            hitSlop={8}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityState={{ expanded: tagExpanded }}
            accessibilityLabel="Tag: sleep. Change tag."
          >
            <FontAwesome name="moon-o" size={11} color={Night.hue} />
            <Text style={styles.sleepTagText}>SLEEP</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.sleepTag} accessibilityLabel="Sleep">
            <FontAwesome name="moon-o" size={11} color={Night.hue} />
            <Text style={styles.sleepTagText}>SLEEP</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const makeStyles = (Night: AppPalette) => StyleSheet.create({
  // Samma mått som pauskortet i stats.tsx (`sessionCard`), så att listan
  // läser som en lista och nätterna bara skiljer sig i himlen.
  card: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: alpha(Night.hue, 0.22),
    padding: 16,
    marginBottom: 10,
    gap: 10,
    overflow: 'hidden',
    backgroundColor: Night.bg,
  },
  top: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  duration: { fontSize: 28, fontWeight: '800', color: Night.textPrimary, letterSpacing: -0.5 },
  date: { fontSize: 12, color: Night.textSecondary, letterSpacing: 0.3 },
  tags: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  sleepTag: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: alpha(Night.hue, 0.14), borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: alpha(Night.hue, 0.35),
  },
  sleepTagText: { fontSize: 12, fontWeight: '800', letterSpacing: 1.4, color: Night.hue },});
