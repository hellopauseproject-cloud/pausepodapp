import { FontAwesome, FontAwesome5, MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Animated, Image, Modal, Pressable, ScrollView, StyleSheet,
  Text, TouchableOpacity, useWindowDimensions, View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useAuth } from '../contexts/AuthContext';
import { ChartSession, PauseActivityChart } from '../components/pause-activity-chart';
import { PauseTotalHeart } from '../components/pause-total-heart';
import { AppPalette, Radius, Spacing, alpha, roomPalette } from '../constants/appTheme';
import { RoomProvider, usePalette, useTheme } from '../contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NightSky } from '../components/night-sky';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { intentionTone, PauseTagChips } from '../components/pause-tag-chips';
import { FlipCard } from '../components/flip-card';
import { contextLine, FactSession, pauseQuote, recordLine } from '../lib/pauseFacts';
import { SleepSessionCard } from '../components/sleep-session-card';
import { GlobeGrid } from '../components/globe-grid';
import { PodBoxIcon } from '../components/pod-box-icon';
import { fetchMyGlobalPauseWindows } from '../lib/globalPause';
import { Cheerer, getCheersFor } from '../lib/pauseCheers';
import { setPauseIntention, tagPauseAsSleep, untagSleep } from '../lib/pauseTags';
import { getNightProgress, getSleepNights } from '../lib/sleep';
import type { SleepNight } from '../types/database';
import { Category, DEFAULT_CATEGORIES, getSelectedCategories } from './pauseLogger';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Sömnen ──
// En liten sektion för sig, privat (supabase/sleep.sql). Den syns bara när
// det finns en natt att visa — samma linje som att wrapped inte introduceras
// för den som inte har någon historik.

// `night_of` är kvällens datum ('2026-10-05') — ett datum och inte ett
// ögonblick, så det räknas i UTC för att sommartid inte ska ge ett 23h-dygn.
const nightIndex = (nightOf: string) => Math.round(Date.parse(`${nightOf}T00:00:00Z`) / 86400000);

/**
 * Hur många nätter i rad, bakåt från den senaste, som telefonen lades undan
 * med SLEEP. Längden spelar ingen roll — det finns inget nattmål, och det
 * sviten belönar är vanan att lägga ifrån sig telefonen, inte sömnen.
 *
 * Sviten får börja i natten som gäller nu (`current`, på morgonen efter) eller
 * natten innan (på eftermiddagen, när kvällens natt inte börjat än — det är
 * inte ett brott). Ligger den senaste natten längre bak är sviten bruten, och
 * en saknad natt däremellan bryter den.
 */
function nightStreak(nights: SleepNight[], current: string): number {
  if (nights.length === 0) return 0;
  const today = nightIndex(current);
  let expected = nightIndex(nights[0].night_of);
  if (expected !== today && expected !== today - 1) return 0;
  let count = 0;
  for (const n of nights) {
    if (nightIndex(n.night_of) !== expected) break;
    count += 1;
    expected -= 1;
  }
  return count;
}

// Läggdagens snitt räknas runt midnatt: 23:30 och 00:30 ska ge 00:00, inte
// 12:00. Minuterna flyttas därför så att kvällen och natten ligger i följd
// (middag = 0) innan de summeras.
function avgBedtime(nights: SleepNight[]): string {
  const mins = nights
    .filter(n => n.bedtime)
    .map(n => { const d = new Date(n.bedtime!); return (d.getHours() * 60 + d.getMinutes() + 12 * 60) % (24 * 60); });
  if (mins.length === 0) return '—';
  const avg = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length);
  const real = (avg + 12 * 60) % (24 * 60);
  return `${String(Math.floor(real / 60)).padStart(2, '0')}:${String(real % 60).padStart(2, '0')}`;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} · ${hh}:${mm}`;
}

function fmtDur(secs: number) {
  if (secs < 60) return `${secs}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

function fmtIntention(raw: string | null, categoryMap: Record<string, string>) {
  if (!raw) return '—';
  if (categoryMap[raw]) return categoryMap[raw];
  const builtIn: Record<string, string> = {
    focus: 'Focus', walk: 'Walk', workout: 'Workout', social: 'Social',
    clean: 'Clean', meditate: 'Meditation', read: 'Reading', study: 'Study',
    rest: 'Rest', create: 'Create', music: 'Music', nature: 'Nature',
  };
  if (builtIn[raw]) return builtIn[raw];
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

type MsgData = {
  id: string; senderId: string; senderName: string;
  text: string; delivered: boolean; createdAt: string;
};

type SessionItem = {
  id: string; durationSecs: number; intention: string | null;
  startedAt: string; sharedSessionId: string | null;
  friendName: string | null; msg: MsgData | null;
  /** Vilka som hjärtat pausen efteråt (supabase/pause_cheers.sql). */
  cheers: Cheerer[];
  withPod: boolean | null;
  /** Pausen låg i en Global Pause (lib/globalPause.ts). */
  globalPause: boolean;
  /** En natt (supabase/sleep.sql) visas som ett eget kort med natthimmel. */
  kind: 'pause' | 'sleep';
  endedAt: string | null;
  wakeCount: number;
  awakeSecs: number;
  /** En paus som taggats som natt i efterhand — bara den går att ångra. */
  taggedAsSleep: boolean;
};

// Modul-nivå — överlever remount inom samma app-session
const _readIds = new Set<string>();

/**
 * Hör till **study-rummet** — Pause-rummet en trappa djupare in. Se ROOMS i
 * [constants/appTheme.ts](../constants/appTheme.ts) för varför de tre
 * skärmarna bakom Hems topbar-ikoner delar ett eget, mörkare rum.
 */
/** Hur många ansikten som får plats på kortet innan resten blir ett `+N`. */
const CHEER_FACES_MAX = 3;
/** Under den här bredden (punkter) får kortets baksida ett mindre citat. */
const COMPACT_WIDTH = 380;

/**
 * Baksidan av en paus kort: rekordraden, ett citat och när. Texterna och uträkningarna bor i
 * [lib/pauseFacts.ts](../lib/pauseFacts.ts); här står bara hur de ritas.
 */
function PauseCardBack({ s, cat, tone, all, quoteIndex, styles }: {
  s: SessionItem; cat: Category | null; tone: string; all: FactSession[];
  /** Pausens plats i tidsordning, äldst = 0 — se `pauseQuote`. */
  quoteIndex: number;
  styles: ReturnType<typeof makeStyles>;
}) {
  // En smal telefon (iPhone SE, de flesta mindre Android) får ett mindre
  // citat, så att de längsta inte gör kortet mycket högre än framsidan.
  // Kortet växer ändå med texten (components/flip-card.tsx mäter baksidan),
  // så ingenting klipps — det här handlar bara om proportioner.
  const { width } = useWindowDimensions();
  const compact = width < COMPACT_WIDTH;
  const fact = all.find(f => f.id === s.id);
  if (!fact) return null;
  const builtIn = cat && DEFAULT_CATEGORIES.some(c => c.id === cat.id) ? cat.id : null;
  const record = recordLine(fact, all, builtIn, cat?.label ?? null);
  const when = contextLine(fact);
  return (
    <View style={styles.backBody}>
      {/* Rekordraden får bryta till två rader i stället för att kapas: en
          lång (`YOUR 3RD CREATIVE BREAK IN SEPTEMBER`) ryms inte på en smal
          skärm, och den kan inte krympas — den står redan på typskalans
          golv (11). */}
      {record && (
        <View style={styles.backRecordRow}>
          <FontAwesome5 name="trophy" size={11} color={tone} style={styles.backTrophy} />
          <Text style={[styles.backRecord, { color: tone }]} numberOfLines={2}>{record.toUpperCase()}</Text>
        </View>
      )}
      <Text style={[styles.backQuote, compact && styles.backQuoteCompact]}>“{pauseQuote(quoteIndex)}”</Text>
      {!!when && <Text style={styles.backWhen} numberOfLines={1}>{when}</Text>}
    </View>
  );
}

/**
 * Vilka som hjärtat en paus: ansiktet med ett litet hjärta i hörnet. Inget
 * att trycka på — det är ett kvitto, inte en inkorg.
 */
function CheerFaces({ cheers, styles, Palette }: {
  cheers: Cheerer[]; styles: ReturnType<typeof makeStyles>; Palette: AppPalette;
}) {
  const shown = cheers.slice(0, CHEER_FACES_MAX);
  const more = cheers.length - shown.length;
  const names = cheers.map(c => c.username).join(', ');
  return (
    <View style={styles.cheerRow} accessible accessibilityLabel={`Cheered by ${names}`}>
      {shown.map(c => (
        <View key={c.userId}>
          {c.avatarUrl?.startsWith('https://') ? (
            <Image source={{ uri: c.avatarUrl }} style={styles.cheerFace} />
          ) : (
            <View style={[styles.cheerFace, styles.cheerFaceFallback]}>
              <Text style={styles.cheerFaceLetter}>{c.username[0]?.toUpperCase() ?? '?'}</Text>
            </View>
          )}
          <View style={styles.cheerBadge}>
            <FontAwesome5 name="heart" size={8} solid color={Palette.dangerSoft} />
          </View>
        </View>
      ))}
      {more > 0 && <Text style={styles.cheerMore}>+{more}</Text>}
    </View>
  );
}

export default function StatsRoom() {
  return (
    <RoomProvider room="study">
      <View style={roomShell}>
        <ScreenBackground room="study" />
        <StatsScreen />
      </View>
    </RoomProvider>
  );
}

function StatsScreen() {
  const Palette = usePalette();
  // SLEEP-sammanfattningen ligger på natthimmel, som nattkorten, och läser
  // därför sin text ur nattpaletten — mörk i båda lägena.
  const { mode } = useTheme();
  const Night = roomPalette(mode, 'night');
  const styles = useMemo(() => makeStyles(Palette, Night), [Palette, Night]);
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { height } = useWindowDimensions();
  const [sessions, setSessions]       = useState<SessionItem[]>([]);
  // Hjärtat fylls först när raderna landat, inte medan de hämtas.
  const [loaded, setLoaded]           = useState(false);
  const [visibleCount, setVisibleCount] = useState(10);
  const [selectedMsg, setSelectedMsg] = useState<MsgData | null>(null);
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({});
  const [nights, setNights] = useState<SleepNight[]>([]);
  // Natten som gäller nu, ur samma `get_night_progress` som Hem läser — så
  // att sviten, veckan och nattens urtavla är överens om vilken natt det är.
  const [currentNight, setCurrentNight] = useState<string | null>(null);
  const fadeAnim     = useRef(new Animated.Value(0)).current;
  const dataFadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    getSelectedCategories().then(cats => {
      const all = [...DEFAULT_CATEGORIES, ...cats];
      const map: Record<string, string> = {};
      all.forEach(c => { map[c.id] = c.label; });
      setCategoryMap(map);
    });
  }, []);

  useFocusEffect(useCallback(() => {
    if (!user?.id) return;
    setVisibleCount(10);
    fadeAnim.setValue(0);
    dataFadeAnim.setValue(0);
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();

    (async () => {
      // Nätterna står i listan som egna kort (`SleepSessionCard`), men
      // diagrammet får bara pauserna — se `pauseSessions` nedan.
      getSleepNights(30).then(setNights);
      getNightProgress().then(p => setCurrentNight(p?.night_of ?? null));
      const { data: all } = await supabase
        .from('pause_sessions')
        .select('id, duration_seconds, intention, started_at, ended_at, shared_session_id, with_pod, kind, wake_count, awake_seconds, tagged_as_sleep')
        .eq('user_id', user.id)
        .not('ended_at', 'is', null)
        .order('started_at', { ascending: false });

      const rows = all ?? [];
      // Vilka pauser som låg i en Global Pause: de som överlappar ett av mina
      // fönster, med en minuts marginal åt båda hållen.
      const globalWindows = await fetchMyGlobalPauseWindows();
      const inGlobal = (start: string | null, end: string | null) => {
        if (!start || !end || globalWindows.length === 0) return false;
        const a = new Date(start).getTime();
        const b = new Date(end).getTime();
        return globalWindows.some(w => a <= w.to + 60_000 && b >= w.from - 60_000);
      };
      const recent = rows;
      const ids    = recent.map(r => r.id);

      // Messages where I am receiver
      let msgMap: Record<string, MsgData> = {};
      if (ids.length > 0) {
        const { data: msgs } = await supabase
          .from('pause_messages')
          .select('id, sender_id, session_id, text_content, delivered, created_at')
          .eq('receiver_id', user.id)
          .eq('message_type', 'text')
          .in('session_id', ids);

        const sIds = [...new Set((msgs ?? []).map(m => m.sender_id))];
        let sMap: Record<string, string> = {};
        if (sIds.length > 0) {
          const { data: ps } = await supabase.from('profiles').select('id, username').in('id', sIds);
          sMap = Object.fromEntries((ps ?? []).map(p => [p.id, p.username ?? '?']));
        }
        for (const m of (msgs ?? [])) {
          msgMap[m.session_id] = {
            id: m.id, senderId: m.sender_id, senderName: sMap[m.sender_id] ?? '?',
            text: m.text_content ?? '', delivered: m.delivered ?? false, createdAt: m.created_at,
          };
        }
      }

      // Hjärtan efter delade pauser. Bara delade pauser kan ha några, så
      // frågan begränsas till dem.
      const cheerMap = await getCheersFor(
        user.id,
        recent.filter(r => r.shared_session_id && r.kind !== 'sleep').map(r => r.id),
      );

      // Friend names for shared sessions
      const sharedIds = recent.filter(r => r.shared_session_id).map(r => r.shared_session_id!);
      let friendMap: Record<string, string> = {};
      if (sharedIds.length > 0) {
        const { data: partners } = await supabase
          .from('pause_sessions')
          .select('shared_session_id, user_id')
          .in('shared_session_id', sharedIds)
          .neq('user_id', user.id);
        const pIds = [...new Set((partners ?? []).map(p => p.user_id))];
        if (pIds.length > 0) {
          const { data: profs } = await supabase.from('profiles').select('id, username').in('id', pIds);
          const pNameMap = Object.fromEntries((profs ?? []).map(p => [p.id, p.username ?? '?']));
          for (const p of (partners ?? [])) {
            if (p.shared_session_id) friendMap[p.shared_session_id] = pNameMap[p.user_id] ?? '?';
          }
        }
      }

      setSessions(recent.map(r => ({
        id: r.id,
        durationSecs: r.duration_seconds ?? 0,
        intention: r.intention,
        startedAt: r.started_at ?? '',
        sharedSessionId: r.shared_session_id,
        friendName: r.shared_session_id ? (friendMap[r.shared_session_id] ?? null) : null,
        msg: msgMap[r.id] ?? null,
        cheers: cheerMap[r.id] ?? [],
        withPod: r.with_pod ?? null,
        globalPause: r.kind !== 'sleep' && inGlobal(r.started_at, r.ended_at),
        kind: r.kind === 'sleep' ? 'sleep' : 'pause',
        endedAt: r.ended_at ?? null,
        wakeCount: r.wake_count ?? 0,
        awakeSecs: r.awake_seconds ?? 0,
        taggedAsSleep: r.tagged_as_sleep ?? false,
      })));
      setLoaded(true);

      Animated.timing(dataFadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    })();
  }, [user?.id]));

  // ── Taggar i efterhand ──
  // Samma skrivning och samma chips som sammanfattningen efter en paus
  // (lib/pauseTags.ts, components/pause-tag-chips.tsx). Här är id:t känt, så
  // ingen rad behöver letas upp. Bara ett kort är öppet åt gången.
  const [tagCats, setTagCats] = useState<Category[]>([]);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [savingTagId, setSavingTagId] = useState<string | null>(null);
  useEffect(() => { getSelectedCategories().then(setTagCats); }, []);

  // `intention` kan vara en etikett (`FOCUS`, som pausskärmen och taggarna
  // skriver) eller ett id (`focus`, som lådflödets kö skriver). Chippen
  // markeras i båda fallen.
  const selectedTagLabel = (raw: string | null) =>
    tagCats.find(c => c.label === raw || c.id === raw)?.label ?? null;

  // Kategorin bakom en paus intention, för kortets emoji och ton. Letar
  // också bland de inbyggda, så att en paus taggad med något man sedan valt
  // bort i Settings behåller sin färg.
  const findCat = (raw: string | null): Category | null => {
    if (!raw) return null;
    return [...tagCats, ...DEFAULT_CATEGORIES].find(c => c.label === raw || c.id === raw) ?? null;
  };

  // ── Baksidan ──
  // Ett kort i taget står vänt. Rekordraden och dagens summa räknas ur alla
  // pauser (inte nätter), med taggen upplöst till en nyckel — `FOCUS` och
  // `focus` är samma tagg (lib/pauseFacts.ts).
  const [flippedId, setFlippedId] = useState<string | null>(null);
  const factSessions = useMemo<FactSession[]>(() => sessions
    .filter(x => x.kind === 'pause')
    .map(x => ({
      id: x.id,
      durationSecs: x.durationSecs,
      intention: x.intention
        ? ([...tagCats, ...DEFAULT_CATEGORIES].find(c => c.label === x.intention || c.id === x.intention)?.id
          ?? x.intention.toLowerCase())
        : null,
      startedAt: x.startedAt,
      endedAt: x.endedAt,
    })), [sessions, tagCats]);
  // Varje paus plats i tidsordning, äldst först — det som gör citaten unika
  // (lib/pauseFacts.ts, `pauseQuote`). Listan kommer nyast först.
  const quoteIndex = useMemo(() => {
    const m: Record<string, number> = {};
    factSessions.forEach((f, i) => { m[f.id] = factSessions.length - 1 - i; });
    return m;
  }, [factSessions]);

  const saveTag = async (s: SessionItem, label: string | null) => {
    if (!user?.id || savingTagId) return;
    if (label !== null && selectedTagLabel(s.intention) === label) { setEditingTagId(null); return; }
    setSavingTagId(s.id);
    const ok = await setPauseIntention(s.id, user.id, label);
    setSavingTagId(null);
    if (!ok) { Alert.alert('Could not save tag', 'Check your connection and try again.'); return; }
    setSessions(prev => prev.map(x => (x.id === s.id ? { ...x, intention: label } : x)));
    setEditingTagId(null);
    track(label ? 'pause_tagged' : 'pause_tag_removed', { where: 'stats' });
  };

  // *Sleep* bland taggarna gör en lådpaus till en natt (supabase/sleep_tag.sql),
  // och kortet byts mot nattens. På en taggad natt öppnar SLEEP samma chips,
  // och en intention gör den till en paus igen. `label` null = till natt.
  const setSleep = async (s: SessionItem, label: string | null) => {
    if (!user?.id || savingTagId) return;
    const toSleep = label === null;
    setSavingTagId(s.id);
    const ok = toSleep ? await tagPauseAsSleep(s.id) : await untagSleep(s.id, label);
    setSavingTagId(null);
    if (!ok) { Alert.alert('Could not save tag', 'Check your connection and try again.'); return; }
    setSessions(prev => prev.map(x => (x.id === s.id
      ? { ...x, kind: toSleep ? 'sleep' : 'pause', intention: label, taggedAsSleep: toSleep, globalPause: false }
      : x)));
    setEditingTagId(null);
    setFlippedId(null);
    getSleepNights(30).then(setNights);
    track(toSleep ? 'pause_tagged_as_sleep' : 'sleep_untagged', { where: 'stats' });
  };

  // Diagrammet räknas fram ur `sessions`, så det uppdaterar sig självt när
  // raden faller bort — ingen extra summeringsfråga behövs längre.
  const deleteSession = async (id: string) => {
    await supabase.from('pause_sessions').delete().eq('id', id).eq('user_id', user!.id);
    // Raden försvinner ur pause_sessions, och därmed ur alla vyer i
    // analytics.sql. Händelsen är det enda som blir kvar av att pausen har
    // funnits — annars ser en raderad paus ut som en paus som aldrig skedde.
    const wasSleep = sessions.find(s => s.id === id)?.kind === 'sleep';
    track(wasSleep ? 'sleep_deleted' : 'pause_deleted');
    setSessions(prev => prev.filter(s => s.id !== id));
    // NIGHTS-sektionen räknas på servern, så den hämtas om.
    if (wasSleep) getSleepNights(30).then(setNights);
  };

  const confirmDelete = (id: string) => {
    const isSleep = sessions.find(s => s.id === id)?.kind === 'sleep';
    const what = isSleep ? 'night' : 'pause';
    Alert.alert(`Delete ${what}`, `Do you want to delete this ${what}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteSession(id) },
    ]);
  };

  // Diagrammet är pausernas: en natt på åtta timmar hade gjort det till ett
  // sömndiagram.
  const pauseSessions = useMemo(() => sessions.filter(s => s.kind === 'pause'), [sessions]);

  // Intentionerna under diagrammet: varje paus intention upplöst till samma
  // nyckel och emoji som pausens kort (`findCat`), så att `FOCUS` och
  // `focus` blir en rad.
  const chartSessions = useMemo<ChartSession[]>(() => pauseSessions.map(s => {
    if (!s.intention) return { startedAt: s.startedAt, durationSecs: s.durationSecs, tag: null };
    const cat = findCat(s.intention);
    const key = cat?.id ?? s.intention.toLowerCase();
    const raw = cat?.label ?? fmtIntention(s.intention, categoryMap);
    const label = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    return {
      startedAt: s.startedAt,
      durationSecs: s.durationSecs,
      tag: { key, label, emoji: cat?.emoji ?? '⏸' },
    };
  // findCat läser tagCats.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [pauseSessions, tagCats, categoryMap]);

  // Hjärtat: all tid, bara pauser. Listan kommer nyast först.
  const totalSecs = useMemo(() => pauseSessions.reduce((a, s) => a + s.durationSecs, 0), [pauseSessions]);

  // Sömnens tre tal. Snitten gäller nätterna som hämtats (högst 30).
  const streak = currentNight ? nightStreak(nights, currentNight) : 0;
  const avgSleep = nights.length
    ? Math.round(nights.reduce((s, n) => s + n.sleep_seconds, 0) / nights.length)
    : 0;

  const openMsg = async (msg: MsgData) => {
    setSelectedMsg(msg);
    if (!msg.delivered && !_readIds.has(msg.id)) {
      _readIds.add(msg.id);
      setSessions(prev =>
        prev.map(s =>
          s.msg?.id === msg.id ? { ...s, msg: { ...s.msg!, delivered: true } } : s
        )
      );
      const { error } = await supabase
        .from('pause_messages')
        .update({ delivered: true })
        .eq('id', msg.id)
        .eq('receiver_id', user!.id);
      if (error) _readIds.delete(msg.id);
    }
  };

  return (
    <ScrollView
      // Bakåtknappen står `marginTop: 30` under kanten, så kanten ligger 22 pt
      // ovanför den gräns knappen ska hålla sig under.
      contentContainerStyle={[styles.container, { paddingTop: Math.max(10, insets.top - 22) }]}
      showsVerticalScrollIndicator={false}
    >

      {/* Back */}
      <Animated.View style={{ opacity: fadeAnim }}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <FontAwesome name="chevron-left" size={14} color={Palette.accent} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Hjärtat: all tid man pausat. Står överst och rörs inte av
          diagrammets bläddring (components/pause-total-heart.tsx). */}
      <PauseTotalHeart totalSecs={totalSecs} loaded={loaded} />

      {/* Diagrammet följer hjärtat och får nästan en skärm — listan under nås
          genom att skrolla, inte genom att trängas. Höjden mäts ur fönstret i
          stället för att hårdkodas: en liten telefon ska inte få ett avklippt
          diagram. */}
      <Animated.View style={[styles.chartSection, { minHeight: Math.max(440, height - 220) }, { opacity: dataFadeAnim }]}>
        <PauseActivityChart sessions={chartSessions} />
      </Animated.View>

      {/* Sömnen i tre tal — sviten, läggdagen och nattens längd. Över
          pauserna och inte under: pauslistan växer med *Show more*, och en
          sektion under den hade ingen hittat. Varje natt står redan som ett
          eget kort i listan, så här står bara det som går att räkna fram ur
          flera. Syns bara när det finns en natt. */}
      {nights.length > 0 && (
        <Animated.View style={[styles.nightsSection, { opacity: dataFadeAnim }]}>
          <View style={styles.sectionHeadRow}>
            <Text style={styles.sectionLabel}>SLEEP</Text>
          </View>
          <View style={styles.nightsSummary}>
            <NightSky seed="sleep-summary" />
            <View
              style={styles.nightsStat}
              accessible
              accessibilityLabel={`Streak: ${streak} ${streak === 1 ? 'night' : 'nights'} in a row with the phone put away.`}
            >
              <Text style={styles.nightsStatValue}>{streak}</Text>
              <Text style={styles.nightsStatLabel}>STREAK</Text>
            </View>
            <View style={styles.nightsStat} accessible accessibilityLabel={`Average bedtime ${avgBedtime(nights)}`}>
              <Text style={styles.nightsStatValue}>{avgBedtime(nights)}</Text>
              <Text style={styles.nightsStatLabel}>AVG BEDTIME</Text>
            </View>
            <View style={styles.nightsStat} accessible accessibilityLabel={`Average sleep ${fmtDur(avgSleep)}`}>
              <Text style={styles.nightsStatValue}>{fmtDur(avgSleep)}</Text>
              <Text style={styles.nightsStatLabel}>AVG SLEEP</Text>
            </View>
          </View>
        </Animated.View>
      )}

      {/* Rubrikraden bär veckoknappen i högra hörnet. Den låg förr som ett
          brett kort med texten "See the week that passed" mellan diagrammet
          och den här rubriken — ett kort som bara sa vad knappen redan var,
          och som sköt ner rubriken en hel radhöjd utan att bära något eget.

          Nu är den bara ikonen, i samma form och ton som sin tvilling i
          kretsfliken (`wrappedBtn` där), så de två ingångarna till samma
          sorts vecka ser likadana ut på båda skärmarna. Texten bärs av
          `accessibilityLabel` i stället — den är inte borta, bara osynlig.

          Här och inte uppe på bakåtraden: veckan hör ihop med pauserna den
          sammanfattar, och listan under rubriken är just de pauserna. */}
      <Animated.View style={[styles.sectionHeadRow, { opacity: fadeAnim }]}>
        <Text style={styles.sectionLabel}>RECENT PAUSES</Text>

        <TouchableOpacity
          style={styles.wrappedBtn}
          onPress={() => router.push('/my-wrapped' as never)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="See the week that passed"
        >
          <MaterialIcons name="insights" size={20} color={Palette.accentSoft} />
        </TouchableOpacity>
      </Animated.View>

      {/* Session cards */}
      {sessions.length === 0 ? (
        <Animated.Text style={[styles.empty, { opacity: dataFadeAnim }]}>No pauses yet.</Animated.Text>
      ) : sessions.slice(0, visibleCount).map((s, i) => {
        const isUnread = !!s.msg && !s.msg.delivered && !_readIds.has(s.msg.id);
        return (
          <Animated.View key={s.id} style={{ opacity: dataFadeAnim }}>
            <Swipeable
              renderRightActions={() => (
                <TouchableOpacity style={styles.deleteAction} onPress={() => confirmDelete(s.id)} activeOpacity={0.85}>
                  <FontAwesome5 name="trash" size={14} color={Palette.onAccent} />
                </TouchableOpacity>
              )}
            >
              {/* En natt: natthimmel och SLEEP i stället för taggar. Samma
                  svep för att radera som en paus. */}
              {s.kind === 'sleep' ? (
                <View>
                  <SleepSessionCard
                    id={s.id}
                    durationText={fmtDur(s.durationSecs)}
                    dateText={s.startedAt ? fmtDate(s.startedAt) : '—'}
                    onPressTag={s.taggedAsSleep
                      ? () => setEditingTagId(editingTagId === s.id ? null : s.id)
                      : undefined}
                    tagExpanded={editingTagId === s.id}
                  />
                  {/* Under kortet och inte i det: chippens toner är gjorda för
                      rummets botten, inte för natthimlen. SLEEP igen stänger. */}
                  {editingTagId === s.id && (
                    <View style={styles.sleepTagEditor}>
                      <PauseTagChips
                        categories={tagCats}
                        onPick={c => setSleep(s, c.label)}
                        disabled={savingTagId === s.id}
                        colorful
                        onPickSleep={() => setEditingTagId(null)}
                        sleepOn
                      />
                    </View>
                  )}
                </View>
              ) : (
              (() => {
              // Kortet tar färg av sin intention, samma ton som chippet på
              // taggkortet (`intentionTone`). En otaggad paus står i rummets
              // blå med pausens symbol — den är inte grå, bara inte namngiven.
              const cat = findCat(s.intention);
              const tone = cat ? intentionTone(Palette, cat.id) : Palette.hue;
              const isPod = s.withPod === true;
              const cardBorder = alpha(tone, Palette.mode === 'dark' ? 0.3 : 0.25);
              return (
              <View style={styles.sessionSlot}>
              <FlipCard
                flipped={flippedId === s.id}
                onToggle={() => {
                  setFlippedId(flippedId === s.id ? null : s.id);
                  if (editingTagId === s.id) setEditingTagId(null);
                }}
                accessibilityLabel={`${fmtDur(s.durationSecs)} pause${isPod ? ' in the Pause Pod' : ''}${cat ? `, ${cat.label.toLowerCase()}` : ''}. ${s.startedAt ? fmtDate(s.startedAt) : ''}`}
                backStyle={[styles.sessionBack, { borderColor: cardBorder }]}
                backTint={alpha(tone, Palette.mode === 'dark' ? 0.16 : 0.11)}
                back={<PauseCardBack s={s} cat={cat} tone={tone} all={factSessions} quoteIndex={quoteIndex[s.id] ?? 0} styles={styles} />}
                front={
              <View style={[styles.sessionCard, { borderColor: cardBorder }]}>
                <View pointerEvents="none" style={[styles.sessionTint, { backgroundColor: alpha(tone, Palette.mode === 'dark' ? 0.09 : 0.07) }]} />
                {/* Nere i högra hörnet, i samma kolumn som lådan ovanför (lika
                    bred som den), så att de står centrerade under varandra. */}
                {s.globalPause && (
                  <View style={styles.globeCorner} pointerEvents="none" accessibilityLabel="Global Pause">
                    <GlobeGrid size={30} active={false} mark markSize={0.36} />
                  </View>
                )}
                <View style={styles.sessionCardTop}>
                  <View style={[styles.sessionBadge, { backgroundColor: alpha(tone, Palette.mode === 'dark' ? 0.2 : 0.15) }]}>
                    {cat
                      ? <Text style={styles.sessionBadgeEmoji}>{cat.emoji}</Text>
                      : <FontAwesome name="pause" size={14} color={tone} />}
                  </View>
                  <View style={styles.sessionMain}>
                    <Text style={styles.sessionDur}>{fmtDur(s.durationSecs)}</Text>
                    <Text style={styles.sessionDate}>{s.startedAt ? fmtDate(s.startedAt) : '—'}</Text>
                  </View>
                  <View style={styles.sessionCardRight}>
                    {/* Bara en lådpaus får en markering: lådan själv i
                        hörnet. "Utan låda" visades förr som en egen ikon på
                        varje paus — men nästan alla pauser är utan låda, så
                        den sa ingenting. */}
                    {/* Lådan, och under den jordklotet från Global Pause-rummet,
                        centrerade mot varandra. */}
                    {isPod && (
                      <View style={styles.markers}>
                        {isPod && <PodBoxIcon />}
                      </View>
                    )}
                    {s.cheers.length > 0 && <CheerFaces cheers={s.cheers} styles={styles} Palette={Palette} />}
                    {s.msg && (
                      <TouchableOpacity style={styles.mailBtn} onPress={() => openMsg(s.msg!)} activeOpacity={0.65}>
                        <FontAwesome5 name="envelope" size={13} color={isUnread ? Palette.accentSoft : Palette.ink20} />
                        {isUnread && <View style={styles.unreadDot} />}
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
                <View style={styles.sessionTags}>
                  {/* Bara en delad paus får en etikett. *Solo pause* stod
                      förr på resten och är borttagen: att pausa ensam är
                      förvalet och behöver inte sägas. */}
                  {!!s.friendName && (
                    <View style={styles.tagFriend}>
                      <FontAwesome5 name="user-friends" size={9} color={Palette.accentSoft} />
                      <Text style={styles.tagFriendText}>{s.friendName}</Text>
                    </View>
                  )}
                  {/* Taggen går att trycka på: den öppnar samma chips som
                      sammanfattningen visar efter pausen, här under kortet.
                      Utan tagg står *+ Add tag* på samma plats. */}
                  <TouchableOpacity
                    style={s.intention
                      ? [styles.tagIntention, { backgroundColor: alpha(tone, 0.12), borderColor: alpha(tone, 0.32) }]
                      : styles.tagAdd}
                    onPress={() => setEditingTagId(editingTagId === s.id ? null : s.id)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: editingTagId === s.id }}
                    accessibilityLabel={s.intention
                      ? `Tag: ${fmtIntention(s.intention, categoryMap)}. Change tag.`
                      : 'Add a tag to this pause'}
                  >
                    <Text style={s.intention ? [styles.tagIntentionText, { color: tone }] : styles.tagAddText}>
                      {s.intention ? fmtIntention(s.intention, categoryMap) : '+ Add tag'}
                    </Text>
                  </TouchableOpacity>
                </View>
                {editingTagId === s.id && (
                  <View style={styles.tagEditor}>
                    <PauseTagChips
                      categories={tagCats}
                      selectedLabel={selectedTagLabel(s.intention)}
                      onPick={c => saveTag(s, c.label)}
                      disabled={savingTagId === s.id}
                      colorful
                      onPickSleep={isPod && !s.sharedSessionId ? () => setSleep(s, null) : undefined}
                    />
                    {!!s.intention && (
                      <TouchableOpacity
                        onPress={() => saveTag(s, null)}
                        disabled={savingTagId === s.id}
                        style={styles.tagRemove}
                        activeOpacity={0.6}
                        accessibilityRole="button"
                      >
                        <Text style={styles.tagRemoveText}>Remove tag</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
                }
              />
              </View>
              );
              })()
              )}
            </Swipeable>
          </Animated.View>
        );
      })}

      {/* Load more */}
      {sessions.length > visibleCount && (
        <TouchableOpacity style={styles.loadMoreBtn} onPress={() => setVisibleCount(v => v + 10)} activeOpacity={0.75}>
          <Text style={styles.loadMoreText}>Show more</Text>
        </TouchableOpacity>
      )}

      {/* Message modal */}
      <Modal visible={!!selectedMsg} transparent animationType="fade" onRequestClose={() => setSelectedMsg(null)}>
        <Pressable style={styles.overlay} onPress={() => setSelectedMsg(null)}>
          <Pressable style={styles.msgCard} onPress={() => {}}>
            <Text style={styles.msgSender}>{selectedMsg?.senderName}</Text>
            <Text style={styles.msgText}>{selectedMsg?.text}</Text>
            <Text style={styles.msgDate}>sent {selectedMsg ? fmtDate(selectedMsg.createdAt) : ''}</Text>
            <TouchableOpacity style={styles.msgCloseBtn} onPress={() => setSelectedMsg(null)} activeOpacity={0.7}>
              <Text style={styles.msgCloseTxt}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const makeStyles = (Palette: AppPalette, Night: AppPalette) => StyleSheet.create({
  container: {
    // Botten ritas av <ScreenBackground> i skalet ovan.
    flexGrow: 1, backgroundColor: 'transparent',
    padding: Spacing.xl, paddingTop: 10,
  },
  backBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginBottom: 28, marginTop: 30, alignSelf: 'flex-start',
    paddingVertical: 10, paddingHorizontal: 4,
  },
  backText: { color: Palette.accent, fontSize: 15 },

  // Diagrammet
  chartSection: { marginBottom: 28 },

  // Section label
  //
  // Marginalerna bor på raden och inte på texten. Med veckoknappen bredvid
  // sig i en `center`-justerad rad hade en `marginBottom` på etiketten
  // förskjutit den uppåt mot knappen i stället för att skilja rubriken från
  // listan under.
  sectionHeadRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 12, marginTop: 4,
  },
  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: Palette.ink30,
    letterSpacing: 3, textTransform: 'uppercase',
  },

  empty: { color: Palette.ink25, fontSize: 14, paddingVertical: 16 },

  // Nätterna. Text läser ur text-tokens eller ink över 0.30 (CLAUDE.md,
  // *Grå text har ett kontrastgolv*).
  nightsSection: { marginBottom: 28 },
  // Samma himmel, ram och radie som nattkorten (sleep-session-card.tsx), så
  // att sammanfattningen och nätterna i listan hör ihop. Texten är nattens.
  nightsSummary: {
    flexDirection: 'row', justifyContent: 'space-between',
    backgroundColor: Night.bg, borderRadius: Radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: alpha(Night.hue, 0.22),
    paddingVertical: 16, paddingHorizontal: 16, marginBottom: 10,
  },
  nightsStat: { alignItems: 'center', flex: 1, gap: 4 },
  nightsStatValue: { fontSize: 20, fontWeight: '800', color: Night.textPrimary },
  nightsStatLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, color: Night.textSecondary },

  deleteAction: {
    backgroundColor: Palette.danger, justifyContent: 'center', alignItems: 'center',
    width: 60, borderRadius: Radius.lg, marginBottom: 10,
  },

  // Session card
  // Kortet är rummets yta med en ton av intentionen ovanpå (`sessionTint`,
  // ett eget lager eftersom en vy bara har en bakgrund) och en kant i samma
  // ton. Tonen sätts i JSX — den hör till pausen, inte till stilen.
  // Listans luft ligger på platsen runt kortet och inte på kortet: baksidan
  // täcker kortets yta exakt (components/flip-card.tsx).
  sessionSlot: { marginBottom: 10 },
  sessionCard: {
    flexGrow: 1,
    backgroundColor: Palette.surface,
    borderRadius: Radius.lg, borderWidth: 1, borderColor: Palette.surfaceBorder,
    padding: 16, gap: 12,
    ...Palette.cardShadow,
  },
  // Baksidan: samma yta och kant som framsidan, med en starkare ton ovanpå
  // (`backTint`). Ingen skugga — `overflow` klipper tonen mot rundningen.
  sessionBack: {
    backgroundColor: Palette.surface,
    borderRadius: Radius.lg, borderWidth: 1,
    overflow: 'hidden',
  },
  backBody: { gap: 8 },
  // `flex-start` och en liten knuff på pokalen, så att den står vid första
  // raden när rekordraden bryter till två.
  backRecordRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  backTrophy: { marginTop: 1.5 },
  backRecord: { flexShrink: 1, fontSize: 11, lineHeight: 14, fontWeight: '900', letterSpacing: 1.2 },
  backQuote: {
    fontSize: 16, lineHeight: 22, fontStyle: 'italic', fontWeight: '600',
    color: Palette.textPrimary,
  },
  backQuoteCompact: { fontSize: 15, lineHeight: 20 },
  backWhen: { fontSize: 12, color: Palette.textTertiary, letterSpacing: 0.3 },
  sessionTint: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    borderRadius: Radius.lg - 1,
  },
  sessionCardTop: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  // Intentionens emoji i en tonad skiva — det som gör att man känner igen en
  // promenad från en läsning innan man läst något.
  sessionBadge: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
  },
  sessionBadgeEmoji: { fontSize: 22 },
  sessionMain: { flex: 1, gap: 2 },
  markers: { alignItems: 'center', gap: 6 },
  // Lådans bredd (PodBoxIcon, 52) och kortets padding (16).
  globeCorner: { position: 'absolute', right: 16, bottom: 14, width: 52, height: 30, alignItems: 'center' },
  sessionCardRight: { alignItems: 'flex-end', gap: 6 },
  sessionDur: { fontSize: 26, lineHeight: 30, fontWeight: '900', color: Palette.textPrimary, letterSpacing: -0.5 },
  // `ink28` låg under textens kontrastgolv (se *Grå text har ett
  // kontrastgolv* i CLAUDE.md).
  sessionDate: { fontSize: 12, color: Palette.textTertiary, letterSpacing: 0.3 },
  sessionTags: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },

  tagFriend: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: alpha(Palette.accentSoft, 0.1), borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: Palette.accentSoftTint,
  },
  tagFriendText: { fontSize: 12, color: Palette.accentSoft, fontWeight: '600' },
  tagIntention: {
    backgroundColor: alpha(Palette.communitySoft, 0.08), borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: alpha(Palette.communitySoft, 0.18),
  },
  tagIntentionText: { fontSize: 12, color: Palette.communitySoft, fontWeight: '600' },
  // *+ Add tag* på en otaggad paus: samma form som taggen, men bara en kontur
  // — den är en väg dit, inte en tagg.
  tagAdd: {
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: alpha(Palette.hue, 0.45), borderStyle: 'dashed',
  },
  tagAddText: { fontSize: 12, color: Palette.hue, fontWeight: '700' },
  tagEditor: {
    gap: 10, paddingTop: 12, marginTop: 2,
    borderTopWidth: 1, borderTopColor: Palette.surfaceBorder,
  },
  // Nattkortet har sin egen marginal under sig; chippen står i den.
  sleepTagEditor: { paddingTop: 2, paddingBottom: 14 },
  tagRemove: { alignSelf: 'flex-start', paddingVertical: 4 },
  tagRemoveText: { fontSize: 13, fontWeight: '600', color: Palette.textSecondary },

  mailBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },

  // Hjärtan: ansiktet med ett litet hjärta i hörnet, ett per person.
  cheerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cheerFace: { width: 26, height: 26, borderRadius: 13 },
  cheerFaceFallback: { backgroundColor: Palette.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  cheerFaceLetter: { color: Palette.textSecondary, fontSize: 12, fontWeight: '700' },
  cheerBadge: {
    position: 'absolute', right: -4, bottom: -3,
    width: 15, height: 15, borderRadius: 8,
    backgroundColor: Palette.surface, alignItems: 'center', justifyContent: 'center',
  },
  cheerMore: { fontSize: 12, color: Palette.textTertiary },
  unreadDot: {
    position: 'absolute', top: 6, right: 6,
    width: 6, height: 6, borderRadius: 3, backgroundColor: Palette.accentSoft,
  },

  loadMoreBtn: {
    alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 28,
    borderRadius: Radius.pill, borderWidth: 1, borderColor: Palette.surfaceBorder,
    marginTop: 4, marginBottom: 16,
  },
  loadMoreText: { color: Palette.ink45, fontSize: 14, letterSpacing: 0.8 },

  // Wrapped
  // Kvadratisk och textlös, identisk med `wrappedBtn` i kretsfliken: samma
  // botten, samma ram, samma radie, samma mått. De två är samma ingång till
  // samma sorts vecka på var sin skärm, och ändras den ena måste den andra
  // följa med. Bottnen är `surface` och inte en tonad accent — se
  // motiveringen vid `chatBtn` i kretsfliken.
  wrappedBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Palette.surface,
    borderRadius: 12, borderWidth: 1, borderColor: Palette.accentSoftTint,
    width: 44, height: 44,
  },

  // Message modal
  overlay: {
    flex: 1, backgroundColor: Palette.scrimStrong,
    justifyContent: 'center', alignItems: 'center', padding: 28,
  },
  msgCard: {
    backgroundColor: Palette.modalSurface, borderRadius: Radius.xl, padding: 28,
    width: '100%', gap: 16, borderWidth: 1, borderColor: alpha(Palette.accentSoft, 0.12),
  },
  msgSender: { fontSize: 12, color: Palette.ink40, letterSpacing: 2, textTransform: 'uppercase' },
  msgText: { fontSize: 18, color: Palette.textPrimary, lineHeight: 28, fontWeight: '500' },
  msgDate: { fontSize: 12, color: Palette.ink22, letterSpacing: 0.4 },
  msgCloseBtn: {
    alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 20,
    borderRadius: Radius.pill, borderWidth: 1, borderColor: Palette.surfaceBorder, marginTop: 4,
  },
  msgCloseTxt: { color: Palette.ink45, fontSize: 14, letterSpacing: 0.8 },
});
