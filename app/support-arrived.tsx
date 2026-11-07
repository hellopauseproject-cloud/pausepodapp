import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import Reanimated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { SupportEnvelope, SupportKind } from '../components/support-envelope';
import { supabase } from '../lib/supabase';
import { setPending } from '../lib/supportQueue';
import { unopenedResponsesQuery } from '../lib/supportStories';

type Arrived = {
  id: string;
  storyId: string | null;
  kind: SupportKind;
  contentUrl: string | null;
  textContent: string | null;
  captionY: number | null;
  senderName: string;
  senderAvatarUrl: string | null;
};

/**
 * Hör till **friends-rummet**, se ROOMS i constants/appTheme.ts.
 *
 * Det enda stället ett stödsvar öppnas från, oavsett sort. Förr ringde röst
 * och video som ett samtal (`app/call.tsx`, riven) medan text och foto låg
 * bakom ett kuvert — två ingångar för samma sak, och den ena var så lik
 * telefonens egen samtalsskärm att den kändes påträngande. Nu landar allt i
 * ett kuvert man öppnar själv, och brevet som glider ut leder vidare till
 * samma visningsskärmar som förut. Det äldsta oöppnade svaret kommer först,
 * så att ingen hamnar längst bak i kön för alltid.
 *
 * Svaret räknas som öppnat först i visningsskärmen (`delivered_at`), inte här:
 * *Later* lämnar det oöppnat, med brickan kvar.
 */
export default function SupportArrivedRoom() {
  return (
    <RoomProvider room="friends">
      <View style={roomShell}>
        <ScreenBackground room="friends" />
        <SupportArrivedScreen />
      </View>
    </RoomProvider>
  );
}

function SupportArrivedScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { user } = useAuth();

  const [arrived, setArrived] = useState<Arrived | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  // Rubriken och knapparna tonar undan när kuvertet öppnas, så att brevet är
  // det enda som rör sig. De står kvar i layouten — annars hoppar kuvertet.
  const chrome = useSharedValue(1);
  useEffect(() => { if (open) chrome.value = withTiming(0, { duration: 250 }); }, [open, chrome]);
  const chromeStyle = useAnimatedStyle(() => ({ opacity: chrome.value }));

  useEffect(() => {
    if (!user?.id) return;
    let alive = true;
    (async () => {
      const { data, count } = await unopenedResponsesQuery(
        user.id, 'id, story_id, response_type, content_url, text_content, caption_y, sender_id',
        { count: 'exact' },
      )
        .order('created_at', { ascending: true })
        .limit(1);
      const r = data?.[0];
      if (!r) { if (alive) setLoading(false); return; }
      const { data: sender } = await supabase
        .from('profiles').select('username, avatar_url').eq('id', r.sender_id).maybeSingle();
      if (!alive) return;
      setArrived({
        id: r.id,
        storyId: r.story_id,
        kind: r.response_type as SupportKind,
        contentUrl: r.content_url,
        textContent: r.text_content,
        captionY: r.caption_y,
        senderName: sender?.username ?? 'A friend',
        senderAvatarUrl: sender?.avatar_url ?? null,
      });
      setWaiting(Math.max(0, (count ?? 1) - 1));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [user?.id]);

  const goToContent = () => {
    const a = arrived;
    if (!a) return;
    if (a.kind === 'voice' || a.kind === 'video') {
      setPending({
        id: a.id,
        storyId: a.storyId,
        responseType: a.kind,
        contentUrl: a.contentUrl,
        textContent: a.textContent,
        senderName: a.senderName,
        senderAvatarUrl: a.senderAvatarUrl,
      });
      router.replace(a.kind === 'video' ? '/video' : '/voice');
      return;
    }
    if (a.kind === 'photo') {
      router.replace({
        pathname: '/support-view-photo',
        params: {
          messageId: a.id,
          photoUrl: a.contentUrl ?? '',
          caption: a.textContent ?? '',
          // Null blir en tom sträng, som visningsskärmen läser som "inget
          // sparat läge" och faller tillbaka på mitten.
          captionY: a.captionY == null ? '' : String(a.captionY),
          senderName: a.senderName,
        },
      } as any);
      return;
    }
    router.replace({
      pathname: '/text-message',
      params: {
        messageId: a.id,
        textContent: a.textContent ?? '',
        senderName: a.senderName,
        senderAvatarUrl: a.senderAvatarUrl ?? '',
        isSupport: 'true',
      },
    } as any);
  };

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/friends' as never);
  };

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color={Palette.hue} /></View>;
  }

  if (!arrived) {
    return (
      <View style={[styles.centered, { gap: Spacing.lg }]}>
        <Text style={styles.sub}>Nothing waiting right now.</Text>
        <TouchableOpacity onPress={leave} activeOpacity={0.7}>
          <Text style={styles.laterText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const firstName = arrived.senderName.split(' ')[0];
  const envW = Math.min(width - 72, 300);

  return (
    <View style={[styles.container, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 }]}>
      <Reanimated.View style={[styles.head, chromeStyle]}>
        <Text style={styles.eyebrow}>SUPPORT</Text>
        <Text style={styles.title}>Support coming{'\n'}your way!</Text>
        <Text style={styles.sub}>{firstName} just sent you support.</Text>
      </Reanimated.View>

      <Pressable
        onPress={() => setOpen(true)}
        disabled={open}
        accessibilityRole="button"
        accessibilityLabel={`Open support from ${firstName}`}
      >
        <SupportEnvelope
          width={envW}
          senderName={arrived.senderName}
          senderAvatarUrl={arrived.senderAvatarUrl}
          kind={arrived.kind}
          previewText={arrived.textContent}
          photoUrl={arrived.kind === 'photo' ? arrived.contentUrl : null}
          open={open}
          onOpened={goToContent}
        />
      </Pressable>

      <Reanimated.View style={[styles.actions, chromeStyle]}>
        {waiting > 0 && (
          <Text style={styles.waiting}>{waiting === 1 ? '1 more waiting' : `${waiting} more waiting`}</Text>
        )}
        <TouchableOpacity style={styles.openBtn} onPress={() => setOpen(true)} disabled={open} activeOpacity={0.85}>
          <Text style={styles.openText}>Open</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={leave} disabled={open} activeOpacity={0.7} style={styles.laterBtn}>
          <Text style={styles.laterText}>Later</Text>
        </TouchableOpacity>
      </Reanimated.View>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1, backgroundColor: 'transparent',
    alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
  },
  centered: { flex: 1, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  head: { alignItems: 'center', gap: 10 },
  eyebrow: { ...Palette.eyebrow, color: Palette.hue },
  title: {
    fontSize: 28, lineHeight: 32, fontWeight: '900', letterSpacing: -0.6,
    color: Palette.textPrimary, textAlign: 'center', textTransform: 'uppercase',
  },
  sub: { fontSize: 16, color: Palette.textSecondary, textAlign: 'center' },
  actions: { alignItems: 'center', gap: 12, alignSelf: 'stretch' },
  waiting: { fontSize: 13, color: Palette.textTertiary },
  openBtn: {
    alignSelf: 'stretch', alignItems: 'center',
    backgroundColor: Palette.accent, borderRadius: Radius.pill,
    paddingVertical: 16,
  },
  openText: { color: Palette.onAccent, fontSize: 16, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  laterBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  laterText: { color: Palette.textSecondary, fontSize: 15, fontWeight: '600' },
});
