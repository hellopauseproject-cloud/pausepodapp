import { FontAwesome5 } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { SegmentedPill } from '../components/segmented-pill';
import { KIND_ICON, KIND_LABEL, SupportKind } from '../components/support-envelope';
import { AppPalette, Spacing } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { supabase } from '../lib/supabase';
import { signSupportMediaUrls } from '../lib/supportMedia';
import { OpenableSupport, openSupportResponse } from '../lib/supportOpen';
import {
  fetchSentSupport, recentSupportQuery, SentSupport, SUPPORT_HISTORY_MS,
} from '../lib/supportStories';

type Received = OpenableSupport & { deliveredAt: string; thankedAt: string | null };
type Tab = 'received' | 'sent';

/**
 * Hör till **friends-rummet**, se ROOMS i constants/appTheme.ts.
 *
 * Stödet de senaste 24 timmarna, i två flikar (november 2026, på begäran):
 *
 * - **Received** — det man öppnat, och det går att se igen. Fönstret räknas
 *   från första öppningen. Ett hjärta på raden: man har skickat ett tillbaka.
 * - **Sent** — det man skickat, räknat från när det skickades, med om det
 *   öppnats och om mottagaren skickat ett hjärta tillbaka. Raderna går inte
 *   att öppna: visningsskärmarna markerar svaret som öppnat, och det får
 *   bara mottagaren göra.
 *
 * Förr fanns ingen historik alls, med flit — ett svar syntes en gång. Fönstret
 * är kompromissen: man kan gå tillbaka till det som hänt i dag, men det blir
 * inte ett arkiv. Inget raderas; det filtreras bort vid läsning. Ingången är
 * klockan i Support-flikens rubrikrad, som bara syns när det finns något här.
 */
export default function SupportHistoryRoom() {
  return (
    <RoomProvider room="friends">
      <View style={roomShell}>
        <ScreenBackground room="friends" />
        <SupportHistoryScreen />
      </View>
    </RoomProvider>
  );
}

function timeLeft(fromIso: string, now = Date.now()) {
  const min = Math.floor((new Date(fromIso).getTime() + SUPPORT_HISTORY_MS - now) / 60000);
  if (min >= 60) return `${Math.floor(min / 60)}h left`;
  if (min >= 1) return `${min} min left`;
  return 'Ending now';
}

function sentStatus(s: SentSupport, firstName: string): string {
  if (s.thankedAt) return `${firstName} sent you a heart`;
  if (s.deliveredAt) return 'Opened';
  if (s.sealed) return 'Opens after a pause';
  return 'Not opened yet';
}

function SupportHistoryScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { user } = useAuth();
  const [received, setReceived] = useState<Received[] | null>(null);
  const [sent, setSent] = useState<SentSupport[] | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);

  // Vid varje fokus: man kommer tillbaka hit från en visningsskärm, och ett
  // svar kan ha hunnit passera sina 24 timmar under tiden.
  useFocusEffect(useCallback(() => {
    if (!user?.id) return;
    let alive = true;
    (async () => {
      const [{ data, error }, sentList] = await Promise.all([
        recentSupportQuery(
          user.id,
          'id, story_id, response_type, content_url, text_content, caption_y, sender_id, delivered_at, thanked_at',
        ).order('delivered_at', { ascending: false }),
        fetchSentSupport(),
      ]);
      if (!alive) return;
      const rows = error || !data ? [] : data;
      const senderIds = [...new Set(rows.map(r => r.sender_id))];
      const [{ data: senders }, signed] = await Promise.all([
        senderIds.length
          ? supabase.from('profiles').select('id, username, avatar_url').in('id', senderIds)
          : Promise.resolve({ data: [] as { id: string; username: string; avatar_url: string | null }[] }),
        signSupportMediaUrls(rows.map(r => r.content_url)),
      ]);
      if (!alive) return;
      const byId = new Map((senders ?? []).map(s => [s.id, s]));
      const receivedList: Received[] = rows.map(r => ({
        id: r.id,
        storyId: r.story_id,
        kind: r.response_type as SupportKind,
        contentUrl: r.content_url ? signed.get(r.content_url) ?? r.content_url : null,
        textContent: r.text_content,
        captionY: r.caption_y,
        senderName: byId.get(r.sender_id)?.username ?? 'A friend',
        senderAvatarUrl: byId.get(r.sender_id)?.avatar_url ?? null,
        deliveredAt: r.delivered_at as string,
        thankedAt: r.thanked_at ?? null,
      }));
      setReceived(receivedList);
      setSent(sentList);
      // Första gången: den flik som har något i sig, med Received före.
      setTab(prev => prev ?? (receivedList.length === 0 && sentList.length > 0 ? 'sent' : 'received'));
    })();
    return () => { alive = false; };
  }, [user?.id]));

  const loading = received === null || sent === null || tab === null;

  const avatar = (name: string, url: string | null) => url
    ? <Image source={{ uri: url }} style={styles.avatar} />
    : (
      <View style={[styles.avatar, styles.avatarFallback]}>
        <Text style={styles.avatarLetter}>{name[0]?.toUpperCase() ?? '?'}</Text>
      </View>
    );

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <TouchableOpacity
        style={styles.backBtn}
        onPress={() => router.back()}
        activeOpacity={0.7}
        accessibilityLabel="Back"
      >
        <FontAwesome5 name="arrow-left" size={16} color={Palette.hue} />
      </TouchableOpacity>
      <Text style={styles.title}>Recent support</Text>
      <Text style={styles.sub}>The last 24 hours.</Text>

      <View style={styles.pillWrap}>
        <SegmentedPill<Tab>
          options={[{ key: 'received', label: 'Received' }, { key: 'sent', label: 'Sent' }]}
          value={tab ?? 'received'}
          onChange={setTab}
          width={Math.min(width - Spacing.xl * 2, 320)}
        />
      </View>

      {loading ? (
        <ActivityIndicator color={Palette.hue} style={{ marginTop: Spacing.xxl }} />
      ) : tab === 'received' ? (
        received!.length === 0 ? (
          <Text style={styles.empty}>Nothing opened in the last 24 hours.</Text>
        ) : (
          <FlatList
            data={received!}
            keyExtractor={r => r.id}
            contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
            renderItem={({ item }) => {
              const firstName = item.senderName.split(' ')[0];
              return (
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => openSupportResponse(item, 'push')}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel={`${KIND_LABEL[item.kind]} from ${firstName}.${item.thankedAt ? ' You sent a heart back.' : ''} ${timeLeft(item.deliveredAt)}.`}
                >
                  {avatar(firstName, item.senderAvatarUrl)}
                  <View style={styles.rowText}>
                    <Text style={styles.name} numberOfLines={1}>{firstName}</Text>
                    <View style={styles.kindRow}>
                      <FontAwesome5 name={KIND_ICON[item.kind]} size={11} color={Palette.community} />
                      <Text style={styles.kind} numberOfLines={1}>{KIND_LABEL[item.kind]}</Text>
                    </View>
                  </View>
                  {item.thankedAt && (
                    <FontAwesome5 name="heart" solid size={14} color={Palette.dangerSoft} />
                  )}
                  <Text style={styles.left}>{timeLeft(item.deliveredAt)}</Text>
                  <FontAwesome5 name="chevron-right" size={13} color={Palette.hue} />
                </TouchableOpacity>
              );
            }}
          />
        )
      ) : sent!.length === 0 ? (
        <Text style={styles.empty}>Nothing sent in the last 24 hours.</Text>
      ) : (
        <FlatList
          data={sent!}
          keyExtractor={r => r.id}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          renderItem={({ item }) => {
            const firstName = item.recipientName.split(' ')[0];
            const status = sentStatus(item, firstName);
            return (
              <View
                style={styles.row}
                accessible
                accessibilityLabel={`${KIND_LABEL[item.kind]} to ${firstName}. ${status}. ${timeLeft(item.createdAt)}.`}
              >
                <View>
                  {avatar(firstName, item.recipientAvatarUrl)}
                  {item.thankedAt && (
                    <View style={styles.heartBadge}>
                      <FontAwesome5 name="heart" solid size={9} color={Palette.onAccent} />
                    </View>
                  )}
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>To {firstName}</Text>
                  <View style={styles.kindRow}>
                    <FontAwesome5 name={KIND_ICON[item.kind]} size={11} color={Palette.community} />
                    <Text
                      style={[styles.kind, item.thankedAt && { color: Palette.dangerSoft, fontWeight: '600' }]}
                      numberOfLines={1}
                    >
                      {status}
                    </Text>
                  </View>
                </View>
                <Text style={styles.left}>{timeLeft(item.createdAt)}</Text>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent', paddingHorizontal: Spacing.xl },
  backBtn: { alignSelf: 'flex-start', paddingVertical: 12, paddingRight: 12, marginBottom: 4 },
  title: {
    fontSize: 28, lineHeight: 32, fontWeight: '900', letterSpacing: -0.6,
    color: Palette.textPrimary, textTransform: 'uppercase',
  },
  sub: { fontSize: 14, color: Palette.textSecondary, marginTop: 6 },
  pillWrap: { alignItems: 'center', marginTop: Spacing.lg, marginBottom: Spacing.md },
  empty: { fontSize: 15, color: Palette.textTertiary, marginTop: Spacing.lg, textAlign: 'center' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: Palette.ink12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  rowText: { flex: 1, gap: 2 },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: { backgroundColor: Palette.hueTint, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: Palette.hue, fontSize: 17, fontWeight: '700' },
  // Samma lilla hjärta som på förfrågans cirkel i Support-fliken.
  heartBadge: {
    position: 'absolute', right: -3, bottom: -3,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: Palette.dangerSoft,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: Palette.bg,
  },
  name: { fontSize: 16, fontWeight: '700', color: Palette.textPrimary },
  kindRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kind: { fontSize: 13, color: Palette.textSecondary, flexShrink: 1 },
  left: { fontSize: 12, color: Palette.textTertiary, marginRight: 4 },
});
