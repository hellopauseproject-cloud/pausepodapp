import { Entypo, FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { Keyboard, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { addCustomCategory, type Category } from '../app/pauseLogger';
import { alpha, AppPalette, Radius, Spacing } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { track } from '../lib/analytics';
import { lastEmoji } from '../lib/emojiInput';
import { DEFAULT_HABIT_TIMES, HabitGoal, MAX_HABITS } from '../lib/habits';
import { intentionTone } from './pause-tag-chips';

/**
 * Vanorna i dagsmålets ruta på Hem: högst två rader med intentionen och
 * `− 3× +`, och en tom plats som *+ Add a habit*. Ett tryck på den byter
 * rutans innehåll mot `HabitPicker` nedan — alla intentioner på en gång, i
 * stället för en rad chips att svepa i, som gömde de flesta.
 *
 * Komponenterna äger bara valet; rutan sparar allt med sin enda knapp
 * (se `handleSaveGoal` i app/(tabs)/index.tsx och lib/habits.ts).
 *
 * `progress` är veckans räkning för vanor som redan är sparade. En nyss
 * tillagd vana har ingen än, och då står ingen rad under namnet — en nolla
 * för något man inte hunnit börja med vore en uppmaning och inte ett läge.
 */
export function HabitGoalsEditor({
  habits, onChange, onAdd, categories, progress,
}: {
  habits: HabitGoal[];
  onChange: (next: HabitGoal[]) => void;
  /** Öppnar väljaren (`HabitPicker`) i rutans ställe. */
  onAdd: () => void;
  /** Intentionerna att välja bland, med emoji. */
  categories: Category[];
  /** Dagar hittills i veckan, per `category_id`. */
  progress: Record<string, number>;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);

  const chosen = new Set(habits.map(h => h.category_id));
  const anyFree = categories.some(c => !chosen.has(c.id));
  const emojiOf = (h: HabitGoal) => categories.find(c => c.id === h.category_id)?.emoji ?? '•';

  const step = (i: number, dir: 1 | -1) => {
    const next = habits[i].times_per_week + dir;
    if (next < 1 || next > 7) return;
    Haptics.selectionAsync();
    onChange(habits.map((h, j) => (j === i ? { ...h, times_per_week: next } : h)));
  };
  const remove = (i: number) => {
    Haptics.selectionAsync();
    onChange(habits.filter((_, j) => j !== i));
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>HABITS</Text>
        <Text style={styles.headNote}>days a week</Text>
      </View>

      {habits.map((h, i) => {
        const tone = intentionTone(Palette, h.category_id);
        const done = progress[h.category_id];
        return (
          <View key={h.category_id} style={styles.row}>
            <View style={[styles.disc, { backgroundColor: alpha(tone, Palette.mode === 'dark' ? 0.18 : 0.14) }]}>
              <Text style={styles.discEmoji}>{emojiOf(h)}</Text>
            </View>
            <View style={styles.rowText}>
              <Text style={[styles.label, { color: tone }]} numberOfLines={1}>{h.label}</Text>
              {done !== undefined && (
                <Text style={styles.sub}>
                  {Math.min(done, h.times_per_week)} of {h.times_per_week} this week
                  {done >= h.times_per_week ? ' ✓' : ''}
                </Text>
              )}
            </View>
            <View style={styles.stepper}>
              <TouchableOpacity
                style={[styles.stepBtn, h.times_per_week <= 1 && styles.stepBtnOff]}
                onPress={() => step(i, -1)}
                disabled={h.times_per_week <= 1}
                accessibilityLabel={`Fewer days of ${h.label.toLowerCase()}`}
              >
                <FontAwesome5 name="minus" size={11} color={Palette.textSecondary} />
              </TouchableOpacity>
              <Text style={styles.times}>{h.times_per_week}×</Text>
              <TouchableOpacity
                style={[styles.stepBtn, h.times_per_week >= 7 && styles.stepBtnOff]}
                onPress={() => step(i, 1)}
                disabled={h.times_per_week >= 7}
                accessibilityLabel={`More days of ${h.label.toLowerCase()}`}
              >
                <FontAwesome5 name="plus" size={11} color={Palette.textSecondary} />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={styles.removeBtn}
              onPress={() => remove(i)}
              hitSlop={8}
              accessibilityLabel={`Remove the ${h.label.toLowerCase()} habit`}
            >
              <FontAwesome5 name="times" size={13} color={Palette.textTertiary} />
            </TouchableOpacity>
          </View>
        );
      })}

      {habits.length < MAX_HABITS && anyFree && (
        <TouchableOpacity
          style={styles.addRow}
          onPress={onAdd}
          accessibilityRole="button"
          accessibilityLabel="Add a habit"
        >
          <View style={styles.addDisc}>
            <FontAwesome5 name="plus" size={12} color={Palette.hue} />
          </View>
          <Text style={styles.addText}>Add a habit</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

/**
 * Alla intentioner på en gång, tre i bredd: emojin stor i en tonad ruta och
 * namnet under, i intentionens egen ton (`intentionTone`, samma som
 * taggkortet och statistiken). En som redan är en vana står nedtonad med en
 * bock — synlig, så att listan ser likadan ut varje gång, men inte valbar.
 *
 * Den ersätter rutans innehåll i stället för att läggas ovanpå: två modaler
 * på varandra fungerar inte på iOS (samma skäl som kretsens meny).
 */
export function HabitPicker({
  categories, habits, onPick, onBack, onCreated,
}: {
  categories: Category[];
  habits: HabitGoal[];
  onPick: (habit: HabitGoal) => void;
  /** En ny egen intention har sparats — rutan behöver den för emojin. */
  onCreated: (cat: Category) => void;
  onBack: () => void;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const chosen = new Set(habits.map(h => h.category_id));
  // Rutornas bredd räknas ur gridets uppmätta bredd, så att en sista rad med
  // en eller två egna intentioner står till vänster och inte sprids ut.
  const [gridW, setGridW] = useState(0);
  const tileW = gridW ? Math.floor((gridW - 2 * TILE_GAP) / 3) : 0;

  // *Your own*: samma två fält som profilens *Add your own activity*, och
  // samma lagring (`addCustomCategory`). Den nya intentionen blir direkt en
  // vana — det var därför man tryckte på plusset.
  const [creating, setCreating] = useState(false);
  const [newEmoji, setNewEmoji] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const canCreate = !!newEmoji.trim() && !!newLabel.trim() && !saving;
  const create = async () => {
    if (!canCreate) return;
    setSaving(true);
    try {
      const cat = await addCustomCategory(newEmoji, newLabel);
      track('categories_saved', { custom_added_from: 'habits' });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onCreated(cat);
      onPick({ category_id: cat.id, label: cat.label, times_per_week: DEFAULT_HABIT_TIMES });
    } catch {
      setSaving(false);
    }
  };

  return (
    <View style={styles.pickWrap}>
      <View style={styles.pickHead}>
        <TouchableOpacity
          onPress={creating ? () => setCreating(false) : onBack}
          hitSlop={10}
          accessibilityLabel={creating ? 'Back to the intentions' : 'Back to your goals'}
          style={styles.backBtn}
        >
          <FontAwesome5 name="chevron-left" size={14} color={Palette.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.pickTitle}>{creating ? 'Your own habit' : 'Choose a habit'}</Text>
        <View style={styles.backBtn} />
      </View>

      {creating ? (
        <View style={styles.form}>
          <View style={styles.formRow}>
            <View style={styles.emojiWrapper}>
              <TextInput
                style={styles.emojiInput}
                value={newEmoji}
                onChangeText={t => setNewEmoji(lastEmoji(t))}
                returnKeyType="done"
                onSubmitEditing={() => Keyboard.dismiss()}
                accessibilityLabel="Emoji"
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
              autoFocus
              maxLength={20}
              returnKeyType="done"
              onSubmitEditing={create}
            />
          </View>
          <TouchableOpacity
            style={[styles.createBtn, !canCreate && styles.createBtnOff]}
            onPress={create}
            disabled={!canCreate}
            accessibilityRole="button"
          >
            <Text style={[styles.createBtnText, !canCreate && styles.createBtnTextOff]}>
              {saving ? 'Adding…' : 'Add habit'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
      <ScrollView style={styles.gridScroll} showsVerticalScrollIndicator={false} bounces={false}>
      <View style={styles.grid} onLayout={e => setGridW(e.nativeEvent.layout.width)}>
        {tileW > 0 && categories.map(cat => {
          const tone = intentionTone(Palette, cat.id);
          const taken = chosen.has(cat.id);
          return (
            <TouchableOpacity
              key={cat.id}
              style={[
                styles.tile,
                {
                  width: tileW,
                  backgroundColor: alpha(tone, Palette.mode === 'dark' ? 0.14 : 0.1),
                  borderColor: alpha(tone, 0.35),
                },
                taken && styles.tileTaken,
              ]}
              disabled={taken}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onPick({ category_id: cat.id, label: cat.label, times_per_week: DEFAULT_HABIT_TIMES });
              }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityState={{ disabled: taken }}
              accessibilityLabel={taken ? `${cat.label.toLowerCase()} is already a habit` : `Make ${cat.label.toLowerCase()} a habit`}
            >
              <Text style={styles.tileEmoji}>{cat.emoji}</Text>
              <Text style={[styles.tileLabel, { color: tone }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
                {cat.label}
              </Text>
              {taken && (
                <View style={[styles.tileCheck, { backgroundColor: tone }]}>
                  <FontAwesome5 name="check" size={8} color={Palette.mode === 'dark' ? Palette.sunken : Palette.onAccent} />
                </View>
              )}
            </TouchableOpacity>
          );
        })}
        {tileW > 0 && (
          <TouchableOpacity
            style={[styles.tile, styles.tileNew, { width: tileW }]}
            onPress={() => setCreating(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Create your own intention"
          >
            <FontAwesome5 name="plus" size={20} color={Palette.hue} />
            <Text style={[styles.tileLabel, { color: Palette.hue }]}>YOUR OWN</Text>
          </TouchableOpacity>
        )}
      </View>
      </ScrollView>
      )}
    </View>
  );
}

const ROW_H = 52;
const TILE_GAP = 10;

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  wrap: { gap: 2 },
  head: {
    flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
    marginBottom: Spacing.xs,
  },
  eyebrow: { ...Palette.eyebrow },
  headNote: { fontSize: 12, lineHeight: 16, color: Palette.textTertiary },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: ROW_H },
  disc: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  discEmoji: { fontSize: 17 },
  rowText: { flex: 1, minWidth: 0 },
  label: { fontSize: 14, lineHeight: 18, fontWeight: '700', letterSpacing: 0.8 },
  sub: { fontSize: 12, lineHeight: 16, color: Palette.textSecondary, marginTop: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Palette.ink06,
  },
  stepBtnOff: { opacity: 0.35 },
  times: {
    minWidth: 26, textAlign: 'center',
    fontSize: 15, lineHeight: 20, fontWeight: '700', color: Palette.textPrimary,
  },
  removeBtn: { width: 24, height: 30, alignItems: 'center', justifyContent: 'center' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: ROW_H },
  addDisc: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: alpha(Palette.hue, 0.5),
  },
  addText: { fontSize: 14, lineHeight: 18, fontWeight: '700', color: Palette.hue },

  pickWrap: { gap: Spacing.lg },
  pickHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  pickTitle: { fontSize: 18, fontWeight: '700', color: Palette.textPrimary, textAlign: 'center' },
  // Tolv inbyggda är fyra rader; egna intentioner kan göra listan längre än
  // en liten skärm, och då rullar den i stället för att trycka ut rutan.
  gridScroll: { maxHeight: 420 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: TILE_GAP },
  tile: {
    aspectRatio: 1.05,
    borderRadius: 16, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingHorizontal: 4,
  },
  tileTaken: { opacity: 0.4 },
  tileNew: { borderStyle: 'dashed', borderColor: alpha(Palette.hue, 0.5), backgroundColor: 'transparent' },

  // Fälten är profilens (components/intention-settings.tsx), på modalens yta.
  form: { gap: Spacing.lg },
  formRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  emojiWrapper: { position: 'relative', width: 52, height: 48, justifyContent: 'center', alignItems: 'center' },
  emojiInput: {
    position: 'absolute', width: 52, height: 48, backgroundColor: Palette.bg, borderRadius: Radius.sm,
    fontSize: 22, color: Palette.textPrimary, textAlign: 'center', borderWidth: 1.5, borderColor: Palette.surfaceBorder,
  },
  emojiOverlay: { pointerEvents: 'none' },
  labelInput: {
    flex: 1, height: 48, backgroundColor: Palette.bg, borderRadius: Radius.sm, paddingHorizontal: 12, fontSize: 14,
    color: Palette.textPrimary, borderWidth: 1.5, borderColor: Palette.surfaceBorder, fontWeight: 'bold', letterSpacing: 1,
  },
  createBtn: { backgroundColor: Palette.accent, paddingVertical: 14, borderRadius: Radius.pill, alignItems: 'center' },
  createBtnOff: { backgroundColor: Palette.ink06 },
  createBtnText: { color: Palette.onAccent, fontSize: 15, fontWeight: '700' },
  createBtnTextOff: { color: Palette.textDisabled },
  tileEmoji: { fontSize: 26 },
  tileLabel: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 0.6 },
  tileCheck: {
    position: 'absolute', top: 6, right: 6,
    width: 16, height: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
});
