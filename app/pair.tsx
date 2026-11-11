import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PauseButtonFace } from '../components/pause-button-face';
import { PauseTagBadge } from '../components/pause-tag-badge';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import {
  claimTagPairing,
  normalizePairCode,
  PAIR_ERROR_TEXT,
  type PairError,
  previewTagPairing,
  setPendingPairCode,
} from '../lib/tagPairing';
import DismissKeyboardView from './components/DismissKeyboardView';

/**
 * Koppla en Pause-tagg till kontot.
 *
 * Nås på två sätt: QR-koden på lådan (`pauseapp://pair?code=ABC123`, via
 * joinpausepod.com/pair) och raden *Register a Pause tag* i Settings, där man
 * knappar in koden som står under QR-koden. Samma skärm, med eller utan kod.
 *
 * Skärmen frågar först (`preview`) och kopplar först efter ett ja, så att en
 * skannad kod aldrig gör något man inte sett.
 *
 * Frågan gäller **taggen**, inte telefonen. Den hette *Is this your phone?*,
 * men man håller redan telefonen man skannade med, så frågan gick inte att
 * förstå. Nu ger skanningen ett kvitto — en haptik och taggen som poppar fram
 * (`PauseTagBadge`) — och raden säger vad ett ja leder till: lådan säger
 * *HI, <NAMN>* med användarnamnet, samma som lådan själv visar.
 */
export default function PairRoom() {
  return (
    <RoomProvider room="pause">
      <View style={roomShell}>
        <ScreenBackground room="pause" />
        <PairScreen />
      </View>
    </RoomProvider>
  );
}

type Step =
  | { kind: 'enter' }
  | { kind: 'checking' }
  | { kind: 'confirm'; boxName: string }
  | { kind: 'claiming'; boxName: string }
  | { kind: 'done'; alreadyYours: boolean }
  | { kind: 'error'; error: PairError };

function PairScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { user, loading } = useAuth();
  const params = useLocalSearchParams<{ code?: string }>();
  const linkCode = normalizePairCode(typeof params.code === 'string' ? params.code : '');

  const [code, setCode] = useState(linkCode);
  const [step, setStep] = useState<Step>(linkCode ? { kind: 'checking' } : { kind: 'enter' });
  const [name, setName] = useState<string | null>(null);

  // Samma namn som lådan säger hi med (`profiles.username`), som på app/pod.tsx.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    supabase.from('profiles').select('username').eq('id', user.id).maybeSingle()
      .then(({ data }) => { if (alive && data?.username) setName(data.username); });
    return () => { alive = false; };
  }, [user]);
  const hi = name ? `HI, ${name.toUpperCase()}` : 'hi';

  // Utloggad: parkera koden, grinden i _layout tar upp den efter inloggningen.
  useEffect(() => {
    if (loading || user || !linkCode) return;
    setPendingPairCode(linkCode).then(() => router.replace('/auth/login' as never));
  }, [loading, user, linkCode]);

  const check = useCallback(async (value: string) => {
    const c = normalizePairCode(value);
    if (c.length < 6) return;
    setStep({ kind: 'checking' });
    const res = await previewTagPairing(c);
    Haptics.notificationAsync(
      res.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error,
    ).catch(() => {});
    setStep(res.ok ? { kind: 'confirm', boxName: res.boxName } : { kind: 'error', error: res.error });
  }, []);

  useEffect(() => {
    if (!loading && user && linkCode) check(linkCode);
  }, [loading, user, linkCode, check]);

  const confirm = async () => {
    if (step.kind !== 'confirm') return;
    setStep({ kind: 'claiming', boxName: step.boxName });
    const res = await claimTagPairing(normalizePairCode(code));
    if (res.ok) {
      track('pause_tag_paired', { already_yours: res.alreadyYours });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setStep({ kind: 'done', alreadyYours: res.alreadyYours });
    } else {
      setStep({ kind: 'error', error: res.error });
    }
  };

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)' as never);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <DismissKeyboardView style={[styles.container, { paddingTop: Math.max(70, insets.top + 8) }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={leave}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <FontAwesome5 name="arrow-left" size={16} color={Palette.accent} />
        </TouchableOpacity>

        {step.kind === 'enter' && (
          <View style={styles.block}>
            <Text style={styles.title}>Register your tag.</Text>
            <Text style={styles.subtitle}>Enter the code on the box screen.</Text>
            <TextInput
              style={styles.codeInput}
              value={code}
              onChangeText={t => setCode(normalizePairCode(t))}
              placeholder="ABC123"
              placeholderTextColor={Palette.textTertiary}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
              maxLength={10}
              returnKeyType="go"
              onSubmitEditing={() => check(code)}
              accessibilityLabel="Code from the box"
            />
            <PrimaryButton
              label="NEXT"
              disabled={normalizePairCode(code).length < 6}
              onPress={() => check(code)}
              styles={styles}
            />
          </View>
        )}

        {step.kind === 'checking' && (
          <View style={styles.center}>
            <ActivityIndicator color={Palette.accent} />
          </View>
        )}

        {(step.kind === 'confirm' || step.kind === 'claiming') && (
          <View style={styles.block}>
            <View style={styles.badge}>
              <PauseTagBadge checked={false} />
            </View>
            <Text style={[styles.title, styles.centered]}>Tag found.</Text>
            <Text style={[styles.subtitle, styles.centered]}>
              Tag registered in {step.boxName}. Is it yours? 
            </Text>
            <PrimaryButton
              label="IT'S MY PHONE"
              pauseFace
              busy={step.kind === 'claiming'}
              onPress={confirm}
              styles={styles}
            />
            <TouchableOpacity onPress={leave} style={styles.secondary} disabled={step.kind === 'claiming'}>
              <Text style={styles.secondaryText}>Not mine</Text>
            </TouchableOpacity>
          </View>
        )}

        {step.kind === 'done' && (
          <View style={styles.block}>
            <View style={styles.badge}>
              <PauseTagBadge checked />
            </View>
            <Text style={[styles.title, styles.centered]}>
              {step.alreadyYours ? 'Already yours.' : "It's yours."}
            </Text>
            <Text style={[styles.subtitle, styles.centered]}>
              Put your phone back in the box. It will say {hi}.
            </Text>
            <PrimaryButton label="DONE" onPress={() => router.replace('/(tabs)' as never)} styles={styles} />
          </View>
        )}

        {step.kind === 'error' && (
          <View style={styles.block}>
            <Text style={styles.title}>Didn&apos;t work.</Text>
            <Text style={styles.subtitle}>{PAIR_ERROR_TEXT[step.error]}</Text>
            <PrimaryButton
              label="ENTER CODE"
              onPress={() => {
                setCode('');
                setStep({ kind: 'enter' });
              }}
              styles={styles}
            />
          </View>
        )}
      </DismissKeyboardView>
    </KeyboardAvoidingView>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
  pauseFace,
  styles,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** PAUSE-knappens material från Hem i stället för platt accent. */
  pauseFace?: boolean;
  styles: ReturnType<typeof makeStyles>;
}) {
  const Palette = usePalette();
  return (
    <TouchableOpacity
      style={[styles.primary, (disabled || busy) && styles.primaryDisabled]}
      onPress={onPress}
      disabled={disabled || busy}
      activeOpacity={0.85}
      accessibilityRole="button"
    >
      {pauseFace && <PauseButtonFace radius={28} />}
      {busy ? <ActivityIndicator color={Palette.onAccent} /> : <Text style={styles.primaryText}>{label}</Text>}
    </TouchableOpacity>
  );
}

const makeStyles = (Palette: AppPalette) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: 'transparent',
      paddingHorizontal: Spacing.xl,
    },
    backBtn: {
      alignSelf: 'flex-start',
      paddingVertical: 12,
      paddingHorizontal: 12,
      marginBottom: 4,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    block: {
      gap: 12,
    },
    badge: {
      alignSelf: 'center',
      marginBottom: 4,
    },
    centered: {
      textAlign: 'center',
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
      marginBottom: 12,
    },
    codeInput: {
      backgroundColor: Palette.surface,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: Palette.surfaceBorder,
      paddingVertical: 16,
      paddingHorizontal: 16,
      fontSize: 28,
      fontWeight: '900',
      letterSpacing: 6,
      textAlign: 'center',
      color: Palette.textPrimary,
      marginBottom: 8,
    },
    primary: {
      minHeight: 56,
      borderRadius: 999,
      backgroundColor: Palette.accent,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    primaryDisabled: {
      opacity: 0.45,
    },
    primaryText: {
      color: Palette.onAccent,
      fontSize: 15,
      fontWeight: '900',
      letterSpacing: 1.2,
    },
    secondary: {
      alignSelf: 'center',
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    secondaryText: {
      color: Palette.textSecondary,
      fontSize: 15,
    },
  });
