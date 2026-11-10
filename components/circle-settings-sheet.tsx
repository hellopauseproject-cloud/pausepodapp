import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View,
} from 'react-native';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { track } from '../lib/analytics';
import { CircleSettings, formatCountRule, formatCountValue, setCircleSettings } from '../lib/circles';
import { CircleSettingsDraft, CircleSettingsForm } from './circle-settings-form';

/**
 * Kretsens inställningar för ägaren, öppnad från medlemslistan. Samma
 * formulär som sista steget i app/circle-create.tsx.
 *
 * Ett ändrat fönster gäller från nästa måndag (utom under kretsens första
 * vecka), och det måste stå här efter sparningen — annars ser det ut som att
 * ändringen inte tog. Belöningen slås på eller av genast.
 */

type Props = {
  visible: boolean;
  circleId: string;
  settings: CircleSettings;
  onClose: () => void;
  onSaved: () => void;
};

function draftFrom(s: CircleSettings): CircleSettingsDraft {
  // En parkerad ändring är det ägaren senast valde, så formuläret visar den.
  const w = s.pending ?? s;
  return {
    rewards_enabled: s.rewards_enabled,
    count_from: w.count_from,
    count_to: w.count_to,
    count_workdays: w.count_workdays,
  };
}

export function CircleSettingsSheet({ visible, circleId, settings, onClose, onSaved }: Props) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const { width } = useWindowDimensions();
  const [draft, setDraft] = useState<CircleSettingsDraft>(() => draftFrom(settings));
  const [saving, setSaving] = useState(false);

  // Nytt utkast varje gång rutan öppnas, så att den aldrig visar ett
  // osparat val från förra gången.
  useEffect(() => { if (visible) setDraft(draftFrom(settings)); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const { deferred } = await setCircleSettings(circleId, draft);
      track('circle_settings_saved', { rewards: draft.rewards_enabled, deferred });
      onSaved();
      onClose();
      if (deferred) {
        Alert.alert('Saved', `The new time window (${formatCountValue(draft)}) starts next Monday, so this week isn’t changed halfway through.`);
      }
    } catch (e: any) {
      Alert.alert('Could not save', e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Circle settings</Text>
          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            <CircleSettingsForm
              value={draft}
              onChange={setDraft}
              width={width - Spacing.xl * 4}
              disabled={saving}
            />
            {settings.pending && (
              <Text style={styles.pending}>
                From next week: {formatCountRule(settings.pending, true)}. Until then: {formatCountValue(settings)}.
              </Text>
            )}
          </ScrollView>
          <TouchableOpacity style={styles.primaryBtn} onPress={handleSave} disabled={saving}>
            <Text style={styles.primaryBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={styles.cancelLink}>
            <Text style={styles.cancelLinkText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// Kortets yta är kretsflikens egna modalmått (`card` i app/(tabs)/circle.tsx).
const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: Palette.scrim, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  card: {
    width: '100%', maxHeight: '88%', backgroundColor: Palette.modalSurface, borderRadius: Radius.xl,
    padding: Spacing.xl, gap: Spacing.lg, borderWidth: 1, borderColor: Palette.modalBorder,
  },
  cardTitle: { fontSize: 18, fontWeight: '700', color: Palette.textPrimary, textAlign: 'center' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  pending: { fontSize: 13, lineHeight: 19, color: Palette.hue, fontWeight: '600', marginTop: Spacing.lg },
  primaryBtn: { backgroundColor: Palette.accent, paddingVertical: 14, borderRadius: Radius.pill, alignItems: 'center' },
  primaryBtnText: { color: Palette.onAccent, fontSize: 15, fontWeight: '700' },
  cancelLink: { alignItems: 'center', paddingVertical: 6 },
  cancelLinkText: { color: Palette.textTertiary, fontSize: 14 },
});
