import { FontAwesome5 } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Image, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AppPalette, Radius } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { usePalette } from '../contexts/ThemeContext';
import { circleLevelName } from '../lib/circleLevels';
import { FriendCircleBadge, getFriendCircleBadge, getMyCircles } from '../lib/circles';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { CircleLevelBadge } from './circle-level-badge';
import { PauseButtonFace } from './pause-button-face';
import { ModerationUser, MoreButton, useModeration } from './moderation';

/**
 * En persons kort: ansiktet, namnet, kretsarna, och det man kan göra med
 * personen. Öppnas med ett tryck på en rad i Friends (vän eller förfrågan)
 * och i kretsens medlemslista (`member`).
 *
 * **⋯ uppe till höger bär det sällsynta**: *Remove friend* för en vän, och
 * *Report* och *Block* för alla. De stod förr som ⋯ på varje rad i listan
 * och som en röd *Remove friend* på kortet; nu är kortet personen, och menyn
 * relationen. Menyn ritas ovanpå kortet (`inline` i components/moderation.tsx),
 * inte i stället för det.
 *
 * **`inline`** ritar kortet som ett lager i stället för ett eget Modal, för
 * kretsens medlemslista, som själv redan är ett Modal — två Modal ovanpå
 * varandra fungerar inte på iOS.
 */
export type ProfileCardData = {
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
} | {
  id: string; username: string; avatar_url: string | null;
  kind: 'member';
  /** Vänskapen sedd härifrån. `pending` utan riktning, samma skäl som listan. */
  friendStatus: 'accepted' | 'pending' | null;
};

/** Samma höjd som stödsvarens PAUSE-knapp (app/text-message.tsx). */
const BTN_H = 42;

function isDarkBg(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return true;
  const n = parseInt(m[1], 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 128;
}

function Avatar({ username, avatarUrl, size }: { username: string; avatarUrl?: string | null; size: number }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  if (avatarUrl) {
    return <Image source={{ uri: avatarUrl }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  return (
    <View style={[styles.avatarFallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarLetter, { fontSize: size * 0.38 }]}>{username[0]?.toUpperCase() ?? '?'}</Text>
    </View>
  );
}

export function ProfileCard({ data, onClose, onRemoveFriend, onAddFriend, onBlocked, inline }: {
  data: ProfileCardData;
  onClose: () => void;
  onRemoveFriend?: (friendshipId: string, friendId: string) => void;
  /** Bara för `member`. Kastar vid fel. */
  onAddFriend?: (userId: string) => Promise<void>;
  /** Kortet stängs av sig självt efter en blockering. */
  onBlocked?: (user: ModerationUser) => void;
  inline?: boolean;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  // Text på en fylld yta i rummets kulör: rummets mörka botten i mörkt läge,
  // vitt i ljust — samma regel som SegmentedPill.
  const onHue = isDarkBg(Palette.bg) ? Palette.bg : Palette.onAccent;
  const { user } = useAuth();
  const moderation = useModeration({
    inline: true,
    onBlocked: u => { onBlocked?.(u); onClose(); },
  });

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

  // En kretsmedlem som inte är vän: *Add friend* på kortet, samma insert som
  // listans knapp.
  const [memberFriend, setMemberFriend] = useState<'none' | 'sending' | 'sent'>('none');
  const [addError, setAddError] = useState('');
  const addFriend = async () => {
    if (!onAddFriend || memberFriend !== 'none') return;
    setAddError('');
    setMemberFriend('sending');
    try {
      await onAddFriend(data.id);
      setMemberFriend('sent');
    } catch (e: any) {
      setAddError(e?.message ?? 'Could not send. Try again.');
      setMemberFriend('none');
    }
  };

  const openMenu = () => {
    const extraRows = data.kind === 'friend' && onRemoveFriend
      ? [{ label: 'Remove friend', onPress: () => confirmRemove(data.friendshipId) }]
      : [];
    moderation.openUserMenu({ id: data.id, username: data.username }, { extraRows });
  };

  const confirmRemove = (friendshipId: string) => {
    Alert.alert(
      `Remove ${data.username}?`,
      'You will no longer see each other in your friend lists.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => { onRemoveFriend?.(friendshipId, data.id); onClose(); } },
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

  const content = (
    <Pressable style={[styles.cardBackdrop, inline && StyleSheet.absoluteFill]} onPress={onClose}>
      <Pressable style={styles.card} onPress={() => {}}>
        <View style={styles.cardMore}>
          <MoreButton username={data.username} onPress={openMenu} />
        </View>
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
              <Text style={styles.cardCircleEyebrow}>CIRCLE</Text>
              <Text style={styles.cardCircleName} numberOfLines={1}>{circle.circle_name}</Text>
              <Text style={styles.cardCircleLevel} numberOfLines={1}>LEVEL {circle.level}</Text>
              <Text style={styles.cardCircleLevelName} numberOfLines={1}>
                {circleLevelName(circle.level)}
              </Text>
            </View>
          </View>
        )}
        {/* Två eller tre kretsar: en rad per krets, märke + namn + nivå. */}
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
                {onlyCircle.state === 'open' && <PauseButtonFace radius={BTN_H / 2} />}
                <FontAwesome5 name="user-plus" size={13} color={onlyCircle.state === 'open' ? Palette.onAccent : Palette.textTertiary} />
                <Text style={[styles.cardInviteBtnText, onlyCircle.state !== 'open' && styles.cardInviteBtnTextDone]} numberOfLines={1}>
                  {onlyCircle.state === 'open' ? `INVITE TO ${onlyCircle.name.toUpperCase()}` : `${circleLabel(onlyCircle)} · ${onlyCircle.name}`.toUpperCase()}
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
                  <PauseButtonFace radius={BTN_H / 2} />
                  <FontAwesome5 name="user-plus" size={13} color={Palette.onAccent} />
                  <Text style={styles.cardInviteBtnText}>INVITE TO CIRCLE</Text>
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

        {data.kind === 'member' && (data.friendStatus === 'accepted' ? (
          <Text style={styles.cardStatus}>Friends</Text>
        ) : data.friendStatus === 'pending' || memberFriend === 'sent' ? (
          <Text style={styles.cardStatus}>Friend request pending</Text>
        ) : onAddFriend ? (
          <View style={styles.cardInviteBlock}>
            <TouchableOpacity
              style={[styles.cardInviteBtn, styles.addFriendBtn]}
              onPress={addFriend}
              disabled={memberFriend !== 'none'}
              activeOpacity={0.85}
              accessibilityRole="button"
            >
              <FontAwesome5 name="user-plus" size={13} color={onHue} />
              <Text style={[styles.cardInviteBtnText, { color: onHue }]}>{memberFriend === 'sending' ? 'SENDING…' : 'ADD FRIEND'}</Text>
            </TouchableOpacity>
            {!!addError && <Text style={styles.cardInviteError}>{addError}</Text>}
          </View>
        ) : null)}

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
      {/* Menyn ovanpå kortet, i samma lager. */}
      {moderation.element}
    </Pressable>
  );

  if (inline) return content;
  return (
    <Modal transparent animationType="fade" onRequestClose={() => (moderation.isOpen ? moderation.close() : onClose())}>
      {content}
    </Modal>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  avatarFallback: {
    backgroundColor: Palette.bg, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Palette.surfaceBorder,
  },
  avatarLetter: { color: Palette.textMuted, fontWeight: '700' },

  acceptBtn: { backgroundColor: Palette.accent, paddingVertical: 5, paddingHorizontal: 10, borderRadius: Radius.pill },
  acceptBtnText: { color: Palette.onAccent, fontSize: 12, fontWeight: '600' },
  declineBtn: {
    backgroundColor: 'transparent', paddingVertical: 5, paddingHorizontal: 10,
    borderRadius: Radius.pill, borderWidth: 1, borderColor: Palette.surfaceBorder,
  },
  declineBtnText: { color: Palette.textTertiary, fontSize: 12, fontWeight: '500' },

  cardBackdrop: { flex: 1, backgroundColor: Palette.scrimStrong, alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: Palette.modalSurface, borderRadius: Radius.xl, borderWidth: 1, borderColor: Palette.modalBorder,
    paddingVertical: 32, paddingHorizontal: 24, alignItems: 'center', gap: 12,
    width: '88%', maxWidth: 380,
  },
  cardMore: { position: 'absolute', top: 6, right: 6, zIndex: 1 },
  cardInviteBlock: { alignSelf: 'stretch', gap: 8, marginTop: 4 },
  // PAUSE-knappens material (PauseButtonFace ligger under innehållet), höjd
  // och versaler. Den glöder i accenten som knappen på stödsvaren.
  cardInviteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    // Bara så bred som texten, centrerad — som PAUSE på stödsvaren, inte
    // kortets fulla bredd.
    alignSelf: 'center', maxWidth: '100%',
    backgroundColor: Palette.accent, borderRadius: BTN_H / 2, height: BTN_H, paddingHorizontal: 22,
    shadowColor: Palette.accent, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 12,
    elevation: 6,
  },
  // *Add friend* på en kretsmedlems kort: fylld i rummets kulör, alltså grön
  // i Kretsen. Grönt är här vilket rum man står i, inte en bekräftelse
  // (CLAUDE.md, grönregeln). Platt: materialet är PAUSE-knappens blå.
  addFriendBtn: { backgroundColor: Palette.hue, shadowColor: Palette.hue },
  cardInviteBtnDone: {
    backgroundColor: 'transparent', borderWidth: 1, borderColor: Palette.surfaceBorder,
    shadowOpacity: 0, elevation: 0,
  },
  cardInviteBtnText: { color: Palette.onAccent, fontSize: 13, fontWeight: '900', letterSpacing: 1.6, flexShrink: 1 },
  cardInviteBtnTextDone: { color: Palette.textTertiary },
  cardInviteRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: Palette.ink05, borderRadius: Radius.md, paddingVertical: 8, paddingHorizontal: 12,
  },
  cardInviteRowName: { flex: 1, fontSize: 14, fontWeight: '600', color: Palette.textPrimary },
  cardInviteError: { color: Palette.danger, fontSize: 13, textAlign: 'center' },
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
});
