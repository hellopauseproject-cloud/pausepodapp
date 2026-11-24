import { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { PausePodLogo } from './pause-pod-logo';
import { roomShell, ScreenBackground } from './screen-background';
import { TermsCheckbox } from './terms-checkbox';

/**
 * Användarvillkoren för den som redan har ett konto men inte godkänt dem —
 * alla som fanns före kryssrutan, och den som loggat in med Google eller
 * Apple från inloggningssidan. En gång, och sedan aldrig mer
 * (`profiles.terms_accepted_at`, supabase/moderation.sql).
 *
 * **Ett lager över allt, inte en rutt.** Det ritas i app/_layout.tsx ovanpå
 * stacken, så att varken introduktionen, ett notistryck eller en djuplänk
 * kan gå förbi det — det går inte att dela något utan att ha godkänt.
 *
 * Utvägen är *Log out*, inte ett kryss: den som inte vill godkänna ska inte
 * hamna i en app den inte får använda.
 */
export function TermsGate() {
  return (
    <RoomProvider room="pause">
      <View style={[StyleSheet.absoluteFill, roomShell]}>
        <ScreenBackground room="pause" />
        <TermsGateScreen />
      </View>
    </RoomProvider>
  );
}

function TermsGateScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { acceptTerms, signOut } = useAuth();
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!checked || saving) return;
    setSaving(true);
    setError('');
    try {
      await acceptTerms();
    } catch (e: any) {
      setError(e?.message ?? 'Could not save. Try again.');
      setSaving(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 32 }]}>
      <PausePodLogo color={Palette.accent} />
      <View style={styles.body}>
        <Text style={styles.title}>Terms of Use</Text>
        <Text style={styles.text}>
          PausePod is a place for friends and circles. To keep using it, please read and agree to our Terms of Use.
        </Text>
        <TermsCheckbox checked={checked} onChange={setChecked} />
        {!!error && <Text style={styles.error}>{error}</Text>}
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, (!checked || saving) && styles.buttonOff]}
          onPress={save}
          disabled={!checked || saving}
          activeOpacity={0.85}
          accessibilityRole="button"
        >
          {saving
            ? <ActivityIndicator color={Palette.onAccent} />
            : <Text style={styles.buttonText}>Continue</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={signOut} style={styles.logout} activeOpacity={0.7} accessibilityRole="button">
          <Text style={styles.logoutText}>Log out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, paddingHorizontal: Spacing.xl, justifyContent: 'space-between' },
  body: { gap: Spacing.lg },
  title: { fontSize: 32, fontWeight: '800', color: Palette.textPrimary, letterSpacing: 0.2 },
  text: { fontSize: 16, lineHeight: 23, color: Palette.textSecondary },
  error: { fontSize: 14, color: Palette.danger },
  actions: { gap: Spacing.sm },
  button: {
    height: 52, borderRadius: Radius.pill, backgroundColor: Palette.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  buttonOff: { opacity: 0.45 },
  buttonText: { color: Palette.onAccent, fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  logout: { alignSelf: 'center', paddingVertical: Spacing.md, paddingHorizontal: Spacing.xl },
  logoutText: { fontSize: 15, color: Palette.textTertiary },
});
