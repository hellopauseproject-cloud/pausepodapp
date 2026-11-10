import { FontAwesome5 } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { KIND_ICON, KIND_LABEL, SupportKind } from '../components/support-envelope';
import { AppPalette, Spacing } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { supabase } from '../lib/supabase';
import { OpenableSupport, openSupportResponse } from '../lib/supportOpen';
import { recentSupportQuery, SUPPORT_HISTORY_MS } from '../lib/supportStories';

type Row = OpenableSupport & { deliveredAt: string };

/**
 * Hör till **friends-rummet**, se ROOMS i constants/appTheme.ts.
 *
 * Stöd man öppnat de senaste 24 timmarna, så att det går att se igen
 * (november 2026, på begäran). Förr fanns ingen historik alls, med flit — ett
 * svar syntes en gång. Fönstret är en kompromiss mellan de två: man kan gå
 * tillbaka till det man fick i dag, men det blir inte ett arkiv.
 *
 * Inget raderas: ett svar äldre än 24 timmar räknat från första öppningen
 * filtreras bort vid läsning (`recentSupportQuery`). Ingången är klockan i
 * Support-flikens rubrikrad, som bara syns när det finns något här.
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

function timeLeft(deliveredAt: string, now = Date.now()) {
  const min = Math.floor((new Date(deliveredAt).getTime() + SUPPORT_HISTORY_MS - now) / 60000);
  if (min >= 60) return `${Math.floor(min / 60)}h left`;
  if (min >= 1) return `${min} min left`;
  return 'Ending now';
}

function SupportHistoryScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);

  // Vid varje fokus: man kommer tillbaka hit från en visningsskärm, och ett
  // svar kan ha hunnit passera sina 24 timmar under tiden.
  useFocusEffect(useCallback(() => {
    if (!user?.id) return;
    let alive = true;
    (async () => {
      const { data, error } = await recentSupportQuery(
        user.id,
        'id, story_id, response_type, content_url, text_content, caption_y, sender_id, delivered_at',
      ).order('delivered_at', { ascending: false });
      if (!alive) return;
      if (error || !data) { setRows([]); return; }
      const senderIds = [...new Set(data.map(r => r.sender_id))];
      const { data: senders } = senderIds.length
        ? await supabase.from('profiles').select('id, username, avatar_url').in('id', senderIds)
        : { data: [] as { id: string; username: string; avatar_url: string | null }[] };
      if (!alive) return;
      const byId = new Map((senders ?? []).map(s => [s.id, s]));
      setRows(data.map(r => ({
        id: r.id,
        storyId: r.story_id,
        kind: r.response_type as SupportKind,
        contentUrl: r.content_url,
        textContent: r.text_content,
        captionY: r.caption_y,
        senderName: byId.get(r.sender_id)?.username ?? 'A friend',
        senderAvatarUrl: byId.get(r.sender_id)?.avatar_url ?? null,
        deliveredAt: r.delivered_at as string,
      })));
    })();
    return () => { alive = false; };
  }, [user?.id]));

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
      <Text style={styles.sub}>Stays here for 24 hours after you open it.</Text>

      {rows === null ? (
        <ActivityIndicator color={Palette.hue} style={{ marginTop: Spacing.xxl }} />
      ) : rows.length === 0 ? (
        <Text style={styles.empty}>Nothing from the last 24 hours.</Text>
      ) : (
        <FlatList
          data={rows}
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
                accessibilityLabel={`${KIND_LABEL[item.kind]} from ${firstName}. ${timeLeft(item.deliveredAt)}.`}
              >
                {item.senderAvatarUrl ? (
                  <Image source={{ uri: item.senderAvatarUrl }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarLetter}>{firstName[0]?.toUpperCase() ?? '?'}</Text>
                  </View>
                )}
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name} numberOfLines={1}>{firstName}</Text>
                  <View style={styles.kindRow}>
                    <FontAwesome5 name={KIND_ICON[item.kind]} size={11} color={Palette.community} />
                    <Text style={styles.kind} numberOfLines={1}>{KIND_LABEL[item.kind]}</Text>
                  </View>
                </View>
                <Text style={styles.left}>{timeLeft(item.deliveredAt)}</Text>
                <FontAwesome5 name="chevron-right" size={13} color={Palette.hue} />
              </TouchableOpacity>
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
  sub: { fontSize: 14, color: Palette.textSecondary, marginTop: 6, marginBottom: Spacing.xl },
  empty: { fontSize: 15, color: Palette.textTertiary, marginTop: Spacing.lg },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: Palette.ink12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: { backgroundColor: Palette.hueTint, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: Palette.hue, fontSize: 17, fontWeight: '700' },
  name: { fontSize: 16, fontWeight: '700', color: Palette.textPrimary },
  kindRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kind: { fontSize: 13, color: Palette.textSecondary },
  left: { fontSize: 12, color: Palette.textTertiary, marginRight: 4 },
});
