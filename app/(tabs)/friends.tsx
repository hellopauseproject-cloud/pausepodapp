import { FontAwesome, FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
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
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Reanimated, {
  cancelAnimation, Easing as REasing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSpring, withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { AppPalette, Radius, Spacing, alpha } from '../../constants/appTheme';
import { useAuth } from '../../contexts/AuthContext';
import {
  dismissPauseInvite, fetchIncomingPauseInvites, getPauseInviteSelection, IncomingPauseInvite,
  joinPauseInvite, MAX_PAUSE_INVITEES, PAUSE_INVITE_WINDOW_MS, setPauseInviteSelection,
  usePauseInviteSelection,
} from '../../lib/pauseInvites';
import { RoomProvider, usePalette } from '../../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../../components/screen-background';
import { PausePodLogo } from '../../components/pause-pod-logo';
import { CircleLevelBadge } from '../../components/circle-level-badge';import { circleLevelName } from '../../lib/circleLevels';
import { FriendCircleBadge, getFriendCircleBadge, getMyCircles } from '../../lib/circles';
import { track } from '../../lib/analytics';
import { isNightHours } from '../../lib/homeMode';
import { enablePushNotifications } from '../../lib/notifications';
import { startSleep } from '../../lib/sleep';
import { supabase } from '../../lib/supabase';
import { liveStoryFilter, storyTimeLeft, unopenedResponsesQuery } from '../../lib/supportStories';
import { fetchUnseenThanks, markThanksSeen, SupportThanks } from '../../lib/supportThanks';
import { fetchSealedSupport, SealedSupport } from '../../lib/supportSealed';
import { openPauseStart } from '../../lib/pauseFlow';
import { ENVELOPE } from '../../components/support-envelope';
import { intentionTone } from '../../components/pause-tag-chips';
import type { PauseSession, Profile } from '../../types/database';
import { Category, DEFAULT_CATEGORIES, getSelectedCategories } from '../pauseLogger';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Mitt svar på en förfrågan. `thankedAt`: mottagaren har skickat ett hjärta tillbaka. */
type RespondedInfo = {
  id: string; deliveredAt: string | null; thankedAt?: string | null;
  /** Förseglat svar som mottagaren inte öppnat än (supabase/support_sealed.sql). */
  sealed?: boolean;
};

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
  /** Null = alla vänner; annars de som valts (supabase/wishlist.sql). */
  recipient_ids?: string[] | null;
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
  friendshipId: string;
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

function ProfileCard({ data, onClose, onRemoveFriend }: {
  data: ProfileCardData;
  onClose: () => void;
  onRemoveFriend?: (friendshipId: string, friendId: string) => void;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const { user } = useAuth();

  // Ens egna kretsar och om vännen redan är med i (eller inbjuden till) var
  // och en — hämtas när kortet öppnas, samma skäl som kretsmärket nedan.
  // Samma frågor som app/circle-invite.tsx ställer.
  const [myCircles, setMyCircles] = useState<{ id: string; name: string; state: 'open' | 'in' | 'sent' | 'sending' }[] | null>(null);
  const [circlePicker, setCirclePicker] = useState(false);
  const [inviteError, setInviteError] = useState('');
  useEffect(() => {
    if (data.kind !== 'friend' || !user?.id) return;
    let alive = true;
    (async () => {
      const circles = await getMyCircles(user.id);
      if (circles.length === 0) { if (alive) setMyCircles([]); return; }
      const ids = circles.map(c => c.id);
      const [{ data: members }, { data: pending }] = await Promise.all([
        supabase.from('circle_members').select('circle_id').eq('user_id', data.id).in('circle_id', ids),
        supabase.from('circle_invites').select('circle_id').eq('invitee_id', data.id).eq('status', 'pending').in('circle_id', ids),
      ]);
      const inSet = new Set((members ?? []).map((m: any) => m.circle_id));
      const sentSet = new Set((pending ?? []).map((i: any) => i.circle_id));
      if (alive) setMyCircles(circles.map(c => ({
        id: c.id, name: c.name,
        state: inSet.has(c.id) ? 'in' : sentSet.has(c.id) ? 'sent' : 'open',
      })));
    })();
    return () => { alive = false; };
  }, [data.id, data.kind, user?.id]);

  const inviteToCircle = async (circleId: string) => {
    setInviteError('');
    setMyCircles(prev => prev?.map(c => c.id === circleId ? { ...c, state: 'sending' } : c) ?? prev);
    const { error } = await supabase.rpc('invite_to_circle', { p_circle_id: circleId, p_invitee_id: data.id });
    if (error) {
      setInviteError(error.message);
      setMyCircles(prev => prev?.map(c => c.id === circleId ? { ...c, state: 'open' } : c) ?? prev);
      return;
    }
    track('circle_invite_sent', { from: 'friend_card' });
    setMyCircles(prev => prev?.map(c => c.id === circleId ? { ...c, state: 'sent' } : c) ?? prev);
  };

  const confirmRemove = () => {
    if (data.kind !== 'friend') return;
    Alert.alert(
      `Remove ${data.username}?`,
      'You will no longer see each other in your friend lists.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => { onRemoveFriend?.(data.friendshipId, data.id); onClose(); } },
      ],
    );
  };

  const circleLabel = (c: { state: 'open' | 'in' | 'sent' | 'sending' }) =>
    c.state === 'in' ? 'In circle' : c.state === 'sent' ? 'Invited' : c.state === 'sending' ? 'Sending…' : 'Invite';
  const onlyCircle = myCircles?.length === 1 ? myCircles[0] : null;

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
          {/* Bjud in till en krets: med en krets är det ett tryck, med fler
              fäller knappen ut en rad per krets. Utan krets syns den inte. */}
          {data.kind === 'friend' && myCircles && myCircles.length > 0 && (
            <View style={styles.cardInviteBlock}>
              {onlyCircle ? (
                <TouchableOpacity
                  style={[styles.cardInviteBtn, onlyCircle.state !== 'open' && styles.cardInviteBtnDone]}
                  onPress={() => inviteToCircle(onlyCircle.id)}
                  disabled={onlyCircle.state !== 'open'}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                >
                  <FontAwesome5 name="user-plus" size={13} color={onlyCircle.state === 'open' ? Palette.onAccent : Palette.textTertiary} />
                  <Text style={[styles.cardInviteBtnText, onlyCircle.state !== 'open' && styles.cardInviteBtnTextDone]} numberOfLines={1}>
                    {onlyCircle.state === 'open' ? `Invite to ${onlyCircle.name}` : `${circleLabel(onlyCircle)} · ${onlyCircle.name}`}
                  </Text>
                </TouchableOpacity>
              ) : (
                <>
                  <TouchableOpacity
                    style={styles.cardInviteBtn}
                    onPress={() => setCirclePicker(v => !v)}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: circlePicker }}
                  >
                    <FontAwesome5 name="user-plus" size={13} color={Palette.onAccent} />
                    <Text style={styles.cardInviteBtnText}>Invite to circle</Text>
                    <FontAwesome5 name={circlePicker ? 'chevron-up' : 'chevron-down'} size={11} color={Palette.onAccent} />
                  </TouchableOpacity>
                  {circlePicker && myCircles.map(c => (
                    <View key={c.id} style={styles.cardInviteRow}>
                      <Text style={styles.cardInviteRowName} numberOfLines={1}>{c.name}</Text>
                      <TouchableOpacity
                        style={[styles.acceptBtn, c.state !== 'open' && styles.declineBtn]}
                        onPress={() => inviteToCircle(c.id)}
                        disabled={c.state !== 'open'}
                        activeOpacity={0.8}
                      >
                        <Text style={c.state === 'open' ? styles.acceptBtnText : styles.declineBtnText}>{circleLabel(c)}</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </>
              )}
              {!!inviteError && <Text style={styles.cardInviteError}>{inviteError}</Text>}
            </View>
          )}
          {data.kind === 'friend' && onRemoveFriend && (
            <TouchableOpacity onPress={confirmRemove} activeOpacity={0.7} style={styles.cardRemove} hitSlop={8}>
              <Text style={styles.cardRemoveText}>Remove friend</Text>
            </TouchableOpacity>
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

  return (
    <View style={styles.friendCard}>
    <View style={styles.friendRow}>
      <TouchableOpacity
        style={styles.friendLeft}
        onPress={() => onProfilePress(friend, statusText)}
        activeOpacity={0.75}
      >
        <View style={styles.friendAvatar}>
          <Avatar username={friend.username} avatarUrl={friend.avatar_url} size={38} />
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
        {/* En genväg till Hem: vännen läggs till bland de valda ovanför
            PAUSE, och inbjudan går ut när pausen startar — samma väg som
            väljaren där. Bocken står medan vännen är vald. Fylld i accenten,
            för ifyllt är accentens (se CLAUDE.md, *Rummet*). */}
        {!isPausing && (
          <View style={styles.iconBtnWrap}>
            <PingRing trigger={invitePing} color={Palette.accent} size={36} duration={1000} />
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

// ─── Bjud in till appen ──────────────────────────────────────────────────────
//
// Telefonens egna delningsark, med länken till webbsidan och ens användarnamn
// så att vännen kan hitta en via *Add friend*. Ingen kod och ingen spårning av
// vem som kom in — bara att arket öppnades och om något delades.

// /get skickar telefonen till sin egen butik (eller visar *Coming soon*), se
// website/get/index.html. Butikslänkarna bor där och inte i appen: avsändarens
// telefon kan inte veta vilken butik mottagaren behöver.
const APP_INVITE_URL = 'https://joinpausepod.com/get';

function InviteToAppCard({ username }: { username: string | null }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);

  const share = useCallback(async () => {
    const findMe = username ? ` Find me as ${username}.` : '';
    track('app_invite_opened');
    try {
      const res = await Share.share({
        message: `Pause with me on PausePod — we can take pauses together and send each other support.${findMe} ${APP_INVITE_URL}${username ? `?from=${encodeURIComponent(username)}` : ''}`,
      });
      track('app_invite_result', { shared: res.action === Share.sharedAction });
    } catch {
      // Arket gick inte att öppna; ingenting att säga till användaren.
    }
  }, [username]);

  return (
    <TouchableOpacity
      style={styles.inviteAppCard}
      onPress={share}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel="Missing a friend here? Invite them to PausePod"
    >
      <View style={styles.inviteAppIcon}>
        <FontAwesome5 name="paper-plane" size={14} color={Palette.hue} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.inviteAppTitle}>Missing a friend here?</Text>
        <Text style={styles.inviteAppSub}>Invite them to PausePod</Text>
      </View>
      <FontAwesome5 name="chevron-right" size={12} color={Palette.hue} />
    </TouchableOpacity>
  );
}

// ─── Stödförfrågningar ───────────────────────────────────────────────────────
//
// Cirklar i en rad, som stories. **Den egna står alltid först**, skild från
// vännernas med en tunn lodrät linje, och den är ens eget ansikte i båda
// lägena: utan förfrågan med ett fyllt plus i hörnet och etiketten *Ask*,
// med en ute med en grön ring (`peer`) och etiketten *Your request*. Samma
// mönster som "Your story" — man ser direkt vilken cirkel som är ens egen.
//
// Två andra försök föll på begäran: stora kort med toning, toner och en
// rubrik (*Anna needs you*) var plottriga, och små kort med text var
// otydliga. Cirklarna var det som fungerade.

const BUBBLE_D = 76;

/**
 * Ett sken bakom en stödförfrågan som andas, och en mjuk våg som växer ut ur
 * cirkeln och tonar bort — så att en förfrågan som väntar fångar blicken lite.
 * Bara bakom det som väntar: en besvarad cirkel har inget att be om. Står
 * still (och utan våg) med reducerad rörelse.
 *
 * Kulören: i mörkt läge ringens egen. I ljust läge är ringarnas kulörer djupa
 * (kakaobrunt, mörkgrönt) och blev en mörk fläck, och en uppljusad pastell
 * syntes inte alls mot den ljusa botten — där används designsystemets
 * flikljus i stället (Friends #E9873C, Circle #2FA66A), som är mättade nog
 * att synas och ljusa nog att inte smutsa.
 */
const GLOW_D = BUBBLE_D + 44;
const GLOW_BREATH_MS = 4000;
const GLOW_RIPPLE_MS = 3600;
const GLOW_LIGHT = { warm: '#E9873C', green: '#2FA66A' } as const;
let glowSeq = 0;

function BubbleGlow({ color: base, tone }: { color: string; tone: keyof typeof GLOW_LIGHT }) {
  const Palette = usePalette();
  const light = Palette.mode === 'light';
  const color = light ? GLOW_LIGHT[tone] : base;
  const peak = light ? 0.42 : 0.4;
  const reduceMotion = useReducedMotion();
  const breath = useSharedValue(1);
  const ripple = useSharedValue(0);
  // Ett eget id per instans: svg-id:n är globala, och två sken i olika
  // kulörer med samma id hade målats i den första kulören. Sekvensen ger
  // också vågorna var sin fas, så att cirklarna inte pulserar i takt.
  const seq = useMemo(() => ++glowSeq, []);
  const id = `bubbleGlow${seq}`;

  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(breath); cancelAnimation(ripple);
      breath.value = 1; ripple.value = 0;
      return;
    }
    breath.value = 0.4;
    breath.value = withRepeat(withTiming(1, { duration: GLOW_BREATH_MS / 2, easing: REasing.inOut(REasing.sin) }), -1, true);
    ripple.value = 0;
    ripple.value = withDelay(
      (seq % 4) * 700,
      withRepeat(withTiming(1, { duration: GLOW_RIPPLE_MS, easing: REasing.out(REasing.cubic) }), -1, false),
    );
    return () => { cancelAnimation(breath); cancelAnimation(ripple); };
  }, [reduceMotion, breath, ripple, seq]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: breath.value,
    transform: [{ scale: 0.86 + 0.18 * breath.value }],
  }));
  const rippleStyle = useAnimatedStyle(() => ({
    opacity: 0.75 * (1 - ripple.value),
    transform: [{ scale: 0.8 + 0.5 * ripple.value }],
  }));

  const disc = (
    <Svg width={GLOW_D} height={GLOW_D}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0.55" stopColor={color} stopOpacity={peak} />
          <Stop offset="0.8" stopColor={color} stopOpacity={peak * 0.35} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={GLOW_D / 2} cy={GLOW_D / 2} r={GLOW_D / 2} fill={`url(#${id})`} />
    </Svg>
  );

  return (
    <>
      {!reduceMotion && (
        <Reanimated.View pointerEvents="none" style={[glowStyles.wrap, rippleStyle]}>{disc}</Reanimated.View>
      )}
      <Reanimated.View pointerEvents="none" style={[glowStyles.wrap, glowStyle]}>{disc}</Reanimated.View>
    </>
  );
}

const glowStyles = StyleSheet.create({
  wrap: {
    position: 'absolute', width: GLOW_D, height: GLOW_D,
    left: (BUBBLE_D + 8 - GLOW_D) / 2, top: (BUBBLE_D + 8 - GLOW_D) / 2,
  },
});

function StoryBubble({
  username, avatarUrl, label, ringColor, dimmed, hearted, plus, onPress, accessibilityLabel,
}: {
  username: string; avatarUrl?: string | null;
  label: string;
  ringColor: string;
  /** Besvarad: tonad, med en bock. */
  dimmed?: boolean;
  /** Svaret fick ett hjärta tillbaka: hjärta i stället för bock, och inte tonad. */
  hearted?: boolean;
  /** Den egna utan förfrågan: ett fyllt plus i hörnet och en streckad ring. */
  plus?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const Palette = usePalette();
  const s = useMemo(() => makeRequestStyles(Palette), [Palette]);
  return (
    <TouchableOpacity
      style={s.bubble}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={[s.ring, { borderColor: ringColor }, plus && s.ringPlus, dimmed && !hearted && s.ringDimmed]}>
        {!dimmed && (
          <BubbleGlow
            color={plus ? Palette.hue : ringColor}
            tone={ringColor === Palette.peer ? 'green' : 'warm'}
          />
        )}
        <View style={dimmed && !hearted && s.faded}>
          <Avatar username={username} avatarUrl={avatarUrl} size={BUBBLE_D} />
        </View>
        {plus && (
          <View style={s.plusBadge}>
            <FontAwesome5 name="plus" size={10} color={Palette.onAccent} />
          </View>
        )}
        {hearted ? (
          <View style={s.heartBadge}>
            <FontAwesome5 name="heart" size={9} solid color={Palette.onAccent} />
          </View>
        ) : dimmed && (
          // Bocken också för ett förseglat svar som inte öppnats än — ett
          // pausmärke här lästes som att personen pausade.
          <View style={s.checkBadge}>
            <FontAwesome5 name="check" size={8} color={Palette.onAccent} />
          </View>
        )}
      </View>
      <Text style={[s.bubbleName, dimmed && !hearted && s.faded]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

function SupportRequests({
  me, myStory, stories, respondedMap, onOpen, onAskPress,
}: {
  me: { username: string; avatar_url: string | null } | null;
  myStory: SupportStory | null;
  stories: SupportStory[];
  respondedMap: Record<string, RespondedInfo>;
  /** Index i story-läsarens lista: den egna först, sedan vännernas. */
  onOpen: (index: number) => void;
  onAskPress: () => void;
}) {
  const Palette = usePalette();
  const s = useMemo(() => makeRequestStyles(Palette), [Palette]);
  const offset = myStory ? 1 : 0;
  // Obesvarade först; en besvarad cirkel står kvar längst bak, tonad.
  const ordered = stories
    .map((story, i) => ({ story, index: offset + i, responded: !!respondedMap[story.id] }))
    .sort((a, b) => Number(a.responded) - Number(b.responded));
  const myName = myStory?.profile?.username ?? me?.username ?? 'You';
  const myAvatar = myStory?.profile?.avatar_url ?? me?.avatar_url ?? null;

  return (
    <View style={s.wrap}>
      <Text style={s.eyebrow}>SUPPORT REQUESTS</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.row}
        contentContainerStyle={s.rowContent}
      >
        {myStory ? (
          <StoryBubble
            username={myName}
            avatarUrl={myAvatar}
            label="Your request"
            ringColor={Palette.peer}
            onPress={() => onOpen(0)}
            accessibilityLabel={`Your request: ${myStory.activity}. ${storyTimeLeft(myStory)}.`}
          />
        ) : (
          <StoryBubble
            username={myName}
            avatarUrl={myAvatar}
            label="Ask"
            ringColor={Palette.ink22}
            plus
            onPress={onAskPress}
            accessibilityLabel="Ask for support"
          />
        )}

        <View style={s.divider} />

        {ordered.length > 0 ? ordered.map(o => {
          const name = o.story.profile?.username ?? 'A friend';
          return (
            <StoryBubble
              key={o.story.id}
              username={name}
              avatarUrl={o.story.profile?.avatar_url}
              label={name.split(' ')[0]}
              ringColor={Palette.community}
              dimmed={o.responded}
              hearted={!!respondedMap[o.story.id]?.thankedAt}
              onPress={() => onOpen(o.index)}
              accessibilityLabel={`${name}: ${o.story.activity}. ${respondedMap[o.story.id]?.thankedAt ? 'Support sent, and they sent a heart back.' : o.responded ? 'Support sent.' : 'Open to send support.'}`}
            />
          );
        }) : (
          <View style={s.emptyWrap}>
            <Text style={s.empty}>{"Friends' requests\nshow up here"}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const makeRequestStyles = (Palette: AppPalette) => StyleSheet.create({
  // Luft ovanför, så att raden står längre ner och inte trängs mot rubriken,
  // och lika mycket under, så att den hålls isär från vänlistan.
  wrap: { marginTop: Spacing.xl, marginBottom: Spacing.xl },
  eyebrow: { ...Palette.eyebrow, marginBottom: 12 },
  // Raden går ut till skärmens kanter, så att nästa cirkel skymtar.
  // Den lodräta paddningen ger skenet bakom cirklarna plats (en ScrollView
  // klipper sina barn), och marginalen tar tillbaka den så att raden står där
  // den stod.
  row: { marginHorizontal: -Spacing.xl, marginVertical: -34 },
  rowContent: { paddingHorizontal: Spacing.xl, gap: 14, alignItems: 'flex-start', paddingVertical: 36 },
  bubble: { alignItems: 'center', gap: 6, width: BUBBLE_D + 12 },
  ring: {
    width: BUBBLE_D + 8, height: BUBBLE_D + 8, borderRadius: (BUBBLE_D + 8) / 2,
    borderWidth: 2.5, alignItems: 'center', justifyContent: 'center',
  },
  ringPlus: { borderStyle: 'dashed', borderWidth: 1.5 },
  ringDimmed: { borderColor: Palette.ink22 },
  faded: { opacity: 0.45 },
  plusBadge: {
    position: 'absolute', right: 0, bottom: 0,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: Palette.accent,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2.5, borderColor: Palette.bg,
  },
  checkBadge: {
    position: 'absolute', right: 0, bottom: 0,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: Palette.community,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: Palette.bg,
  },
  heartBadge: {
    position: 'absolute', right: -2, bottom: -2,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: Palette.dangerSoft,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: Palette.bg,
  },
  bubbleName: { fontSize: 12, color: Palette.textSecondary, textAlign: 'center', maxWidth: BUBBLE_D + 12 },
  // Linjen mellan den egna och vännernas — det enda som behövs för att
  // läsa "jag" mot "de".
  divider: { width: 1, height: BUBBLE_D - 8, marginTop: 8, backgroundColor: Palette.ink15 },
  emptyWrap: { height: BUBBLE_D + 8, justifyContent: 'center' },
  empty: { fontSize: 13, lineHeight: 18, color: Palette.textTertiary },
});

/**
 * Förseglat stöd: *Dag sent you support · Take a pause to open*. Ett kuvert
 * med pausens sigill, och knappen startar en paus. Innehållet går inte att
 * läsa förrän pausen är gjord — det spärras i SQL (supabase/support_sealed.sql),
 * och Hem säger *Your envelope is ready* när det låsts upp.
 */
function SealedCard({ sealed }: { sealed: SealedSupport[] }) {
  const Palette = usePalette();
  const s = useMemo(() => makeInboxStyles(Palette), [Palette]);
  const first = sealed[0];
  const firstName = first.username.split(' ')[0];
  const title = sealed.length === 1
    ? `${firstName} sent you support`
    : `${sealed.length} sealed envelopes`;
  return (
    <View style={s.sealedCard}>
      <View style={s.sealedEnvelope}>
        <FontAwesome5 name="envelope" size={26} color={ENVELOPE.flap} solid />
        <View style={s.sealedSeal}>
          <View style={s.sealedSealBar} />
          <View style={s.sealedSealBar} />
        </View>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.inboxTitle} numberOfLines={2}>{title}</Text>
        <Text style={s.thanksSub}>Take a pause to open.</Text>
      </View>
      <TouchableOpacity
        style={s.sealedBtn}
        onPress={() => openPauseStart('push')}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Start a pause to open it"
      >
        <FontAwesome5 name="pause" size={11} color={Palette.onAccent} />
        <Text style={s.sealedBtnText}>Pause</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * *Anna sent you a heart* — ett hjärta tillbaka för stöd man skickat
 * (supabase/support_thanks.sql). Det visas en gång: raderna markeras sedda när
 * de hämtats, och kortet står kvar tills fliken lämnas. Hjärtat studsar in,
 * för det här är det enda ögonblicket avsändaren får veta att stödet nådde fram.
 */
function ThanksCard({ thanks }: { thanks: SupportThanks[] }) {
  const Palette = usePalette();
  const s = useMemo(() => makeInboxStyles(Palette), [Palette]);
  const reduceMotion = useReducedMotion();
  const pop = useSharedValue(reduceMotion ? 1 : 0.4);
  useEffect(() => {
    if (reduceMotion) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    pop.value = withSpring(1, { damping: 7, stiffness: 160 });
  }, [reduceMotion, pop]);
  const heartStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  const first = thanks[0];
  const firstName = first.username.split(' ')[0];
  const others = new Set(thanks.map(t => t.userId)).size - 1;
  const title = others <= 0
    ? `${firstName} sent you a heart`
    : `${firstName} and ${others} ${others === 1 ? 'other' : 'others'} sent you hearts`;
  const sub = thanks.length === 1 && first.activity
    ? `For your support with ${first.activity}`
    : 'For the support you sent';
  return (
    <View style={s.thanksCard} accessibilityRole="text" accessibilityLabel={`${title}. ${sub}.`}>
      <View>
        <Avatar username={first.username} avatarUrl={first.avatarUrl} size={48} />
        <Reanimated.View style={[s.thanksHeart, heartStyle]}>
          <FontAwesome5 name="heart" size={12} solid color={Palette.onAccent} />
        </Reanimated.View>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.inboxTitle} numberOfLines={2}>{title}</Text>
        <Text style={s.thanksSub} numberOfLines={2}>{sub}</Text>
      </View>
    </View>
  );
}

/**
 * Stöd som väntar, överst i fliken. Det ersatte två små ikoner på rubrikraden
 * (en lur och ett kuvert) som var lätta att missa — och luren lovade ett
 * samtal. Ett tryck öppnar kuvertet i app/support-arrived.tsx.
 */
function SupportInboxCard({ count, senderName, senderAvatarUrl, onPress }: {
  count: number; senderName: string; senderAvatarUrl: string | null; onPress: () => void;
}) {
  const Palette = usePalette();
  const inboxStyles = useMemo(() => makeInboxStyles(Palette), [Palette]);
  const firstName = senderName.split(' ')[0];
  return (
    <TouchableOpacity
      style={inboxStyles.inboxCard}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={count === 1 ? `${firstName} sent you support. Open it.` : `${count} messages of support waiting. Open them.`}
    >
      <View style={inboxStyles.inboxIcon}>
        <PingRing trigger={count} color={Palette.community} size={60} />
        <FontAwesome5 name="envelope" size={22} color={Palette.community} solid />
        <View style={inboxStyles.inboxAvatar}>
          <Avatar username={senderName} avatarUrl={senderAvatarUrl} size={22} />
        </View>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={inboxStyles.inboxTitle} numberOfLines={2}>
          {count === 1 ? `${firstName} sent you support` : `${count} messages of support`}
        </Text>
        <Text style={inboxStyles.inboxSub}>Open the envelope</Text>
      </View>
      <FontAwesome5 name="chevron-right" size={14} color={Palette.hue} />
    </TouchableOpacity>
  );
}

function StoryDetailModal({
  items, initialIndex, myUserId, friendNames,
  respondedMap, onUndoResponse,
  onRespondText, onRespondVoice, onRespondVideo, onRespondPhoto,
  onDeactivateOwn, onClose,
}: {
  items: SupportStory[];
  initialIndex: number;
  myUserId: string;
  /** Vännernas namn per id, för *Asked Anna, Dag* på den egna förfrågan. */
  friendNames: Record<string, string>;
  respondedMap: Record<string, RespondedInfo>;
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

          {isOwn && (
            <Text style={storyModalStyles.audienceText}>
              {!item.recipient_ids
                ? 'Asked all your friends'
                : `Asked ${item.recipient_ids.map(id => friendNames[id]?.split(' ')[0]).filter(Boolean).join(', ') || `${item.recipient_ids.length} friends`}`}
            </Text>
          )}

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
  // Det egna ansiktet till den första cirkeln, också när ingen förfrågan är ute.
  // Läses om vid varje fokus: flikar avmonteras inte, så ett namnbyte i
  // profilen syntes annars inte här — *Find me as …* i inbjudan bar det gamla
  // namnet. `realName` är null när inget namn finns, så att inbjudan inte
  // skriver *Find me as You*.
  const [me, setMe] = useState<{ username: string; realName: string | null; avatar_url: string | null } | null>(null);
  useFocusEffect(useCallback(() => {
    if (!user?.id) return;
    let alive = true;
    supabase.from('profiles').select('username, avatar_url').eq('id', user.id).maybeSingle()
      .then(({ data }) => {
        if (alive && data) setMe({ username: data.username ?? 'You', realName: data.username ?? null, avatar_url: data.avatar_url ?? null });
      });
    return () => { alive = false; };
  }, [user?.id]));
  const [respondedMap, setRespondedMap] = useState<Record<string, RespondedInfo>>({}); // storyId → { id, deliveredAt }
  const [storyModalIndex, setStoryModalIndex] = useState<number | null>(null);

  // Inkorgen för stöd-svar: ett kort överst i fliken, inte två ikoner på
  // rubrikraden. Förr var luren det som ringde (röst och video) och kuvertet
  // det som låg tyst (text och foto); nu landar alla fyra sorterna i samma
  // kuvert (app/support-arrived.tsx), och kortet är fliken huvudsak när det
  // finns något. Flikens egen badge i (tabs)/_layout.tsx räknar in dem.
  const [inbox, setInbox] = useState<{ count: number; senderName: string; senderAvatarUrl: string | null } | null>(null);

  // Vänradernas tryck, stabila så att `FriendRow`s memo håller.
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
  const [storyStep, setStoryStep] = useState<1 | 2 | 3>(1);
  // Vem förfrågan går till: tomt = alla vänner (förval), annars de ikryssade.
  // Skickas som `p_recipient_ids` till activate_story (supabase/wishlist.sql).
  const [storyRecipients, setStoryRecipients] = useState<Set<string>>(new Set());
  const audienceLabel = (() => {
    if (storyRecipients.size === 0) return 'Everyone';
    const names = friends.filter(fr => storyRecipients.has(fr.id)).map(fr => fr.username.split(' ')[0]);
    return names.length <= 2 ? names.join(', ') : `${names.length} friends`;
  })();
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
    setStoryRecipients(new Set());
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
        // Bara när man valt: då fungerar *alla vänner* också mot en databas
        // där wishlist.sql inte körts om än.
        ...(storyRecipients.size > 0 ? { p_recipient_ids: [...storyRecipients] } : {}),
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
        // Antalet och inte vilka: vilka man ber är deras sak.
        audience: storyRecipients.size > 0 ? 'chosen' : 'all',
        recipients: storyRecipients.size > 0 ? storyRecipients.size : null,
      });

      setStorySheet(false);
      fetchStories();
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
    // `recipient_ids` finns först när wishlist.sql körts om; utan den faller
    // frågan tillbaka på de gamla kolumnerna i stället för att tömma raden.
    const storyQuery = (cols: string) => supabase
      .from('support_stories')
      .select(cols)
      .eq('is_active', true)
      .or(liveStoryFilter())
      .order('created_at', { ascending: false });
    const base = 'id, user_id, support_type, activity, intention_id, personal_note, created_at, wishlist_item_id, expires_at, profile:profiles!user_id(id, username, avatar_url)';
    let { data, error: storyError } = await storyQuery(`${base}, recipient_ids`);
    if (storyError) ({ data } = await storyQuery(base));

    const all = ((data ?? []) as any[]).map(s => ({
      ...s,
      profile: Array.isArray(s.profile) ? (s.profile[0] ?? null) : (s.profile ?? null),
    })) as SupportStory[];
    setMyStory(all.find(s => s.user_id === user.id) ?? null);
    setStories(all.filter(s => s.user_id !== user.id));

    if (all.length > 0) {
      // `thanked_at` finns först när supabase/support_thanks.sql körts; utan
      // den faller frågan tillbaka på de gamla kolumnerna i stället för att
      // tömma alla bockar.
      const ids = all.map(s => s.id);
      const { data: myResponses } = await supabase
        .from('support_responses')
        .select('*')
        .eq('sender_id', user.id)
        .in('story_id', ids);

      const map: Record<string, RespondedInfo> = {};
      for (const r of ((myResponses ?? []) as any[])) {
        map[r.story_id] = {
          id: r.id,
          deliveredAt: r.delivered_at,
          thankedAt: r.thanked_at ?? null,
          sealed: !!r.opens_after_pause && !r.delivered_at,
        };
      }
      setRespondedMap(map);
    }
  }, [user]);

  const [thanks, setThanks] = useState<SupportThanks[]>([]);
  const [sealedSupport, setSealedSupport] = useState<SealedSupport[]>([]);
  useFocusEffect(
    useCallback(() => {
      if (!user?.id) return;
      let alive = true;
      fetchSealedSupport().then(list => { if (alive) setSealedSupport(list); });
      return () => { alive = false; };
    }, [user?.id])
  );
  useFocusEffect(
    useCallback(() => {
      if (!user?.id) return;
      let alive = true;
      fetchUnseenThanks().then(list => {
        if (!alive || list.length === 0) return;
        setThanks(list);
        markThanksSeen(list.map(t => t.responseId));
      });
      return () => { alive = false; setThanks([]); };
    }, [user?.id])
  );

  useFocusEffect(
    useCallback(() => {
      if (!user?.id) return;
      const checkPending = async () => {
        // Svaren överlever förfrågan, så inkorgen räknar svar på alla egna
        // stories — också utgångna och borttagna.
        // Det senaste svaret ger namnet på kortet ("Anna sent you support");
        // kuvertet öppnar ändå det äldsta först.
        const { data, count } = await unopenedResponsesQuery(user.id, 'id, sender_id', { count: 'exact' })
          .order('created_at', { ascending: false })
          .limit(1);
        const latest = data?.[0];
        if (!latest || !count) { setInbox(null); return; }
        const { data: sender } = await supabase
          .from('profiles').select('username, avatar_url').eq('id', latest.sender_id).maybeSingle();
        setInbox({
          count,
          senderName: sender?.username ?? 'A friend',
          senderAvatarUrl: sender?.avatar_url ?? null,
        });
      };
      checkPending();
    }, [user?.id])
  );

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

  // Samma delete som ett avböjande, på en accepterad rad. Vännen tas också
  // ur pausinbjudans val, annars bjöds en före detta vän in vid nästa paus.
  const removeFriend = async (friendshipId: string, friendId: string) => {
    setFriends(prev => prev.filter(f => f.friendshipId !== friendshipId));
    const current = getPauseInviteSelection();
    if (current.some(f => f.id === friendId)) setPauseInviteSelection(current.filter(f => f.id !== friendId));
    const { error } = await supabase.from('friendships').delete().eq('id', friendshipId);
    if (error) {
      Alert.alert('Could not remove friend', error.message);
      fetchAll();
      return;
    }
    track('friend_removed');
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
        <PausePodLogo />
      </View>

      {/* Stöd som väntar. Kortet är kuvertet i liten skala och leder till
          app/support-arrived.tsx, där det öppnas. */}
      {thanks.length > 0 && <ThanksCard thanks={thanks} />}

      {sealedSupport.length > 0 && <SealedCard sealed={sealedSupport} />}

      {inbox && (
        <SupportInboxCard
          count={inbox.count}
          senderName={inbox.senderName}
          senderAvatarUrl={inbox.senderAvatarUrl}
          onPress={() => router.push('/support-arrived' as never)}
        />
      )}

      {/* Be om stöd, och vänners förfrågningar. */}
      <SupportRequests
        me={me}
        myStory={myStory}
        stories={stories}
        respondedMap={respondedMap}
        onOpen={(index) => setStoryModalIndex(index)}
        onAskPress={openStorySheet}
      />

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

      {/* Vänlista — lugn och liten under förfrågningarna. *Add friend* är en
          länk på rubrikraden och inte längre en hel knapp under listan. */}
      <View style={styles.section}>
        <View style={styles.friendsLabelRow}>
          <Text style={[styles.sectionLabel, { marginBottom: 0 }]}>YOUR FRIENDS</Text>
          <TouchableOpacity
            onPress={() => router.push('/add-friend' as never)}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.addFriendLink}
          >
            <FontAwesome5 name="user-plus" size={12} color={Palette.hue} />
            <Text style={styles.addFriendLinkText}>Add friend</Text>
          </TouchableOpacity>
        </View>
        {friends.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>You don't have any friends yet.</Text>
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
        {/* Stödet fungerar bara om det finns någon att fråga, och den man
            saknar här har oftast inte appen. *Add friend* söker bland dem som
            redan finns; det här går till alla andra. */}
        <InviteToAppCard username={me?.realName ?? null} />
      </View>

      {/* Profilkort */}
      {profileCard && (
        <ProfileCard data={profileCard} onClose={() => setProfileCard(null)} onRemoveFriend={removeFriend} />
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
                <View style={styles.storyTitleRow}>
                  <Text style={[styles.storyTitle, { flex: 1 }]}>Ask for support to…</Text>
                  {/* Vem: en knapp man går in i. Rörs den inte är det alla. */}
                  <TouchableOpacity
                    style={[styles.toPill, storyRecipients.size > 0 && styles.toPillOn]}
                    onPress={() => setStoryStep(3)}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={`Ask: ${audienceLabel}. Change who you ask.`}
                  >
                    <FontAwesome5 name={storyRecipients.size > 0 ? 'user-check' : 'users'} size={11} color={Palette.communitySoft} />
                    <Text style={styles.toPillText} numberOfLines={1}>{audienceLabel}</Text>
                    <FontAwesome5 name="chevron-right" size={9} color={Palette.communitySoft} />
                  </TouchableOpacity>
                </View>
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
                  {/* Alla intentioner på en gång, tre i bredd, var och en i sin
                      egen ton (`intentionTone`, samma som pausens kort i
                      statistiken). Det var piller i en lång radbrytande rad,
                      och då gick det inte att se vad som fanns att välja på. */}
                  <View style={styles.catGrid}>
                    {inviteCategories.map((c, i) => {
                      const on = storyCategory?.id === c.id;
                      const tone = intentionTone(Palette, c.id);
                      return (
                        <TouchableOpacity
                          key={c.id}
                          style={[
                            styles.catTile,
                            { backgroundColor: alpha(tone, on ? 0.28 : 0.12), borderColor: on ? tone : 'transparent' },
                            // Luft till höger utom i tredje kolumnen, så att en ofull sista rad står till vänster.
                            i % 3 !== 2 && styles.catTileGap,
                          ]}
                          onPress={() => pickCategory(c)}
                          activeOpacity={0.8}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: on }}
                          accessibilityLabel={c.label}
                        >
                          <Text style={styles.catTileEmoji}>{c.emoji}</Text>
                          <Text
                            style={[styles.catTileText, on && { color: tone }]}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.85}
                          >
                            {c.label}
                          </Text>
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
            ) : storyStep === 2 ? (
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
                    {publishingStory
                      ? 'Sharing…'
                      : storyRecipients.size === 0
                        ? 'Ask everyone'
                        : `Ask ${storyRecipients.size} ${storyRecipients.size === 1 ? 'friend' : 'friends'}`}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.storyAlt} onPress={() => setStoryStep(1)}>
                  <Text style={styles.storyAltText}>Back</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                {/* Vem man ber, och en vy man går in i från steg 1. *Everyone*
                    överst, sedan vännerna med kryssrutor; en vän ikryssad
                    gör förfrågan riktad, och *Everyone* tömmer valet. Går man
                    ut utan att kryssa i någon är det alla, som förut. */}
                <Text style={styles.storyTitle}>Who do you want to ask?</Text>
                <ScrollView style={styles.recipientList} showsVerticalScrollIndicator={false}>
                  <TouchableOpacity
                    style={styles.recipientRow}
                    onPress={() => setStoryRecipients(new Set())}
                    activeOpacity={0.75}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: storyRecipients.size === 0 }}
                  >
                    <View style={styles.everyoneIcon}>
                      <FontAwesome5 name="users" size={14} color={Palette.communitySoft} />
                    </View>
                    <Text style={styles.recipientName}>Everyone</Text>
                    <View style={[styles.checkBox, styles.checkRound, storyRecipients.size === 0 && styles.checkBoxOn]}>
                      {storyRecipients.size === 0 && <FontAwesome5 name="check" size={10} color={Palette.onAccent} />}
                    </View>
                  </TouchableOpacity>
                  <View style={styles.recipientDivider} />
                  {friends.length === 0 ? (
                    <Text style={styles.storyEmpty}>You don&apos;t have any friends to choose yet.</Text>
                  ) : friends.map(fr => {
                    const on = storyRecipients.has(fr.id);
                    return (
                      <TouchableOpacity
                        key={fr.id}
                        style={styles.recipientRow}
                        onPress={() => setStoryRecipients(prev => {
                          const next = new Set(prev);
                          if (next.has(fr.id)) next.delete(fr.id); else next.add(fr.id);
                          return next;
                        })}
                        activeOpacity={0.75}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on }}
                      >
                        <Avatar username={fr.username} avatarUrl={fr.avatar_url} size={34} />
                        <Text style={styles.recipientName} numberOfLines={1}>{fr.username}</Text>
                        <View style={[styles.checkBox, on && styles.checkBoxOn]}>
                          {on && <FontAwesome5 name="check" size={10} color={Palette.onAccent} />}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                <TouchableOpacity style={styles.storyPrimary} onPress={() => setStoryStep(1)}>
                  <Text style={styles.storyPrimaryText}>Done</Text>
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
            friendNames={Object.fromEntries(friends.map(fr => [fr.id, fr.username]))}
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
  storyList: { maxHeight: 340 },
  storyListKeyboard: { maxHeight: 120 },
  storyGroupLabel: { ...Palette.eyebrow, fontSize: 12, marginBottom: 8, marginTop: 4 },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8, marginBottom: 4 },
  catTileGap: { marginRight: '2.75%' },
  catTile: {
    width: '31.5%', height: 76, borderRadius: Radius.md,
    alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1.5, paddingHorizontal: 6,
  },
  catTileEmoji: { fontSize: 24 },
  catTileText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: Palette.textSecondary },
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
  storyEmpty: { fontSize: 14, color: Palette.textTertiary, paddingVertical: 8 },
  recipientList: { maxHeight: 320 },
  recipientDivider: { height: StyleSheet.hairlineWidth, backgroundColor: Palette.ink15, marginVertical: 4 },
  everyoneIcon: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: alpha(Palette.community, 0.16),
    alignItems: 'center', justifyContent: 'center',
  },
  checkRound: { borderRadius: 11 },
  storyTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 150,
    paddingVertical: 7, paddingHorizontal: 11, borderRadius: Radius.pill,
    backgroundColor: alpha(Palette.community, 0.12),
    borderWidth: 1, borderColor: alpha(Palette.community, 0.3),
  },
  toPillOn: { backgroundColor: alpha(Palette.community, 0.22), borderColor: Palette.community },
  toPillText: { fontSize: 13, fontWeight: '700', color: Palette.communitySoft, flexShrink: 1 },
  recipientRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 8, paddingHorizontal: 4,
  },
  recipientName: { flex: 1, fontSize: 15, fontWeight: '600', color: Palette.textPrimary },
  checkBox: {
    width: 22, height: 22, borderRadius: 7,
    borderWidth: 1.5, borderColor: Palette.ink30,
    alignItems: 'center', justifyContent: 'center',
  },
  checkBoxOn: { backgroundColor: Palette.accent, borderColor: Palette.accent },
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
  // Vänlistan är fliken bakgrund, inte dess huvudsak: rader utan egen yta,
  // åtskilda av hårfina linjer, med mindre ansikten och text. Det var kort
  // på 78 px med 50 px ansikten, och listan blev det som syntes mest.
  friendCard: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Palette.ink10 },
  friendRow: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  friendLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, paddingVertical: 9, paddingRight: 10 },
  friendAvatar: { position: 'relative' },
  friendInfo: { flex: 1, gap: 2 },
  friendActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Runda knappar i rummets kulör: teckning och ram är `hue`, ytan rummets
  // ton — samma regel som rubrikradens lur och kuvert.
  iconBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Palette.hueTint, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: alpha(Palette.hue, 0.24),
  },
  // Ifylld: inbjudan är skickad. Ifyllt är accentens, i alla rum.
  iconBtnSent: { backgroundColor: Palette.accent, borderColor: Palette.accent },
  iconBtnWrap: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },

  // Avatar
  avatarFallback: {
    backgroundColor: Palette.bg, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Palette.surfaceBorder,
  },
  avatarLetter: { color: Palette.textMuted, fontWeight: '700' },

  rowUsername: { fontSize: 15, fontWeight: '600', color: Palette.textPrimary, letterSpacing: 0.2 },
  statusText: { fontSize: 13, color: Palette.textTertiary, letterSpacing: 0.2 },
  // "pausing now" i accentens blå även i det varma rummet: det är pausens
  // färg, och den ska kännas igen var den än står.
  statusTextActive: { color: Palette.accent, fontWeight: '700' },

  emptyState: { paddingVertical: 24, alignItems: 'center', gap: 10 },
  emptyText: { color: Palette.textTertiary, fontSize: 14 },

  // Profile card modal
  cardBackdrop: { flex: 1, backgroundColor: Palette.scrimStrong, alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: Palette.modalSurface, borderRadius: Radius.xl, borderWidth: 1, borderColor: Palette.modalBorder,
    paddingVertical: 32, paddingHorizontal: 24, alignItems: 'center', gap: 12,
    width: '88%', maxWidth: 380,
  },
  cardInviteBlock: { alignSelf: 'stretch', gap: 8, marginTop: 4 },
  cardInviteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Palette.accent, borderRadius: Radius.pill, paddingVertical: 12, paddingHorizontal: 16,
  },
  cardInviteBtnDone: { backgroundColor: 'transparent', borderWidth: 1, borderColor: Palette.surfaceBorder },
  cardInviteBtnText: { color: Palette.onAccent, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  cardInviteBtnTextDone: { color: Palette.textTertiary },
  cardInviteRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: Palette.ink05, borderRadius: Radius.md, paddingVertical: 8, paddingHorizontal: 12,
  },
  cardInviteRowName: { flex: 1, fontSize: 14, fontWeight: '600', color: Palette.textPrimary },
  cardInviteError: { color: Palette.danger, fontSize: 13, textAlign: 'center' },
  cardRemove: { marginTop: 4, paddingVertical: 6 },
  cardRemoveText: { color: Palette.danger, fontSize: 14, fontWeight: '600' },
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

  friendsLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  addFriendLink: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  addFriendLinkText: { color: Palette.hue, fontSize: 13, fontWeight: '700' },
  inviteAppCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16,
    paddingVertical: 14, paddingHorizontal: 14, borderRadius: Radius.md,
    backgroundColor: Palette.hueTint,
  },
  inviteAppIcon: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: alpha(Palette.hue, 0.24),
  },
  inviteAppTitle: { color: Palette.textPrimary, fontSize: 15, fontWeight: '700' },
  inviteAppSub: { color: Palette.textSecondary, fontSize: 13, marginTop: 2 },

});


const makeInboxStyles = (Palette: AppPalette) => StyleSheet.create({
  inboxCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: 16, borderRadius: Radius.lg,
    backgroundColor: Palette.surface,
    borderWidth: 1, borderColor: alpha(Palette.community, 0.45),
  },
  inboxIcon: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: Palette.communityTint,
    alignItems: 'center', justifyContent: 'center',
  },
  inboxAvatar: {
    position: 'absolute', right: -4, bottom: -4,
    borderRadius: 13, borderWidth: 2, borderColor: Palette.surface,
  },
  inboxTitle: { fontSize: 17, fontWeight: '800', color: Palette.textPrimary },
  thanksCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: 16, borderRadius: Radius.lg,
    backgroundColor: alpha(Palette.dangerSoft, 0.12),
    borderWidth: 1, borderColor: alpha(Palette.dangerSoft, 0.4),
  },
  thanksHeart: {
    position: 'absolute', right: -4, bottom: -4,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: Palette.dangerSoft,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: Palette.bg,
  },
  thanksSub: { fontSize: 13, color: Palette.textSecondary },
  sealedCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: 16, borderRadius: Radius.lg,
    backgroundColor: Palette.surface,
    borderWidth: 1, borderColor: alpha(ENVELOPE.seal, 0.45),
  },
  sealedEnvelope: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: alpha(ENVELOPE.seal, 0.16),
    alignItems: 'center', justifyContent: 'center',
  },
  sealedSeal: {
    position: 'absolute', right: 4, bottom: 6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: ENVELOPE.seal,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2.5,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.8)',
  },
  sealedSealBar: { width: 2.5, height: 7, borderRadius: 1.25, backgroundColor: ENVELOPE.sealMark },
  sealedBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: Palette.accent, borderRadius: Radius.pill,
    paddingVertical: 10, paddingHorizontal: 14,
  },
  sealedBtnText: { color: Palette.onAccent, fontSize: 14, fontWeight: '800' },
  inboxSub: { fontSize: 13, color: Palette.hue, fontWeight: '600' },
});

const makeStoryModalStyles = (Palette: AppPalette) => StyleSheet.create({
  audienceText: { fontSize: 13, color: Palette.textTertiary, textAlign: 'center', marginBottom: 12 },
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
