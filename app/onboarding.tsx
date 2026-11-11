import { FontAwesome, FontAwesome5 } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AppPalette, Radius, Spacing, alpha, darkPalette, lightPalette } from '../constants/appTheme';
import { RoomProvider, ThemePreference, usePalette, useTheme } from '../contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PodBoxIcon } from '../components/pod-box-icon';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { track } from '../lib/analytics';
import { fetchMyTags, formatTagUid, type MyTag, removeMyTag } from '../lib/tagPairing';
import DismissKeyboardView from './components/DismissKeyboardView';

type ThemeOption = {
  value: ThemePreference;
  label: string;
  /** Vänster (eller enda) halva av förhandsrutan. */
  left: typeof darkPalette;
  /** Satt bara för 'system', som visar båda lägena i samma ruta. */
  right?: typeof darkPalette;
};

const THEME_OPTIONS: ThemeOption[] = [
  { value: 'light', label: 'Light', left: lightPalette },
  { value: 'dark', label: 'Dark', left: darkPalette },
  { value: 'system', label: 'System', left: lightPalette, right: darkPalette },
];


function ThemeSwatchHalf({ palette }: { palette: typeof darkPalette }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  return (
    <View style={[styles.themeSwatchHalf, { backgroundColor: palette.bg }]}>
      <View style={[styles.themeSwatchDot, { backgroundColor: palette.accent }]} />
      <View style={[styles.themeSwatchLine, { backgroundColor: palette.ink30 }]} />
      <View style={[styles.themeSwatchLine, { backgroundColor: palette.ink15, width: '60%' }]} />
    </View>
  );
}

/**
 * Hör till **study-rummet** — Pause-rummet en trappa djupare in. Se ROOMS i
 * [constants/appTheme.ts](../constants/appTheme.ts) för varför de tre
 * skärmarna bakom Hems topbar-ikoner delar ett eget, mörkare rum.
 */
export default function SettingsRoom() {
  return (
    <RoomProvider room="study">
      <View style={roomShell}>
        <ScreenBackground room="study" />
        <SettingsScreen />
      </View>
    </RoomProvider>
  );
}

function SettingsScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  // Utseendet sparas direkt när man trycker. Intentionerna, som hade
  // skärmens Spara-knapp, bor i profilen (components/intention-settings.tsx).
  const { preference, setPreference } = useTheme();
  // `null` = inte hämtat (eller nätet föll); `[]` = inga taggar.
  const [myTags, setMyTags] = useState<MyTag[] | null>(null);

  // Vid varje fokus: man kommer tillbaka hit från /pair med en ny tagg.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      fetchMyTags().then(tags => {
        if (alive) setMyTags(tags);
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  const confirmRemoveTag = (tag: MyTag) => {
    Alert.alert(
      'Remove this tag?',
      'The box will no longer recognise this phone. You can register the tag again later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const ok = await removeMyTag(tag.id);
            if (ok) {
              track('pause_tag_removed');
              setMyTags(prev => (prev ?? []).filter(t => t.id !== tag.id));
            } else {
              Alert.alert("Couldn't remove the tag", 'Check your connection and try again.');
            }
          },
        },
      ],
    );
  };
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
    <DismissKeyboardView>

      {/* Topbar */}
      <View style={[styles.topBar, { paddingTop: Math.max(40, insets.top + 8) }]}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <FontAwesome name="chevron-left" size={16} color={Palette.accent} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.pageTitle}>Settings</Text>

      {/* APPEARANCE */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Appearance</Text>
        <Text style={styles.sectionSubtitle}>
          Change theme.
        </Text>
        <View style={styles.themeRow}>
          {THEME_OPTIONS.map(opt => {
            const on = preference === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[styles.themeOption, on && styles.themeOptionOn]}
                onPress={() => setPreference(opt.value)}
                activeOpacity={0.85}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
              >
                <View style={styles.themeSwatch}>
                  <ThemeSwatchHalf palette={opt.left} />
                  {opt.right && <ThemeSwatchHalf palette={opt.right} />}
                </View>
                <Text style={[styles.themeLabel, on && styles.themeLabelOn]}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {preference === 'system' && (
          <Text style={styles.themeHint}>Follows your phone&apos;s light and dark setting.</Text>
        )}
      </View>

      {/* PAUSE POD: taggregistrering — samma skärm som lådans QR-kod öppnar */}
      <View style={styles.section}>
        {/* Lådan i hörnet, samma som på en lådpaus i statistiken. */}
        <View style={styles.podTitleRow}>
          <PodBoxIcon width={40} />
          <Text style={[styles.sectionTitle, styles.podTitle]}>PausePod</Text>
          {/* Lådsidan: vad lådan är och hur den ställs in (app/pod.tsx). */}
          <TouchableOpacity
            style={styles.podHow}
            onPress={() => router.push('/pod' as never)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
          >
            <Text style={styles.podHowText}>How it works ›</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.sectionSubtitle}>
          {myTags && myTags.length > 0
            ? 'Your PausePod knows you by these tags.'
            : 'New tag on your phone? Enter the code from the box.'}
        </Text>
        {myTags && myTags.length > 0 && (
          <View style={styles.tagList}>
            {myTags.map(tag => (
              <View key={tag.id} style={styles.tagRow}>
                <FontAwesome5 name="tag" size={13} color={Palette.accent} />
                <View style={styles.tagText}>
                  <Text style={styles.tagName}>{tag.label ?? 'Pause tag'}</Text>
                  <Text style={styles.tagMeta}>
                    {formatTagUid(tag.tagUid)} · added{' '}
                    {new Date(tag.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => confirmRemoveTag(tag)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove tag ${formatTagUid(tag.tagUid)}`}
                >
                  <FontAwesome5 name="times" size={14} color={Palette.danger} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}
        <TouchableOpacity
          style={styles.chip}
          onPress={() => router.push('/pair' as never)}
          accessibilityRole="button"
        >
          <FontAwesome5 name="tag" size={12} color={Palette.accent} />
          <Text style={styles.chipLabel}>
            {myTags && myTags.length > 0 ? 'Register another tag' : 'Register a Pause tag'}
          </Text>
        </TouchableOpacity>
      </View>

    </DismissKeyboardView>
    </ScrollView>
  </KeyboardAvoidingView>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flexGrow: 1,
    // Botten ritas av <ScreenBackground> i skalet ovan.
    backgroundColor: 'transparent',
    padding: Spacing.xl,
    paddingTop: 0,
    paddingBottom: 70,

  },
  topBar: {
    paddingTop: 40,
    marginBottom: 16,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingRight: 16,
  },
  backText: {
    color: Palette.accent,
    fontSize: 16,
  },
  pageTitle: {
    fontSize: 32,
    fontWeight: '800',
    color: Palette.textPrimary,
    marginBottom: 32,
  },
  section: {
    backgroundColor: Palette.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
    padding: Spacing.lg,
    marginBottom: 40,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: Palette.textPrimary,
    marginBottom: 6,
  },
  podTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  podTitle: { marginBottom: 0 },
  podHow: { marginLeft: 'auto' },
  podHowText: { fontSize: 14, fontWeight: '600', color: Palette.hue },
  sectionSubtitle: {
    fontSize: 14,
    color: Palette.textSecondary,
    marginBottom: 16,
    lineHeight: 22,
  },
  themeRow: {
    flexDirection: 'row',
    gap: 10,
  },
  themeOption: {
    flex: 1,
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    borderColor: Palette.surfaceAlt,
    backgroundColor: Palette.surfaceAlt,
  },
  themeOptionOn: {
    borderColor: Palette.hue,
    backgroundColor: Palette.hueTint,
  },
  // Rutan är en miniatyr av läget den erbjuder: botten, en blå prick och två
  // textrader. 'System' lägger två halvor kant i kant i samma ruta.
  themeSwatch: {
    flexDirection: 'row',
    width: 58,
    height: 42,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
  },
  themeSwatchHalf: {
    flex: 1,
    padding: 5,
    gap: 3,
  },
  themeSwatchDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginBottom: 2,
  },
  themeSwatchLine: {
    height: 3,
    borderRadius: 2,
    width: '85%',
  },
  themeLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    color: Palette.textSecondary,
  },
  themeLabelOn: {
    color: Palette.accent,
  },
  themeHint: {
    fontSize: 13,
    color: Palette.textTertiary,
    marginTop: 12,
    lineHeight: 19,
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  tagList: {
    gap: 8,
    marginBottom: 16,
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: Palette.surfaceAlt,
    borderRadius: Radius.md,
  },
  tagText: {
    flex: 1,
    gap: 2,
  },
  tagName: {
    fontSize: 15,
    fontWeight: '600',
    color: Palette.textPrimary,
  },
  tagMeta: {
    fontSize: 13,
    color: Palette.textTertiary,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.surfaceAlt,
    borderWidth: 1.5,
    borderColor: Palette.surfaceAlt,
    borderRadius: Radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  chipSelected: {
    borderColor: Palette.hue,
    backgroundColor: Palette.hueTint,
  },
  chipEmoji: {
    fontSize: 14,
  },
  chipLabel: {
    color: Palette.textSecondary,
    fontSize: 12,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  chipLabelSelected: {
    color: Palette.textPrimary,
  },
  addSection: {
    marginTop: 20,
    backgroundColor: Palette.surfaceAlt,
    borderRadius: Radius.xl,
    padding: 16,
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
  },
  addTitle: {
    ...Palette.eyebrow,
    marginBottom: 12,
  },
  addRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  emojiWrapper: {
    position: 'relative',
    width: 52,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emojiInput: {
    position: 'absolute',
    width: 52,
    height: 48,
    backgroundColor: Palette.bg,
    borderRadius: Radius.sm,
    fontSize: 22,
    color: Palette.textPrimary,
    textAlign: 'center',
    borderWidth: 1.5,
    borderColor: Palette.surfaceBorder,
  },
  emojiOverlay: {
    pointerEvents: 'none',
  },
  labelInput: {
    flex: 1,
    backgroundColor: Palette.bg,
    borderRadius: Radius.sm,
    padding: 12,
    fontSize: 14,
    color: Palette.textPrimary,
    borderWidth: 1.5,
    borderColor: Palette.surfaceBorder,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  addButton: {
    backgroundColor: Palette.accent,
    width: 44,
    height: 44,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonDisabled: {
    backgroundColor: Palette.surfaceAlt,
  },
  saveButton: {
    backgroundColor: Palette.accent,
    paddingVertical: 16,
    borderRadius: Radius.pill,
    alignItems: 'center',
    marginTop: 0,
  },
  saveButtonDone: {
    backgroundColor: Palette.success,

  },
  saveText: {
    color: Palette.onAccent,
    fontSize: 18,
    fontWeight: 'bold',
  },
  unsavedOverlay: {
    flex: 1,
    backgroundColor: Palette.scrim,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  unsavedSheet: {
    backgroundColor: Palette.modalSurface,
    borderRadius: Radius.xl,
    padding: 28,
    width: '100%',
    gap: 12,
    borderWidth: 1,
    borderColor: Palette.modalBorder,
  },
  unsavedTitle: {
    color: Palette.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 2,
  },
  unsavedBody: {
    color: Palette.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 8,
  },
  unsavedBtnSave: {
    backgroundColor: Palette.accent,
    borderRadius: Radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  unsavedBtnSaveText: {
    color: Palette.onAccent,
    fontSize: 15,
    fontWeight: '700',
  },
  unsavedBtnDiscard: {
    backgroundColor: Palette.ink05,
    borderRadius: Radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  unsavedBtnDiscardText: {
    color: alpha(Palette.dangerSoft, 0.85),
    fontSize: 15,
    fontWeight: '500',
  },
  unsavedBtnCancel: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  unsavedBtnCancelText: {
    color: Palette.textTertiary,
    fontSize: 14,
  },
});
