import { FontAwesome, FontAwesome5 } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Reanimated, {
  cancelAnimation, Easing as REasing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppPalette, Radius, Spacing, alpha } from '../../constants/appTheme';
import { useAuth } from '../../contexts/AuthContext';
import {
  dismissPauseInvite, fetchIncomingPauseInvites, getPauseInviteSelection, IncomingPauseInvite,
  joinPauseInvite, MAX_PAUSE_INVITEES, PAUSE_INVITE_WINDOW_MS, setPauseInviteSelection,
  usePauseInviteSelection,
} from '../../lib/pauseInvites';
import { RoomProvider, usePalette } from '../../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../../components/screen-background';
import { CircleLevelBadge } from '../../components/circle-level-badge';import { circleLevelName } from '../../lib/circleLevels';
import { FriendCircleBadge, getFriendCircleBadge } from '../../lib/circles';
import { track } from '../../lib/analytics';
import { isNightHours } from '../../lib/homeMode';
import { enablePushNotifications } from '../../lib/notifications';
import { startSleep } from '../../lib/sleep';
import { supabase } from '../../lib/supabase';
import { liveStoryFilter, storyTimeLeft, unopenedResponsesQuery } from '../../lib/supportStories';
import type { PauseSession, Profile } from '../../types/database';
import { Category, DEFAULT_CATEGORIES, getSelectedCategories } from '../pauseLogger';

// ─── Types ────────────────────────────────────────────────────────────────────

type SupportStory = {
  id: string;
  user_id: string;
  support_type: string;
  activity: string;
  intention_id: string | null;
  personal_note: string | null;
  created_at: string;
  /** Satt när storyn kommer från en punkt på listan i stället för en
   *  stöd-förfrågan. Då bär `support_type` tonen och `activity` punktens text. */
  wishlist_item_id?: string | null;
  expires_at?: string | null;
  profile: { id: string; username: string; avatar_url: string | null } | null;
};

/**
 * Genvägarna i tonsteget. Det är INTE en egen vokabulär — det är tre id:n ur
 * SUPPORT_TYPE_LABELS nedan, valda för att täcka spannet från mjukt till
 * hårt. En egen lista här är precis vad som gjorde de två flödena omöjliga
 * att skilja på: samma tre begrepp fanns redan, med andra id:n.
 */
const QUICK_TONE_IDS = ['värme', 'motivationstal', 'tillsägelse'];


const SUPPORT_TYPE_LABELS: Record<string, string> = {
  tröst: 'Comfort', värme: 'Warmth', närvaro: 'Presence', sällskap: 'Company',
  empati: 'Empathy', förståelse: 'Understanding', stöd: 'Support', lugn: 'Calm',
  hopp: 'Hope', skratt: 'Laughter', pepp: 'Pep', hejarop: 'Cheering',
  'en knuff': 'A nudge', 'hjälp att börja': 'Help getting started',
  råd: 'Advice', perspektiv: 'Perspective', klarhet: 'Clarity', visdom: 'Wisdom',
  strategi: 'Strategy', ärlighet: 'Honesty', 'reality check': 'Reality check',
  motivationstal: 'Pep talk', predikan: 'Lecture', tillsägelse: 'A talking-to',
};

/**
 * Alla 24 synliga på en gång, med de tre vanligaste först. Att gömma resten
 * bakom "Something else…" sparade ingen plats värd namnet och lade ett tryck
 * mellan användaren och det hen letade efter.
 */
const ALL_TONE_IDS = [
  ...QUICK_TONE_IDS,
  ...Object.keys(SUPPORT_TYPE_LABELS).filter(id => !QUICK_TONE_IDS.includes(id)),
];


type IncomingRequest = {
  friendshipId: string;
  requester: Pick<Profile, 'id' | 'username' | 'avatar_url'>;
};

type Friend = Pick<Profile, 'id' | 'username' | 'avatar_url' | 'show_stats' | 'is_pausing'> & {
  friendshipId: string;
};

type SessionMap = Record<string, {
  active: PauseSession | null;
  latest: PauseSession | null;
}>;

type ProfileCardData = {
  id: string; username: string; avatar_url: string | null;
  kind: 'request';
  friendshipId: string;
  onAccept: () => void;
  onDecline: () => void;
} | {
  id: string; username: string; avatar_url: string | null;
  kind: 'friend';
  statusText: string | null;
  isPausing: boolean;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Äldre pauser än så här visas inte under en väns namn. */
const STATUS_MAX_HOURS = 7 * 24;

function friendStatusText(friend: Friend, sessionMap: SessionMap): string | null {
  if (friend.is_pausing) return 'pausing now';
  const entry = sessionMap[friend.id];
  // Pausstatistiken syns alltid för vänner; flaggan show_stats läses inte längre.
  if (!entry?.latest?.ended_at) return null;
  const minutesAgo = Math.floor(
    (Date.now() - new Date(entry.latest.ended_at).getTime()) / 60000
  );
  if (minutesAgo < 1) return 'paused just now';
  if (minutesAgo < 60) return `last paused ${minutesAgo} min ago`;
  const hoursAgo = Math.floor(minutesAgo / 60);
  // Efter ett dygn slutar timmar betyda något: "last paused 73 h ago" är en
  // siffra man måste räkna om i huvudet för att förstå.
  if (hoursAgo < 24) return `last paused ${hoursAgo} h ago`;
  // Bara veckans aktivitet visas. En gammal siffra läses som "ingen här
  // pausar" och tar lusten från den som läser — då står raden hellre tom.
  if (hoursAgo >= STATUS_MAX_HOURS) return null;
  const daysAgo = Math.floor(hoursAgo / 24);
  return daysAgo === 1 ? 'paused yesterday' : `paused ${daysAgo} days ago`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Avatar({ username, avatarUrl, size = 44 }: { username: string; avatarUrl?: string | null; size?: number }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  if (avatarUrl) {
    return <Image source={{ uri: avatarUrl }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  return (
    <View style={[styles.avatarFallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarLetter, { fontSize: size * 0.38 }]}>
        {username[0]?.toUpperCase() ?? '?'}
      </Text>
    </View>
  );
}

function ProfileCard({ data, onClose }: { data: ProfileCardData; onClose: () => void }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);

  // Hämtas när kortet öppnas och inte i listans load(): listan ritar upp till
  // åtta rader, och åtta RPC-anrop för något som syns först vid ett tryck är
  // åtta anrop för mycket. Samma skäl som medlemslistan i Kretsen hämtar sina
  // vänskapsrelationer först när modalen öppnas.
  const [circle, setCircle] = useState<FriendCircleBadge | null>(null);
  useEffect(() => {
    let alive = true;
    getFriendCircleBadge(data.id).then(c => { if (alive) setCircle(c); });
    return () => { alive = false; };
  }, [data.id]);

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.cardBackdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Avatar username={data.username} avatarUrl={data.avatar_url} size={80} />
          <Text style={styles.cardName}>{data.username}</Text>

          {/* Kretsen, om hen är med i någon. Nivån är kretsens gemensamma och
              inte hens egen — därför står kretsnamnet överst och nivån under
              som dess egenskap, inte tvärtom. Raden uteblir helt när svaret
              är null: "ingen krets" är inget kortet behöver säga. */}
          {circle && (circle.circles?.length ?? 1) <= 1 && (
            <View style={styles.cardCircle}>
              <CircleLevelBadge level={circle.level} size={44} />
              <View style={styles.cardCircleText}>
                {/* Etiketten säger vad namnet under den är. Utan den står ett
                    egennamn ensamt på ett kort och kan lika gärna vara
                    vad som helst. */}
                <Text style={styles.cardCircleEyebrow}>CIRCLE</Text>
                <Text style={styles.cardCircleName} numberOfLines={1}>{circle.circle_name}</Text>
                <Text style={styles.cardCircleLevel} numberOfLines={1}>LEVEL {circle.level}</Text>
                <Text style={styles.cardCircleLevelName} numberOfLines={1}>
                  {circleLevelName(circle.level)}
                </Text>
              </View>
            </View>
          )}
          {/* Två eller tre kretsar: en rad per krets, märke + namn + nivå.
              Nivåns namn faller bort — tre rader med fyra rader text var
              hade gjort kortet till en lista om kretsar i stället för om
              personen. Det står kvar i kretsens egen stege. */}
          {circle && (circle.circles?.length ?? 1) > 1 && (
            <View style={[styles.cardCircle, styles.cardCircleList]}>
              <Text style={styles.cardCircleEyebrow}>CIRCLES</Text>
              {circle.circles!.map((c, i) => (
                <View key={`${c.circle_name}-${i}`} style={styles.cardCircleListRow}>
                  <CircleLevelBadge level={c.level} size={32} />
                  <Text style={[styles.cardCircleName, styles.cardCircleListName]} numberOfLines={1}>
                    {c.circle_name}
                  </Text>
                  <Text style={styles.cardCircleLevel} numberOfLines={1}>LEVEL {c.level}</Text>
                </View>
              ))}
            </View>
          )}
          {data.kind === 'friend' && data.statusText && (
            <Text style={[styles.cardStatus, data.isPausing && styles.cardStatusActive]}>
              {data.statusText}
            </Text>
          )}
          {data.kind === 'request' && (
            <Text style={styles.cardStatus}>Wants to add you</Text>
          )}
          {data.kind === 'request' && (
            <View style={styles.cardActions}>
              <TouchableOpacity style={styles.acceptBtn} onPress={() => { data.onAccept(); onClose(); }} activeOpacity={0.8}>
                <Text style={styles.acceptBtnText}>Accept</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.declineBtn} onPress={() => { data.onDecline(); onClose(); }} activeOpacity={0.8}>
                <Text style={styles.declineBtnText}>Decline</Text>
              </TouchableOpacity>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * En väns paus man kan hänga på (lib/pauseInvites.ts). Värden har redan
 * börjat — det finns inget att tacka ja eller nej till, bara en dörr som står
 * öppen tills pausen slutar. *Not now* tar bort kortet tyst; värden får aldrig
 * veta det.
 */
function PauseInviteCard({
  invite,
  joining,
  onJoin,
  onDismiss,
}: {
  invite: IncomingPauseInvite;
  joining: boolean;
  onJoin: () => void;
  onDismiss: () => void;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  // Starten räknas ur utgången, för det är den enda tiden raden bär.
  const startedMin = Math.max(0, Math.round(
    (Date.now() - (new Date(invite.expiresAt).getTime() - PAUSE_INVITE_WINDOW_MS)) / 60000,
  ));
  return (
    <View style={styles.inviteCard}>
      <View style={styles.inviteTop}>
        <View style={styles.friendAvatar}>
          <Avatar username={invite.host.username} avatarUrl={invite.host.avatar_url} size={48} />
          <PulseDot color={Palette.accent} borderColor={Palette.surface} />
        </View>
        <View style={styles.inviteTextBlock}>
          <Text style={styles.inviteTitle} numberOfLines={1}>
            {invite.host.username} is pausing
          </Text>
          <Text style={styles.inviteSubtitle}>
            {startedMin < 1 ? 'Started just now' : `Started ${startedMin} min ago`} · join in?
          </Text>
        </View>
      </View>
      <View style={styles.inviteActions}>
        <TouchableOpacity
          style={[styles.pauseNowBtn, joining && { opacity: 0.6 }]}
          onPress={onJoin}
          disabled={joining}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`Join ${invite.host.username}'s pause`}
        >
          <FontAwesome name="pause" size={11} color={Palette.onAccent} />
          <Text style={styles.pauseNowText}>{joining ? 'Joining…' : 'Join'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.notNowBtn} onPress={onDismiss} activeOpacity={0.7}>
          <Text style={styles.notNowText}>Not now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * Ett tryck på en notis om en paus som hunnit sluta. Utan raden hade
 * notisen lett till en flik där ingenting stod om den — samma sak som en
 * trasig länk.
 */
function EndedInviteNote({ hostName, onDismiss }: { hostName: string; onDismiss: () => void }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  return (
    <View style={styles.endedNote} accessibilityLiveRegion="polite">
      <FontAwesome5 name="leaf" size={13} color={Palette.hue} />
      <Text style={styles.endedNoteText} numberOfLines={2}>
        {hostName}&apos;s pause has ended.
      </Text>
      <TouchableOpacity onPress={onDismiss} activeOpacity={0.7} style={styles.endedNoteBtn} hitSlop={8}>
        <Text style={styles.endedNoteBtnText}>OK</Text>
      </TouchableOpacity>
    </View>
  );
}

function RequestRow({
  req, onAccept, onDecline, onProfilePress,
}: {
  req: IncomingRequest;
  onAccept: () => void;
  onDecline: () => void;
  onProfilePress: () => void;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  return (
    <View style={styles.requestRow}>
      <TouchableOpacity onPress={onProfilePress} activeOpacity={0.7}>
        <Avatar username={req.requester.username} avatarUrl={req.requester.avatar_url} />
      </TouchableOpacity>
      <TouchableOpacity style={{ flex: 1 }} onPress={onProfilePress} activeOpacity={0.7}>
        <Text style={styles.rowUsername} numberOfLines={1}>{req.requester.username}</Text>
      </TouchableOpacity>
      <View style={styles.requestActions}>
        <TouchableOpacity style={styles.acceptBtn} onPress={onAccept} activeOpacity={0.8}>
          <Text style={styles.acceptBtnText}>Accept</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.declineBtn} onPress={onDecline} activeOpacity={0.8}>
          <Text style={styles.declineBtnText}>Decline</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Små rörelser ───────────────────────────────────────────────────────────
// Båda kör på UI-tråden och står still med reducerad rörelse.

/**
 * En ring som växer ut och tonar bort, EN gång, varje gång `trigger` ökar.
 * Noll betyder "aldrig" — så att ingenting pingar bara för att skärmen
 * monterades.
 */
function PingRing({ trigger, color, size, duration = 1400 }: {
  trigger: number; color: string; size: number; duration?: number;
}) {
  const reduceMotion = useReducedMotion();
  const p = useSharedValue(1);
  useEffect(() => {
    if (!trigger || reduceMotion) return;
    p.value = 0;
    p.value = withTiming(1, { duration, easing: REasing.out(REasing.quad) });
  }, [trigger, reduceMotion, duration, p]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.7 * (1 - p.value),
    transform: [{ scale: 0.94 + 0.24 * p.value }],
  }));
  return (
    <Reanimated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 2.5, borderColor: color },
        style,
      ]}
    />
  );
}

/**
 * Pricken vid en vän som pausar just nu, med en mjuk puls. Pulsen är den enda
 * rörelsen i listan som går utan att något hänt, och den finns därför bara
 * medan pausen pågår — och inte alls med reducerad rörelse.
 */
function PulseDot({ color, borderColor }: { color: string; borderColor: string }) {
  const reduceMotion = useReducedMotion();
  const p = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) { cancelAnimation(p); p.value = 0; return; }
    p.value = withRepeat(withTiming(1, { duration: 2000, easing: REasing.out(REasing.quad) }), -1, false);
    return () => cancelAnimation(p);
  }, [reduceMotion, p]);
  const ringStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0 : 0.7 * (1 - p.value),
    transform: [{ scale: 0.94 + 0.5 * p.value }],
  }));
  return (
    <View style={{ position: 'absolute', bottom: -1, right: -1, width: 15, height: 15, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
      <Reanimated.View
        style={[{ position: 'absolute', width: 21, height: 21, borderRadius: 10.5, borderWidth: 2, borderColor: color }, ringStyle]}
      />
      <View style={{ width: 15, height: 15, borderRadius: 7.5, backgroundColor: color, borderWidth: 3, borderColor }} />
    </View>
  );
}

/**
 * En rad i vänlistan. **Memoiserad på det den visar**, inte på objektet:
 * listan byggs om ur nya objekt vid varje hämtning och pollning, så en vanlig
 * `memo` hade aldrig sparat en enda rendering. Callbackarna tar vännen som
 * argument och är stabila i skärmen, och statusraden räknas där och kommer
 * hit som en sträng i stället för hela `sessionMap`.
 */
const FriendRow = memo(function FriendRow({
  friend, statusText, inviteOpen, onProfilePress, onInvite,
}: {
  friend: Friend;
  statusText: string | null;
  /** Vännen står bland de valda ovanför PAUSE på Hem (lib/pauseInvites.ts). */
  inviteOpen: boolean;
  onProfilePress: (friend: Friend, statusText: string | null) => void;
  onInvite: (friend: Friend) => void;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const isPausing = friend.is_pausing;

  // Ringen går en gång när bocken dyker upp — inte vid montering, och inte om
  // inbjudan redan var öppen när listan ritades första gången.
  const [invitePing, setInvitePing] = useState(0);
  const wasOpenRef = useRef(inviteOpen);
  useEffect(() => {
    if (inviteOpen && !wasOpenRef.current) setInvitePing(k => k + 1);
    wasOpenRef.current = inviteOpen;
  }, [inviteOpen]);

  // Statistiken fälls ut i kortet i stället för att öppna wrapped. Tillståndet
  // bor i raden, så memo-jämförelsen nedan behöver inte känna till det.
  const [statsOpen, setStatsOpen] = useState(false);

  return (
    <View style={styles.friendCard}>
    <View style={styles.friendRow}>
      <TouchableOpacity
        style={styles.friendLeft}
        onPress={() => onProfilePress(friend, statusText)}
        activeOpacity={0.75}
      >
        <View style={styles.friendAvatar}>
          <Avatar username={friend.username} avatarUrl={friend.avatar_url} size={50} />
          {isPausing && <PulseDot color={Palette.accent} borderColor={Palette.surface} />}
        </View>
        <View style={styles.friendInfo}>
          <Text style={styles.rowUsername} numberOfLines={1}>{friend.username}</Text>
          {statusText && (
            <Text style={[styles.statusText, isPausing && styles.statusTextActive]}>
              {statusText}
            </Text>
          )}
        </View>
      </TouchableOpacity>

      <View style={styles.friendActions}>
        {(
          <TouchableOpacity
            style={[styles.iconBtn, statsOpen && styles.iconBtnOpen]}
            onPress={() => setStatsOpen(o => !o)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityState={{ expanded: statsOpen }}
            accessibilityLabel={statsOpen ? `Hide ${friend.username}'s stats` : `Show ${friend.username}'s stats`}
          >
            <FontAwesome name="bar-chart" size={15} color={Palette.hue} />
          </TouchableOpacity>
        )}
        {/* En genväg till Hem: vännen läggs till bland de valda ovanför
            PAUSE, och inbjudan går ut när pausen startar — samma väg som
            väljaren där. Bocken står medan vännen är vald. Fylld i accenten,
            för ifyllt är accentens (se CLAUDE.md, *Rummet*). */}
        {!isPausing && (
          <View style={styles.iconBtnWrap}>
            <PingRing trigger={invitePing} color={Palette.accent} size={42} duration={1000} />
            <TouchableOpacity
              style={[styles.iconBtn, inviteOpen && styles.iconBtnSent]}
              onPress={() => onInvite(friend)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={inviteOpen ? `Remove ${friend.username} from your next pause` : `Invite ${friend.username} to your next pause`}
            >
              {inviteOpen ? (
                <FontAwesome5 name="check" size={13} color={Palette.onAccent} />
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 3 }}>
                  <FontAwesome5 name="pause" size={11} color={Palette.hue} />
                  <FontAwesome5 name="plus" size={7} color={Palette.hue} />
                </View>
              )}
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
    {statsOpen && <FriendWeekStats friendId={friend.id} />}
    </View>
  );
}, (a, b) =>
  a.friend.id === b.friend.id &&
  a.friend.username === b.friend.username &&
  a.friend.avatar_url === b.friend.avatar_url &&
  a.friend.show_stats === b.friend.show_stats &&
  a.friend.is_pausing === b.friend.is_pausing &&
  a.statusText === b.statusText &&
  a.inviteOpen === b.inviteOpen &&
  a.onProfilePress === b.onProfilePress &&
  a.onInvite === b.onInvite,
);

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // getDay(): söndag = 0

/**
 * En väns senaste sju dygn som sju rör: ett per dag, fyllt nerifrån efter hur
 * länge hen pausade mot veckans längsta dag. Rullande sju dygn som slutar idag
 * (därav rubriken), i lokal tid — samma läsning av `pause_sessions` som
 * `friend-wrapped.tsx` gör, så RLS släpper igenom samma rader. Hämtas när
 * kortet fälls ut och inte i listans `load()`, samma skäl som kretsmärket på
 * profilkortet.
 */
function FriendWeekStats({ friendId }: { friendId: string }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const [daySecs, setDaySecs] = useState<number[] | null>(null);

  const days = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (6 - i));
      return d;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('pause_sessions')
        .select('started_at, duration_seconds')
        .eq('user_id', friendId)
        .eq('kind', 'pause')
        .gte('started_at', days[0].toISOString())
        .not('ended_at', 'is', null);
      if (cancelled) return;
      const out: number[] = Array(7).fill(0);
      for (const row of data ?? []) {
        if (!row.started_at) continue;
        const start = new Date(row.started_at);
        // Jämför kalenderdagar, inte 24h-block — sommartid ger ett 23h-dygn.
        const i = days.findIndex(d =>
          d.getFullYear() === start.getFullYear() &&
          d.getMonth() === start.getMonth() &&
          d.getDate() === start.getDate());
        if (i >= 0) out[i] += row.duration_seconds ?? 0;
      }
      setDaySecs(out);
    })();
    return () => { cancelled = true; };
  }, [friendId, days]);

  const max = daySecs ? Math.max(...daySecs) : 0;

  return (
    <View style={styles.weekStats}>
      <Text style={styles.weekStatsLabel}>LAST 7 DAYS</Text>
      <View style={styles.weekBars}>
        {days.map((d, i) => {
          const secs = daySecs?.[i] ?? 0;
          // Ett golv så att en kort paus syns som en droppe och inte försvinner.
          const frac = max > 0 && secs > 0 ? Math.max(0.14, secs / max) : 0;
          return (
            <View
              key={i}
              style={styles.weekBarCol}
              accessible
              accessibilityLabel={`${d.toLocaleDateString('en', { weekday: 'long' })}: ${Math.round(secs / 60)} min`}
            >
              <View style={styles.weekBarTrack}>
                {frac > 0 && <View style={[styles.weekBarFill, { height: `${frac * 100}%` }]} />}
              </View>
              <Text style={styles.weekBarDay}>{WEEKDAY_INITIALS[d.getDay()]}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ─── Story bubbles (horisontell rad) ─────────────────────────────────────────

const BUBBLE_D = 68;

function StoryBubble({
  username, avatarUrl, ringColor, dimmed, onPress, isPlus, plusOpen = false, pingKey = 0,
}: {
  username: string; avatarUrl?: string | null;
  ringColor: string; dimmed?: boolean;
  onPress: () => void; isPlus?: boolean;
  /** Plusset vrids till ett kryss medan förfrågningsarket är öppet. */
  plusOpen?: boolean;
  /** Ringen pingar en gång när talet ökar. */
  pingKey?: number;
}) {
  const Palette = usePalette();
  const bubbleStyles = useMemo(() => makeBubbleStyles(Palette), [Palette]);
  const firstName = username.split(' ')[0];
  const reduceMotion = useReducedMotion();
  const turn = useSharedValue(plusOpen ? 1 : 0);
  useEffect(() => {
    turn.value = reduceMotion ? (plusOpen ? 1 : 0) : withTiming(plusOpen ? 1 : 0, { duration: 300 });
  }, [plusOpen, reduceMotion, turn]);
  const plusStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 45}deg` }] }));
  return (
    <TouchableOpacity style={bubbleStyles.wrap} onPress={onPress} activeOpacity={0.75}>
      <View style={[bubbleStyles.ring, { borderColor: dimmed ? alpha(Palette.community, 0.2) : ringColor }]}>
        <PingRing trigger={pingKey} color={ringColor} size={BUBBLE_D + 14} />
        {isPlus ? (
          <Reanimated.View style={[bubbleStyles.plusCircle, plusStyle]}>
            <FontAwesome5 name="plus" size={22} color={Palette.community} />
          </Reanimated.View>
        ) : (
          <View style={{ opacity: dimmed ? 0.45 : 1 }}>
            <Avatar username={username} avatarUrl={avatarUrl} size={BUBBLE_D} />
          </View>
        )}
        {dimmed && (
          <View style={bubbleStyles.checkBadge}>
            <FontAwesome5 name="check" size={8} color={Palette.onAccent} />
          </View>
        )}
      </View>
      <Text style={[bubbleStyles.name, dimmed && { opacity: 0.45 }]} numberOfLines={1}>
        {isPlus ? 'Add request' : firstName}
      </Text>
    </TouchableOpacity>
  );
}

function StoryRow({
  myStory, stories, respondedMap, onBubblePress, onPlusPress, plusOpen, pingKey,
}: {
  myStory: SupportStory | null;
  stories: SupportStory[];
  respondedMap: Record<string, { id: string; deliveredAt: string | null }>;
  onBubblePress: (index: number) => void;
  onPlusPress: () => void;
  plusOpen: boolean;
  pingKey: number;
}) {
  const Palette = usePalette();
  const bubbleStyles = useMemo(() => makeBubbleStyles(Palette), [Palette]);
  // Rubriken är ett substantiv och står alltid. "Ask for support" över
  // vännernas ansikten lästes som en uppmaning att be *dem* om stöd, när
  // raden visar att de ber *dig*. Och utan rubrik var plusset en okänd bubbla
  // precis när en förklaring behövdes mest.
  return (
    <View style={bubbleStyles.section}>
      <Text style={bubbleStyles.sectionLabel}>Support requests</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={bubbleStyles.row}
      >
        {myStory ? (
          <StoryBubble
            username={myStory.profile?.username ?? '?'}
            avatarUrl={myStory.profile?.avatar_url}
            ringColor={Palette.peer}
            onPress={() => onBubblePress(0)}
            // Den egna bubblan ersätter plusset när förfrågan gått ut, och
            // det är den som pingar: "din fråga är ute".
            pingKey={pingKey}
          />
        ) : (
          <StoryBubble
            username="Add request"
            ringColor={Palette.community}
            isPlus
            plusOpen={plusOpen}
            onPress={onPlusPress}
          />
        )}
        {stories.map((story, i) => (
          <StoryBubble
            key={story.id}
            username={story.profile?.username ?? '?'}
            avatarUrl={story.profile?.avatar_url}
            ringColor={Palette.community}
            dimmed={!!respondedMap[story.id]}
            onPress={() => onBubblePress((myStory ? 1 : 0) + i)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function StoryDetailModal({
  items, initialIndex, myUserId,
  respondedMap, onUndoResponse,
  onRespondText, onRespondVoice, onRespondVideo, onRespondPhoto,
  onDeactivateOwn, onClose,
}: {
  items: SupportStory[];
  initialIndex: number;
  myUserId: string;
  respondedMap: Record<string, { id: string; deliveredAt: string | null }>;
  onUndoResponse: (storyId: string) => Promise<void>;
  onRespondText: (storyId: string, ownerName: string) => void;
  onRespondVoice: (storyId: string, ownerName: string) => void;
  onRespondVideo: (storyId: string, ownerName: string) => void;
  onRespondPhoto: (storyId: string, ownerName: string) => void;
  onDeactivateOwn: () => Promise<void>;
  onClose: () => void;
}) {
  const Palette = usePalette();
  const storyModalStyles = useMemo(() => makeStoryModalStyles(Palette), [Palette]);
  const listRef = useRef<FlatList<SupportStory>>(null);
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const SCREEN_W = Dimensions.get('window').width;

  const renderItem = ({ item }: { item: SupportStory }) => {
    const isOwn = item.user_id === myUserId;
    // Ett vokabulär för båda sorternas stories, så etiketterna slås upp
    // likadant oavsett var storyn skapades. Bara ingressen skiljer.
    const fromList = !!item.wishlist_item_id;
    const typeLabels = item.support_type
      ? item.support_type.split(',').map(id => SUPPORT_TYPE_LABELS[id.trim()] ?? id.trim())
      : [];
    const responded = !!respondedMap[item.id];
    const responseDelivered = respondedMap[item.id]?.deliveredAt != null;
    const name = item.profile?.username ?? '?';
    const intentionEmoji = item.intention_id
      ? DEFAULT_CATEGORIES.find(c => c.id === item.intention_id)?.emoji
      : undefined;

    return (
      <View style={[storyModalStyles.page, { width: SCREEN_W }]}>
        <View style={storyModalStyles.inner}>
          <View style={storyModalStyles.avatarWrap}>
            <View style={[storyModalStyles.avatarRing, { borderColor: isOwn ? Palette.peer : Palette.community }]}>
              <Avatar username={name} avatarUrl={item.profile?.avatar_url} size={88} />
            </View>
          </View>

          <Text style={storyModalStyles.nameText}>{name}</Text>


          {/* Kortet hade allt i en hög: emoji, etikett, aktivitet, piller och
              not i ungefär samma vikt, centrerat. Inget ledde. Nu är
              aktiviteten ensam stor, allt annat är dess sammanhang — och de
              tre delarna skiljs av linjer i stället för av tomrum. */}
          <View style={storyModalStyles.ownContentCard}>
            <View style={storyModalStyles.askBlock}>
              {intentionEmoji && (
                <View style={storyModalStyles.emojiBadge}>
                  <Text style={storyModalStyles.bigEmoji}>{intentionEmoji}</Text>
                </View>
              )}
              {!!item.activity && (
                <>
                  <Text style={storyModalStyles.activityPrefix}>
                    {fromList ? 'wants to' : 'needs motivation to'}
                  </Text>
                  <Text style={storyModalStyles.activityLabel}>{item.activity}</Text>
                </>
              )}
            </View>

            {typeLabels.length > 0 && (
              <>
                <View style={storyModalStyles.ownCardDivider} />
                <Text style={storyModalStyles.cardEyebrow}>Asked for</Text>
                <View style={storyModalStyles.typePillRow}>
                  {typeLabels.map(label => (
                    <View key={label} style={storyModalStyles.typePill}>
                      <Text style={storyModalStyles.typePillText}>{label}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}

            {!!item.personal_note && (
              <>
                <View style={storyModalStyles.ownCardDivider} />
                <View style={storyModalStyles.quoteBlock}>
                  <Text style={storyModalStyles.noteText}>{item.personal_note}</Text>
                </View>
              </>
            )}

            {/* I hörnet och utanför flödet: tiden är en fotnot till
                förfrågan, inte en fjärde del av den. Kortets översta rad är
                emojin eller den korta ingressen, båda centrerade, så hörnet
                är ledigt. */}
            <Text style={storyModalStyles.timeLeftText}>{storyTimeLeft(item)}</Text>
          </View>

          {isOwn ? (
            <TouchableOpacity style={storyModalStyles.deactivateBtn} onPress={onDeactivateOwn} activeOpacity={0.8}>
              <FontAwesome5 name="times-circle" size={13} color={Palette.dangerSoft} />
              <Text style={storyModalStyles.deactivateBtnText}>Remove request</Text>
            </TouchableOpacity>
          ) : responded ? (
            <View style={storyModalStyles.respondedRow}>
              <Text style={storyModalStyles.respondedText}>✓  Sent</Text>
              {!responseDelivered && (
                <TouchableOpacity onPress={() => onUndoResponse(item.id)} activeOpacity={0.7}>
                  <Text style={storyModalStyles.undoText}>Undo</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <View style={storyModalStyles.respondBtns}>
              <TouchableOpacity style={storyModalStyles.respondBtn} onPress={() => onRespondText(item.id, name)} activeOpacity={0.8}>
                <FontAwesome5 name="comment-alt" size={13} color={Palette.communitySoft} />
                <Text style={storyModalStyles.respondBtnText}>Text</Text>
              </TouchableOpacity>
              <TouchableOpacity style={storyModalStyles.respondBtn} onPress={() => onRespondVoice(item.id, name)} activeOpacity={0.8}>
                <FontAwesome5 name="microphone" size={13} color={Palette.communitySoft} />
                <Text style={storyModalStyles.respondBtnText}>Voice</Text>
              </TouchableOpacity>
              <TouchableOpacity style={storyModalStyles.respondBtn} onPress={() => onRespondVideo(item.id, name)} activeOpacity={0.8}>
                <FontAwesome5 name="video" size={13} color={Palette.communitySoft} />
                <Text style={storyModalStyles.respondBtnText}>Video</Text>
              </TouchableOpacity>
              <TouchableOpacity style={storyModalStyles.respondBtn} onPress={() => onRespondPhoto(item.id, name)} activeOpacity={0.8}>
                <FontAwesome5 name="camera" size={13} color={Palette.communitySoft} />
                <Text style={storyModalStyles.respondBtnText}>Photo</Text>
              </TouchableOpacity>
            </View>
          )}

        </View>
      </View>
    );
  };

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={storyModalStyles.container}>
        {/* Stänger-knapp */}
        <TouchableOpacity style={storyModalStyles.closeBtn} onPress={onClose} activeOpacity={0.7}>
          <FontAwesome5 name="times" size={18} color={Palette.ink50} />
        </TouchableOpacity>

        {/* Dots-indikator */}
        {items.length > 1 && (
          <View style={storyModalStyles.dotsRow}>
            {items.map((_, i) => (
              <View key={i} style={[storyModalStyles.dot, i === currentIndex && storyModalStyles.dotActive]} />
            ))}
          </View>
        )}

        <FlatList
          ref={listRef}
          data={items}
          renderItem={renderItem}
          keyExtractor={item => item.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={initialIndex}
          getItemLayout={(_, index) => ({ length: SCREEN_W, offset: SCREEN_W * index, index })}
          onMomentumScrollEnd={e => {
            setCurrentIndex(Math.round(e.nativeEvent.contentOffset.x / SCREEN_W));
          }}
        />
      </View>
    </Modal>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

/** Se HomeRoom i app/(tabs)/index.tsx — en komponent kan inte läsa sin egen
 *  provider, så rummet ligger i ett skal runt skärmen. */
export default function FriendsRoom() {
  return (
    <RoomProvider room="friends">
      <View style={roomShell}>
        <ScreenBackground room="friends" />
        <FriendsScreen />
      </View>
    </RoomProvider>
  );
}

function FriendsScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const { user } = useAuth();
  // Gestfältet/knappraden är olika hög på olika telefoner, så lakanets
  // bottenmarginal måste läsas av enheten i stället för gissas till ett tal.
  const insets = useSafeAreaInsets();
  const [requests, setRequests] = useState<IncomingRequest[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [sessionMap, setSessionMap] = useState<SessionMap>({});
  // Vänners pauser man kan hänga på (lib/pauseInvites.ts).
  const [invites, setInvites] = useState<IncomingPauseInvite[]>([]);
  const [joiningInviteId, setJoiningInviteId] = useState<string | null>(null);
  // Värden för en inbjudan vars notis trycktes på men vars paus hunnit sluta.
  const [endedInviteHost, setEndedInviteHost] = useState<string | null>(null);
  const { pauseInvite: tappedSharedId } = useLocalSearchParams<{ pauseInvite?: string }>();
  // Valet ovanför PAUSE på Hem. Raden visar en bock för den som är vald.
  const inviteSelection = usePauseInviteSelection();
  const selectedIds = useMemo(() => new Set(inviteSelection.map(f => f.id)), [inviteSelection]);
  const [inviteCategories, setInviteCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [profileCard, setProfileCard] = useState<ProfileCardData | null>(null);
  const friendIdsRef = useRef<string[]>([]);
  const [stories, setStories] = useState<SupportStory[]>([]);
  const [myStory, setMyStory] = useState<SupportStory | null>(null);
  const [respondedMap, setRespondedMap] = useState<Record<string, { id: string; deliveredAt: string | null }>>({}); // storyId → { id, deliveredAt }
  const [storyModalIndex, setStoryModalIndex] = useState<number | null>(null);

  // Inkorgen för stöd-svar. Låg på Hem förut, men hör hemma här: det är
  // Community-innehåll, och Hem behövde botten fri. Flikens egen badge i
  // (tabs)/_layout.tsx räknar in dem, så man ser dem utan att besöka fliken.
  //
  // Två kanaler och inte fyra: luren är det som ringer (röst och video), och
  // kuvertet är det som bara ligger där (text och foto). Fotot fick alltså
  // ingen egen knapp — tre ikoner på rubrikraden hade gjort den till en
  // verktygslåda, samma skäl som kretsens rubrikrad inte fick en tredje.
  const [pendingVoiceVideo, setPendingVoiceVideo] = useState(0);
  const [pendingQuiet, setPendingQuiet] = useState(0);

  // Vänradernas tryck, stabila så att `FriendRow`s memo håller. Veckan fälls
  // ut i själva kortet (`FriendWeekStats`) och behöver ingen callback.
  const openFriendProfile = useCallback((friend: Friend, statusText: string | null) => {
    setProfileCard({ ...friend, kind: 'friend', statusText, isPausing: friend.is_pausing });
  }, []);
  // Genvägen till Hem: vännen läggs till bland de valda (eller står redan
  // där), och Hem visar den ovanför PAUSE. Inbjudan går ut när pausen startar.
  // Bocken är en växel: står vännen redan bland de valda tas hen bort, och man
  // stannar kvar i Friends — det finns ingenting att se på Hem efter ett
  // ångrat val.
  const openFriendInvite = useCallback((friend: Friend) => {
    const current = getPauseInviteSelection();
    if (current.some(f => f.id === friend.id)) {
      setPauseInviteSelection(current.filter(f => f.id !== friend.id));
      return;
    }
    if (current.length >= MAX_PAUSE_INVITEES) {
      Alert.alert('That’s a full pause', `You can invite up to ${MAX_PAUSE_INVITEES} friends at a time.`);
      return;
    }
    setPauseInviteSelection([...current, {
      id: friend.id,
      username: friend.username ?? '?',
      avatar_url: friend.avatar_url?.startsWith('https://') ? friend.avatar_url : null,
      is_pausing: !!friend.is_pausing,
    }]);
    router.navigate('/(tabs)' as never);
  }, []);

  // Dela en punkt från listan som story. Två steg: vad, sedan i vilken ton.
  const [storySheet, setStorySheet] = useState(false);
  // Tangentbordets höjd, mätt för hand — samma lösning som circle-chat.tsx
  // och todo-sheet.tsx. KeyboardAvoidingView gjorde ingenting på Android
  // (`edgeToEdgeEnabled` stänger av `adjustResize`), så *Or write something
  // else…* låg under tangentbordet. Lägg inte tillbaka en KAV ovanpå, då
  // räknas tangentbordet två gånger på iOS.
  const [storyKeyboard, setStoryKeyboard] = useState(0);
  useEffect(() => {
    if (!storySheet) return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, e => setStoryKeyboard(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvt, () => setStoryKeyboard(0));
    return () => { show.remove(); hide.remove(); setStoryKeyboard(0); };
  }, [storySheet]);
  // Ökar när en förfrågan publicerats, och får den egna bubblans ring att
  // pinga en gång. Noll vid montering, så att ingenting pingar vid laddning.
  const [storyPingKey, setStoryPingKey] = useState(0);
  const [storyStep, setStoryStep] = useState<1 | 2>(1);
  const [storyItems, setStoryItems] = useState<{ id: string; text: string }[]>([]);
  const [storyPickedId, setStoryPickedId] = useState<string | null>(null);
  const [storyCategory, setStoryCategory] = useState<Category | null>(null);
  const [storyFreeText, setStoryFreeText] = useState('');
  const [storyTypes, setStoryTypes] = useState<string[]>([]);
  const [publishingStory, setPublishingStory] = useState(false);

  // Ämnet kommer från exakt en av tre källor. Att välja i en nollställer de
  // andra två — annars går det att skicka in ett motsägelsefullt läge.
  const pickFromList = (id: string) => { setStoryPickedId(id); setStoryCategory(null); setStoryFreeText(''); };
  const pickCategory = (c: Category) => { setStoryCategory(c); setStoryPickedId(null); setStoryFreeText(''); };
  const pickFreeText = (t: string) => { setStoryFreeText(t); if (t) { setStoryPickedId(null); setStoryCategory(null); } };

  const storySubject = storyPickedId
    ? (storyItems.find(i => i.id === storyPickedId)?.text ?? '')
    : storyCategory ? storyCategory.label
    : storyFreeText.trim();

  const openStorySheet = async () => {
    setStoryStep(1);
    setStoryPickedId(null);
    setStoryCategory(null);
    setStoryFreeText('');
    setStoryTypes([]);
    setStorySheet(true);
    if (!user) return;
    const { data } = await supabase
      .from('wishlist_items')
      .select('id, text')
      .eq('user_id', user.id)
      .is('done_at', null)
      .order('created_at', { ascending: false });
    setStoryItems(data ?? []);
  };

  const handlePublishStory = async () => {
    if (!user || storyTypes.length === 0 || publishingStory) return;
    setPublishingStory(true);
    try {
      // Bara ämnen som PLOCKATS ur listan hänger ihop med en punkt. En
      // kategori eller en fritext är en fråga i stunden — den ska inte
      // hamna på "On my list", där man bara vill se det man själv lagt dit.
      const { error } = await supabase.rpc('activate_story', {
        p_item_id: storyPickedId,
        p_tone: storyTypes.join(','),
        p_intention_id: storyCategory?.id ?? null,
        p_activity: storyPickedId ? null : storySubject,
      });
      if (error) throw new Error(error.message);

      // Den som just bett om stöd vill veta när svaret kommer — se
      // `enablePushNotifications`. Väntas inte in.
      enablePushNotifications().catch(() => {});

      // Ingen text och inget ämne: om stödet gällde en punkt ur listan, en
      // kategori eller en fritext räcker för att se vilken ingång folk
      // använder, och ämnet är deras eget.
      track('support_story_shared', {
        from_wishlist: !!storyPickedId,
        tones: storyTypes.length,
        has_category: !!storyCategory,
      });

      setStorySheet(false);
      fetchStories();
      setStoryPingKey(k => k + 1);
    } catch (e: any) {
      Alert.alert('Could not share', e.message);
    } finally {
      setPublishingStory(false);
    }
  };
  const pendingNavRef = useRef<(() => void) | null>(null);

  // Kör pending navigation efter att story-modalen stängt
  useEffect(() => {
    if (storyModalIndex === null && pendingNavRef.current) {
      const nav = pendingNavRef.current;
      pendingNavRef.current = null;
      const t = setTimeout(nav, 350);
      return () => clearTimeout(t);
    }
  }, [storyModalIndex]);

  // ── Sessions ──────────────────────────────────────────────────────────────

  const fetchSessions = useCallback(async (ids: string[]) => {
    if (ids.length === 0) { setSessionMap({}); return; }
    const { data } = await supabase
      .from('pause_sessions')
      .select('id, user_id, started_at, ended_at, duration_seconds, intention, is_shared, shared_session_id, invite_status, with_pod, completed, box_id, box_seq, kind, wake_count, awake_seconds')
      .in('user_id', ids)
      .eq('kind', 'pause')
      .order('started_at', { ascending: false });

    const map: SessionMap = {};
    for (const id of ids) {
      const userSessions = (data ?? []).filter(s => s.user_id === id);
      map[id] = {
        active: userSessions.find(s => !s.ended_at && s.started_at && !['pending', 'sent', 'declined'].includes(s.invite_status as string)) ?? null,
        latest: userSessions.find(s => !!s.ended_at) ?? null,
      };
    }
    setSessionMap(map);
  }, []);

  // ── Friends & requests ────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    if (!user) return;

    const { data: reqData } = await supabase
      .from('friendships')
      .select('id, requester_id, requester:profiles!requester_id(id, username, avatar_url)')
      .eq('receiver_id', user.id)
      .eq('status', 'pending');

    setRequests(
      (reqData ?? []).map((r: any) => ({
        friendshipId: r.id,
        requester: r.requester ?? { id: r.requester_id, username: 'Unknown user', avatar_url: null },
      }))
    );

    const { data: friendData } = await supabase
      .from('friendships')
      .select(`
        id, requester_id, receiver_id,
        requester:profiles!requester_id(id, username, avatar_url, show_stats, is_pausing),
        receiver:profiles!receiver_id(id, username, avatar_url, show_stats, is_pausing)
      `)
      .or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`)
      .eq('status', 'accepted');

    const friendList: Friend[] = (friendData ?? [])
      .filter((f: any) => {
        const isRequester = f.requester_id === user.id;
        return isRequester ? f.receiver != null : f.requester != null;
      })
      .map((f: any) => {
        const isRequester = f.requester_id === user.id;
        const profile = isRequester ? f.receiver : f.requester;
        return { ...profile, friendshipId: f.id };
      });

    setFriends(friendList);
    const ids = friendList.map(f => f.id);
    friendIdsRef.current = ids;
    await fetchSessions(ids);
  }, [user, fetchSessions]);

  // ── Pausinbjudningar ──────────────────────────────────────────────────────
  // Vänners pauser som pågår och som man kan hänga på. Samma fråga som
  // flikbrickan, så att brickan räknar det som står här.

  const fetchInvites = useCallback(async () => {
    if (!user) return;
    setInvites(await fetchIncomingPauseInvites(user.id));
  }, [user]);

  // ── Support stories ───────────────────────────────────────────────────────

  const fetchStories = useCallback(async () => {
    if (!user) return;
    // Varje förfrågan faller ur raden efter 24 timmar — se lib/supportStories.ts.
    const { data } = await supabase
      .from('support_stories')
      .select('id, user_id, support_type, activity, intention_id, personal_note, created_at, wishlist_item_id, expires_at, profile:profiles!user_id(id, username, avatar_url)')
      .eq('is_active', true)
      .or(liveStoryFilter())
      .order('created_at', { ascending: false });

    const all = ((data ?? []) as any[]).map(s => ({
      ...s,
      profile: Array.isArray(s.profile) ? (s.profile[0] ?? null) : (s.profile ?? null),
    })) as SupportStory[];
    setMyStory(all.find(s => s.user_id === user.id) ?? null);
    setStories(all.filter(s => s.user_id !== user.id));

    if (all.length > 0) {
      const { data: myResponses } = await supabase
        .from('support_responses')
        .select('id, story_id, delivered_at')
        .eq('sender_id', user.id)
        .in('story_id', all.map(s => s.id));

      const map: Record<string, { id: string; deliveredAt: string | null }> = {};
      for (const r of (myResponses ?? [])) map[r.story_id] = { id: r.id, deliveredAt: r.delivered_at };
      setRespondedMap(map);
    }
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      if (!user?.id) return;
      const checkPending = async () => {
        // Svaren överlever förfrågan, så inkorgen räknar svar på alla egna
        // stories — också utgångna och borttagna.
        const [{ count: vvCount }, { count: quietCount }] = await Promise.all([
          unopenedResponsesQuery(user.id, 'id', { count: 'exact', head: true })
            .in('response_type', ['voice', 'video']),
          unopenedResponsesQuery(user.id, 'id', { count: 'exact', head: true })
            .in('response_type', ['text', 'photo']),
        ]);

        setPendingVoiceVideo(vvCount ?? 0);
        setPendingQuiet(quietCount ?? 0);
      };
      checkPending();
    }, [user?.id])
  );

  const handleCallChannel = () => {
    if (pendingVoiceVideo === 0) {
      Alert.alert('No messages', 'You have no support messages right now.');
      return;
    }
    router.push('/call');
  };

  // Kuvertets kanal: det äldsta oöppnade svaret som inte ringer, oavsett om
  // det är skrivet eller fotograferat. Sorten avgör bara vilken skärm som
  // öppnas — båda är pepp som landat tyst, och båda slutar med samma två val.
  const handleQuietChannel = async () => {
    if (!user?.id) return;

    const { data: response } = await unopenedResponsesQuery(
      user.id, 'id, response_type, text_content, content_url, caption_y, sender_id',
    )
      .in('response_type', ['text', 'photo'])
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (response) {
      const { data: sender } = await supabase
        .from('profiles')
        .select('username, avatar_url')
        .eq('id', response.sender_id)
        .maybeSingle();

      if (response.response_type === 'photo') {
        router.push({
          pathname: '/support-view-photo',
          params: {
            messageId: response.id,
            photoUrl: response.content_url ?? '',
            caption: response.text_content ?? '',
            // Null blir en tom sträng här, och visningsskärmen läser den som
            // "inget sparat läge" och faller tillbaka på mitten.
            captionY: response.caption_y == null ? '' : String(response.caption_y),
            senderName: sender?.username ?? 'A friend',
          },
        } as any);
        return;
      }

      router.push({
        pathname: '/text-message',
        params: {
          messageId: response.id,
          textContent: response.text_content ?? '',
          senderName: sender?.username ?? 'A friend',
          senderAvatarUrl: sender?.avatar_url ?? '',
          isSupport: 'true',
        },
      } as any);
      return;
    }

    Alert.alert('No messages', 'You have no support messages right now.');
  };

  // Hänga på en väns paus. Servern avgör om dörren fortfarande står öppen —
  // värden kan ha slutat i sekunden mellan pollningen och trycket.
  const joinInvite = async (invite: IncomingPauseInvite) => {
    if (joiningInviteId) return;
    // Efter midnatt blir det en natt i stället, och en natt är privat — den
    // hänger inte på någons paus, så inbjudan besvaras inte (lib/homeMode.ts).
    if (isNightHours()) { startSleep('push', 'night_hours'); return; }
    setJoiningInviteId(invite.id);
    try {
      const { sharedId, hostName } = await joinPauseInvite(invite.id);
      setInvites(prev => prev.filter(i => i.id !== invite.id));
      // Samma lådlösa start som PAUSE på Hem, bara med pausens id och
      // värdens namn. Intentionen ställs efteråt, som för varje paus.
      router.push({
        pathname: '/pausing',
        params: {
          mode: 'session',
          category: '',
          withPod: 'false',
          pauseType: 'session',
          targetSeconds: '0',
          sharedSessionId: sharedId,
          sharedWithName: hostName,
        },
      } as never);
    } catch (e: any) {
      Alert.alert('Too late to join', e.message);
      fetchInvites();
    } finally {
      setJoiningInviteId(null);
    }
  };

  // *Not now*. Tyst åt båda håll — värden får aldrig veta.
  const dismissInvite = async (invite: IncomingPauseInvite) => {
    setInvites(prev => prev.filter(i => i.id !== invite.id));
    await dismissPauseInvite(invite.id);
  };

  // Kom vi hit från en notis om en paus som redan slutat? Då står inget kort
  // för den, och raden säger varför i stället för att inte säga något.
  useEffect(() => {
    if (!tappedSharedId || !user) return;
    let alive = true;
    (async () => {
      const open = await fetchIncomingPauseInvites(user.id);
      if (!alive) return;
      setInvites(open);
      if (open.some(i => i.sharedId === tappedSharedId)) { setEndedInviteHost(null); return; }
      const { data } = await supabase
        .from('pause_invites')
        .select('joined_at, host:profiles!host_id(username)')
        .eq('shared_id', tappedSharedId)
        .eq('invitee_id', user.id)
        .maybeSingle();
      if (!alive) return;
      // Redan med (eller raden finns inte): inget att förklara.
      const host = (data as any)?.host?.username as string | undefined;
      setEndedInviteHost(data && !data.joined_at && host ? host : null);
    })();
    return () => { alive = false; };
  }, [tappedSharedId, user]);

  // ── Vänförfrågningar ──────────────────────────────────────────────────────

  const acceptRequest = async (friendshipId: string) => {
    await supabase.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId);
    track('friend_request_accepted');
    // En vän är någon vars stödförfrågningar kan knacka — se
    // `enablePushNotifications`.
    enablePushNotifications().catch(() => {});
    fetchAll();
  };

  const declineRequest = async (friendshipId: string) => {
    await supabase.from('friendships').delete().eq('id', friendshipId);
    track('friend_request_declined');
    setRequests(prev => prev.filter(r => r.friendshipId !== friendshipId));
  };

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    getSelectedCategories().then(cats => {
      setInviteCategories(cats.length > 0 ? cats : DEFAULT_CATEGORIES);
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchAll(), fetchInvites(), fetchStories()]).finally(() => setLoading(false));
  }, [fetchAll, fetchInvites, fetchStories]);

  useFocusEffect(useCallback(() => { fetchStories(); }, [fetchStories]));

  // Polling — ny inbjudan dyker upp utan att användaren behöver refresha
  useFocusEffect(useCallback(() => {
    fetchInvites();
    const poll = setInterval(fetchInvites, 3000);
    return () => clearInterval(poll);
  }, [fetchInvites]));

  /**
   * "pausing now" under en väns namn, pollad.
   *
   * `is_pausing` är enda signalen för att en vän pausar just nu: en ensam paus
   * skriver ingen rad i `pause_sessions` förrän den är slut (se insert:en i
   * app/pausing.tsx), så `sessionMap[id].active` finns bara för delade pauser.
   *
   * Och `fetchAll()` — det enda som läste flaggan — kördes bara vid montering.
   * Flikarna avmonteras inte när man byter flik, så att gå till Community och
   * tillbaka räknade inte som en ny montering: statusen stod kvar som den var
   * när appen startade. Kvar fanns realtime-kanalen nedan, och den kräver att
   * `profiles` ligger i publikationen `supabase_realtime` — är den inte
   * påslagen för tabellen kommer UPDATE-händelsen aldrig, och "pausing now"
   * gick bara att framkalla med en dragning nedåt.
   *
   * Pollningen är därför golvet, inte optimeringen: realtime är fortfarande
   * den snabba vägen när den är påslagen, men funktionen får inte hänga på en
   * inställning som inte syns i koden.
   *
   * En egen smal fråga och inte `fetchAll()`: den läser tre tabeller och ska
   * inte gå var femte sekund. Här räcker en kolumn för en handfull id:n, och
   * `setFriends` hoppas över helt när ingenting ändrats — annars ritas hela
   * listan om tolv gånger i minuten utan att något blivit nytt.
   */
  const fetchPausingNow = useCallback(async () => {
    const ids = friendIdsRef.current;
    if (ids.length === 0) return;

    const { data, error } = await supabase
      .from('profiles')
      .select('id, is_pausing')
      .in('id', ids);

    if (error) {
      console.log('[friends] fetchPausingNow error:', error.message);
      return;
    }

    const live = new Map((data ?? []).map((r: any) => [r.id as string, !!r.is_pausing]));
    setFriends(prev => {
      let changed = false;
      const next = prev.map(f => {
        const v = live.get(f.id);
        if (v === undefined || v === f.is_pausing) return f;
        changed = true;
        return { ...f, is_pausing: v };
      });
      return changed ? next : prev;
    });
  }, []);

  useFocusEffect(useCallback(() => {
    fetchPausingNow();
    const poll = setInterval(fetchPausingNow, 5000);
    return () => clearInterval(poll);
  }, [fetchPausingNow]));

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`friend-realtime-${user.id}-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pause_sessions' }, (payload) => {
        const uid = (payload.new as any)?.user_id ?? (payload.old as any)?.user_id;
        if (uid === user.id) {
          fetchInvites();
        } else if (uid && friendIdsRef.current.includes(uid)) {
          fetchSessions(friendIdsRef.current);
        }
      })
      // Den här grenen bär "pausing now" i realtid — men bara om `profiles`
      // ligger i publikationen `supabase_realtime` (Database → Replication i
      // Supabase, av som förval per tabell). Är den av kommer händelsen aldrig,
      // och ingenting i koden säger till. Därför pollar `fetchPausingNow`
      // ovan parallellt: den här är snabbare, den är inte garantin.
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (payload) => {
        const uid = (payload.new as any)?.id;
        if (uid && friendIdsRef.current.includes(uid)) {
          fetchAll();
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchAll(), fetchInvites(), fetchStories()]);
    setRefreshing(false);
  };

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color={Palette.accent} /></View>;
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: Math.max(60, insets.top + 8) }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Palette.accent} />}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.logoRow}>
          <FontAwesome name="pause" size={16} color={Palette.hue} />
          <Text style={styles.logoText}>PAUSEPOD</Text>
        </View>
        <View style={styles.titleWithInbox}>
          <Text style={styles.title}>FRIENDS</Text>
          <View style={styles.inboxRow}>
            <TouchableOpacity style={styles.inboxBtn} onPress={handleCallChannel} activeOpacity={0.8}>
              <FontAwesome5 name="phone-alt" size={15} color={Palette.hue} />
              {pendingVoiceVideo > 0 && (
                <View style={styles.inboxBadge}>
                  <Text style={styles.inboxBadgeText}>{pendingVoiceVideo > 9 ? '9+' : pendingVoiceVideo}</Text>
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.inboxBtn} onPress={handleQuietChannel} activeOpacity={0.8}>
              {/* Kuvert och inte pratbubbla: knappen är en INKORG för
                  färdiga pep-meddelanden man fått, inte en ingång till ett
                  samtal. Bubblan står numera för kretsens chatt, där det
                  faktiskt går att svara — samma ikon för båda hade lovat
                  en tråd som inte finns här. Pratbubblan längre upp
                  (`comment-alt`, bredvid Voice och Video) är kvar: den
                  väljer ett medium att svara i, och är inte den här.
                  Kuvertet bär både text och foto, och är fortfarande ett
                  kuvert: det är vad man öppnar, inte vad som ligger i. */}
              <FontAwesome5 name="envelope" size={15} color={Palette.hue} solid />
              {pendingQuiet > 0 && (
                <View style={styles.inboxBadge}>
                  <Text style={styles.inboxBadgeText}>{pendingQuiet > 9 ? '9+' : pendingQuiet}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Vänners pauser som pågår och går att hänga på. Ingen väntar på
          svar, så inbjudarens sida har ingenting här. */}
      {(invites.length > 0 || endedInviteHost) && (
        <View style={styles.section}>
          {endedInviteHost && (
            <EndedInviteNote hostName={endedInviteHost} onDismiss={() => setEndedInviteHost(null)} />
          )}
          {invites.map(invite => (
            <PauseInviteCard
              key={invite.id}
              invite={invite}
              joining={joiningInviteId === invite.id}
              onJoin={() => joinInvite(invite)}
              onDismiss={() => dismissInvite(invite)}
            />
          ))}
        </View>
      )}

      {/* Inkommande vänförfrågningar */}
      {requests.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionLabelRow}>
            <Text style={styles.sectionLabel}>INCOMING</Text>
            <View style={styles.sectionBadge}>
              <Text style={styles.sectionBadgeText}>{requests.length}</Text>
            </View>
          </View>
          {requests.map(req => (
            <RequestRow
              key={req.friendshipId}
              req={req}
              onAccept={() => acceptRequest(req.friendshipId)}
              onDecline={() => declineRequest(req.friendshipId)}
              onProfilePress={() => setProfileCard({
                ...req.requester,
                kind: 'request',
                friendshipId: req.friendshipId,
                onAccept: () => acceptRequest(req.friendshipId),
                onDecline: () => declineRequest(req.friendshipId),
              })}
            />
          ))}
        </View>
      )}

      {/* Anrop — story bubbles */}
      <StoryRow
        myStory={myStory}
        stories={stories}
        respondedMap={respondedMap}
        onBubblePress={(index) => setStoryModalIndex(index)}
        onPlusPress={openStorySheet}
        plusOpen={storySheet}
        pingKey={storyPingKey}
      />

      {/* Vänlista */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>YOUR FRIENDS</Text>
        {friends.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>You don't have any friends yet.</Text>
            <TouchableOpacity onPress={() => router.push('/add-friend' as never)}>
              <Text style={styles.emptyLink}>Add your first friend →</Text>
            </TouchableOpacity>
          </View>
        ) : (
          friends.map(friend => (
            <FriendRow
              key={friend.id}
              friend={friend}
              statusText={friendStatusText(friend, sessionMap)}
              inviteOpen={selectedIds.has(friend.id)}
              onProfilePress={openFriendProfile}
              onInvite={openFriendInvite}
            />
          ))
        )}
      </View>

      {/* Lägg till vän */}
      <TouchableOpacity
        style={styles.addFriendBtn}
        onPress={() => router.push('/add-friend' as never)}
        activeOpacity={0.85}
      >
        <FontAwesome5 name="user-plus" size={14} color={Palette.accent} />
        <Text style={styles.addFriendText}>Add friend</Text>
      </TouchableOpacity>

      {/* Profilkort */}
      {profileCard && (
        <ProfileCard data={profileCard} onClose={() => setProfileCard(null)} />
      )}

      {/* Dela en punkt som story — steg 1 vad, steg 2 i vilken ton */}
      {/* Genomskinliga systemfält, så att tangentbordets höjd och modalens
          koordinater mäts mot samma fönster — samma som todo-sheet.tsx. */}
      <Modal
        visible={storySheet}
        transparent
        animationType="slide"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setStorySheet(false)}
      >
        <View style={[styles.storyOverlay, { paddingBottom: storyKeyboard }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setStorySheet(false)} />
          <View style={[styles.storySheet, { paddingBottom: storyKeyboard > 0 ? 16 : 24 + insets.bottom }]}>
            <View style={styles.storyGrabBar} />

            {storyStep === 1 ? (
              <>
                <Text style={styles.storyTitle}>Ask for support to…</Text>
                {/* Listan krymper medan man skriver, annars trycker
                    tangentbordet arkets överkant ut ur skärmen på en liten
                    telefon. */}
                <ScrollView
                  style={[styles.storyList, storyKeyboard > 0 && styles.storyListKeyboard]}
                  showsVerticalScrollIndicator={false}
                >
                  {storyItems.length > 0 && <Text style={styles.storyGroupLabel}>On your list</Text>}
                  {storyItems.map(item => {
                    const picked = storyPickedId === item.id;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.storyOption, picked && styles.storyOptionOn]}
                        onPress={() => pickFromList(item.id)}
                        activeOpacity={0.75}
                      >
                        {/* Markören är vad som skiljer ett val från ett
                            textfält — utan den läses raden som något att
                            skriva i, inte att trycka på. */}
                        <View style={[styles.optMark, picked && styles.optMarkOn]}>
                          {picked && <FontAwesome name="check" size={9} color={Palette.communitySoft} />}
                        </View>
                        <Text style={[styles.storyOptionText, picked && styles.storyOptionTextOn]} numberOfLines={2}>
                          {item.text}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}

                  <Text style={styles.storyGroupLabel}>Or something you want to do</Text>
                  <View style={styles.catRow}>
                    {inviteCategories.map(c => {
                      const on = storyCategory?.id === c.id;
                      return (
                        <TouchableOpacity
                          key={c.id}
                          style={[styles.catChip, on && styles.catChipOn]}
                          onPress={() => pickCategory(c)}
                          activeOpacity={0.8}
                        >
                          <Text style={styles.catChipEmoji}>{c.emoji}</Text>
                          <Text style={[styles.catChipText, on && styles.catChipTextOn]}>{c.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </ScrollView>

                <TextInput
                  style={styles.storyInput}
                  value={storyFreeText}
                  onChangeText={pickFreeText}
                  placeholder="Or write something else…"
                  placeholderTextColor={Palette.textTertiary}
                  maxLength={80}
                />

                <TouchableOpacity
                  style={[styles.storyPrimary, !storySubject && styles.storyPrimaryOff]}
                  onPress={() => setStoryStep(2)}
                  disabled={!storySubject}
                >
                  <Text style={styles.storyPrimaryText}>Next</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.storyTitle}>What do you need?</Text>
                <Text style={styles.storySub} numberOfLines={2}>{storySubject}</Text>

                {/* Tre genvägar, sedan alla 24 bakom ett tryck. Flerval, som
                    i den gamla skärmen — man kan vilja ha både värme och en
                    tillsägelse. */}
                <ScrollView style={styles.toneScroll} showsVerticalScrollIndicator={false}>
                  <View style={styles.toneWrap}>
                    {ALL_TONE_IDS.map(id => {
                      const on = storyTypes.includes(id);
                      return (
                        <TouchableOpacity
                          key={id}
                          style={[styles.chip, on && styles.chipActive]}
                          onPress={() => setStoryTypes(prev =>
                            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
                          activeOpacity={0.75}
                        >
                          <Text style={[styles.chipText, on && styles.chipTextActive]}>
                            {SUPPORT_TYPE_LABELS[id]}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </ScrollView>

                <TouchableOpacity
                  style={[styles.storyPrimary, storyTypes.length === 0 && styles.storyPrimaryOff]}
                  onPress={handlePublishStory}
                  disabled={storyTypes.length === 0 || publishingStory}
                >
                  <Text style={styles.storyPrimaryText}>
                    {publishingStory ? 'Sharing…' : 'Share'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.storyAlt} onPress={() => setStoryStep(1)}>
                  <Text style={styles.storyAltText}>Back</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Story detail modal */}
      {storyModalIndex !== null && (() => {
        const items: SupportStory[] = [...(myStory ? [myStory] : []), ...stories];
        if (items.length === 0) return null;
        return (
          <StoryDetailModal
            items={items}
            initialIndex={Math.min(storyModalIndex, items.length - 1)}
            myUserId={user!.id}
            respondedMap={respondedMap}
            onUndoResponse={async (storyId) => {
              const rid = respondedMap[storyId]?.id;
              if (!rid) return;
              await supabase.from('support_responses').delete().eq('id', rid).eq('sender_id', user!.id);
              setRespondedMap(prev => { const n = { ...prev }; delete n[storyId]; return n; });
            }}
            onRespondText={(storyId, ownerName) => {
              pendingNavRef.current = () => router.push({ pathname: '/support-respond-text', params: { storyId, ownerName } } as never);
              setStoryModalIndex(null);
            }}
            onRespondVoice={(storyId, ownerName) => {
              pendingNavRef.current = () => router.push({ pathname: '/support-respond-voice', params: { storyId, ownerName } } as never);
              setStoryModalIndex(null);
            }}
            onRespondVideo={(storyId, ownerName) => {
              pendingNavRef.current = () => router.push({ pathname: '/support-respond-video', params: { storyId, ownerName } } as never);
              setStoryModalIndex(null);
            }}
            onRespondPhoto={(storyId, ownerName) => {
              pendingNavRef.current = () => router.push({ pathname: '/support-respond-photo', params: { storyId, ownerName } } as never);
              setStoryModalIndex(null);
            }}
            onDeactivateOwn={async () => {
              if (!myStory) return;
              await supabase.from('support_stories').update({ is_active: false }).eq('id', myStory.id);
              setMyStory(null);
              setStoryModalIndex(null);
            }}
            onClose={() => setStoryModalIndex(null)}
          />
        );
      })()}
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { paddingHorizontal: Spacing.xl, paddingTop: 60, paddingBottom: 48, gap: Spacing.xl },
  centered: { flex: 1, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },

  // Header
  header: { gap: Spacing.lg },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logoText: { fontSize: 13, fontWeight: 'bold', color: Palette.hue, letterSpacing: 4 },
  // Samma rubrik som YOUR PAUSES i statistiken: designsystemets display.
  title: { fontSize: 26, lineHeight: 30, fontWeight: '900', letterSpacing: -0.6, color: Palette.textPrimary },

  // Inkorgen sitter på samma rad som rubriken, längst till höger. Mindre än
  // de 64 px de var på Hem — här är de en detalj bredvid en rubrik, inte
  // skärmens enda handling.
  titleWithInbox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inboxRow: { flexDirection: 'row', gap: 10 },
  inboxBtn: {
    width: 40, height: 40, borderRadius: Radius.md,
    backgroundColor: Palette.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  inboxBadge: {
    position: 'absolute', top: 3, right: 3,
    minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: Palette.accent,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  inboxBadgeText: { color: Palette.onAccent, fontSize: 11, fontWeight: '700', lineHeight: 13 },

  // Dela-en-punkt-lakanet
  storyOverlay: { flex: 1, backgroundColor: Palette.scrim, justifyContent: 'flex-end' },
  storySheet: {
    backgroundColor: Palette.modalSurface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, paddingBottom: 36,
    gap: Spacing.md,
  },
  storyGrabBar: {
    width: 38, height: 4, borderRadius: 2, alignSelf: 'center',
    backgroundColor: Palette.ink22, marginBottom: Spacing.sm,
  },
  storyTitle: { fontSize: 19, fontWeight: '800', color: Palette.textPrimary },
  // Ämnet hör ihop med rubriken ovanför, inte med pillren under: negativ
  // marginal uppåt drar det mot rubriken, positiv nedåt skjuter pillren
  // ifrån sig. Med bara lakanets `gap` låg alla tre på samma avstånd och
  // raderna såg staplade ut i stället för grupperade.
  storySub: {
    fontSize: 15, fontWeight: '600', color: Palette.accent,
    marginTop: -7, marginBottom: 14,
  },
  storyList: { maxHeight: 260 },
  storyListKeyboard: { maxHeight: 120 },
  storyGroupLabel: { ...Palette.eyebrow, fontSize: 12, marginBottom: 8, marginTop: 4 },
  catRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  catChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 9, paddingHorizontal: 12,
    borderRadius: Radius.pill, backgroundColor: Palette.surface,
  },
  catChipOn: { backgroundColor: Palette.hueTint },
  catChipEmoji: { fontSize: 14 },
  catChipText: { fontSize: 14, color: Palette.textSecondary },
  catChipTextOn: { color: Palette.hue, fontWeight: '700' },
  // Samma yt-språk som pillren nedan: svag fyllning, hårfin ram, lila när
  // vald. Utan ram och markör blev raden en textfältsattrapp.
  storyOption: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: Radius.md, marginBottom: 8,
    backgroundColor: Palette.ink05,
    borderWidth: 1, borderColor: Palette.ink10,
  },
  storyOptionOn: { backgroundColor: Palette.communityTint, borderColor: Palette.community },
  optMark: {
    width: 19, height: 19, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: Palette.ink20,
  },
  optMarkOn: { borderColor: Palette.community, backgroundColor: alpha(Palette.community, 0.2) },
  storyOptionText: { flex: 1, fontSize: 15, color: Palette.ink55 },
  storyOptionTextOn: { color: Palette.communitySoft, fontWeight: '600' },
  storyInput: {
    backgroundColor: Palette.surface, borderRadius: Radius.md,
    padding: 14, fontSize: 15, color: Palette.textPrimary,
  },
  // Samma piller som den pensionerade stöd-skärmen ritade, värdena oförändrade
  // — inklusive lilan #a29bfe, som är Community-flikens egen accent och det
  // story-bubblornas ringar redan använder. Blått hade brutit mot den.
  toneScroll: { maxHeight: 250 },
  toneWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 4 },
  chip: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 22,
    backgroundColor: Palette.ink05,
    borderWidth: 1, borderColor: Palette.ink10,
  },
  chipActive: { backgroundColor: Palette.communityTint, borderColor: Palette.community },
  chipText: { color: Palette.ink45, fontSize: 14, fontWeight: '500' },
  chipTextActive: { color: Palette.communitySoft, fontWeight: '600' },
  storyPrimary: {
    backgroundColor: Palette.accent, paddingVertical: 15,
    borderRadius: Radius.pill, alignItems: 'center', marginTop: Spacing.xs,
  },
  storyPrimaryOff: { backgroundColor: Palette.accentTint },
  storyPrimaryText: { color: Palette.onAccent, fontSize: 15, fontWeight: '700' },
  storyAlt: { alignItems: 'center', paddingVertical: 8 },
  storyAltText: { color: Palette.textTertiary, fontSize: 14 },

  // Section
  section: { gap: 4 },
  sectionLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  sectionBadge: {
    backgroundColor: Palette.accent, borderRadius: 10, minWidth: 18, height: 18,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  sectionBadgeText: { color: Palette.onAccent, fontSize: 11, fontWeight: '700', lineHeight: 13 },
  sectionLabel: { ...Palette.eyebrow, marginBottom: Spacing.sm },

  // En väns paus man kan hänga på (mottagarens vy)
  inviteCard: {
    backgroundColor: Palette.hueTint,
    borderRadius: Radius.lg,
    borderWidth: 1,
    // Tonen och ramen hör ihop: en ring i en annan kulör än ytan är två
    // kulörer om samma kant. Knappen inne i kortet är däremot accent — det
    // är den som är ifylld.
    borderColor: alpha(Palette.hue, 0.5),
    padding: Spacing.lg,
    gap: 14,
    marginBottom: 8,
  },
  inviteTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  inviteTextBlock: { flex: 1 },
  inviteTitle: { fontSize: 15, fontWeight: '700', color: Palette.textPrimary },
  inviteSubtitle: { fontSize: 14, color: Palette.hue, marginTop: 3, lineHeight: 19 },
  inviteActions: { flexDirection: 'row', gap: 10 },
  pauseNowBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 7, backgroundColor: Palette.accent, paddingVertical: 11, borderRadius: 22,
  },
  pauseNowText: { color: Palette.onAccent, fontSize: 14, fontWeight: '700' },
  notNowBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 11, borderRadius: 22,
    borderWidth: 1, borderColor: Palette.ink10,
  },
  notNowText: { color: Palette.textMuted, fontSize: 14 },

  // En paus som hunnit sluta (efter ett tryck på notisen)
  endedNote: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: alpha(Palette.hue, 0.08),
    borderRadius: 14, borderWidth: 1, borderColor: alpha(Palette.hue, 0.2),
    paddingVertical: 12, paddingHorizontal: 16, marginBottom: 8,
  },
  endedNoteText: { flex: 1, fontSize: 14, color: Palette.textSecondary, fontWeight: '500' },
  endedNoteBtn: {
    paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14,
    borderWidth: 1, borderColor: Palette.ink10,
  },
  endedNoteBtnText: { color: Palette.textSecondary, fontSize: 13, fontWeight: '600' },

  // Request row
  requestRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, paddingHorizontal: 16,
    backgroundColor: Palette.surface, borderRadius: Radius.lg, marginBottom: 8,
    borderWidth: 1, borderColor: Palette.surfaceBorder,
  },
  requestActions: { flexDirection: 'row', gap: 8, marginLeft: 'auto' },
  acceptBtn: { backgroundColor: Palette.accent, paddingVertical: 5, paddingHorizontal: 10, borderRadius: Radius.pill },
  acceptBtnText: { color: Palette.onAccent, fontSize: 12, fontWeight: '600' },
  declineBtn: {
    backgroundColor: 'transparent', paddingVertical: 5, paddingHorizontal: 10,
    borderRadius: Radius.pill, borderWidth: 1, borderColor: Palette.surfaceBorder,
  },
  declineBtnText: { color: Palette.textTertiary, fontSize: 12, fontWeight: '500' },

  // Friend row
  // Kortet har ingen kantlinje: ytan skiljer sig redan från rummets botten,
  // och en ram ovanpå blir en andra gräns för samma kant (samma linje som
  // panelerna i Kretsen). Ingen `overflow: hidden` heller — pingringen runt
  // inbjudningsknappen ska få gå utanför knappen.
  friendCard: { backgroundColor: Palette.surface, borderRadius: Radius.xl, marginBottom: 10 },
  friendRow: { flexDirection: 'row', alignItems: 'center', minHeight: 78 },
  // Utfälld statistik under raden, i samma kort.
  weekStats: { paddingHorizontal: 18, paddingBottom: 18, paddingTop: 2 },
  weekStatsLabel: { ...Palette.eyebrow, color: Palette.textTertiary, marginBottom: 14 },
  weekBars: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  weekBarCol: { flex: 1, alignItems: 'center', gap: 10 },
  weekBarTrack: {
    width: '100%', maxWidth: 22, height: 52, borderRadius: 8,
    backgroundColor: Palette.ink07, overflow: 'hidden', justifyContent: 'flex-end',
  },
  weekBarFill: { width: '100%', borderRadius: 8, backgroundColor: Palette.hue },
  weekBarDay: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, color: Palette.ink55 },
  friendLeft: { flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1, padding: 14 },
  friendAvatar: { position: 'relative' },
  friendInfo: { flex: 1, gap: 2 },
  friendActions: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 14 },
  // Runda knappar i rummets kulör: teckning och ram är `hue`, ytan rummets
  // ton — samma regel som rubrikradens lur och kuvert.
  iconBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: Palette.hueTint, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: alpha(Palette.hue, 0.24),
  },
  // Ifylld: inbjudan är skickad. Ifyllt är accentens, i alla rum.
  iconBtnSent: { backgroundColor: Palette.accent, borderColor: Palette.accent },
  // Statistiken är utfälld: ramen tar rummets hela kulör.
  iconBtnOpen: { borderColor: Palette.hue },
  iconBtnWrap: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },

  // Avatar
  avatarFallback: {
    backgroundColor: Palette.bg, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Palette.surfaceBorder,
  },
  avatarLetter: { color: Palette.textMuted, fontWeight: '700' },

  rowUsername: { fontSize: 17, fontWeight: '700', color: Palette.textPrimary, letterSpacing: 0.2 },
  statusText: { fontSize: 14, color: Palette.textTertiary, letterSpacing: 0.2 },
  // "pausing now" i accentens blå även i det varma rummet: det är pausens
  // färg, och den ska kännas igen var den än står.
  statusTextActive: { color: Palette.accent, fontWeight: '700' },

  emptyState: { paddingVertical: 24, alignItems: 'center', gap: 10 },
  emptyText: { color: Palette.textTertiary, fontSize: 14 },
  emptyLink: { color: Palette.accent, fontSize: 14, fontWeight: '500' },

  // Profile card modal
  cardBackdrop: { flex: 1, backgroundColor: Palette.scrimStrong, alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: Palette.modalSurface, borderRadius: Radius.xl, borderWidth: 1, borderColor: Palette.modalBorder,
    paddingVertical: 32, paddingHorizontal: 32, alignItems: 'center', gap: 12, width: 260,
  },
  cardName: { fontSize: 20, fontWeight: '700', color: Palette.textPrimary, letterSpacing: 0.2, textAlign: 'center' },
  // Ligger i en egen tonad yta för att skilja hemvist från status: den ena
  // säger vem hen pausar med, den andra vad hen gör just nu.
  cardCircle: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    alignSelf: 'stretch',
    backgroundColor: Palette.ink05,
    borderRadius: Radius.md,
    paddingVertical: 10, paddingHorizontal: 12,
    marginTop: 4,
  },
  cardCircleText: { flex: 1, gap: 3, alignItems: 'flex-start' },
  cardCircleEyebrow: { ...Palette.eyebrow },
  cardCircleName: { fontSize: 15, fontWeight: '700', color: Palette.textPrimary },
  cardCircleLevel: { fontSize: 12, fontWeight: '900', color: Palette.hue, letterSpacing: 1 },
  cardCircleLevelName: { fontSize: 13, fontWeight: '600', color: Palette.textSecondary },
  cardCircleList: { flexDirection: 'column', alignItems: 'stretch', gap: 8 },
  cardCircleListRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardCircleListName: { flex: 1 },
  cardStatus: { fontSize: 14, color: Palette.textTertiary, textAlign: 'center' },
  cardStatusActive: { color: Palette.accent },
  cardActions: { flexDirection: 'row', gap: 10, marginTop: 8 },

  addFriendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, paddingVertical: 16, borderRadius: Radius.pill,
    borderWidth: 1, borderColor: Palette.surfaceBorder, backgroundColor: Palette.surface,
  },
  addFriendText: { color: Palette.accent, fontSize: 15, fontWeight: '600', letterSpacing: 0.5 },

});


const makeBubbleStyles = (Palette: AppPalette) => StyleSheet.create({
  section: { gap: 0 },
  sectionLabel: {
    fontSize: 13, color: Palette.ink30, letterSpacing: 1.2,
    marginBottom: 10, marginLeft: 4,
    fontWeight: '400',
  },
  row: {
    flexDirection: 'row',
    gap: 16,
    paddingHorizontal: 2,
    paddingVertical: 4,
  },
  wrap: {
    alignItems: 'center',
    gap: 6,
    width: BUBBLE_D + 16,
  },
  ring: {
    width: BUBBLE_D + 8,
    height: BUBBLE_D + 8,
    borderRadius: (BUBBLE_D + 8) / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusCircle: {
    width: BUBBLE_D,
    height: BUBBLE_D,
    borderRadius: BUBBLE_D / 2,
    backgroundColor: alpha(Palette.community, 0.1),
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Palette.success,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Palette.surfaceAlt,
  },
  name: {
    fontSize: 12,
    color: Palette.ink55,
    textAlign: 'center',
    maxWidth: BUBBLE_D + 12,
  },
});

const makeStoryModalStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Palette.bg,
  },
  closeBtn: {
    position: 'absolute',
    top: 52,
    right: 12,
    zIndex: 10,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Palette.ink08,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotsRow: {
    position: 'absolute',
    top: 60,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    zIndex: 10,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Palette.ink20,
  },
  dotActive: {
    backgroundColor: Palette.community,
    width: 18,
  },
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 100,
    paddingBottom: 60,
  },
  inner: {
    alignItems: 'center',
    gap: 16,
    width: '100%',
  },
  avatarWrap: { marginBottom: 4 },
  avatarRing: {
    width: 88 + 10,
    height: 88 + 10,
    borderRadius: (88 + 10) / 2,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameText: {
    fontSize: 22,
    fontWeight: '700',
    color: Palette.textPrimary,
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  timeLeftText: {
    position: 'absolute',
    top: 12,
    right: 16,
    fontSize: 12,
    lineHeight: 16,
    color: Palette.textTertiary,
  },
  ownBadgePill: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: alpha(Palette.peer, 0.12),
    borderWidth: 1,
    borderColor: alpha(Palette.peer, 0.3),
  },
  ownBadge: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.peer,
    letterSpacing: 2,
  },
  ownContentCard: {
    width: '100%',
    backgroundColor: Palette.ink04,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Palette.ink07,
    paddingVertical: 24,
    paddingHorizontal: 22,
    gap: 16,
    marginTop: 4,
  },
  askBlock: { alignItems: 'center', gap: 4 },
  // Emojin i en egen rundel: fristående blev den ett tecken bland andra
  // rader, i en rundel blir den kortets ankare.
  emojiBadge: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: alpha(Palette.community, 0.12),
    marginBottom: 6,
  },
  bigEmoji: { fontSize: 26, lineHeight: 34 },
  activityPrefix: {
    fontSize: 14,
    color: Palette.ink40,
    textAlign: 'center',
  },
  // Hela hierarkin vilar på hoppet härifrån till raden ovan: 24 mot 13.
  activityLabel: {
    fontSize: 24,
    fontWeight: '800',
    color: Palette.textPrimary,
    textAlign: 'center',
    lineHeight: 30,
    letterSpacing: 0.2,
  },
  cardEyebrow: {
    fontSize: 12, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: Palette.ink30,
    marginBottom: -2,
  },
  // Citatet får en egen kant till vänster — utan den blev noten ännu en rad
  // text i högen i stället för någons ord.
  quoteBlock: {
    borderLeftWidth: 2,
    borderLeftColor: alpha(Palette.community, 0.5),
    paddingLeft: 12,
  },
  typePillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  typePill: {
    backgroundColor: alpha(Palette.community, 0.12),
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: alpha(Palette.community, 0.3),
  },
  typePillText: {
    fontSize: 12,
    color: Palette.communitySoft,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  ownCardDivider: {
    width: '100%',
    height: 1,
    backgroundColor: Palette.ink08,
  },
  requestText: {
    fontSize: 16,
    color: Palette.ink70,
    textAlign: 'center',
    lineHeight: 24,
  },
  nameInText: {
    fontWeight: '700',
    color: Palette.textPrimary,
  },
  accentText: {
    color: Palette.communitySoft,
    fontWeight: '600',
  },
  noteText: {
    fontSize: 14,
    color: Palette.ink55,
    fontStyle: 'italic',
    lineHeight: 21,
  },
  // Raden bär fyra medier sedan fotot kom till, och fyra piller med etikett
  // ryms inte bredvid varandra på en iPhone SE. `wrap` lägger dem i två rader
  // om två i stället för att krympa texten — en etikett som knappt går att
  // läsa är samma fel som typskalans golv finns för att hindra. Mittlagda, så
  // en udda sista rad hamnar under mitten av de andra och inte i vänsterkant.
  respondBtns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 10,
    marginTop: 8,
  },
  respondBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: alpha(Palette.community, 0.1),
    borderWidth: 1,
    borderColor: alpha(Palette.community, 0.25),
  },
  respondBtnText: {
    color: Palette.communitySoft,
    fontSize: 14,
    fontWeight: '600',
  },
  respondedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 8,
  },
  respondedText: {
    fontSize: 15,
    color: Palette.success,
    fontWeight: '600',
  },
  undoText: {
    fontSize: 14,
    color: Palette.ink30,
    textDecorationLine: 'underline',
  },
  deactivateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: alpha(Palette.dangerSoft, 0.25),
    backgroundColor: alpha(Palette.dangerSoft, 0.05),
  },
  deactivateBtnText: {
    color: alpha(Palette.dangerSoft, 0.7),
    fontSize: 13,
    fontWeight: '500',
  },
  swipeHint: {
    fontSize: 12,
    color: Palette.ink20,
    letterSpacing: 0.5,
    marginTop: 32,
  },
});
