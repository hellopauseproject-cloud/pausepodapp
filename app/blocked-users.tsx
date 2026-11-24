import { FontAwesome } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { BlockedUser, fetchBlockedUsers, unblockUser } from '../lib/moderation';

/**
 * De man blockerat, med *Unblock* bredvid var och en. Nås från *Blocked
 * users ›* i profilen (app/profile.tsx).
 *
 * Unblock lägger inte tillbaka vänskapen — den revs när blockeringen
 * skrevs (supabase/moderation.sql) — och skärmen säger det, så att ingen
 * väntar på en vän som inte kommer tillbaka av sig själv.
 *
 * Hör till **study-rummet**, som profilen den nås från.
 */
export default function BlockedUsersRoom() {
  return (
    <RoomProvider room="study">
      <View style={roomShell}>
        <ScreenBackground room="study" />
        <BlockedUsersScreen />
      </View>
    </RoomProvider>
  );
}

function BlockedUsersScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [list, setList] = useState<BlockedUser[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user?.id) return;
    try {
      setList(await fetchBlockedUsers(user.id));
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'Could not load the list.');
      setList(prev => prev ?? []);
    }
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  const unblock = async (b: BlockedUser) => {
    if (!user?.id) return;
    setBusyId(b.id);
    try {
      await unblockUser(user.id, b.id);
      setList(prev => prev?.filter(x => x.id !== b.id) ?? prev);
    } catch (e: any) {
      Alert.alert('Could not unblock', e?.message ?? 'Try again.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={[styles.container, { paddingTop: Math.max(40, insets.top + 8) }]}>
      <TouchableOpacity style={styles.backButton} onPress={() => router.back()} accessibilityRole="button">
        <FontAwesome name="chevron-left" size={16} color={Palette.accent} />
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Blocked users</Text>
      <Text style={styles.subtitle}>
        {"Unblocking doesn't make you friends again. You can send a new friend request."}
      </Text>

      {list === null ? (
        <ActivityIndicator color={Palette.accent} style={{ marginTop: Spacing.xl }} />
      ) : list.length === 0 ? (
        <Text style={styles.empty}>{error || "You haven't blocked anyone."}</Text>
      ) : (
        <View style={styles.list}>
          {list.map((b, i) => (
            <View key={b.id} style={[styles.row, i > 0 && styles.rowLine]}>
              {b.avatarUrl ? (
                <Image source={{ uri: b.avatarUrl }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Text style={styles.avatarLetter}>{b.username[0]?.toUpperCase() ?? '?'}</Text>
                </View>
              )}
              <Text style={styles.name} numberOfLines={1}>{b.username}</Text>
              <TouchableOpacity
                style={styles.unblockBtn}
                onPress={() => unblock(b)}
                disabled={busyId === b.id}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={`Unblock ${b.username}`}
              >
                {busyId === b.id
                  ? <ActivityIndicator size="small" color={Palette.textSecondary} />
                  : <Text style={styles.unblockText}>Unblock</Text>}
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: 'transparent',
    padding: Spacing.xl,
    paddingBottom: 60,
  },
  backButton: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    alignSelf: 'flex-start', paddingVertical: 10, paddingRight: 16, marginBottom: 16,
  },
  backText: { color: Palette.accent, fontSize: 16 },
  title: { fontSize: 32, fontWeight: '800', color: Palette.textPrimary, letterSpacing: 0.2 },
  subtitle: { fontSize: 14, color: Palette.textSecondary, lineHeight: 20, marginTop: Spacing.sm, marginBottom: Spacing.xl },
  empty: { fontSize: 15, color: Palette.textTertiary, textAlign: 'center', marginTop: Spacing.xl },
  list: { backgroundColor: Palette.surface, borderRadius: Radius.lg, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.lg, minHeight: 64 },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Palette.ink12 },
  avatar: { width: 38, height: 38, borderRadius: 19 },
  avatarFallback: { backgroundColor: Palette.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: Palette.textSecondary, fontWeight: '700', fontSize: 15 },
  name: { flex: 1, fontSize: 15, fontWeight: '600', color: Palette.textPrimary },
  unblockBtn: {
    minHeight: 36, minWidth: 92, paddingHorizontal: Spacing.lg, borderRadius: Radius.pill,
    borderWidth: 1, borderColor: Palette.ink25, alignItems: 'center', justifyContent: 'center',
  },
  unblockText: { fontSize: 14, fontWeight: '600', color: Palette.textPrimary },
});
