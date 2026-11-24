import { FontAwesome5 } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, Keyboard, KeyboardAvoidingView,
  NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { useModeration } from '../components/moderation';
import {
  CHAT_PAGE_SIZE, ChatMessage, deleteCircleMessage, fetchCircleMessages,
  markCircleChatRead, sendCircleMessage,
} from '../lib/circleChat';
import { getMyCircleId } from '../lib/circles';
import { setChatScreenOpen } from '../lib/notifications';
import { supabase } from '../lib/supabase';

const MAX_BODY = 500;

/** Två meddelanden från samma person tätare än så här klumpas ihop utan att
 *  namnet och avataren upprepas — en rad är ett inlägg, inte en avsändare. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Hur nära botten man måste vara för att nya meddelanden ska dra ner vyn.
 *  Läser man bakåt i samtalet ska ett inkommande inlägg inte rycka undan
 *  texten under fingret. */
const STICK_SLOP = 80;

// Samma form som formatWeekRange och kretsflikens formatToday ger sina
// datum ("MON 24"), så avdelarna här ser ut att höra till samma app.
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  if (dayKey(iso) === dayKey(new Date(now).toISOString())) return 'TODAY';
  if (dayKey(iso) === dayKey(new Date(now - 86400000).toISOString())) return 'YESTERDAY';
  return `${DAYS[d.getDay()]} ${d.getDate()}`;
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Avatar({ username, avatarUrl, size = 28 }: { username: string; avatarUrl?: string | null; size?: number }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  if (avatarUrl) {
    return <Image source={{ uri: avatarUrl }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  return (
    <View style={[styles.avatarFallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarLetter, { fontSize: size * 0.4 }]}>{username[0]?.toUpperCase() ?? '?'}</Text>
    </View>
  );
}

/**
 * Kretsens chatt.
 *
 * **Egen skärm och inte en panel i fliken.** Ett samtal behöver hela höjden
 * och en skrivrad som följer tangentbordet; inne i kretsflikens rullning
 * hade den slagits med potten och flödet om samma lodräta utrymme, och
 * skrivraden hamnat under tangentbordet längst ner i en lång sida.
 *
 * **Inga notiser.** Se supabase/circle_chat.sql och notisavsnittet i
 * CLAUDE.md — appen skickar exakt två, och en chatt är den bullrigaste
 * tänkbara tredje. Det olästa bärs av pricken på chattikonen i fliken.
 *
 * Färskheten kommer från realtime, med en poll var fjärde sekund som
 * skyddsnät — samma par som kretsfliken använder, och av samma skäl:
 * `circle_messages` måste ligga i publikationen `supabase_realtime` för att
 * kanalen ska säga något, och en databas där den raden inte körts ska bli
 * långsam snarare än trasig.
 *
 * Hör till **circle-rummet** — rummet följer ärendet och inte filträdet,
 * se ROOMS i [constants/appTheme.ts](../constants/appTheme.ts). Skalet nedan
 * är identiskt med de andra rummens: en komponent kan inte läsa sin egen
 * provider, och en bakgrund i skalet täcker varje gren skärmen returnerar.
 */
export default function CircleChatRoom() {
  return (
    <RoomProvider room="circle">
      <View style={roomShell}>
        <ScreenBackground room="circle" />
        <CircleChatScreen />
      </View>
    </RoomProvider>
  );
}

function CircleChatScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const { user } = useAuth();
  const moderation = useModeration();
  const insets = useSafeAreaInsets();

  // Tangentbordets höjd, mätt för hand. På Android gör `adjustResize`
  // ingenting när appen ritas kant till kant (`edgeToEdgeEnabled` i app.json),
  // och KeyboardAvoidingView utan `behavior` lät skrivraden ligga kvar under
  // tangentbordet. iOS sköts av KeyboardAvoidingView som förut; där behövs
  // bara vetskapen om att tangentbordet är uppe, så att hemstrecksinsetet
  // inte lägger en tom remsa mellan skrivraden och tangenterna.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, e => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const keyboardUp = keyboardHeight > 0;

  // Rullningen krymper när tangentbordet kommer upp, och står man längst ner
  // ska de senaste raderna stanna synliga ovanför skrivraden.
  useEffect(() => {
    if (keyboardUp && stickRef.current) {
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    }
  }, [keyboardUp]);
  const params = useLocalSearchParams<{ circleId?: string; name?: string }>();

  const [circleId, setCircleId] = useState<string | null>(params.circleId ?? null);
  const [circleName, setCircleName] = useState<string>(params.name ?? 'Your circle');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Sätts när en bakåtbläddring kom tillbaka med mindre än en hel sida —
  // alltså när samtalets början är nådd. Ett eget tillstånd och inte ett
  // `hasMore` som varje poll räknar om: pollen hämtar alltid den SENASTE
  // sidan, och skulle den få räkna om talet vore svaret "en hel sida, alltså
  // finns det mer" — och knappen kom tillbaka varje gång man nått början.
  const [reachedStart, setReachedStart] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  // Följer botten tills användaren själv scrollar uppåt. `didScrollRef` gör
  // bara första hoppet omedelbart — resten animeras.
  const stickRef = useRef(true);
  const didScrollRef = useRef(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const hasMore = !reachedStart && messages.length >= CHAT_PAGE_SIZE;

  // Kretsen skickas med som parameter från fliken, men skärmen ska kunna
  // öppnas utan den (djuplänk, omstart mitt i navigeringen).
  //
  // Faller uppslaget ut tomt finns ingen krets att prata i, och då måste
  // `loading` släppas här — `refresh()` returnerar tidigt utan `circleId`
  // och hade annars lämnat en snurra som aldrig slutar snurra. Samma fälla
  // som kretsflikens `load()` har sin egen guard för.
  useEffect(() => {
    if (circleId) return;
    let alive = true;
    getMyCircleId().then(id => {
      if (!alive) return;
      if (id) setCircleId(id); else setLoading(false);
    });
    return () => { alive = false; };
  }, [circleId]);

  useEffect(() => {
    if (!circleId || params.name) return;
    supabase.from('circles').select('name').eq('id', circleId).maybeSingle()
      .then(({ data }) => { if (data?.name) setCircleName(data.name); });
  }, [circleId, params.name]);

  /**
   * Hämtar om den senaste sidan och lägger den ovanpå det som redan finns.
   *
   * Sammanfogningen är inte ett rent tillägg: allt lokalt som ligger inom den
   * hämtade sidans tidsfönster kastas och ersätts av svaret. Det är så en
   * radering syns — hade den bara lagt till rader skulle ett borttaget
   * meddelande stå kvar på skärmen tills man lämnade den. Äldre sidor rörs
   * inte, så en radering längre bak syns först nästa gång chatten öppnas.
   */
  const refresh = useCallback(async () => {
    if (!circleId) return;
    const page = await fetchCircleMessages(circleId);
    setMessages(prev => {
      if (page.length === 0) return [];
      const cutoff = page[0].created_at;
      return [...prev.filter(m => m.created_at < cutoff), ...page];
    });
    setLoading(false);
  }, [circleId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!circleId) return;
    const poll = setInterval(refresh, 4000);
    return () => clearInterval(poll);
  }, [circleId, refresh]);

  useEffect(() => {
    if (!circleId || !user) return;
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
    // Nyttolasten används inte — kanalen är bara en signal om att fråga igen,
    // samma mönster som kretsflikens prenumerationer. Det håller RLS och
    // profil-joinen på ett ställe (fetchCircleMessages) i stället för att
    // behöva byggas en gång till ur en rå rad.
    const channel = supabase
      .channel(`circle-chat-${user.id}-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'circle_messages' }, refresh)
      .subscribe();
    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); channelRef.current = null; };
  }, [circleId, user, refresh]);

  // Läsmärket flyttas fram när skärmen öppnas och varje gång ett nytt
  // meddelande landar medan den är öppen — inte vid varje rullning. Att
  // chatten står framme ÄR läsningen.
  const newestId = messages.length > 0 ? messages[messages.length - 1].id : null;

  // Chattnotisen ska inte synas ovanpå chatten den handlar om — se
  // `setChatScreenOpen` i lib/notifications.ts.
  useEffect(() => {
    setChatScreenOpen(circleId);
    return () => setChatScreenOpen(null);
  }, [circleId]);
  useEffect(() => {
    if (!circleId) return;
    markCircleChatRead(circleId);
  }, [circleId, newestId]);

  const handleLoadEarlier = async () => {
    if (!circleId || messages.length === 0 || loadingMore) return;
    stickRef.current = false;
    setLoadingMore(true);
    const older = await fetchCircleMessages(circleId, messages[0].created_at);
    setLoadingMore(false);
    if (older.length < CHAT_PAGE_SIZE) setReachedStart(true);
    if (older.length > 0) setMessages(prev => [...older, ...prev]);
  };

  const handleSend = async () => {
    const body = draft.trim();
    if (!body || sending || !circleId) return;
    setSending(true);
    try {
      await sendCircleMessage(circleId, body);
      setDraft('');
      stickRef.current = true;
      await refresh();
    } catch (e: any) {
      Alert.alert('Could not send', e?.message ?? 'Try again.');
    } finally {
      setSending(false);
    }
  };

  const handleLongPress = (m: ChatMessage) => {
    // Andras meddelanden: bara Report. Blockeringen bor på personen, inte
    // på ett meddelande (components/moderation.tsx).
    if (m.user_id !== user?.id) {
      if (m.user_id) moderation.openContentMenu({ contentType: 'message', contentId: m.id });
      return;
    }
    Alert.alert('Delete message?', m.body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          // Tas bort lokalt direkt: refresh() kommer ändå, men en rad som
          // ligger kvar ett ögonblick efter att man valt "Delete" läser som
          // att raderingen inte gick igenom.
          setMessages(prev => prev.filter(x => x.id !== m.id));
          try { await deleteCircleMessage(m.id); } catch { /* refresh sätter tillbaka den */ }
          refresh();
        },
      },
    ]);
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    stickRef.current = contentSize.height - contentOffset.y - layoutMeasurement.height < STICK_SLOP;
  };

  const onContentSizeChange = () => {
    if (!stickRef.current) return;
    scrollRef.current?.scrollToEnd({ animated: didScrollRef.current });
    didScrollRef.current = true;
  };

  const remaining = MAX_BODY - draft.length;

  return (
    <KeyboardAvoidingView
      style={[
        styles.container,
        // React Native räknar tangentbordets höjd minus navigeringsfältet
        // (ime-insetet minus systemfältens), men kant till kant ritas skärmen
        // ända ner bakom fältet — utan tillägget hamnar skrivraden just så
        // mycket under tangenterna.
        Platform.OS === 'android' && keyboardUp && { paddingBottom: keyboardHeight + insets.bottom },
      ]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + Spacing.md }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7} hitSlop={8}>
          <FontAwesome5 name="arrow-left" size={16} color={Palette.accent} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{circleName}</Text>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={Palette.accent} size="large" />
        </View>
      ) : !circleId ? (
        // Ingen krets att prata i. Kan bara nås genom att skärmen öppnats
        // utanför fliken — eller genom att man lämnat kretsen i ett annat
        // fönster medan chatten stod öppen.
        <View style={styles.centered}>
          <Text style={styles.emptyText}>You are not in a circle.</Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={32}
          onContentSizeChange={onContentSizeChange}
          keyboardDismissMode="interactive"
        >
          {hasMore && (
            <Pressable onPress={handleLoadEarlier} style={styles.earlierBtn} disabled={loadingMore}>
              <Text style={styles.earlierText}>{loadingMore ? 'Loading…' : 'Load earlier'}</Text>
            </Pressable>
          )}

          {messages.length === 0 && (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <FontAwesome5 name="comments" size={24} color={Palette.accent} />
              </View>
              <Text style={styles.emptyTitle}>Nothing said yet</Text>
              <Text style={styles.emptyText}>
                Be the first. Ask how someone's week is going.
              </Text>
            </View>
          )}

          {messages.map((m, i) => {
            const prev = i > 0 ? messages[i - 1] : null;
            const mine = !!user && m.user_id === user.id;
            const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
            const grouped =
              !newDay && !!prev && prev.user_id === m.user_id &&
              new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_WINDOW_MS;

            return (
              <View key={m.id}>
                {newDay && (
                  <View style={styles.daySep}>
                    <Text style={styles.dayLabel}>{dayLabel(m.created_at)}</Text>
                  </View>
                )}
                <View style={[styles.row, mine && styles.rowMine, grouped && styles.rowGrouped]}>
                  {/* Platshållaren håller de grupperade raderna i linje med
                      den första i klumpen — utan den vandrar texten i sidled
                      mellan meddelande ett och två från samma person. */}
                  {!mine && (grouped
                    ? <View style={styles.avatarSpacer} />
                    : <Avatar username={m.authorName} avatarUrl={m.authorAvatar} />)}

                  {/* Klockslaget står utanför bubblan, till vänster om den
                      och i grått. Inne i bubblan delade det utrymme med
                      texten och tvingade fram en luftrad under varje kort
                      meddelande; här är det en egen kolumn som varken
                      trycker ihop orden eller byter färg med underlaget.
                      Raden ligger i `flex-end`, så siffran står i linje med
                      bubblans nederkant oavsett hur många rader den har. */}
                  <Text style={styles.time}>{clockTime(m.created_at)}</Text>

                  <Pressable
                    onLongPress={() => handleLongPress(m)}
                    delayLongPress={350}
                    style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}
                  >
                    {!mine && !grouped && <Text style={styles.author}>{m.authorName}</Text>}
                    <Text style={[styles.body, mine && styles.bodyMine]}>{m.body}</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      {!!circleId && (
      <View style={[styles.composer, { paddingBottom: (keyboardUp ? 0 : insets.bottom) + Spacing.md }]}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={t => setDraft(t.slice(0, MAX_BODY))}
          placeholder="Say something…"
          placeholderTextColor={Palette.textTertiary}
          multiline
          maxLength={MAX_BODY}
        />
        {/* Räknaren visas först när den betyder något. Ett tal som alltid står
            där gör varje meddelande till ett prov. */}
        {remaining < 60 && <Text style={styles.charCount}>{remaining}</Text>}
        <TouchableOpacity
          style={[styles.sendBtn, (!draft.trim() || sending) && styles.sendBtnOff]}
          onPress={handleSend}
          disabled={!draft.trim() || sending}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Send message"
        >
          <FontAwesome5
            name="paper-plane"
            size={14}
            color={!draft.trim() || sending ? Palette.textDisabled : Palette.onAccent}
          />
        </TouchableOpacity>
      </View>
      )}
      {moderation.element}
    </KeyboardAvoidingView>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Palette.divider,
  },
  backBtn: { paddingVertical: 6, paddingRight: 4 },
  title: { flex: 1, fontSize: 18, fontWeight: '900', color: Palette.textPrimary, letterSpacing: 0.3 },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.lg },

  earlierBtn: { alignSelf: 'center', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg, marginBottom: Spacing.sm },
  earlierText: { fontSize: 12, lineHeight: 15, fontWeight: '700', color: Palette.accent, letterSpacing: 0.6, textTransform: 'uppercase' },

  daySep: { alignItems: 'center', paddingVertical: Spacing.lg },
  dayLabel: { fontSize: 11, lineHeight: 14, fontWeight: '700', color: Palette.textTertiary, letterSpacing: 1.2 },

  row: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm, marginTop: Spacing.md },
  rowMine: { justifyContent: 'flex-end' },
  rowGrouped: { marginTop: 2 },
  avatarSpacer: { width: 28 },

  // 70 och inte 78: klockslaget till vänster och avataren till höger om det
  // tar sin bredd ur samma rad, och på en smal skärm hade en bubbla på 78 %
  // tryckt ut dem båda.
  bubble: { maxWidth: '70%', paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 2, borderRadius: Radius.md },
  bubbleTheirs: { backgroundColor: Palette.surface, borderBottomLeftRadius: 4 },
  // Fylld accent, alltså `onAccent` på texten och inte `textPrimary` — ytan
  // under byter aldrig ton, så en vit som vänder med läget hade blivit
  // osynlig i det ljusa.
  bubbleMine: { backgroundColor: Palette.accent, borderBottomRightRadius: 4 },

  author: { fontSize: 12, lineHeight: 15, fontWeight: '700', color: Palette.accentSoft, marginBottom: 2 },
  body: { fontSize: 15, lineHeight: 21, color: Palette.textPrimary },
  bodyMine: { color: Palette.onAccent },
  // En färg, inte två: siffran ligger mot skärmens botten i båda riktningarna
  // nu när den står utanför bubblan, så `onAccent` hör inte hit längre.
  // `paddingBottom` lyfter den i linje med bubblans sista textrad i stället
  // för med dess underkant.
  time: { fontSize: 11, lineHeight: 14, color: Palette.textTertiary, paddingBottom: Spacing.sm },

  empty: { alignItems: 'center', paddingTop: 64, paddingHorizontal: Spacing.lg, gap: Spacing.md },
  emptyIcon: {
    width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Palette.accentTint,
  },
  emptyTitle: { fontSize: 20, fontWeight: '900', color: Palette.textPrimary, letterSpacing: 0.3 },
  emptyText: { fontSize: 14, lineHeight: 20, color: Palette.textSecondary, textAlign: 'center' },

  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm,
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.md,
    borderTopWidth: 1, borderTopColor: Palette.divider,
    backgroundColor: Palette.bg,
  },
  input: {
    flex: 1, maxHeight: 120,
    backgroundColor: Palette.surface, borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Palette.surfaceBorder,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm + 2, paddingBottom: Spacing.sm + 2,
    fontSize: 15, lineHeight: 21, color: Palette.textPrimary,
  },
  charCount: { fontSize: 11, lineHeight: 14, color: Palette.textTertiary, paddingBottom: 14 },
  sendBtn: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center', backgroundColor: Palette.accent,
  },
  sendBtnOff: { backgroundColor: Palette.ink08 },

  avatarFallback: { backgroundColor: Palette.accentTint, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: Palette.accent, fontWeight: '900' },
});
