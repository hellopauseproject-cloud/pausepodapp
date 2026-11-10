import * as Haptics from 'expo-haptics';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import Reanimated, {
  Easing, Extrapolation, interpolate, Keyframe, runOnJS, SharedValue, useAnimatedReaction, useAnimatedRef,
  useAnimatedScrollHandler, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppPalette, Spacing } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { envelopeMetrics, SupportEnvelope, SupportKind } from '../components/support-envelope';
import { PauseButtonFace } from '../components/pause-button-face';
import { openPauseStart } from '../lib/pauseFlow';
import { supabase } from '../lib/supabase';
import { OpenableSupport, openSupportResponse } from '../lib/supportOpen';
import { fetchSealedSupport, setEnvelopeAfterPause, SUPPORT_UNLOCK_MIN_MINUTES } from '../lib/supportSealed';
import { unopenedResponsesQuery } from '../lib/supportStories';

/** Ett kuvert i raden. Ett förseglat har inget innehåll här — SQL lämnar
 *  bara ut vem och när (`get_sealed_support`) — och öppnas efter en paus. */
type Slide = OpenableSupport & { sealed: boolean };

// Mindre än PAUSE på Hem, och lika bred för OPEN och PAUSE TO OPEN, så att
// knappen står still när man sveper mellan ett öppet och ett förseglat kuvert.
const PAUSE_BTN_H = 50;
const PAUSE_BTN_W = 236;
// PAUSE-knappen tonar fram när sigillet trycks: stiger lite och växer till
// full storlek, mjukt med en liten studs på slutet (`back(1.3)`; en fjäder
// prövades och var för livlig, och helt utan studs var för stilla).
const PAUSE_BTN_ENTER = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 12 }, { scale: 0.94 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }], easing: Easing.out(Easing.back(1.3)) },
}).duration(520);

/** Högst så många kuvert i raden; resten kommer när de första öppnats. */
const MAX_ENVELOPES = 20;
// Efter en paus från PAUSE TO OPEN: upplåsningen görs av en trigger när
// pausens rad sparas, och den kan landa strax efter att man kommit hit. Så
// länge kuvertet fortfarande står förseglat frågar skärmen om, ett tag.
const UNLOCK_RETRY_MS = 1000;
const UNLOCK_RETRIES = 6;
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
  const { width, height } = useWindowDimensions();
  const { user } = useAuth();
  const reduceMotion = useReducedMotion();
  // Kuvertet man just pausade för (app/pausesummary.tsx): det ställs i mitten.
  const { unlocked } = useLocalSearchParams<{ unlocked?: string }>();
  const unlockedRef = useRef(unlocked ?? null);

  const [items, setItems] = useState<Slide[] | null>(null);
  const [index, setIndex] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  // Byts vid varje inläsning, så att kuverten monteras om stängda när man
  // kommer tillbaka från en visningsskärm.
  const [loadKey, setLoadKey] = useState(0);
  const hadItemsRef = useRef(false);
  // Det förseglade kuvert vars sigill man tryckt på: då står PAUSE-knappen
  // under raden. Knappen syns inte förrän dess, så att sidan har ett enda
  // ställe att trycka på — kuvertet.
  const [pauseFor, setPauseFor] = useState<string | null>(null);
  // Var rubriken slutar, så att ett kuvert på en låg skärm aldrig hamnar
  // ovanpå den.
  const [headBottom, setHeadBottom] = useState(0);

  const envW = Math.min(width - 96, 290);
  const snap = envW + GAP;
  const sidePad = (width - envW) / 2;
  const glowPad = Math.round(envW * 0.5);
  // Kuvertet reserverar luft ovanför sig (`rise`) för brevet att glida upp i,
  // och raden har luft under för glöden. Därför står raden fritt (absolut)
  // och placeras så att själva kuvertet står mitt på skärmen; luften får
  // ligga över rubriken, som ändå tonar bort när brevet glider upp. I flödet
  // flyttade luften kuvertet långt under mitten hur rubriken än flyttades.
  const env = envelopeMetrics(envW);
  const envTop = Math.max(Math.round(height * 0.58 - env.H / 2), headBottom + 28);
  const pagerTop = envTop - env.rise;

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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = async (attempt: number) => {
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
      const target = unlockedRef.current;
      if (target && sealedList.some(x => x.responseId === target) && attempt < UNLOCK_RETRIES) {
        retryTimer = setTimeout(() => { if (alive) load(attempt + 1); }, UNLOCK_RETRY_MS);
        if (attempt > 0) return;
      } else {
        unlockedRef.current = null;
      }
      const start = target ? Math.max(0, list.findIndex(x => x.id === target)) : 0;
      // Tillbaka från det sista: ingenting kvar att visa här.
      if (list.length === 0 && hadItemsRef.current) { leave(); return; }
      hadItemsRef.current = list.length > 0;
      setItems(list);
      setIndex(start);
      setOpenId(null);
      setPauseFor(null);
      setLoadKey(k => k + 1);
      opening.value = 0;
      scrollX.value = start * snap;
      // Raden monteras om (`loadKey`), så rullningen sätts när den finns.
      setTimeout(() => scrollRef.current?.scrollTo({ x: start * snap, animated: false }), 0);
    };
    load(0);
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, snap]));

  const onScroll = useAnimatedScrollHandler(e => { scrollX.value = e.contentOffset.x; });

  // Ett lätt knäpp varje gång ett nytt kuvert hamnar i mitten, och namnet
  // ovanför byts med det.
  const onPage = useCallback((i: number) => {
    setIndex(i);
    setPauseFor(null);
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
    // Ett förseglat kuvert går inte att bryta här; sigillet tar fram
    // PAUSE-knappen under raden, som startar pausen som öppnar det.
    if (item.sealed) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      setPauseFor(item.id);
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
      <Reanimated.View
        style={[styles.head, chromeStyle]}
        onLayout={e => setHeadBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
      >
        <Text style={styles.title}>Support coming{'\n'}your way!</Text>
        <Text style={styles.sub}>
          {many ? `${items.length} envelopes are waiting for you.` : `${firstName} just sent you support.`}
        </Text>
        <Text style={styles.tapHint}>{current.sealed ? 'Tap the seal' : 'Tap to open'}</Text>
      </Reanimated.View>

      <View style={[styles.pager, { top: pagerTop }]}>
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
                  ? `Sealed support from ${item.senderName.split(' ')[0]}. Opens after a pause. Tap to show the pause button.`
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
                invite={i === index && !openId && pauseFor !== item.id}
                onOpened={() => openSupportResponse(item, 'push')}
              />
            </EnvelopeSlide>
          ))}
        </Reanimated.ScrollView>

        {/* Ett ensamt förseglat kuvert får också raden: det är den som säger
            hur lång pausen ska vara. */}
        {(many || current.sealed) && (
          <Reanimated.View style={[styles.under, { marginTop: -glowPad + 4 }, chromeStyle]}>
            <Text style={styles.from} numberOfLines={1}>
              {/* Sorten står inte här: vad som ligger i kuvertet är en överraskning. */}
              From {firstName}{current.sealed ? ` · Opens after a pause (>${SUPPORT_UNLOCK_MIN_MINUTES}min)` : ''}
            </Text>
            {many && (
              <View style={styles.dots}>
                {items.map((item, i) => (
                  <Dot key={item.id} index={i} snap={snap} scrollX={scrollX} color={Palette.hue} />
                ))}
              </View>
            )}
          </Reanimated.View>
        )}
      </View>

      {/* Ligger efter raden, så att Later och knappen får trycken där raden
          luft når ner över dem; box-none så att resten går igenom till
          kuverten. */}
      <Reanimated.View style={[styles.actions, chromeStyle]} pointerEvents="box-none">
        {current.sealed && pauseFor === current.id ? (
          // Sigillet är tryckt: PAUSE-knappen från Hem, som startar pausen som
          // öppnar det. Den växer fram där tipsraden stod, så att Later står
          // still.
          <Reanimated.View key={current.id} entering={reduceMotion ? undefined : PAUSE_BTN_ENTER}>
          <TouchableOpacity
            style={styles.pauseBtn}
            onPress={() => { setEnvelopeAfterPause(current.id); openPauseStart('push'); }}
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
          </Reanimated.View>
        ) : (
          // Kuvertet är knappen (sigillet slår och säger var; tipset står under
          // rubriken). Platsen står kvar tom, så att *Later* inte flyttar sig
          // när knappen växer fram.
          <View style={styles.pauseSlot} pointerEvents="none" />
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
 * det fullt och rakt, och ju längre ut det glider desto mindre, lägre
 * och mer lutat — åt det håll det är på väg, som ett kort i en hand.
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
    // Grannarna är helt täckande: genomskinliga lät man se brevet inuti, och
    // det ska vara en överraskning. De tonar bara bort när ett kuvert öppnas.
    const fade = isOpening ? 1 : 1 - opening.value;
    if (reduceMotion) return { opacity: fade };
    return {
      opacity: fade,
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

/**
 * En markering under raden per kuvert: ett av logotypens streck
 * (components/pause-pod-logo.tsx — 0.4 × 1.15, helt rundat, och glappet lika
 * brett som strecket), så att raden läser som pausens streck (november 2026,
 * på begäran; det var prickar). Det i mitten står fullt, de andra krymper med
 * logotypens proportioner och tonas.
 */
const DOT_W = 6;
const DOT_H = Math.round(DOT_W * (1.15 / 0.4));

function Dot({ index, snap, scrollX, color }: {
  index: number; snap: number; scrollX: SharedValue<number>; color: string;
}) {
  const style = useAnimatedStyle(() => {
    const d = Math.abs(scrollX.value / snap - index);
    return {
      opacity: interpolate(d, [0, 1], [1, 0.3], Extrapolation.CLAMP),
      transform: [{ scale: interpolate(d, [0, 1], [1, 0.7], Extrapolation.CLAMP) }],
    };
  });
  return (
    <Reanimated.View
      style={[{ width: DOT_W, height: DOT_H, borderRadius: DOT_W, backgroundColor: color }, style]}
    />
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1, backgroundColor: 'transparent',
    alignItems: 'center', justifyContent: 'space-between',
  },
  centered: { flex: 1, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  // Rubriken och knapparna tar lika mycket höjd var (flex: 1), så att kuvertet
  // mellan dem står mitt på skärmen och inte mitt mellan två olika höga block.
  // Rubriken är bara så hög som sin text (med luft ovanför) och knapparnas
  // block tar resten av höjden. Kuvertraden står fritt ovanpå båda, se
  // `pagerTop`. flexShrink: 0 så att texten aldrig klipps.
  head: { flexShrink: 0, alignSelf: 'stretch', alignItems: 'center', gap: 10, paddingTop: 30, paddingHorizontal: Spacing.xl },
  title: {
    fontSize: 28, lineHeight: 32, fontWeight: '900', letterSpacing: -0.6,
    color: Palette.textPrimary, textAlign: 'center', textTransform: 'uppercase',
  },
  sub: { fontSize: 16, color: Palette.textSecondary, textAlign: 'center' },
  // Raden går kant i kant, så att grannkuverten glider in från skärmkanten.
  pager: { position: 'absolute', left: 0, right: 0, gap: 14 },
  under: { alignItems: 'center', gap: 12, paddingHorizontal: Spacing.xl },
  from: { fontSize: 14, color: Palette.textSecondary },
  dots: { flexDirection: 'row', alignItems: 'center', gap: DOT_W },
  actions: {
    flexGrow: 1, flexShrink: 0, flexBasis: 'auto', justifyContent: 'flex-end', alignItems: 'center', gap: 12,
    alignSelf: 'stretch', paddingHorizontal: Spacing.xl,
  },
  // Samma knapp som PAUSE på Hem (app/(tabs)/index.tsx), för både OPEN och
  // PAUSE TO OPEN.
  pauseBtn: {
    width: PAUSE_BTN_W, height: PAUSE_BTN_H, borderRadius: PAUSE_BTN_H / 2,
    backgroundColor: Palette.accent,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    shadowColor: Palette.accent, shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.5, shadowRadius: 18, elevation: 10,
  },
  pauseSlot: { height: PAUSE_BTN_H, justifyContent: 'center' },
  tapHint: { fontSize: 14, fontStyle: 'italic', color: Palette.textTertiary },
  pauseGlyph: { flexDirection: 'row', gap: 5 },
  pauseGlyphBar: { width: 5, height: 15, borderRadius: 2.5, backgroundColor: Palette.onAccent },
  pauseText: { color: Palette.onAccent, fontSize: 15, fontWeight: '900', letterSpacing: 2 },
  laterBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  laterText: { color: Palette.textSecondary, fontSize: 15, fontWeight: '600' },
});
