import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, Keyboard, Modal, Platform, Pressable,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppPalette, Radius, Spacing, alpha } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { usePalette } from '../contexts/ThemeContext';
import { safeBottom } from '../lib/bottomInset';
import {
  blockUser, REPORT_REASONS, ReportReason, ReportTarget, sendReport,
} from '../lib/moderation';

/**
 * Rapportera och blockera — arket, rapportflödet och toasten, i en hook.
 *
 *   const moderation = useModeration({ onBlocked });
 *   moderation.openUserMenu({ id, username });       // ⋯ på en person
 *   moderation.openContentMenu(target, username);    // långtryck på innehåll
 *   …
 *   {moderation.element}                             // i skärmens rot
 *
 * **En hook och inte en provider i roten**, för en modal tillhör rummet man
 * öppnade den från (CLAUDE.md, *Plommon, rum och bakgrunden*): elementet
 * renderas inne i skärmens `RoomProvider` och får dess palett. Det ska stå i
 * skärmens rot och inte i en ScrollView — toasten är absolut placerad.
 *
 * **Ett enda Modal-lager**, som byter innehåll från menyn till rapporten och
 * tacket. Två modaler ovanpå varandra fungerar inte på iOS.
 *
 * **`inline`** ritar samma ark som ett absolut lager i stället för ett eget
 * Modal, för när menyn öppnas inifrån ett Modal som redan står uppe
 * (kretsens medlemslista). Elementet ska då stå sist inne i det Modal-et, och
 * dess `onRequestClose` ska stänga arket först (`isOpen`, `close`), så att
 * Androids bakåtknapp tar bort det översta lagret och inte det under.
 *
 * Långtrycket på innehåll erbjuder bara *Report*: blockeringen bor på
 * personen (⋯ i listorna och på profilkortet), inte på ett meddelande.
 */

export type ModerationUser = { id: string; username: string };

/** En rad till överst i personens meny, i neutralt bläck — *Remove friend* på
 *  profilkortet. Arket stängs innan `onPress` körs. */
export type ModerationMenuRow = { label: string; onPress: () => void };

type Stage =
  | { kind: 'userMenu'; user: ModerationUser; extraRows: ModerationMenuRow[] }
  | { kind: 'contentMenu'; target: ReportTarget }
  | { kind: 'report'; target: ReportTarget }
  | { kind: 'thanks' };

/** Felröd för *Report* och *Block*, enligt specen och inte paletten:
 *  `Palette.danger` är Finish och raderingar, och mot de ljusa ytorna i mörkt
 *  läge behövs en ljusare ton. */
const REPORT_RED_LIGHT = '#C2321F';
const REPORT_RED_DARK = '#FFB4A8';

/** iOS hinner inte stänga ett Modal innan nästa (eller en Alert) visas. */
const MODAL_GAP_MS = 350;
const TOAST_MS = 2400;

function isDarkColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum < 128;
}

export function useModeration(opts: { onBlocked?: (user: ModerationUser) => void; inline?: boolean } = {}) {
  const Palette = usePalette();
  const red = isDarkColor(Palette.bg) ? REPORT_RED_DARK : REPORT_RED_LIGHT;
  const styles = useMemo(() => makeStyles(Palette, red), [Palette, red]);
  const insets = useSafeAreaInsets();
  const { user: me } = useAuth();

  const [stage, setStage] = useState<Stage | null>(null);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const toastAnim = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onBlockedRef = useRef(opts.onBlocked);
  onBlockedRef.current = opts.onBlocked;

  // Samma lösning som circle-reward-sheet.tsx: med edgeToEdge gör
  // KeyboardAvoidingView ingenting på Android.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (stage?.kind !== 'report') return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, e => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); setKeyboardHeight(0); };
  }, [stage?.kind]);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const showToast = useCallback((text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(text);
    toastAnim.setValue(0);
    Animated.timing(toastAnim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    toastTimer.current = setTimeout(() => {
      Animated.timing(toastAnim, { toValue: 0, duration: 260, useNativeDriver: true })
        .start(() => setToast(null));
    }, TOAST_MS);
  }, [toastAnim]);

  const resetReport = () => { setReason(null); setDetails(''); setError(''); setSending(false); };

  const close = useCallback(() => { setStage(null); Keyboard.dismiss(); }, []);

  /** `delayMs` när ett annat Modal just stängts. */
  const openUserMenu = useCallback((
    user: ModerationUser,
    { delayMs = 0, extraRows = [] }: { delayMs?: number; extraRows?: ModerationMenuRow[] } = {},
  ) => {
    resetReport();
    const open = () => setStage({ kind: 'userMenu', user, extraRows });
    if (delayMs > 0) setTimeout(open, delayMs);
    else open();
  }, []);

  const openContentMenu = useCallback((target: ReportTarget) => {
    resetReport();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setStage({ kind: 'contentMenu', target });
  }, []);

  const confirmBlock = (user: ModerationUser) => {
    close();
    setTimeout(() => {
      Alert.alert(
        `Block ${user.username}?`,
        "They can't see you, message you or send you support anymore. They're not told.",
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Block',
            style: 'destructive',
            onPress: async () => {
              if (!me?.id) return;
              try {
                await blockUser(me.id, user.id);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                showToast(`${user.username} is blocked.`);
                onBlockedRef.current?.(user);
              } catch (e: any) {
                Alert.alert('Could not block', e?.message ?? 'Try again.');
              }
            },
          },
        ],
      );
    }, MODAL_GAP_MS);
  };

  const submitReport = async () => {
    if (stage?.kind !== 'report' || !reason || sending) return;
    setSending(true);
    setError('');
    try {
      await sendReport(stage.target, reason, details);
      Keyboard.dismiss();
      setStage({ kind: 'thanks' });
    } catch (e: any) {
      setError(e?.message ?? 'Could not send. Try again.');
    } finally {
      setSending(false);
    }
  };

  /** `cancel`: den sista, fristående raden — fetare och med en tydligare
   *  kant, så att den inte smälter ihop med systemets knappar under. */
  const menuRows = (rows: { label: string; onPress: () => void; danger?: boolean }[], cancel = false) => (
    <View style={[styles.menu, cancel && styles.menuCancel]}>
      {rows.map((r, i) => (
        <TouchableOpacity
          key={r.label}
          style={[styles.menuRow, i > 0 && styles.menuRowLine]}
          onPress={r.onPress}
          activeOpacity={0.7}
          accessibilityRole="button"
        >
          <Text style={[styles.menuText, r.danger && styles.menuTextDanger, cancel && styles.menuTextCancel]} numberOfLines={1}>{r.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  let body: React.ReactNode = null;
  if (stage?.kind === 'userMenu') {
    const u = stage.user;
    body = (
      <>
        {menuRows([
          ...stage.extraRows.map(r => ({
            label: r.label,
            onPress: () => { close(); setTimeout(r.onPress, MODAL_GAP_MS); },
          })),
          {
            label: `Report ${u.username}`,
            danger: true,
            onPress: () => setStage({ kind: 'report', target: { contentType: 'profile', contentId: null, userId: u.id } }),
          },
          { label: `Block ${u.username}`, danger: true, onPress: () => confirmBlock(u) },
        ])}
        {menuRows([{ label: 'Cancel', onPress: close }], true)}
      </>
    );
  } else if (stage?.kind === 'contentMenu') {
    const target = stage.target;
    body = (
      <>
        {menuRows([{ label: 'Report', danger: true, onPress: () => setStage({ kind: 'report', target }) }])}
        {menuRows([{ label: 'Cancel', onPress: close }], true)}
      </>
    );
  } else if (stage?.kind === 'report') {
    body = (
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text style={styles.title}>Report</Text>
        <Text style={styles.subtitle}>Why are you reporting this?</Text>
        <View style={styles.reasons} accessibilityRole="radiogroup">
          {REPORT_REASONS.map(r => {
            const on = reason === r.id;
            return (
              <TouchableOpacity
                key={r.id}
                style={styles.reasonRow}
                onPress={() => setReason(r.id)}
                activeOpacity={0.7}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
              >
                <View style={[styles.radio, on && styles.radioOn]}>
                  {on && <View style={styles.radioDot} />}
                </View>
                <Text style={styles.reasonText}>{r.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TextInput
          style={styles.input}
          value={details}
          onChangeText={t => setDetails(t.slice(0, 1000))}
          placeholder="Anything else we should know? (optional)"
          placeholderTextColor={Palette.textTertiary}
          multiline
          maxLength={1000}
        />
        {!!error && <Text style={styles.error}>{error}</Text>}
        <TouchableOpacity
          style={[styles.primary, (!reason || sending) && styles.primaryOff]}
          onPress={submitReport}
          disabled={!reason || sending}
          activeOpacity={0.85}
          accessibilityRole="button"
        >
          {sending
            ? <ActivityIndicator color={Palette.onAccent} />
            : <Text style={styles.primaryText}>Send report</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={close} style={styles.cancel} activeOpacity={0.7} accessibilityRole="button">
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (stage?.kind === 'thanks') {
    body = (
      <View style={[styles.sheet, styles.thanks]}>
        <View style={styles.grabber} />
        <View style={styles.thanksIcon}>
          {/* Accenten och inte rummets hue: i Kretsen är hue grön, och en grön
              bock är lådans bekräftelse (CLAUDE.md, grönregeln). */}
          <FontAwesome5 name="check" size={18} color={Palette.accent} />
        </View>
        <Text style={styles.thanksText}>Thanks. A real person looks at every report.</Text>
        <TouchableOpacity style={styles.primary} onPress={close} activeOpacity={0.85} accessibilityRole="button">
          <Text style={styles.primaryText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const layer = (
    <Pressable style={[styles.backdrop, opts.inline && StyleSheet.absoluteFill]} onPress={close}>
      <Pressable
        onPress={() => {}}
        // safeBottom: Android-golvet, samma som flikraden (lib/bottomInset.ts),
        // plus luft så att Cancel står fritt från systemets knappar.
        style={[styles.panel, { paddingBottom: safeBottom(insets.bottom) + Spacing.lg + keyboardHeight }]}
      >
        {body}
      </Pressable>
    </Pressable>
  );

  const element = (
    <>
      {opts.inline ? (
        stage && layer
      ) : (
        <Modal visible={!!stage} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
          {layer}
        </Modal>
      )}
      {toast && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.toast,
            { bottom: insets.bottom + 96, opacity: toastAnim,
              transform: [{ translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] },
          ]}
          accessibilityLiveRegion="polite"
        >
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      )}
    </>
  );

  return { openUserMenu, openContentMenu, element, isOpen: !!stage, close };
}

/**
 * ⋯ till höger på en persons rad. 44 × 44 så att den går att träffa, och
 * ikonen i rummets dämpade bläck — den är en väg till något sällsynt, inte en
 * handling raden bär.
 */
export function MoreButton({ username, onPress, color }: { username: string; onPress: () => void; color?: string }) {
  const Palette = usePalette();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={moreStyle}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={`More options for ${username}`}
    >
      <FontAwesome5 name="ellipsis-h" size={15} color={color ?? Palette.textTertiary} />
    </TouchableOpacity>
  );
}

const moreStyle = { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' } as const;

const makeStyles = (Palette: AppPalette, red: string) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: Palette.scrim, justifyContent: 'flex-end' },
  panel: { paddingHorizontal: Spacing.md, gap: Spacing.sm },

  menu: {
    backgroundColor: Palette.modalSurface, borderRadius: Radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: Palette.modalBorder,
  },
  menuCancel: { marginTop: Spacing.xs, borderColor: Palette.ink20 },
  menuTextCancel: { fontWeight: '700' },
  menuRow: { minHeight: 56, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.lg },
  menuRowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Palette.ink12 },
  menuText: { fontSize: 17, fontWeight: '600', color: Palette.textPrimary, letterSpacing: 0.2 },
  menuTextDanger: { color: red },

  sheet: {
    backgroundColor: Palette.modalSurface, borderRadius: Radius.xl, padding: Spacing.xl, paddingTop: Spacing.md,
    borderWidth: 1, borderColor: Palette.modalBorder, gap: Spacing.sm,
  },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: Palette.ink20, marginBottom: Spacing.sm },
  title: { fontSize: 22, fontWeight: '700', color: Palette.textPrimary, letterSpacing: 0.2 },
  subtitle: { fontSize: 15, color: Palette.textSecondary, marginBottom: Spacing.xs },
  reasons: { marginVertical: Spacing.xs },
  reasonRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, minHeight: 44 },
  radio: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: Palette.ink40,
    alignItems: 'center', justifyContent: 'center',
  },
  radioOn: { borderColor: Palette.accent },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Palette.accent },
  reasonText: { flex: 1, fontSize: 15, color: Palette.textPrimary },
  input: {
    minHeight: 72, maxHeight: 140, textAlignVertical: 'top',
    backgroundColor: alpha(Palette.textPrimary, 0.05), borderRadius: Radius.md,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.md,
    fontSize: 15, color: Palette.textPrimary, marginTop: Spacing.xs,
  },
  error: { fontSize: 13, color: red },
  primary: {
    height: 50, borderRadius: Radius.pill, backgroundColor: Palette.accent,
    alignItems: 'center', justifyContent: 'center', marginTop: Spacing.sm,
  },
  primaryOff: { opacity: 0.45 },
  primaryText: { color: Palette.onAccent, fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  cancel: { alignSelf: 'center', paddingVertical: Spacing.md, paddingHorizontal: Spacing.xl },
  cancelText: { fontSize: 15, fontWeight: '600', color: Palette.textSecondary },

  thanks: { alignItems: 'center', gap: Spacing.md },
  thanksIcon: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: alpha(Palette.accent, 0.15),
    alignItems: 'center', justifyContent: 'center',
  },
  thanksText: { fontSize: 17, fontWeight: '600', color: Palette.textPrimary, textAlign: 'center', lineHeight: 24 },

  toast: {
    position: 'absolute', alignSelf: 'center', maxWidth: '86%',
    backgroundColor: Palette.modalSurface, borderRadius: Radius.pill,
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md,
    borderWidth: 1, borderColor: Palette.modalBorder,
  },
  toastText: { fontSize: 14, fontWeight: '600', color: Palette.textPrimary, textAlign: 'center' },
});
