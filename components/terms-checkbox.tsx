import { FontAwesome5 } from '@expo/vector-icons';
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppPalette, Radius } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { PRIVACY_URL, TERMS_URL } from '../lib/moderation';

export function openTerms(): void {
  openBrowserAsync(TERMS_URL, { presentationStyle: WebBrowserPresentationStyle.AUTOMATIC }).catch(() => {});
}

export function openPrivacyPolicy(): void {
  openBrowserAsync(PRIVACY_URL, { presentationStyle: WebBrowserPresentationStyle.AUTOMATIC }).catch(() => {});
}

/**
 * *I agree to the Terms of Use*, med länken till villkoren. Delad av
 * registreringen (app/auth/signup.tsx) och grinden för den som redan har ett
 * konto (components/terms-gate.tsx), så att det är samma mening på båda.
 *
 * Rutan och texten är en tryckyta; länken är en egen, inuti texten.
 */
export function TermsCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  return (
    <Pressable
      style={styles.row}
      onPress={() => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel="I agree to the Terms of Use"
      hitSlop={6}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked && <FontAwesome5 name="check" size={11} color={Palette.onAccent} />}
      </View>
      <Text style={styles.text}>
        I agree to the{' '}
        <Text style={styles.link} onPress={openTerms} accessibilityRole="link">Terms of Use</Text>
      </Text>
    </Pressable>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  box: {
    width: 22, height: 22, borderRadius: Radius.sm / 2, borderWidth: 2, borderColor: Palette.ink40,
    alignItems: 'center', justifyContent: 'center',
  },
  boxOn: { backgroundColor: Palette.accent, borderColor: Palette.accent },
  text: { flex: 1, fontSize: 15, color: Palette.textSecondary },
  link: { color: Palette.accent, fontWeight: '600', textDecorationLine: 'underline' },
});
