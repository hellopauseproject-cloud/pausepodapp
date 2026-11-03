import { Entypo, FontAwesome5 } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import DismissKeyboardView from './components/DismissKeyboardView';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { enablePushNotifications } from '../lib/notifications';
import { supabase } from '../lib/supabase';
import { storyExpiresAt } from '../lib/supportStories';
import { Category, DEFAULT_CATEGORIES } from './pauseLogger';
import { AppPalette, alpha } from '../constants/appTheme';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { lastEmoji } from '../lib/emojiInput';

const CUSTOM_CATEGORIES_PATH = (FileSystem.documentDirectory ?? '') + 'customCategories.json';

const SUPPORT_TYPES = [
  { id: 'tröst', label: 'Comfort' },
  { id: 'värme', label: 'Warmth' },
  { id: 'närvaro', label: 'Presence' },
  { id: 'sällskap', label: 'Company' },
  { id: 'empati', label: 'Empathy' },
  { id: 'förståelse', label: 'Understanding' },
  { id: 'stöd', label: 'Support' },
  { id: 'lugn', label: 'Calm' },
  { id: 'hopp', label: 'Hope' },
  { id: 'skratt', label: 'Laughter' },
  { id: 'pepp', label: 'Pep' },
  { id: 'hejarop', label: 'Cheering' },
  { id: 'en knuff', label: 'A nudge' },
  { id: 'hjälp att börja', label: 'Help getting started' },
  { id: 'råd', label: 'Advice' },
  { id: 'perspektiv', label: 'Perspective' },
  { id: 'klarhet', label: 'Clarity' },
  { id: 'visdom', label: 'Wisdom' },
  { id: 'strategi', label: 'Strategy' },
  { id: 'ärlighet', label: 'Honesty' },
  { id: 'reality check', label: 'Reality check' },
  { id: 'motivationstal', label: 'Pep talk' },
  { id: 'predikan', label: 'Lecture' },
  { id: 'tillsägelse', label: 'A talking-to' },
];

const CATEGORY_VERB: Record<string, string> = {
  focus: 'focus',
  walk: 'go for a walk',
  workout: 'work out',
  social: 'hang out',
  clean: 'clean',
  meditate: 'meditate',
  read: 'read',
  study: 'study',
  rest: 'rest',
  create: 'create',
  music: 'play music',
  nature: 'be in nature',
};

const CARD_W = 82;
const CARD_GAP = 12;

/**
 * Hör till **friends-rummet**. Rummet följer ärendet och inte filträdet — se
 * ROOMS i [constants/appTheme.ts](../constants/appTheme.ts). Skalet är
 * identiskt med de andra rummens: en komponent kan inte läsa sin egen
 * provider, och en bakgrund i skalet täcker varje gren skärmen returnerar.
 */
export default function SupportStoryCreateRoom() {
  return (
    <RoomProvider room="friends">
      <View style={roomShell}>
        <ScreenBackground room="friends" />
        <SupportStoryCreateScreen />
      </View>
    </RoomProvider>
  );
}

function SupportStoryCreateScreen() {
  const Palette = usePalette();
  const s = useMemo(() => makeS(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [supportTypeExpanded, setSupportTypeExpanded] = useState(false);
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [showFreeText, setShowFreeText] = useState(false);
  const [freeEmoji, setFreeEmoji] = useState('');
  const [freeActivity, setFreeActivity] = useState('');
  const [personalNote, setPersonalNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const json = await FileSystem.readAsStringAsync(CUSTOM_CATEGORIES_PATH);
        const customCats: Category[] = JSON.parse(json);
        if (customCats.length > 0) setCategories([...DEFAULT_CATEGORIES, ...customCats]);
      } catch { /* no custom categories */ }
    })();
  }, []);

  const selectedCategory = categories.find(c => c.id === selectedCategoryId) ?? null;
  const hasIntention = showFreeText ? freeActivity.trim().length > 0 : !!selectedCategoryId;
  const canSubmit = hasIntention;

  const handleSubmit = async () => {
    if (!user || !canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const intentionId = showFreeText ? null : selectedCategoryId;
      const activity = showFreeText
        ? (freeEmoji.trim() ? `${freeEmoji.trim()} ${freeActivity.trim()}` : freeActivity.trim())
        : (CATEGORY_VERB[selectedCategory!.id] ?? selectedCategory!.label.toLowerCase());

      const { error } = await supabase.from('support_stories').insert({
        user_id: user.id,
        support_type: selectedTypes.length > 0 ? selectedTypes.join(',') : null,
        activity,
        intention_id: intentionId,
        personal_note: personalNote.trim() || null,
        expires_at: storyExpiresAt(),
      });
      if (error) { setSubmitting(false); Alert.alert('Error', error.message); return; }

      // Den som just bett om stöd vill veta när svaret kommer — se
      // `enablePushNotifications`. Väntas inte in.
      enablePushNotifications().catch(() => {});

      const { data: myProfile } = await supabase
        .from('profiles').select('username').eq('id', user.id).maybeSingle();
      router.back();
    } catch (e: any) {
      setSubmitting(false);
      Alert.alert('Error', e?.message ?? 'Unknown error');
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        style={s.container}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <DismissKeyboardView style={[s.content, { paddingTop: Math.max(24, insets.top - 8) }]}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <FontAwesome5 name="chevron-left" size={15} color={Palette.accent} />
          </TouchableOpacity>
          <Text style={s.title}>Ask for support</Text>
          <View style={{ width: 40 }} />
        </View>

        {/* 1. INTENTION */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>What do you want?</Text>
          {showFreeText ? (
            <View>
              <TouchableOpacity
                onPress={() => { setShowFreeText(false); setFreeActivity(''); setFreeEmoji(''); }}
                style={s.backToCarouselBtn}
                activeOpacity={0.7}
              >
                <FontAwesome5 name="chevron-left" size={11} color={Palette.community} />
                <Text style={s.backToCarouselText}>Choose intention</Text>
              </TouchableOpacity>
              <View style={s.freeInputRow}>
                <View style={{ justifyContent: 'center', alignItems: 'center' }}>
                  <TextInput
                    style={s.emojiInput}
                    value={freeEmoji}
                    onChangeText={t => setFreeEmoji(lastEmoji(t))}
                    placeholder=""
                    textAlign="center"
                  />
                  {!freeEmoji && (
                    <Entypo name="emoji-happy" size={22} color={Palette.ink20} style={{ position: 'absolute', pointerEvents: 'none' }} />
                  )}
                </View>
                <TextInput
                  style={[s.textInput, { flex: 1 }]}
                  value={freeActivity}
                  onChangeText={t => { if (t.length <= 50) setFreeActivity(t); }}
                  placeholder="What do you want to do?"
                  placeholderTextColor={Palette.ink20}
                  maxLength={50}
                  autoFocus
                />
              </View>
              <Text style={s.charCount}>{50 - freeActivity.length}</Text>
            </View>
          ) : (
            <ScrollView
              horizontal
              snapToInterval={CARD_W + CARD_GAP}
              decelerationRate="fast"
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.carouselContent}
            >
              {categories.map(cat => {
                const active = selectedCategoryId === cat.id;
                return (
                  <TouchableOpacity
                    key={cat.id}
                    style={[s.carouselCard, active && s.carouselCardActive]}
                    onPress={() => setSelectedCategoryId(active ? null : cat.id)}
                    activeOpacity={0.75}
                  >
                    <Text style={s.carouselEmoji}>{cat.emoji}</Text>
                    <Text style={[s.carouselLabel, active && s.carouselLabelActive]} numberOfLines={1}>
                      {cat.label.length > 9 ? cat.label.slice(0, 7) + '…' : cat.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={s.carouselCard}
                onPress={() => { setSelectedCategoryId(null); setShowFreeText(true); }}
                activeOpacity={0.75}
              >
                <Text style={s.carouselEmoji}>✏️</Text>
                <Text style={s.carouselLabel}>Write your own</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>

        {/* 3. PERSONAL NOTE */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Want to add something?</Text>
          <TextInput
            style={[s.textInput, s.noteInput]}
            value={personalNote}
            onChangeText={t => { if (t.length <= 100) setPersonalNote(t); }}
            placeholder="E.g. 'Have a test tomorrow'"
            placeholderTextColor={Palette.ink20}
            maxLength={100}
            multiline
          />
          <Text style={s.charCount}>{100 - personalNote.length}</Text>
        </View>

        {/* 3. SPECIFIC KIND OF SUPPORT — collapsed */}
        <View style={s.expandSection}>
          <TouchableOpacity
            style={s.expandToggle}
            onPress={() => setSupportTypeExpanded(e => !e)}
            activeOpacity={0.7}
          >
            <Text style={s.expandToggleText}>
              {selectedTypes.length > 0
                ? selectedTypes.map(id => SUPPORT_TYPES.find(t => t.id === id)?.label ?? id).join(', ')
                : 'A specific kind of support?'}
            </Text>
            <FontAwesome5
              name={supportTypeExpanded ? 'chevron-up' : 'chevron-down'}
              size={11}
              color={Palette.ink25}
            />
          </TouchableOpacity>

          {supportTypeExpanded && (
            <View style={s.expandContent}>
              <Text style={s.expandHint}>Choose what kind of response you'd like</Text>
              <View style={s.tagCloud}>
                <TouchableOpacity
                  style={[s.chip, selectedTypes.length === 0 && s.chipActive]}
                  onPress={() => setSelectedTypes([])}
                  activeOpacity={0.75}
                >
                  <Text style={[s.chipText, selectedTypes.length === 0 && s.chipTextActive]}>Nothing specific</Text>
                </TouchableOpacity>
                {SUPPORT_TYPES.map(t => {
                  const active = selectedTypes.includes(t.id);
                  return (
                    <TouchableOpacity
                      key={t.id}
                      style={[s.chip, active && s.chipActive]}
                      onPress={() => setSelectedTypes(prev =>
                        active ? prev.filter(id => id !== t.id) : [...prev, t.id]
                      )}
                      activeOpacity={0.75}
                    >
                      <Text style={[s.chipText, active && s.chipTextActive]}>{t.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}
        </View>

        {/* 4. SUBMIT */}
        <TouchableOpacity
          style={[s.submitBtn, !canSubmit && s.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={!canSubmit || submitting}
          activeOpacity={0.85}
        >
          <Text style={s.submitText}>{submitting ? 'Posting…' : 'Post'}</Text>
        </TouchableOpacity>
        {/* Gränsen sägs där man postar, inte först när förfrågan försvinner. */}
        <Text style={s.lifetimeHint}>Your friends see it for 24 hours.</Text>
        </DismissKeyboardView>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeS = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: 24, paddingBottom: 60, gap: 40 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginTop: 16,
  },
  backBtn: { width: 44, height: 44, justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: '700', color: Palette.textPrimary, letterSpacing: 0.2 },

  section: { gap: 14 },
  sectionLabel: {
    fontSize: 14, fontWeight: '500',
    color: Palette.textSecondary, letterSpacing: 0.3,
  },

  chipRow: { gap: 8, paddingHorizontal: 2, paddingVertical: 4 },
  chip: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 22,
    backgroundColor: Palette.ink05,
    borderWidth: 1, borderColor: Palette.ink10,
  },
  chipActive: { backgroundColor: Palette.communityTint, borderColor: Palette.community },
  chipText: { color: Palette.ink45, fontSize: 14, fontWeight: '500' },
  chipTextActive: { color: Palette.communitySoft, fontWeight: '600' },

  carouselContent: { gap: CARD_GAP, paddingHorizontal: 2, paddingVertical: 4 },
  carouselCard: {
    width: CARD_W,
    paddingVertical: 14,
    paddingHorizontal: 6,
    borderRadius: 16,
    backgroundColor: Palette.ink04,
    borderWidth: 1.5,
    borderColor: Palette.ink08,
    alignItems: 'center',
    gap: 8,
  },
  carouselCardActive: {
    backgroundColor: alpha(Palette.community, 0.12),
    borderColor: Palette.community,
  },
  carouselEmoji: { fontSize: 30, lineHeight: 38 },
  carouselLabel: {
    fontSize: 11, color: Palette.ink35,
    letterSpacing: 0.5, textAlign: 'center',
  },
  carouselLabelActive: { color: Palette.communitySoft },

  backToCarouselBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10,
  },
  backToCarouselText: { color: Palette.community, fontSize: 13, fontWeight: '500' },

  freeInputRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  emojiInput: {
    width: 54,
    height: 54,
    backgroundColor: Palette.ink05,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Palette.ink10,
    fontSize: 26,
    textAlign: 'center',
    color: Palette.textPrimary,
  },
  textInput: {
    backgroundColor: Palette.ink05, borderRadius: 12,
    borderWidth: 1, borderColor: Palette.ink10,
    padding: 14, color: Palette.textPrimary, fontSize: 14,
  },
  noteInput: { minHeight: 64, textAlignVertical: 'top' },
  charCount: {
    color: Palette.ink20, fontSize: 12, textAlign: 'right', marginTop: 4,
  },

  expandSection: {
    borderTopWidth: 1,
    borderTopColor: Palette.ink07,
    paddingTop: 20,
  },
  expandToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  expandToggleText: {
    fontSize: 14,
    color: Palette.ink40,
    fontWeight: '500',
  },
  expandContent: {
    gap: 12,
    paddingTop: 16,
  },
  tagCloud: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  expandHint: {
    fontSize: 13,
    color: Palette.ink25,
    letterSpacing: 0.2,
  },

  submitBtn: {
    backgroundColor: Palette.community, paddingVertical: 16,
    borderRadius: 32, alignItems: 'center', marginTop: 8,
  },
  submitBtnDisabled: { backgroundColor: alpha(Palette.community, 0.2) },
  submitText: { color: Palette.onAccent, fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  lifetimeHint: { color: Palette.textTertiary, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 10 },
});
