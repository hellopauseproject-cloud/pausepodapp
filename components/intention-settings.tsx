import { Entypo, FontAwesome5 } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { useEffect, useMemo, useState } from 'react';
import { Keyboard, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { Category, DEFAULT_CATEGORIES, saveSelectedCategories } from '../app/pauseLogger';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { track } from '../lib/analytics';
import { lastEmoji } from '../lib/emojiInput';

/**
 * *What do you do during your pause?* — vilka intentioner som erbjuds före och
 * efter en paus, och de egna. Bor i profilen ([app/profile.tsx](../app/profile.tsx));
 * den stod förr i Settings och flyttades på begäran: det är en sak om en själv,
 * inte om appen.
 *
 * **Sparas vid varje tryck.** I Settings hörde den till en Spara-knapp och en
 * fråga om osparade ändringar; ett val man ser slå igenom ska ingen behöva
 * bekräfta, och profilens egen Spara gäller namn och foto.
 *
 * Samma filer som förut: `selectedCategories.json` (via `saveSelectedCategories`)
 * och `customCategories.json`.
 */

const CATEGORIES_PATH = FileSystem.documentDirectory + 'selectedCategories.json';
const CUSTOM_CATEGORIES_PATH = FileSystem.documentDirectory + 'customCategories.json';

export function IntentionSettings() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState<Category[]>([]);
  const [newEmoji, setNewEmoji] = useState('');
  const [newLabel, setNewLabel] = useState('');

  useEffect(() => {
    (async () => {
      try { setSelected(JSON.parse(await FileSystem.readAsStringAsync(CATEGORIES_PATH))); } catch {}
      try { setCustom(JSON.parse(await FileSystem.readAsStringAsync(CUSTOM_CATEGORIES_PATH))); } catch {}
    })();
  }, []);

  const all = [...DEFAULT_CATEGORIES, ...custom];

  const persist = async (ids: string[], customList: Category[]) => {
    const known = new Set([...DEFAULT_CATEGORIES, ...customList].map(c => c.id));
    await saveSelectedCategories(ids.filter(id => known.has(id)));
    track('categories_saved', { count: ids.length, custom: customList.length });
  };

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter(c => c !== id) : [...selected, id];
    setSelected(next);
    persist(next, custom);
  };

  const addCustom = async () => {
    if (!newEmoji.trim() || !newLabel.trim()) return;
    const cat: Category = { id: 'custom_' + Date.now(), label: newLabel.trim().toUpperCase(), emoji: newEmoji.trim() };
    const nextCustom = [...custom, cat];
    const nextSelected = [...selected, cat.id];
    setCustom(nextCustom);
    setSelected(nextSelected);
    setNewEmoji('');
    setNewLabel('');
    await FileSystem.writeAsStringAsync(CUSTOM_CATEGORIES_PATH, JSON.stringify(nextCustom));
    persist(nextSelected, nextCustom);
  };

  const removeCustom = async (id: string) => {
    const nextCustom = custom.filter(c => c.id !== id);
    const nextSelected = selected.filter(c => c !== id);
    setCustom(nextCustom);
    setSelected(nextSelected);
    await FileSystem.writeAsStringAsync(CUSTOM_CATEGORIES_PATH, JSON.stringify(nextCustom));
    persist(nextSelected, nextCustom);
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>What do you do during your pause?</Text>
      <Text style={styles.sectionSubtitle}>Choose the activities that suit you.</Text>
      <View style={styles.categoryGrid}>
        {all.map(cat => {
          const on = selected.includes(cat.id);
          return (
            <TouchableOpacity
              key={cat.id}
              style={[styles.chip, on && styles.chipSelected]}
              onPress={() => toggle(cat.id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
            >
              <Text style={styles.chipEmoji}>{cat.emoji}</Text>
              <Text style={[styles.chipLabel, on && styles.chipLabelSelected]}>{cat.label}</Text>
              {custom.some(c => c.id === cat.id) && (
                <TouchableOpacity onPress={() => removeCustom(cat.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <FontAwesome5 name="times" size={10} color={Palette.textFaint} />
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.addSection}>
        <Text style={styles.addTitle}>ADD YOUR OWN ACTIVITY:</Text>
        <View style={styles.addRow}>
          <View style={styles.emojiWrapper}>
            <TextInput
              style={styles.emojiInput}
              value={newEmoji}
              onChangeText={t => setNewEmoji(lastEmoji(t))}
              returnKeyType="done"
              onSubmitEditing={() => Keyboard.dismiss()}
            />
            {!newEmoji && (
              <Entypo name="emoji-happy" size={22} color={Palette.textDisabled} style={styles.emojiOverlay} />
            )}
          </View>
          <TextInput
            style={styles.labelInput}
            placeholder="Activity name"
            placeholderTextColor={Palette.textDisabled}
            value={newLabel}
            onChangeText={setNewLabel}
            autoCapitalize="words"
            maxLength={20}
            returnKeyType="done"
            onSubmitEditing={addCustom}
          />
          <TouchableOpacity
            style={[styles.addButton, (!newEmoji.trim() || !newLabel.trim()) && styles.addButtonDisabled]}
            onPress={addCustom}
            disabled={!newEmoji.trim() || !newLabel.trim()}
            accessibilityLabel="Add activity"
          >
            <FontAwesome5 name="plus" size={16} color={Palette.onAccent} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  section: {
    backgroundColor: Palette.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
    padding: Spacing.lg,
    marginBottom: Spacing.xl,
  },
  sectionTitle: { fontSize: 20, fontWeight: 'bold', color: Palette.textPrimary, marginBottom: 6 },
  sectionSubtitle: { fontSize: 14, color: Palette.textSecondary, marginBottom: 16, lineHeight: 22 },
  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Palette.surfaceAlt, borderWidth: 1.5, borderColor: Palette.surfaceAlt,
    borderRadius: Radius.pill, paddingVertical: 7, paddingHorizontal: 10,
  },
  chipSelected: { borderColor: Palette.hue, backgroundColor: Palette.hueTint },
  chipEmoji: { fontSize: 14 },
  chipLabel: { color: Palette.textSecondary, fontSize: 12, fontWeight: 'bold', letterSpacing: 0.5 },
  chipLabelSelected: { color: Palette.textPrimary },
  addSection: {
    marginTop: 20, backgroundColor: Palette.surfaceAlt, borderRadius: Radius.xl, padding: 16,
    borderWidth: 1, borderColor: Palette.surfaceBorder,
  },
  addTitle: { ...Palette.eyebrow, marginBottom: 12 },
  addRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  emojiWrapper: { position: 'relative', width: 52, height: 48, justifyContent: 'center', alignItems: 'center' },
  emojiInput: {
    position: 'absolute', width: 52, height: 48, backgroundColor: Palette.bg, borderRadius: Radius.sm,
    fontSize: 22, color: Palette.textPrimary, textAlign: 'center', borderWidth: 1.5, borderColor: Palette.surfaceBorder,
  },
  emojiOverlay: { pointerEvents: 'none' },
  labelInput: {
    flex: 1, backgroundColor: Palette.bg, borderRadius: Radius.sm, padding: 12, fontSize: 14,
    color: Palette.textPrimary, borderWidth: 1.5, borderColor: Palette.surfaceBorder, fontWeight: 'bold', letterSpacing: 1,
  },
  addButton: {
    backgroundColor: Palette.accent, width: 44, height: 44, borderRadius: Radius.pill,
    alignItems: 'center', justifyContent: 'center',
  },
  addButtonDisabled: { backgroundColor: Palette.surfaceAlt },
});
