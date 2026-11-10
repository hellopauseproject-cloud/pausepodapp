import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { GoalDial } from './goal-dial';
import { PauseButtonFace } from './pause-button-face';

/**
 * Dagsmålets ruta på Hem (ett tryck på ringen): ringen är reglaget
 * (components/goal-dial.tsx), och knappen har PAUSE-knappens material
 * (components/pause-button-face.tsx).
 *
 * Den har varit två saker före ratten, och båda föll: en titel med en lista
 * att rulla och en platt knapp (lästes som ett formulär), och en kopia av
 * Hems ring ovanför listan med dagens tid mot målet (tom och död vid 0 min).
 * Dagens tid visas med flit inte — rutan handlar om löftet, inte om dagen.
 *
 * Kretsen öppnar fortfarande listan (components/duration-wheel.tsx).
 */

const BTN_H = 52;

export function DailyGoalCard({
  goalIndex, onIndexChange, saving, onSave, onCancel,
}: {
  goalIndex: number;
  onIndexChange: (i: number) => void;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);

  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>DAILY GOAL</Text>
      <GoalDial index={goalIndex} onIndexChange={onIndexChange} />
      <TouchableOpacity
        style={styles.saveBtn}
        onPress={onSave}
        disabled={saving}
        activeOpacity={0.85}
        accessibilityRole="button"
      >
        <PauseButtonFace radius={BTN_H / 2} />
        <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save goal'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onCancel} style={styles.cancelLink}>
        <Text style={styles.cancelText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  card: {
    width: '100%', backgroundColor: Palette.modalSurface, borderRadius: Radius.xl,
    borderWidth: 1, borderColor: Palette.modalBorder,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.xl, paddingBottom: Spacing.lg,
    alignItems: 'stretch', gap: Spacing.md,
  },
  eyebrow: { ...Palette.eyebrow, textAlign: 'center' },
  saveBtn: {
    height: BTN_H, borderRadius: BTN_H / 2, overflow: 'hidden',
    backgroundColor: Palette.accent, alignItems: 'center', justifyContent: 'center',
    marginTop: Spacing.xs,
  },
  saveText: { color: Palette.onAccent, fontSize: 15, fontWeight: '900', letterSpacing: 1.5 },
  cancelLink: { alignItems: 'center', paddingVertical: 4 },
  cancelText: { color: Palette.textTertiary, fontSize: 14 },
});
