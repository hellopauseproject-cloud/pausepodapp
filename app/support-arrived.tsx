import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import Reanimated, {
  Extrapolation, interpolate, runOnJS, SharedValue, useAnimatedReaction, useAnimatedRef,
  useAnimatedScrollHandler, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppPalette, Spacing } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { KIND_LABEL, SupportEnvelope, SupportKind } from '../components/support-envelope';
import { PauseButtonFace } from '../components/pause-button-face';
import { openPauseStart } from '../lib/pauseFlow';
import { supabase } from '../lib/supabase';
import { OpenableSupport, openSupportResponse } from '../lib/supportOpen';
import { fetchSealedSupport, SUPPORT_UNLOCK_MIN_MINUTES } from '../lib/supportSealed';
import { unopenedResponsesQuery } from '../lib/supportStories';

/** Ett kuvert i raden. Ett förseglat har inget innehåll här — SQL lämnar
 *  bara ut vem och när (`get_sealed_support`) — och öppnas efter en paus. */
type Slide = OpenableSupport & { sealed: boolean };

const PAUSE_BTN_H = 58;

/** Högst så många kuvert i raden; resten kommer när de första öppnats. */
const MAX_ENVELOPES = 20;
const GAP = 18;

/**
 * Hör till **friends-rummet**, se ROOMS i constants/appTheme.ts.
 *
 * Det enda stället ett stödsvar öppnas från, oavsett sort. Förr ringde röst
 * och video som ett samtal (`app/call.tsx`, riven) medan text och foto låg
 * bakom ett kuvert — två ingångar för samma sak, och den ena var så lik
 * telefonens egen samtalsskärm att den kändes påträngande. Nu landar allt i
 * ett kuvert man öppnar själv, och brevet som glider ut leder vidare till
 * samma visningsskärmar som förut.
 *
 * **Väntar flera är kuverten en rad man sveper mellan** (november 2026, på
 * begäran): det i mitten står fullt, grannarna krymper, lutar och tonar, och
 * prickarna under säger var man är. Det äldsta står först, så att ingen hamnar
 * längst bak i kön för alltid. Ett tryck på ett grannkuvert sveper dit; ett
 * tryck på det i mitten öppnar det — sigillet spricker, fliken viker sig upp
 * och brevet glider ut (components/support-envelope.tsx).
 *
 * Visningsskärmen öppnas med `push`, och stängs med `closeSupportViewer`
 * (lib/supportOpen.ts), så man kommer tillbaka hit till det som är kvar. Är
 * raden tom när man kommer tillbaka går skärmen själv tillbaka dit man kom
 * ifrån.
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
  const reduceMotion = useReducedMotion();

  const [items, setItems] = useState<Slide[] | null>(null);
  const [index, setIndex] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  // Byts vid varje inläsning, så att kuverten monteras om stängda när man
  // kommer tillbaka från en visningsskärm.
  const [loadKey, setLoadKey] = useState(0);
  const hadItemsRef = useRef(false);

  const envW = Math.min(width - 96, 290);
  const snap = envW + GAP;
  const sidePad = (width - envW) / 2;
  const glowPad = Math.round(envW * 0.5);

  const scrollRef = useAnimatedRef<Reanimated.ScrollView>();
  const scrollX = useSharedValue(0);
  // 0 → 1 när ett kuvert öppnas: rubriken, knapparna och grannarna tonar
  // undan så att brevet är det enda som rör sig. De står kvar i layouten —
  // annars hoppar kuvertet.
  const opening = useSharedValue(0);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/friends' as never);
  }, []);

  useFocusEffect(useCallback(() => {
    if (!user?.id) return;
    let alive = true;
    (async () => {
      const [{ data }, sealedList] = await Promise.all([
        unopenedResponsesQuery(
          user.id, 'id, story_id, response_type, content_url, text_content, caption_y, sender_id',
        )
          .order('created_at', { ascending: true })
          .limit(MAX_ENVELOPES),
        fetchSealedSupport(),
      ]);
      const rows = data ?? [];
      const senderIds = [...new Set(rows.map(r => r.sender_id))];
      const { data: senders } = senderIds.length
        ? await supabase.from('profiles').select('id, username, avatar_url').in('id', senderIds)
        : { data: [] as { id: string; username: string; avatar_url: string | null }[] };
      if (!alive) return;
      const byId = new Map((senders ?? []).map(s => [s.id, s]));
      // De som går att öppna nu först, de förseglade sist — i varje grupp det
      // äldsta först.
      const list: Slide[] = [
        ...rows.map(r => ({
          id: r.id,
          storyId: r.story_id,
          kind: r.response_type as SupportKind,
          contentUrl: r.content_url,
          textContent: r.text_content,
          captionY: r.caption_y,
          senderName: byId.get(r.sender_id)?.username ?? 'A friend',
          senderAvatarUrl: byId.get(r.sender_id)?.avatar_url ?? null,
          sealed: false,
        })),
        ...[...sealedList].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(s => ({
          id: s.responseId,
          storyId: null,
          kind: 'text' as SupportKind,
          contentUrl: null,
          textContent: null,
          captionY: null,
          senderName: s.username,
          senderAvatarUrl: s.avatarUrl,
          sealed: true,
        })),
      ].slice(0, MAX_ENVELOPES);
      // Tillbaka från det sista: ingenting kvar att visa här.
      if (list.length === 0 && hadItemsRef.current) { leave(); return; }
      hadItemsRef.current = list.length > 0;
      setItems(list);
      setIndex(0);
      setOpenId(null);
      setLoadKey(k => k + 1);
      opening.value = 0;
      scrollX.value = 0;
      scrollRef.current?.scrollTo({ x: 0, animated: false });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]));

  const onScroll = useAnimatedScrollHandler(e => { scrollX.value = e.contentOffset.x; });

  // Ett lätt knäpp varje gång ett nytt kuvert hamnar i mitten, och namnet
  // ovanför byts med det.
  const onPage = useCallback((i: number) => {
    setIndex(i);
    Haptics.selectionAsync().catch(() => {});
  }, []);
  useAnimatedReaction(
    () => Math.round(scrollX.value / snap),
    (cur, prev) => { if (prev !== null && cur !== prev) runOnJS(onPage)(cur); },
    [snap],
  );

  const openAt = (i: number) => {
    const item = items?.[i];
    if (!item || openId) return;
    if (i !== index) {
      scrollRef.current?.scrollTo({ x: i * snap, animated: true });
      return;
    }
    // Ett förseglat kuvert går inte att bryta här; knappen under startar pausen.
    if (item.sealed) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }
    opening.value = withTiming(1, { duration: reduceMotion ? 0 : 280 });
    setOpenId(item.id);
  };

  const chromeStyle = useAnimatedStyle(() => ({ opacity: 1 - opening.value }));

  if (items === null) {
    return <View style={styles.centered}><ActivityIndicator color={Palette.hue} /></View>;
  }

  if (items.length === 0) {
    return (
      <View style={[styles.centered, { gap: Spacing.lg }]}>
        <Text style={styles.sub}>Nothing waiting right now.</Text>
        <TouchableOpacity onPress={leave} activeOpacity={0.7}>
          <Text style={styles.laterText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const current = items[Math.min(index, items.length - 1)];
  const firstName = current.senderName.split(' ')[0];
  const many = items.length > 1;

  return (
    <View style={[styles.container, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 }]}>
      <Reanimated.View style={[styles.head, chromeStyle]}>
        <Text style={styles.eyebrow}>SUPPORT</Text>
        <Text style={styles.title}>Support coming{'\n'}your way!</Text>
        <Text style={styles.sub}>
          {many ? `${items.length} envelopes are waiting for you.` : `${firstName} just sent you support.`}
        </Text>
      </Reanimated.View>

      <View style={styles.pager}>
        <Reanimated.ScrollView
          key={loadKey}
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={snap}
          decelerationRate="fast"
          disableIntervalMomentum
          scrollEnabled={!openId && many}
          onScroll={onScroll}
          scrollEventThrottle={16}
          // Raden klipper sitt innehåll, och glöden under kuvertet når långt
          // nedanför det — utan luften där syns en skarp kant i glöden.
          // Prickarna dras sedan upp i samma luft (`under`).
          contentContainerStyle={{ paddingHorizontal: sidePad, gap: GAP, alignItems: 'flex-end', paddingBottom: glowPad }}
        >
          {items.map((item, i) => (
            <EnvelopeSlide
              key={item.id}
              index={i}
              snap={snap}
              scrollX={scrollX}
              opening={opening}
              isOpening={openId === item.id}
              reduceMotion={reduceMotion}
              onPress={() => openAt(i)}
              accessibilityLabel={i !== index
                ? `Go to support from ${item.senderName.split(' ')[0]}`
                : item.sealed
                  ? `Sealed support from ${item.senderName.split(' ')[0]}. Take a pause to open it.`
                  : `Open support from ${item.senderName.split(' ')[0]}`}
            >
              <SupportEnvelope
                sealed={item.sealed}
                width={envW}
                senderName={item.senderName}
                senderAvatarUrl={item.senderAvatarUrl}
                kind={item.kind}
                previewText={item.textContent}
                photoUrl={item.kind === 'photo' ? item.contentUrl : null}
                open={openId === item.id}
                onOpened={() => openSupportResponse(item, 'push')}
              />
            </EnvelopeSlide>
          ))}
        </Reanimated.ScrollView>

        {many && (
          <Reanimated.View style={[styles.under, { marginTop: -glowPad + 4 }, chromeStyle]}>
            <Text style={styles.from} numberOfLines={1}>
              From {firstName} · {current.sealed ? 'Opens after a pause' : KIND_LABEL[current.kind]}
            </Text>
            <View style={styles.dots}>
              {items.map((item, i) => (
                <Dot key={item.id} index={i} snap={snap} scrollX={scrollX} color={Palette.hue} />
              ))}
            </View>
          </Reanimated.View>
        )}
      </View>

      <Reanimated.View style={[styles.actions, chromeStyle]}>
        {current.sealed ? (
          // Förseglat: PAUSE-knappen från Hem, som startar pausen som öppnar
          // det, och hur lång den behöver vara.
          <>
            <TouchableOpacity
              style={styles.pauseBtn}
              onPress={() => openPauseStart('push')}
              disabled={!!openId}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={`Take a pause to open. It opens after ${SUPPORT_UNLOCK_MIN_MINUTES} minutes.`}
            >
              <PauseButtonFace radius={PAUSE_BTN_H / 2} />
              <View style={styles.pauseGlyph}>
                <View style={styles.pauseGlyphBar} />
                <View style={styles.pauseGlyphBar} />
              </View>
              <Text style={styles.pauseText}>PAUSE TO OPEN</Text>
            </TouchableOpacity>
            <Text style={styles.pauseHint}>Opens after {SUPPORT_UNLOCK_MIN_MINUTES} minutes of pause</Text>
          </>
        ) : (
          <TouchableOpacity
            style={styles.pauseBtn}
            onPress={() => openAt(index)}
            disabled={!!openId}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={`Open support from ${firstName}`}
          >
            <PauseButtonFace radius={PAUSE_BTN_H / 2} />
            <Text style={styles.pauseText}>OPEN</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={leave} disabled={!!openId} activeOpacity={0.7} style={styles.laterBtn}>
          <Text style={styles.laterText}>Later</Text>
        </TouchableOpacity>
      </Reanimated.View>
    </View>
  );
}

/**
 * Ett kuvert i raden. Läget räknas ur rullningen på UI-tråden: i mitten står
 * det fullt och rakt, och ju längre ut det glider desto mindre, lägre,
 * blekare och mer lutat — åt det håll det är på väg, som ett kort i en hand.
 * När ett kuvert öppnas tonar alla andra bort.
 */
function EnvelopeSlide({
  index, snap, scrollX, opening, isOpening, reduceMotion, onPress, accessibilityLabel, children,
}: {
  index: number;
  snap: number;
  scrollX: SharedValue<number>;
  opening: SharedValue<number>;
  isOpening: boolean;
  reduceMotion: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  children: React.ReactNode;
}) {
  const style = useAnimatedStyle(() => {
    const pos = scrollX.value / snap - index; // 0 i mitten, ±1 en plats bort
    const range = [-1, 0, 1];
    const fade = isOpening ? 1 : 1 - opening.value;
    if (reduceMotion) {
      return { opacity: interpolate(pos, range, [0.5, 1, 0.5], Extrapolation.CLAMP) * fade };
    }
    return {
      opacity: interpolate(pos, range, [0.45, 1, 0.45], Extrapolation.CLAMP) * fade,
      transform: [
        { translateY: interpolate(Math.abs(pos), [0, 1], [0, 26], Extrapolation.CLAMP) },
        { scale: interpolate(Math.abs(pos), [0, 1], [1, 0.84], Extrapolation.CLAMP) },
        { rotate: `${interpolate(pos, range, [6, 0, -6], Extrapolation.CLAMP)}deg` },
      ],
    };
  });
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      <Reanimated.View style={style}>{children}</Reanimated.View>
    </Pressable>
  );
}

/** En prick under raden; den i mitten sträcks ut till ett streck. */
function Dot({ index, snap, scrollX, color }: {
  index: number; snap: number; scrollX: SharedValue<number>; color: string;
}) {
  const style = useAnimatedStyle(() => {
    const d = Math.abs(scrollX.value / snap - index);
    return {
      width: interpolate(d, [0, 1], [20, 6], Extrapolation.CLAMP),
      opacity: interpolate(d, [0, 1], [1, 0.3], Extrapolation.CLAMP),
    };
  });
  return <Reanimated.View style={[{ height: 6, borderRadius: 3, backgroundColor: color }, style]} />;
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1, backgroundColor: 'transparent',
    alignItems: 'center', justifyContent: 'space-between',
  },
  centered: { flex: 1, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  // Rubriken och knapparna tar lika mycket höjd var (flex: 1), så att kuvertet
  // mellan dem står mitt på skärmen och inte mitt mellan två olika höga block.
  head: { flex: 1, alignSelf: 'stretch', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.xl },
  eyebrow: { ...Palette.eyebrow, color: Palette.hue },
  title: {
    fontSize: 28, lineHeight: 32, fontWeight: '900', letterSpacing: -0.6,
    color: Palette.textPrimary, textAlign: 'center', textTransform: 'uppercase',
  },
  sub: { fontSize: 16, color: Palette.textSecondary, textAlign: 'center' },
  // Raden går kant i kant, så att grannkuverten glider in från skärmkanten.
  pager: { alignSelf: 'stretch', marginVertical: Spacing.lg, gap: 14 },
  under: { alignItems: 'center', gap: 12, paddingHorizontal: Spacing.xl },
  from: { fontSize: 14, color: Palette.textSecondary },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actions: {
    flex: 1, justifyContent: 'flex-end', alignItems: 'center', gap: 12,
    alignSelf: 'stretch', paddingHorizontal: Spacing.xl,
  },
  // Samma knapp som PAUSE på Hem (app/(tabs)/index.tsx), för både OPEN och
  // PAUSE TO OPEN.
  pauseBtn: {
    alignSelf: 'stretch', height: PAUSE_BTN_H, borderRadius: PAUSE_BTN_H / 2,
    backgroundColor: Palette.accent,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    shadowColor: Palette.accent, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.55, shadowRadius: 22, elevation: 12,
  },
  pauseGlyph: { flexDirection: 'row', gap: 6 },
  pauseGlyphBar: { width: 6, height: 18, borderRadius: 3, backgroundColor: Palette.onAccent },
  pauseText: { color: Palette.onAccent, fontSize: 17, fontWeight: '900', letterSpacing: 2.4 },
  pauseHint: { fontSize: 13, color: Palette.textTertiary, marginTop: -2 },
  laterBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  laterText: { color: Palette.textSecondary, fontSize: 15, fontWeight: '600' },
});
