import { FontAwesome5 } from '@expo/vector-icons';
import { useAudioPlayer } from 'expo-audio';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { track } from '../lib/analytics';
import { setPendingPauseTag } from '../lib/pauseTags';
import { GlobalPauseResult, takeGlobalPauseResult } from '../lib/globalPause';
import { GlobalPauseSummary } from '../components/global-pause-summary';
import { getSharedPausePeople, SharedPausePerson } from '../lib/pauseInvites';
import { removeCheers, sendCheers } from '../lib/pauseCheers';
import { getSelectedCategories } from './pauseLogger';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../components/screen-background';

// Hur ofta listan över de andra hämtas om medan någon fortfarande pausar.
const PEOPLE_REFRESH_MS = 15_000;

/** "Anna", "Anna and Steve", "Anna, Steve and Bo". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function PersonFace({ username, avatarUrl, styles }: {
  username: string; avatarUrl: string | null; styles: ReturnType<typeof makeStyles>;
}) {
  if (avatarUrl?.startsWith('https://')) {
    return <Image source={{ uri: avatarUrl }} style={styles.personFace} />;
  }
  return (
    <View style={[styles.personFace, styles.personFaceFallback]}>
      <Text style={styles.personFaceLetter}>{username[0]?.toUpperCase() ?? '?'}</Text>
    </View>
  );
}

/**
 * Hör till **pause-rummet**. Rummet följer ärendet och inte filträdet — se
 * ROOMS i [constants/appTheme.ts](../constants/appTheme.ts). Skalet är
 * identiskt med de andra rummens: en komponent kan inte läsa sin egen
 * provider, och en bakgrund i skalet täcker varje gren skärmen returnerar.
 */
export default function PauseSummaryRoom() {
  const { duration, category, sharedSessionId } = useLocalSearchParams<{
    duration: string; category: string; sharedSessionId: string;
  }>();
  const bell = useAudioPlayer(require('../assets/images/Bell.mp3'));
  // En paus i en Global Pause får sin egen sammanfattning, i rummets stil
  // (components/global-pause-summary.tsx). `undefined` = inte frågat än, och
  // då ritas bara botten. En delad paus frågar inte: den har sina personer.
  const [global, setGlobal] = useState<GlobalPauseResult | null | undefined>(sharedSessionId ? null : undefined);
  useEffect(() => {
    if (sharedSessionId) return;
    takeGlobalPauseResult().then(setGlobal);
  }, [sharedSessionId]);

  if (global) {
    return (
      <RoomProvider room="night">
        <View style={roomShell}>
          <ScreenBackground room="night" />
          <GlobalPauseSummary
            result={global}
            seconds={parseInt(duration ?? '0')}
            hasIntention={!!category}
            bell={bell}
          />
        </View>
      </RoomProvider>
    );
  }
  return (
    <RoomProvider room="pause">
      <View style={roomShell}>
        <ScreenBackground room="pause" />
        {global === null && <PauseSummaryScreen />}
      </View>
    </RoomProvider>
  );
}

function PauseSummaryScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const { user } = useAuth();
  const { duration, category, sharedSessionId, withPod } = useLocalSearchParams<{
    duration: string;
    category: string;
    sharedWithName: string;
    sharedSessionId: string;
    withPod: string;
  }>();
  // Bara en ensam lådpaus kan bli en natt i efterhand (lib/pauseTags.ts).
  const sleepable = withPod === '1' && !sharedSessionId;

  const seconds = parseInt(duration ?? '0');
  const bellPlayer = useAudioPlayer(require('../assets/images/Bell.mp3'));

  // **En ensam paus slutar på Hem**, inte här: strecken stiger med det man
  // vann tillbaka och frågan glider upp där (se lib/pauseTags.ts, *Överlämningen*).
  // Rutten hit sätts i app/_layout.tsx, som inte rörs, så skärmen lämnar en
  // lapp och byter sig själv mot Hem — och klockan ringer där i stället.
  //
  // En delad paus stannar här, men bara om någon faktiskt var med: den som
  // bjöd in och som ingen hängde på har pausat ensam, och det ska se ut
  // precis så. Att ingen kom står ingenstans (lib/pauseInvites.ts). Därför
  // avgörs det först när listan över de andra kommit — `people` null betyder
  // "inte hämtad än", och då ritas ingenting.
  const [people, setPeople] = useState<SharedPausePerson[] | null>(sharedSessionId ? null : []);
  const handOff = people !== null && people.length === 0;
  const handedOffRef = useRef(false);
  useEffect(() => {
    if (people === null) return;
    if (handOff) {
      if (handedOffRef.current) return;
      handedOffRef.current = true;
      setPendingPauseTag(seconds, !!category, true, sleepable);
      router.replace('/(tabs)');
      return;
    }
    if (!handedOffRef.current) {
      handedOffRef.current = true;
      bellPlayer.play();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people === null, handOff]);

  // De andra i pausen. Hämtas om medan någon fortfarande pausar, så att
  // "still pausing" blir "paused 12 min" medan skärmen står framme.
  useEffect(() => {
    if (!sharedSessionId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      const list = await getSharedPausePeople(sharedSessionId);
      if (!alive) return;
      setPeople(list);
      if (list.some(p => p.still_pausing)) timer = setTimeout(load, PEOPLE_REFRESH_MS);
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [sharedSessionId]);

  const [cat, setCat] = useState<{ id: string; emoji: string; label: string } | null>(null);

  // Hjärtat går till dem som slutat — deras paus finns som rad, och det är
  // den hjärtat hänger på (stats.tsx visar det på mottagarens paus). Den som
  // fortfarande pausar har ingen rad än.
  const finished = (people ?? []).filter(p => !p.still_pausing && p.seconds != null);
  const finishedNames = joinNames(finished.map(p => p.username));

  // ── Ett hjärta i stället för en hälsning ──
  // Ett tryck fyller det och skickar, ett till tömmer det igen. Fyllningen
  // sker direkt och rullas tillbaka om skrivningen faller, så att trycket
  // känns som ett tryck och inte som ett formulär. Se supabase/pause_cheers.sql.
  const [cheered, setCheered] = useState(false);
  const [cheerBusy, setCheerBusy] = useState(false);
  const heartPop = useRef(new Animated.Value(1)).current;
  // Vilka som faktiskt fått hjärtat. Ett tryck är ett hjärta till alla i
  // pausen, också dem som slutar efteråt — så effekten nedan skickar till
  // var och en som dyker upp i `finished` medan hjärtat är fyllt.
  const cheeredIdsRef = useRef<Set<string>>(new Set());

  const toggleCheer = async () => {
    if (cheerBusy || !user?.id || !sharedSessionId || finished.length === 0) return;
    const next = !cheered;
    setCheered(next);
    if (next) {
      heartPop.setValue(0.6);
      Animated.spring(heartPop, { toValue: 1, friction: 3, tension: 160, useNativeDriver: true }).start();
    }
    setCheerBusy(true);
    const ids = finished.map(p => p.user_id);
    let ok: boolean;
    if (next) {
      const got = await sendCheers(user.id, sharedSessionId, ids);
      got.forEach(id => cheeredIdsRef.current.add(id));
      ok = got.length > 0;
    } else {
      // Tar tillbaka från alla som fått det, också de som tillkom efteråt.
      ok = await removeCheers(user.id, sharedSessionId, [...cheeredIdsRef.current]);
      if (ok) cheeredIdsRef.current.clear();
    }
    setCheerBusy(false);
    if (!ok) setCheered(!next);
    else if (next) track('pause_cheer_sent', { recipients: ids.length });
  };

  // Den som slutar pausa efter trycket får sitt hjärta när raden dyker upp.
  const finishedKey = finished.map(p => p.user_id).join(',');
  useEffect(() => {
    if (!cheered || cheerBusy || !user?.id || !sharedSessionId) return;
    const missing = finished.map(p => p.user_id).filter(id => !cheeredIdsRef.current.has(id));
    if (missing.length === 0) return;
    sendCheers(user.id, sharedSessionId, missing).then(got => {
      got.forEach(id => cheeredIdsRef.current.add(id));
      if (got.length > 0) track('pause_cheer_sent', { recipients: got.length, late: true });
    });
  // `finished` byggs om varje rendering; nyckeln är listan av id:n.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cheered, cheerBusy, finishedKey, user?.id, sharedSessionId]);

  useEffect(() => {
    const load = async () => {
      if (!category) return;
      const allCats = await getSelectedCategories();
      const found = allCats.find(c => c.id === category);
      setCat(found ?? null);
    };
    load();
  }, [category]);

  // Två lager: siffran + meningen möter blicken direkt (ingen fråga, inget
  // beslut att fatta — sessionen är redan avslutad och sparad av lådan).
  // Kortet, kategori, hjärtat och partnerstatus ligger kvar under,
  // nåbara genom att scrolla ner eller genom att tona in efter en sekund.
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const detailsFade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }).start();
    Animated.sequence([
      Animated.delay(1000),
      Animated.timing(detailsFade, { toValue: 1, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  const formatTime = (secs: number) => {
    if (secs < 60) return `${secs} sec`;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}min`;
    if (s === 0) return `${m} min`;
    return `${m} min ${s} sec`;
  };

  // Spellar ut i klartext ("18 minutes") bara för den stora siffran —
  // resten av skärmen (kortet, partnerstatus) behåller appens vanliga
  // förkortade format.
  const formatHeroDuration = (secs: number) => {
    if (secs < 60) return `${secs} second${secs === 1 ? '' : 's'}`;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0) return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`;
    return `${m} minute${m === 1 ? '' : 's'}`;
  };

  // Medan bytet till Hem pågår ritas ingenting — annars blinkar den gamla
  // sammanfattningen till under en bildruta.
  if (handOff || people === null) return null;

  const together = people.length > 0;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
    <ScrollView
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >

      <Animated.View style={{ opacity: fadeAnim, alignItems: 'center', gap: 8 }}>
        <Text style={styles.bigNumber}>{formatHeroDuration(seconds)}</Text>
        <Text style={styles.welcomeText}>Welcome back.</Text>
      </Animated.View>

      <Animated.View style={{ opacity: detailsFade, alignItems: 'center', width: '100%', gap: 20, marginTop: 56 }}>

        {(cat || together) && (
          <View style={styles.card}>
            {cat && (
              <View style={styles.categoryBlock}>
                <Text style={styles.categoryEmoji}>{cat.emoji}</Text>
                <Text style={styles.categoryLabel}>{cat.label}</Text>
              </View>
            )}

            {together && (
              <View style={styles.sharedRow}>
                <FontAwesome5 name="user-friends" size={13} color={Palette.accent} />
                <Text style={styles.sharedText}>You paused together</Text>
              </View>
            )}

            {/* En rad per person. Inget pronomen — appen vet inte vilket
                någon använder (CLAUDE.md) — så namnet bär raden och tiden
                står efter en punkt. */}
            {together && (
              <View style={styles.peopleList} accessibilityLiveRegion="polite">
                {people.map(p => (
                  <View key={p.user_id} style={styles.personRow}>
                    <PersonFace username={p.username} avatarUrl={p.avatar_url} styles={styles} />
                    <Text style={styles.personText}>
                      <Text style={styles.personName}>{p.username}</Text>
                      {p.is_host ? ' invited you' : ' joined in'}
                      {p.still_pausing
                        ? ' · still pausing'
                        : p.seconds != null ? ` · paused ${formatTime(p.seconds)}` : ''}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* Hjärtat hör till raderna ovanför, så det står i samma kort —
                en rad, inte en egen sektion. Hela raden är knappen. */}
            {together && finished.length > 0 && (
              <TouchableOpacity
                style={styles.cheerRow}
                onPress={toggleCheer}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityState={{ selected: cheered }}
                accessibilityLabel={cheered ? `Take back your cheer for ${finishedNames}` : `Send a cheer to ${finishedNames}`}
              >
                <Animated.View style={[styles.cheerHeart, cheered && styles.cheerHeartOn, { transform: [{ scale: heartPop }] }]}>
                  <FontAwesome5 name="heart" size={14} solid={cheered} color={cheered ? Palette.onAccent : Palette.dangerSoft} />
                </Animated.View>
                <Text style={styles.cheerText}>
                  {cheered ? `You cheered ${finishedNames}` : `Send a cheer to ${finishedNames}`}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <TouchableOpacity
          style={styles.doneButton}
          // Frågan *What did you do instead?* ställs på Hem, som efter en
          // ensam paus — klockan har redan ringt här (lib/pauseTags.ts).
          onPress={() => { setPendingPauseTag(seconds, !!category, false); router.replace('/(tabs)'); }}
          activeOpacity={0.85}
        >
          <Text style={styles.doneText}>Back to start</Text>
        </TouchableOpacity>

      </Animated.View>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xxl,
    gap: 16,
    paddingBottom: 48,
  },
  bigNumber: {
    fontSize: 56,
    fontWeight: '900',
    color: Palette.textPrimary,
    letterSpacing: 1,
  },
  welcomeText: {
    fontSize: 18,
    color: Palette.textSecondary,
  },
  card: {
    backgroundColor: Palette.surface,
    borderRadius: Radius.xl,
    padding: Spacing.xxl,
    alignItems: 'center',
    width: '100%',
    borderWidth: 1,
    borderColor: Palette.accentBorder,
    gap: 16,
    ...Palette.cardShadow,
  },
  categoryBlock: {
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  categoryEmoji: {
    fontSize: 36,
  },
  categoryLabel: {
    color: Palette.accent,
    fontSize: 14,
    fontWeight: 'bold',
    letterSpacing: 2,
  },
  message: {
    fontSize: 17,
    color: Palette.accentPale,
    textAlign: 'center',
    lineHeight: 28,
    fontStyle: 'italic',
    paddingHorizontal: 8,
  },
  partnerStatusText: {
    fontSize: 14,
    color: Palette.textTertiary,
    textAlign: 'center',
    fontStyle: 'italic',
    letterSpacing: 0.2,
  },

  sharedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: Palette.accentTint,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Palette.accentBorder,
  },
  sharedText: {
    color: Palette.accentPale,
    fontSize: 14,
    fontWeight: '600',
  },

  // De andra i pausen, en rad per person.
  peopleList: { alignSelf: 'stretch', gap: 12 },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  personFace: { width: 32, height: 32, borderRadius: 16 },
  personFaceFallback: {
    backgroundColor: Palette.surfaceAlt, alignItems: 'center', justifyContent: 'center',
  },
  personFaceLetter: { color: Palette.textSecondary, fontSize: 14, fontWeight: '700' },
  personText: { flex: 1, fontSize: 15, lineHeight: 21, color: Palette.textSecondary },
  personName: { color: Palette.textPrimary, fontWeight: '700' },

  // Hjärtat. Hjärtats rosa (`dangerSoft`) är den enda kulören ett hjärta
  // läses som; fyllt får det en fylld cirkel med vitt hjärta, samma språk som
  // appens fyllda knappar.
  // En rad i kortet, avdelad från personerna med ett hårstreck. Hjärtat är
  // lika stort som ansiktena ovanför (32), så raden läses som en av dem.
  cheerRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.ink10,
  },
  cheerHeart: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: Palette.dangerSoft,
  },
  cheerHeartOn: {
    backgroundColor: Palette.dangerSoft,
  },
  cheerText: {
    flex: 1,
    color: Palette.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },

  doneButton: {
    backgroundColor: Palette.accent,
    paddingVertical: 16,
    paddingHorizontal: 48,
    borderRadius: Radius.pill,
    width: '100%',
    alignItems: 'center',
    marginTop: 8,
    ...Palette.cardShadow,
  },
  doneText: {
    color: Palette.onAccent,
    fontSize: 18,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
});
