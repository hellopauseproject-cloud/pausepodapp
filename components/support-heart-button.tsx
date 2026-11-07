import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { AppPalette, Radius, alpha } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { thankSupportResponse } from '../lib/supportThanks';

/**
 * *Send a heart back* på de fyra visningsskärmarna för stödsvar (text, foto,
 * röst, video). Ett tryck fyller hjärtat och ett till tömmer det, som hjärtat
 * efter en delad paus — så länge avsändaren inte hunnit se det (SQL:en
 * vägrar annars, och knappen står kvar fylld).
 *
 * Hjärtats kulör är `dangerSoft`, samma rosa som pausens hjärta: ett hjärta
 * läses bara som ett hjärta i den färgen. `onDark` är för videoskärmen, som
 * har svart botten oavsett läge.
 */
export function SupportHeartButton({ responseId, senderName, onDark = false }: {
  responseId: string | null | undefined;
  senderName: string;
  onDark?: boolean;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette, onDark), [Palette, onDark]);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const pop = useRef(new Animated.Value(1)).current;
  const firstName = senderName.split(' ')[0];

  if (!responseId) return null;

  const toggle = async () => {
    if (busy) return;
    const next = !sent;
    setBusy(true);
    setSent(next);
    if (next) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      pop.setValue(0.6);
      Animated.spring(pop, { toValue: 1, friction: 3, tension: 160, useNativeDriver: true }).start();
    }
    const ok = await thankSupportResponse(responseId, next);
    // Gick det inte (t.ex. redan sett) står knappen som den var.
    if (!ok) setSent(!next);
    setBusy(false);
  };

  return (
    <TouchableOpacity
      style={[styles.btn, sent && styles.btnOn]}
      onPress={toggle}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityState={{ selected: sent }}
      accessibilityLabel={sent ? `Heart sent to ${firstName}. Tap to take it back.` : `Send a heart back to ${firstName}`}
    >
      <Animated.View style={{ transform: [{ scale: pop }] }}>
        <FontAwesome5 name="heart" size={15} solid={sent} color={sent ? Palette.onAccent : Palette.dangerSoft} />
      </Animated.View>
      <Text style={[styles.text, sent && styles.textOn]}>
        {sent ? `Heart sent to ${firstName}` : 'Send a heart back'}
      </Text>
    </TouchableOpacity>
  );
}

const makeStyles = (Palette: AppPalette, onDark: boolean) => StyleSheet.create({
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    alignSelf: 'center',
    paddingVertical: 12, paddingHorizontal: 22, borderRadius: Radius.pill,
    borderWidth: 1.5, borderColor: alpha(Palette.dangerSoft, 0.6),
    backgroundColor: alpha(Palette.dangerSoft, onDark ? 0.14 : 0.1),
  },
  btnOn: { backgroundColor: Palette.dangerSoft, borderColor: Palette.dangerSoft },
  text: { fontSize: 15, fontWeight: '700', color: onDark ? '#ffffff' : Palette.textPrimary },
  textOn: { color: Palette.onAccent },
});
