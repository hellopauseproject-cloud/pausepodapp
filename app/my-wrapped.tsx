import { FontAwesome5 } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppPalette, alpha } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { usePalette } from '../contexts/ThemeContext';
import { supabase } from '../lib/supabase';
import { fetchMyGlobalPauseWindows } from '../lib/globalPause';
import { GlobalPauseWeekCard } from '../components/global-pause-week-card';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

type MyWrappedData = {
  pauseCount: number;
  totalMinutes: number;
  avgMinutes: number;
  longestMinutes: number;
  topIntention: string | null;
  topIntentionEmoji: string | null;
  avatarUrl: string | null;
  sharedPauseCount: number;
  bestBuddy: { username: string; avatarUrl: string | null } | null;
  /** Global Pauses man pausade i, senaste sju dagarna (lib/globalPause.ts). */
  globalPauseCount: number;
};

type PageConfig = {
  bg: string;
  accentColor: string;
  render: (data: MyWrappedData) => React.ReactNode;
};

// Se friend-wrapped.tsx: sidlistan är data med render-callbacks och kan inte
// hämta paletten ur en krok, så skärmen bygger den och skickar in stilarna.
type WrappedStyles = ReturnType<typeof makeStyles>;

function formatMinutes(minutes: number): string {
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

const CATEGORY_INFO: Record<string, { label: string; emoji: string }> = {
  focus:      { label: 'FOCUS',      emoji: '🎯' },
  walk:       { label: 'WALK',       emoji: '🚶' },
  workout:    { label: 'WORKOUT',    emoji: '💪' },
  social:     { label: 'SOCIAL',     emoji: '💬' },
  clean:      { label: 'CLEAN',      emoji: '🧹' },
  meditate:   { label: 'MEDITATION', emoji: '🧘' },
  read:       { label: 'READING',    emoji: '📖' },
  study:      { label: 'STUDY',      emoji: '✏️' },
  rest:       { label: 'REST',       emoji: '😴' },
  create:     { label: 'CREATE',     emoji: '🎨' },
  music:      { label: 'MUSIC',      emoji: '🎵' },
  nature:     { label: 'NATURE',     emoji: '🌲' },
  FOCUS:      { label: 'FOCUS',      emoji: '🎯' },
  WALK:       { label: 'WALK',       emoji: '🚶' },
  WORKOUT:    { label: 'WORKOUT',    emoji: '💪' },
  SOCIAL:     { label: 'SOCIAL',     emoji: '💬' },
  CLEAN:      { label: 'CLEAN',      emoji: '🧹' },
  MEDITATION: { label: 'MEDITATION', emoji: '🧘' },
  READING:    { label: 'READING',    emoji: '📖' },
  STUDY:      { label: 'STUDY',      emoji: '✏️' },
  REST:       { label: 'REST',       emoji: '😴' },
  CREATE:     { label: 'CREATE',     emoji: '🎨' },
  MUSIC:      { label: 'MUSIC',      emoji: '🎵' },
  NATURE:     { label: 'NATURE',     emoji: '🌲' },
};

const INTENTION_STATEMENT: Record<string, string> = {
  FOCUS:      'You spent time on deep focus work this week.',
  WALK:       'You got out for fresh air and moved this week.',
  WORKOUT:    'You prioritized your body and exercise this week.',
  SOCIAL:     'You spent time with loved ones this week.',
  CLEAN:      'You created order around yourself this week.',
  MEDITATION: 'You made time for quiet presence this week.',
  READING:    'You traded scrolling for real stories this week.',
  STUDY:      'You invested time in learning this week.',
  REST:       'You gave yourself permission to rest properly this week.',
  CREATE:     'You let creativity flow this week.',
  MUSIC:      'You found peace in music this week.',
  NATURE:     'You found your way back to nature this week.',
};

// ─── Page definitions ──────────────────────────────────────────────────────────

const makePages = (Palette: AppPalette, styles: WrappedStyles): PageConfig[] => [
  {
    bg: Palette.tintBlue,
    accentColor: Palette.accent,
    render: (data) => (
      <View style={styles.page}>
        <Text style={styles.eyebrow}>THIS WEEK</Text>
        <Text style={[styles.bigNumber, { color: Palette.accent }]}>{data.pauseCount}</Text>
        <Text style={styles.statement}>
          {data.pauseCount === 0
            ? 'No pauses this week yet.'
            : data.pauseCount === 1
            ? 'You took one pause this week.'
            : `You took ${data.pauseCount} pauses this week.`}
        </Text>
        {data.pauseCount >= 7 && (
          <Text style={styles.subtle}>More than one a day. Impressive.</Text>
        )}
        {data.pauseCount >= 3 && data.pauseCount < 7 && (
          <Text style={styles.subtle}>A good rhythm.</Text>
        )}
        {data.globalPauseCount > 0 && <GlobalPauseWeekCard count={data.globalPauseCount} />}
      </View>
    ),
  },
  {
    bg: Palette.tintBlue,
    accentColor: Palette.accentSoft,
    render: (data) => (
      <View style={styles.page}>
        <Text style={styles.eyebrow}>TOTAL TIME</Text>
        <Text style={[styles.bigNumber, { color: Palette.accentSoft, fontSize: data.totalMinutes >= 100 ? 56 : 80 }]}>
          {data.totalMinutes > 0 ? formatMinutes(data.totalMinutes) : '—'}
        </Text>
        <Text style={styles.statement}>
          {data.totalMinutes > 0
            ? 'Time this week that was entirely yours.'
            : 'Take your first pause this week.'}
        </Text>
        {data.totalMinutes >= 60 && (
          <Text style={styles.subtle}>More than an hour away from the noise.</Text>
        )}
      </View>
    ),
  },
  {
    bg: Palette.tintGreen,
    accentColor: Palette.slideAccent.green,
    render: (data) => (
      <View style={styles.page}>
        <Text style={styles.eyebrow}>LONGEST PAUSE</Text>
        <Text style={[styles.bigNumber, { color: Palette.slideAccent.green, fontSize: data.longestMinutes >= 100 ? 56 : 80 }]}>
          {data.longestMinutes > 0 ? formatMinutes(data.longestMinutes) : '—'}
        </Text>
        <Text style={styles.statement}>
          {data.longestMinutes >= 30
            ? 'You gave your brain a really deep rest.'
            : data.longestMinutes >= 12
            ? 'A proper pause. Your body notices.'
            : data.longestMinutes > 0
            ? 'Every minute of presence counts.'
            : 'Your longest pause is waiting for you.'}
        </Text>
      </View>
    ),
  },
  {
    bg: Palette.tintPurple,
    accentColor: Palette.slideAccent.violet,
    render: (data) => (
      <View style={[styles.page, { gap: 36 }]}>
        <Text style={styles.eyebrow}>MOST COMMON INTENTION</Text>
        {data.topIntention ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Text style={{ fontSize: 36 }}>{data.topIntentionEmoji ?? '⏸'}</Text>
              <Text style={[styles.bigNumber, { color: Palette.slideAccent.violet, fontSize: 36 }]}>
                {data.topIntention}
              </Text>
            </View>
            <Text style={styles.statement}>
              {INTENTION_STATEMENT[data.topIntention] ?? 'You paused with intention this week.'}
            </Text>
          </>
        ) : (
          <Text style={styles.statement}>
            You paused without a specific intention this week.
          </Text>
        )}
      </View>
    ),
  },
  {
    bg: Palette.tintBlue,
    accentColor: Palette.accentSoft,
    render: (data) => (
      <View style={styles.page}>
        <Text style={styles.eyebrow}>PAUSED TOGETHER</Text>
        <Text style={[styles.bigNumber, { color: Palette.accentSoft }]}>{data.sharedPauseCount}</Text>
        <Text style={styles.statement}>
          {data.sharedPauseCount === 0
            ? 'No shared pauses this week.'
            : data.sharedPauseCount === 1
            ? 'You paused with a friend this week.'
            : `You paused with friends ${data.sharedPauseCount} times this week.`}
        </Text>
        {data.bestBuddy && (
          <View style={styles.buddyCard}>
            <Text style={styles.buddyLabel}>FAVORITE PAUSE BUDDY</Text>
            <View style={styles.buddyRow}>
              {data.bestBuddy.avatarUrl ? (
                <Image source={{ uri: data.bestBuddy.avatarUrl }} style={styles.buddyAvatar} />
              ) : (
                <View style={styles.buddyAvatarFallback} />
              )}
              <Text style={styles.buddyName}>@{data.bestBuddy.username}</Text>
            </View>
          </View>
        )}
      </View>
    ),
  },
  {
    bg: Palette.bg,
    accentColor: Palette.highlight,
    render: (data) => (
      <View style={[styles.page, { alignItems: 'center', justifyContent: 'flex-start', paddingTop: 140 }]}>
        <Text style={{ fontSize: 56, marginBottom: 12 }}>
          {data.pauseCount >= 5 ? '🌟' : data.pauseCount > 0 ? '✨' : '🌱'}
        </Text>
        <Text style={[styles.bigNumber, { color: Palette.highlight, fontSize: 28, textAlign: 'center', lineHeight: 38 }]}>
          {data.pauseCount > 0 ? 'Every pause is an investment.' : 'Next week starts now.'}
        </Text>
        <Text style={[styles.statement, { textAlign: 'center', marginTop: 32, fontSize: 18, lineHeight: 28 }]}>
          {data.pauseCount > 0
            ? 'Your future self will remember this.'
            : 'Take your first pause today. Even 5 minutes makes a difference.'}
        </Text>
        {data.avatarUrl ? (
          <Image source={{ uri: data.avatarUrl }} style={styles.lastSlideAvatar} />
        ) : (
          <View style={styles.lastSlideAvatarFallback} />
        )}
      </View>
    ),
  },
];

// ─── Dot indicator ─────────────────────────────────────────────────────────────

function Dots({ count, activeIndex }: { count: number; activeIndex: number }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  return (
    <View style={styles.dots}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={[styles.dot, i === activeIndex && styles.dotActive]} />
      ))}
    </View>
  );
}

// ─── Main screen ───────────────────────────────────────────────────────────────

export default function MyWrappedScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [data, setData] = useState<MyWrappedData | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const load = async () => {
      if (!user?.id) return;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [{ data: sessions }, { data: profile }, globalWindows] = await Promise.all([
        supabase
          .from('pause_sessions')
          .select('duration_seconds, intention, shared_session_id')
          .eq('user_id', user.id)
          // Bara pauser: annars blev "longest pause" en natts sömn.
          .eq('kind', 'pause')
          .gte('started_at', sevenDaysAgo)
          .not('ended_at', 'is', null),
        supabase
          .from('profiles')
          .select('avatar_url')
          .eq('id', user.id)
          .maybeSingle(),
        fetchMyGlobalPauseWindows(),
      ]);
      const weekFrom = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const globalPauseCount = globalWindows.filter(w => w.from >= weekFrom).length;

      const rows = sessions ?? [];
      const pauseCount = rows.length;
      const totalSeconds = rows.reduce((s, r) => s + (r.duration_seconds ?? 0), 0);
      const totalMinutes = totalSeconds / 60;
      const avgMinutes = pauseCount > 0 ? totalMinutes / pauseCount : 0;
      const longestMinutes = rows.reduce(
        (max, r) => Math.max(max, (r.duration_seconds ?? 0) / 60),
        0
      );
      const intentionCounts: Record<string, number> = {};
      for (const r of rows) {
        if (!r.intention || /^custom_\d+$/.test(r.intention)) continue;
        const label = CATEGORY_INFO[r.intention]?.label ?? r.intention;
        intentionCounts[label] = (intentionCounts[label] ?? 0) + 1;
      }
      const topIntention = Object.keys(intentionCounts).sort(
        (a, b) => intentionCounts[b] - intentionCounts[a]
      )[0] ?? null;
      const topIntentionEmoji = topIntention ? (CATEGORY_INFO[topIntention]?.emoji ?? '⏸') : null;

      const sharedRows = rows.filter(r => r.shared_session_id);
      const sharedPauseCount = sharedRows.length;
      let bestBuddy: { username: string; avatarUrl: string | null } | null = null;
      if (sharedRows.length > 0) {
        const sharedIds = sharedRows.map(r => r.shared_session_id!);
        const { data: partnerSessions } = await supabase
          .from('pause_sessions')
          .select('shared_session_id, user_id')
          .in('shared_session_id', sharedIds)
          .neq('user_id', user.id);
        const partnerCounts: Record<string, number> = {};
        for (const p of (partnerSessions ?? [])) {
          partnerCounts[p.user_id] = (partnerCounts[p.user_id] ?? 0) + 1;
        }
        const topId = Object.keys(partnerCounts).sort((a, b) => partnerCounts[b] - partnerCounts[a])[0];
        if (topId) {
          const { data: bp } = await supabase
            .from('profiles').select('username, avatar_url').eq('id', topId).maybeSingle();
          if (bp) bestBuddy = { username: bp.username ?? '?', avatarUrl: bp.avatar_url ?? null };
        }
      }

      setData({
        pauseCount, totalMinutes, avgMinutes, longestMinutes,
        topIntention, topIntentionEmoji,
        avatarUrl: profile?.avatar_url ?? null,
        sharedPauseCount, bestBuddy, globalPauseCount,
      });

      Animated.timing(fadeAnim, { toValue: 1, duration: 800, useNativeDriver: true }).start();
    };
    load();
  }, [user?.id]);

  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    if (viewableItems[0] != null) setActiveIndex(viewableItems[0].index ?? 0);
  }).current;

  const PAGES = useMemo(() => makePages(Palette, styles), [Palette, styles]);
  const currentPage = PAGES[activeIndex] ?? PAGES[PAGES.length - 1];

  if (!data) {
    return (
      <View style={{ flex: 1, backgroundColor: Palette.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: Palette.textSecondary, fontSize: 16 }}>Loading…</Text>
      </View>
    );
  }

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: currentPage.bg, paddingTop: Math.max(60, insets.top + 8) }]}>
      <TouchableOpacity style={[styles.closeBtn, { top: Math.max(56, insets.top + 4) }]} onPress={() => router.back()} activeOpacity={0.7}>
        <FontAwesome5 name="times" size={18} color={Palette.textSecondary} />
      </TouchableOpacity>

      <View style={[styles.chip, { borderColor: currentPage.accentColor + '66' }]}>
        <Text style={[styles.chipText, { color: currentPage.accentColor }]}>YOUR WEEK</Text>
      </View>
      <FlatList
        data={PAGES}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, i) => String(i)}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        renderItem={({ item }) => (
          <View style={{ width: SCREEN_WIDTH }}>{item.render(data)}</View>
        )}
      />

      <View style={styles.footer}>
        <Dots count={PAGES.length} activeIndex={activeIndex} />
      </View>
    </Animated.View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, paddingTop: 60 },
  closeBtn: {
    position: 'absolute',
    top: 56,
    right: 16,
    zIndex: 10,
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chip: {
    alignSelf: 'center',
    borderWidth: 1,
    borderRadius: 20,
    paddingVertical: 5,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  chipText: { fontSize: 13, fontWeight: '700', letterSpacing: 2 },
  page: {
    width: SCREEN_WIDTH,
    flex: 1,
    paddingHorizontal: 36,
    paddingTop: 40,
    gap: 20,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.ink30,
    letterSpacing: 3,
  },
  bigNumber: {
    fontSize: 80,
    fontWeight: '900',
    color: Palette.textPrimary,
    letterSpacing: -2,
  },
  statement: {
    fontSize: 24,
    fontWeight: '700',
    color: Palette.textPrimary,
    lineHeight: 34,
    letterSpacing: 0.2,
  },
  subtle: { fontSize: 15, color: Palette.ink40 },
  barContainer: { width: '100%', gap: 16, marginTop: 8 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: {
    color: Palette.ink50,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    width: 68,
  },
  barTrack: {
    flex: 1,
    height: 14,
    backgroundColor: Palette.ink08,
    borderRadius: 7,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 7 },
  barPercent: { color: Palette.textPrimary, fontSize: 13, fontWeight: '600', width: 36, textAlign: 'right' },
  // Footer
  footer: { paddingBottom: 72, alignItems: 'center', gap: 12 },
  dots: { flexDirection: 'row', gap: 6 },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Palette.ink20,
  },
  dotActive: {
    backgroundColor: Palette.ink80,
    width: 18,
  },
  swipeHint: { fontSize: 14, color: Palette.ink30, letterSpacing: 1 },
  weekLabel: { alignSelf: 'center', fontSize: 12, letterSpacing: 2, marginTop: -10, marginBottom: 4 },
  lastSlideAvatar: {
    width: 80, height: 80, borderRadius: 40,
    marginTop: 16,
    borderWidth: 2, borderColor: alpha(Palette.highlight, 0.4),
  },
  lastSlideAvatarFallback: {
    width: 80, height: 80, borderRadius: 40,
    marginTop: 16,
    backgroundColor: alpha(Palette.highlight, 0.08),
    borderWidth: 2, borderColor: alpha(Palette.highlight, 0.2),
  },
  buddyCard: {
    backgroundColor: alpha(Palette.accentSoft, 0.08),
    borderRadius: 16, borderWidth: 1, borderColor: Palette.accentSoftTint,
    padding: 16, gap: 10, marginTop: 8,
  },
  buddyLabel: {
    fontSize: 12, fontWeight: '700' as const,
    color: alpha(Palette.accentSoft, 0.6), letterSpacing: 2,
  },
  buddyRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12 },
  buddyAvatar: {
    width: 40, height: 40, borderRadius: 20,
    borderWidth: 2, borderColor: alpha(Palette.accentSoft, 0.3),
  },
  buddyAvatarFallback: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: alpha(Palette.accentSoft, 0.1),
    borderWidth: 2, borderColor: Palette.accentSoftTint,
  },
  buddyName: { fontSize: 18, fontWeight: '700' as const, color: Palette.textPrimary },
});
