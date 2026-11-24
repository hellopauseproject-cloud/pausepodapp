import { FontAwesome5 } from '@expo/vector-icons';
import { router } from 'expo-router';
import DismissKeyboardView from './components/DismissKeyboardView';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { track } from '../lib/analytics';
import { enablePushNotifications } from '../lib/notifications';
import { supabase } from '../lib/supabase';
import type { Profile } from '../types/database';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { MoreButton, useModeration } from '../components/moderation';

/*
  Sökningen går via RPC:n `search_profiles`, som ligger i
  supabase/profiles_search.sql och körs för hand i Supabase SQL-editorn.

  Den versionen som stod här förut krävde två tecken och sökte som substräng,
  vilket gjorde hela användarregistret bläddringsbart med ett par hundra
  anrop. Regeln nu är tre tecken rätt — eller hela namnet, för den vars namn
  är kortare än så. Skälet, varför det är substräng och inte prefix, och vad
  som gick förlorat när talet sänktes från fem till tre, står i SQL-filen.
*/

type SearchResult = Pick<Profile, 'id' | 'username' | 'avatar_url'>;

/**
 * Hur många tecken som krävs innan sökningen ens skickas.
 *
 * Två är vad som gällde förut, och två tecken i en substrängsökning är ingen
 * sökning utan en bläddring genom registret. Tre är regeln nu, och den gäller
 * på riktigt i `search_profiles` — det här talet finns bara för att slippa
 * anrop som ändå inte kan ge något.
 *
 * Det fanns ett andra tal här (`FULL_QUERY = 5`) när databasen krävde fem
 * tecken för en bred sökning men klienten skickade från tre. Glappet mellan
 * dem var ett läge där skärmen varken hade letat eller kunde säga att den
 * inte hade det, och raden "Type at least 5 letters…" fanns bara för att
 * förklara just det läget. Samma tal på båda ställena betyder att varje
 * sökning som skickas är en riktig sökning, och att "No one found" alltid är
 * sant när den står där. Skiljer de sig åt igen måste den raden tillbaka.
 */
const MIN_QUERY = 3;

function Avatar({ username, avatarUrl, size = 42 }: { username: string; avatarUrl?: string | null; size?: number }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  if (avatarUrl) {
    return (
      <Image
        source={{ uri: avatarUrl }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
      />
    );
  }
  return (
    <View style={[styles.avatarFallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarLetter, { fontSize: size * 0.38 }]}>
        {username[0]?.toUpperCase() ?? '?'}
      </Text>
    </View>
  );
}

/**
 * Hör till **friends-rummet**. Rummet följer ärendet och inte filträdet — se
 * ROOMS i [constants/appTheme.ts](../constants/appTheme.ts). Skalet är
 * identiskt med de andra rummens: en komponent kan inte läsa sin egen
 * provider, och en bakgrund i skalet täcker varje gren skärmen returnerar.
 */
export default function AddFriendRoom() {
  return (
    <RoomProvider room="friends">
      <View style={roomShell}>
        <ScreenBackground room="friends" />
        <AddFriendScreen />
      </View>
    </RoomProvider>
  );
}

function AddFriendScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());
  const [existingRelationIds, setExistingRelationIds] = useState<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // En blockerad försvinner ur träffarna direkt; nästa sökning hittar hen
  // inte heller, för search_profiles filtrerar på blockeringen.
  const moderation = useModeration({
    onBlocked: u => setResults(prev => prev.filter(p => p.id !== u.id)),
  });

  // Ladda befintliga relationer för filtrering
  useEffect(() => {
    if (!user) return;
    supabase
      .from('friendships')
      .select('requester_id, receiver_id')
      .or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`)
      .then(({ data }) => {
        const ids = new Set<string>();
        for (const rel of data ?? []) {
          ids.add(rel.requester_id);
          ids.add(rel.receiver_id);
        }
        ids.delete(user.id); // ta inte bort sig själv här, hanteras separat
        setExistingRelationIds(ids);
      });
  }, [user]);

  const search = useCallback(
    async (text: string) => {
      if (!user || text.trim().length < MIN_QUERY) {
        setResults([]);
        return;
      }
      setSearching(true);
      // Via RPC, inte mot tabellen. Regeln om fem tecken bor i databasen —
      // en spärr som bara finns i klienten är ingen spärr, den är en
      // inställning vem som helst kan runda med ett eget anrop.
      const { data, error } = await supabase.rpc('search_profiles', {
        search_query: text.trim(),
      });
      setSearching(false);

      const filtered = (data ?? []).filter(
        (p: SearchResult) => !existingRelationIds.has(p.id)
      );
      setResults(filtered);
    },
    [user, existingRelationIds]
  );

  const handleChangeText = (text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(text), 350);
  };

  const sendRequest = async (targetId: string) => {
    if (!user) return;
    setSentIds(prev => new Set(prev).add(targetId));
    await supabase.from('friendships').insert({
      requester_id: user.id,
      receiver_id: targetId,
      status: 'pending',
    });
    track('friend_request_sent');
    // En vän är någon vars stödförfrågningar kan knacka — se
    // `enablePushNotifications`.
    enablePushNotifications().catch(() => {});
    // Lägg till i existing så resultatet filtreras bort vid ny sökning
    setExistingRelationIds(prev => new Set(prev).add(targetId));
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <DismissKeyboardView style={[styles.container, { paddingTop: Math.max(70, insets.top + 8) }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <FontAwesome5 name="arrow-left" size={16} color={Palette.accent} />
        </TouchableOpacity>
        <Text style={styles.title}>Add friend.</Text>
        <Text style={styles.subtitle}>You need to know their username.</Text>
      </View>

      {/* Search field */}
      <View style={styles.searchRow}>
        <FontAwesome5 name="search" size={14} color={Palette.textTertiary} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search username..."
          placeholderTextColor={Palette.textTertiary}
          value={query}
          onChangeText={handleChangeText}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="search"
        />
        {searching && (
          <ActivityIndicator size="small" color={Palette.accent} style={{ marginRight: 12 }} />
        )}
      </View>

      {/* Resultat */}
      <View style={styles.results}>
        {/* Ett tomt läge, inte två. Så länge klientens tröskel och databasens
            regel är samma tal har varje sökning som skickats verkligen letat,
            och då är det här svaret sant. */}
        {query.trim().length >= MIN_QUERY && !searching && results.length === 0 && (
          <Text style={styles.noResults}>No one found with that username.</Text>
        )}

        {results.map(profile => {
          const sent = sentIds.has(profile.id);
          return (
            <View key={profile.id} style={styles.resultRow}>
              <Avatar username={profile.username} avatarUrl={profile.avatar_url} />
              <Text style={styles.resultUsername}>{profile.username}</Text>
              <TouchableOpacity
                style={[styles.sendBtn, sent && styles.sendBtnSent]}
                onPress={() => !sent && sendRequest(profile.id)}
                disabled={sent}
                activeOpacity={0.8}
              >
                <Text style={[styles.sendBtnText, sent && styles.sendBtnTextSent]}>
                  {sent ? 'Sent' : 'Add'}
                </Text>
              </TouchableOpacity>
              <MoreButton
                username={profile.username}
                onPress={() => moderation.openUserMenu({ id: profile.id, username: profile.username })}
              />
            </View>
          );
        })}
      </View>
      </DismissKeyboardView>
      {moderation.element}
    </KeyboardAvoidingView>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
    paddingHorizontal: Spacing.xl,
    paddingTop: 70,
  },

  // Header
  header: {
    gap: 8,
    marginBottom: 28,
  },
  backBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  title: {
    fontSize: 36,
    fontWeight: '800',
    color: Palette.textPrimary,
    letterSpacing: 0.2,
    lineHeight: 44,
  },
  subtitle: {
    fontSize: 15,
    color: Palette.textSecondary,
    letterSpacing: 0.2,
  },

  // Search
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Palette.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
    marginBottom: 20,
  },
  searchIcon: {
    paddingLeft: 16,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 15,
    paddingHorizontal: 12,
    fontSize: 16,
    color: Palette.textPrimary,
  },

  // Results
  results: {
    gap: 8,
  },
  noResults: {
    color: Palette.textTertiary,
    fontSize: 14,
    textAlign: 'center',
    paddingTop: 24,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingLeft: 16,
    // ⋯ är 44 bred med ikonen i mitten, och får stå närmare kanten.
    paddingRight: 4,
    backgroundColor: Palette.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
  },
  resultUsername: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: Palette.textPrimary,
    letterSpacing: 0.2,
  },
  sendBtn: {
    backgroundColor: Palette.accent,
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: Radius.pill,
  },
  sendBtnSent: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
  },
  sendBtnText: {
    color: Palette.onAccent,
    fontSize: 14,
    fontWeight: '600',
  },
  sendBtnTextSent: {
    color: Palette.textTertiary,
  },

  // Avatar
  avatarFallback: {
    backgroundColor: Palette.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
  },
  avatarLetter: {
    color: Palette.textSecondary,
    fontWeight: '700',
  },
});
