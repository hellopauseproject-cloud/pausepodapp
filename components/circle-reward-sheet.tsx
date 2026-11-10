import { FontAwesome5 } from '@expo/vector-icons';
import { useEffect, useId, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, Keyboard, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { alpha, AppPalette, Radius, Spacing } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { track } from '../lib/analytics';
import { formatWeekRange } from '../lib/circles';
import {
  CircleReward, formatWeekSpan, getCircleRewardHistory, proposeCircleReward,
  REWARD_MAX_LENGTH, RewardProposal, RewardWeek, toggleCircleRewardVote, withdrawCircleReward,
} from '../lib/circleRewards';
import { RewardWreathIcon } from './reward-wreath-icon';

/**
 * Kretsens belöning — modalen bakom kransknappen i kretsflikens rubrik.
 *
 * Tre saker och inget mer: belöningen, förslagen, och en rad att skriva i.
 * Inga rubriker, inga etiketter, ingen stängknapp (tryck utanför). En första
 * version hade alla tre plus en tonad ruta, en sektionsrubrik, dagar kvar och
 * en stor knapp, och lästes som ett formulär. Reglerna bor i
 * supabase/circle_rewards.sql; här syns bara det man behöver för att handla.
 *
 * Två hörnknappar, en i varje hörn: historiken till vänster, reglerna till
 * höger. Båda byter kortets innehåll i stället för att lägga något över det.
 */

type Props = {
  visible: boolean;
  /** Kretsen belöningen gäller — man kan vara med i upp till tre. */
  circleId: string;
  reward: CircleReward | null;
  meId: string;
  onClose: () => void;
  /** Efter varje skrivning, så att fliken hämtar om svaret. */
  onChanged: () => Promise<void> | void;
};

const GLOW = 260;

// Reglerna, i den ordning man undrar över dem. Allt här är sant i
// supabase/circle_rewards.sql — ändras en regel där ska raden ändras här.
const HOW_IT_WORKS = [
  'The suggestion with the most votes is the reward. If two are tied, the one suggested first wins.',
  'You have one vote, and it can’t go to your own suggestion.',
  'The reward unlocks when everyone hits their goal for the week.',
  'You can make one suggestion. Suggestions and votes reset every Monday.',
];

export function CircleRewardSheet({ visible, circleId, reward, meId, onClose, onChanged }: Props) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Kortet visar en sak i taget: belöningen, reglerna eller historiken.
  const [view, setView] = useState<'main' | 'help' | 'history'>('main');

  // Tangentbordets höjd, mätt för hand — samma lösning som
  // circle-chat.tsx. KeyboardAvoidingView gjorde ingenting på Android
  // (`edgeToEdgeEnabled` stänger av `adjustResize`), så skrivraden låg under
  // tangentbordet. Lägg inte tillbaka en KAV ovanpå: då räknas det två gånger.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, e => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); setKeyboardHeight(0); };
  }, [visible]);
  const [history, setHistory] = useState<RewardWeek[] | null>(null);

  // Historiken hämtas när den öppnas och inte i fliken var fjärde sekund —
  // avslutade veckor ändras inte.
  const openHistory = () => {
    setView('history');
    setHistory(null);
    getCircleRewardHistory(circleId).then(setHistory);
    track('circle_reward_history_opened');
  };
  const glowId = `rewardGlow${useId().replace(/:/g, '')}`;

  const proposals = reward?.proposals ?? [];
  // Den upplåsta belöningen leder när veckan är vunnen: det är den kretsen
  // ska göra nu, även om de hunnit byta efteråt.
  const unlocked = reward?.week_reached ? reward.unlocked_text : null;
  const shown = unlocked ?? reward?.current?.text ?? null;
  const canSend = draft.trim().length > 0 && !sending;

  const handlePropose = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await proposeCircleReward(circleId, text);
      track('circle_reward_proposed', { length: text.length });
      setDraft('');
      await onChanged();
    } catch (e: any) {
      Alert.alert('Could not suggest', e.message);
    } finally {
      setSending(false);
    }
  };

  // Ett ja tas tillbaka med samma tryck, men ett borttaget förslag kommer
  // inte tillbaka med sina ja — därför frågar bara den vägen.
  const confirmWithdraw = (p: RewardProposal) => {
    Alert.alert('Remove your suggestion?', p.text, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => apply(p) },
    ]);
  };

  const handleTap = (p: RewardProposal) => {
    if (p.proposer_id === meId) confirmWithdraw(p);
    else apply(p);
  };

  const apply = async (p: RewardProposal) => {
    if (busyId) return;
    setBusyId(p.id);
    try {
      if (p.proposer_id === meId) {
        await withdrawCircleReward(p.id);
        track('circle_reward_withdrawn');
      } else {
        const nowIn = await toggleCircleRewardVote(p.id);
        track(nowIn ? 'circle_reward_voted' : 'circle_reward_unvoted');
      }
      await onChanged();
    } catch (e: any) {
      Alert.alert('Could not update', e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, keyboardHeight > 0 && { paddingBottom: keyboardHeight + Spacing.md }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => { setView('main'); onClose(); }} accessibilityLabel="Close" />
        <View style={styles.card}>
          {/* Reglerna står inte i modalen — bara bakom frågetecknet, för den
              som undrar. En rad regeltext ovanför listan läses varje gång
              och förstås en. */}
          {view === 'main' && (<>
          <TouchableOpacity
            style={[styles.cornerBtn, styles.cornerLeft]}
            onPress={openHistory}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Past weeks"
          >
            <FontAwesome5 name="history" size={14} color={Palette.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.cornerBtn, styles.cornerRight]}
            onPress={() => setView('help')}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="How the reward works"
          >
            <FontAwesome5 name="question" size={10} color={Palette.textTertiary} />
          </TouchableOpacity>
          {/* Belöningen. Raden under säger det enda man behöver veta om
              den: om den är vunnen, och annars vad som vinner den. */}
          {/* När veckan är vunnen blir belöningen ett eget kort med glöd —
              det är priset, och förslagen under tonas ner till bakgrund. */}
          <View style={[styles.hero, unlocked && styles.heroWon]}>
            {/* Glöden är en radiell toning (svg, som månen). En platt cirkel
                i samma kulör prövades och lästes som en skiva, inte som ljus. */}
            {unlocked && (
              <Svg width={GLOW} height={GLOW} style={styles.heroGlow} pointerEvents="none">
                <Defs>
                  <RadialGradient id={glowId} cx="50%" cy="50%" r="50%">
                    <Stop offset="0" stopColor={Palette.hue} stopOpacity={0.38} />
                    <Stop offset="0.65" stopColor={Palette.hue} stopOpacity={0} />
                  </RadialGradient>
                </Defs>
                <Circle cx={GLOW / 2} cy={GLOW / 2} r={GLOW / 2} fill={`url(#${glowId})`} />
              </Svg>
            )}
            <RewardWreathIcon size={unlocked ? 60 : 44} color={Palette.hue} filled={!!shown} />
            {/* Veckan, direkt ovanför belöningen den gäller. Den stod en tid
                ensam i vänstra hörnet och läste som en etikett utan ägare.
                Samma form som kretsflikens datumrad ("OCT 5 – OCT 11"). */}
            {reward?.week_start && (
              <Text style={styles.weekRange}>{formatWeekRange(reward.week_start)}</Text>
            )}
            <Text style={[styles.rewardText, !shown && styles.rewardTextEmpty]}>
              {shown ?? 'No reward yet'}
            </Text>
            <Text style={[styles.sub, unlocked && styles.subUnlocked]}>
              {unlocked ? 'Unlocked this week' : 'When everyone hits their goal'}
            </Text>
          </View>

          {/* Förslagen. Hela raden är knappen: ett tryck är ett ja (eller tar
              tillbaka det), och på ens eget förslag tar det bort det. */}
          {proposals.length > 0 && reward && (
            <ScrollView style={[styles.list, unlocked && styles.listDimmed]} showsVerticalScrollIndicator={false}>
              {proposals.map(p => {
                const isMine = p.proposer_id === meId;
                const on = isMine || p.i_voted;
                return (
                  <TouchableOpacity
                    key={p.id}
                    style={styles.row}
                    onPress={() => handleTap(p)}
                    activeOpacity={0.6}
                    disabled={!!busyId}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={(
                      isMine ? `Your suggestion, ${p.text}. Tap to remove.`
                        : p.i_voted ? `${p.text}. You're in. Tap to take it back.`
                        : `${p.text}, suggested by ${p.proposer_name}. Tap to vote for it.`
                    ) + ` ${p.votes} ${p.votes === 1 ? 'person is' : 'people are'} in.`}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowText} numberOfLines={2}>{p.text}</Text>
                      <Text style={styles.rowMeta}>{isMine ? 'You' : p.proposer_name}</Text>
                    </View>
                    {/* Bara antalet ja. Listan kommer sorterad (flest först,
                        äldst först vid lika), så översta raden med ett ja är
                        belöningen — dess siffra står i rummets kulör. */}
                    <Text style={[styles.count, p.id === reward.leader_id && styles.countLeader]}>{p.votes}</Text>
                    {busyId === p.id ? (
                      <ActivityIndicator size="small" color={Palette.hue} style={styles.check} />
                    ) : isMine ? (
                      <View style={styles.check}>
                        <FontAwesome5 name="times" size={12} color={Palette.danger} />
                      </View>
                    ) : (
                      <View style={[styles.check, styles.checkRing, on && styles.checkOn]}>
                        {on && <FontAwesome5 name="check" size={11} color={Palette.onAccent} />}
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          {/* En rad, som chattens: fältet och en pil. */}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Suggest a reward…"
              placeholderTextColor={Palette.textTertiary}
              maxLength={REWARD_MAX_LENGTH}
              returnKeyType="send"
              onSubmitEditing={handlePropose}
            />
            <TouchableOpacity
              style={[styles.send, !canSend && styles.sendOff]}
              onPress={handlePropose}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel="Suggest"
            >
              {sending
                ? <ActivityIndicator size="small" color={Palette.onAccent} />
                : <FontAwesome5 name="arrow-up" size={13} color={Palette.onAccent} />}
            </TouchableOpacity>
          </View>
          </>)}

          {/* Rutan tar kortets plats i stället för att läggas över det: ett
              kort utan förslag är lägre än reglerna, och en ruta ovanpå hade
              klippts. Man är kvar i samma modal och kommer tillbaka dit man
              var. */}
          {view === 'help' && (
            <View style={styles.help}>
              <Text style={styles.helpTitle}>How it works</Text>
              <View style={styles.helpList}>
                {HOW_IT_WORKS.map(line => (
                  <View key={line} style={styles.helpRow}>
                    <View style={styles.helpBullet} />
                    <Text style={styles.helpText}>{line}</Text>
                  </View>
                ))}
              </View>
              <TouchableOpacity onPress={() => setView('main')} style={styles.helpDone} accessibilityRole="button">
                <Text style={styles.helpDoneText}>Got it</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Historiken: de vunna veckorna, senaste först, med belöningen de
              låste upp. Bara de vunna — det här är ett ställe att fira. */}
          {view === 'history' && (
            <View style={styles.help}>
              <Text style={styles.helpTitle}>Past weeks</Text>
              {history === null ? (
                <ActivityIndicator color={Palette.hue} style={{ paddingVertical: Spacing.lg }} />
              ) : history.length === 0 ? (
                <Text style={styles.historyEmpty}>No weeks won yet. They’ll show up here.</Text>
              ) : (
                <ScrollView style={styles.historyList} showsVerticalScrollIndicator={false}>
                  {history.map(w => (
                    <View
                      key={w.week_start}
                      style={styles.historyRow}
                      accessible
                      accessibilityLabel={`${formatWeekSpan(w.week_start)}. Goal reached.${w.reward ? ` ${w.reward}.` : ''}`}
                    >
                      <FontAwesome5 name="star" solid size={15} color={Palette.hue} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.historyReward} numberOfLines={2}>
                          {w.reward ?? 'Goal reached'}
                        </Text>
                        <Text style={styles.rowMeta}>{formatWeekSpan(w.week_start)}</Text>
                      </View>
                    </View>
                  ))}
                </ScrollView>
              )}
              <TouchableOpacity onPress={() => setView('main')} style={styles.helpDone} accessibilityRole="button">
                <Text style={styles.helpDoneText}>Back</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

// Kortets yta är kretsflikens egna modalmått (`card` i app/(tabs)/circle.tsx).
// Ändras de där ska de ändras här också.
const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: Palette.scrim, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  // `flexShrink`: med tangentbordet uppe krymper kortet till ytan ovanför
  // det, och det är förslagslistan (som själv krymper) som ger plats.
  card: {
    width: '100%', maxHeight: '85%', flexShrink: 1, backgroundColor: Palette.modalSurface, borderRadius: Radius.xl,
    padding: Spacing.xl, gap: Spacing.lg, borderWidth: 1, borderColor: Palette.modalBorder,
  },

  hero: { alignItems: 'center', gap: 8, paddingTop: Spacing.xs },
  weekRange: { fontSize: 12, fontWeight: '700', color: Palette.textTertiary, letterSpacing: 1.2, marginTop: 2 },
  // Hörnknapparna: samma ring i båda hörnen, så att de läses som ett par.
  // Historiken är större än frågetecknet: den är en plats man går till, reglerna
  // något man kollar en gång.
  cornerLeft: { left: 10, top: 10, width: 32, height: 32, borderRadius: 16 },
  cornerRight: { right: 14 },
  cornerBtn: {
    position: 'absolute', top: 14, zIndex: 1,
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.2, borderColor: Palette.surfaceBorder,
  },
  help: { gap: Spacing.lg, paddingTop: Spacing.xs },
  helpTitle: { fontSize: 18, fontWeight: '800', color: Palette.textPrimary, textAlign: 'center' },
  helpList: { gap: Spacing.md },
  helpRow: { flexDirection: 'row', gap: 10 },
  helpBullet: { width: 6, height: 6, borderRadius: 3, backgroundColor: Palette.hue, marginTop: 7 },
  helpText: { flex: 1, fontSize: 14, lineHeight: 20, color: Palette.textSecondary },
  helpDone: { alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 12 },
  helpDoneText: { fontSize: 15, fontWeight: '700', color: Palette.hue },
  historyList: { flexGrow: 0, flexShrink: 1, maxHeight: 380, borderTopWidth: 1, borderTopColor: Palette.surfaceBorder },
  historyRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: Palette.surfaceBorder,
  },
  historyReward: { fontSize: 15, fontWeight: '600', color: Palette.textPrimary },
  historyEmpty: { fontSize: 14, color: Palette.textTertiary, textAlign: 'center', paddingVertical: Spacing.md },
  // Den vunna veckan: ett kort i rummets kulör med en glöd bakom kransen.
  // `overflow: hidden` klipper glöden mot kortets hörn.
  heroWon: {
    // Luft ovanför för frågetecknet i kortets hörn, som annars hamnar på
    // kanten av det här kortet.
    marginTop: 20,
    paddingVertical: Spacing.xl, paddingHorizontal: Spacing.lg,
    borderRadius: Radius.lg, overflow: 'hidden',
    backgroundColor: alpha(Palette.hue, 0.14),
    borderWidth: 1, borderColor: alpha(Palette.hue, 0.4),
  },
  heroGlow: { position: 'absolute', top: -90, left: '50%', marginLeft: -GLOW / 2 },
  rewardText: {
    fontSize: 22, lineHeight: 28, fontWeight: '800', color: Palette.textPrimary,
    textAlign: 'center', marginTop: 4,
  },
  rewardTextEmpty: { color: Palette.textTertiary, fontWeight: '700' },
  sub: { fontSize: 13, color: Palette.textTertiary, textAlign: 'center' },
  subUnlocked: { color: Palette.hue, fontWeight: '700' },

  list: { flexGrow: 0, flexShrink: 1, borderTopWidth: 1, borderTopColor: Palette.surfaceBorder },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Palette.surfaceBorder,
  },
  rowText: { fontSize: 15, fontWeight: '600', color: Palette.textPrimary },
  rowMeta: { fontSize: 12, color: Palette.textTertiary, marginTop: 2 },
  // Förslagen när veckan är vunnen: kvar och tryckbara (de gäller nästa
  // belöning), men bakgrund till priset ovanför.
  listDimmed: { opacity: 0.4 },
  countLeader: { color: Palette.hue },
  count: { fontSize: 15, fontWeight: '700', color: Palette.textSecondary, fontVariant: ['tabular-nums'], minWidth: 14, textAlign: 'right' },
  check: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  checkRing: { borderRadius: 13, borderWidth: 1.5, borderColor: alpha(Palette.hue, 0.5) },
  // Ett ja är fyllt i accenten, som brickorna: ett val man gjort.
  checkOn: { backgroundColor: Palette.accent, borderColor: Palette.accent },

  inputRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  input: {
    flex: 1, backgroundColor: Palette.surface, borderRadius: Radius.pill,
    paddingVertical: 11, paddingHorizontal: 16, fontSize: 15, color: Palette.textPrimary,
  },
  send: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: Palette.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  sendOff: { opacity: 0.35 },
});
