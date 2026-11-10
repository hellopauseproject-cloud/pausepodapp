import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, TouchableOpacity } from 'react-native';
import { AppPalette } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { hasThankedSupportResponse, thankSupportResponse } from '../lib/supportThanks';

const HEART = 30;
const RING = 56;

/**
 * Hjärtat tillbaka på de fyra visningsskärmarna för stödsvar (text, foto,
 * röst, video). Bara ett tomt hjärta, utan ord (november 2026, på begäran:
 * *Send a heart back* i en kapsel var för mycket). Ett tryck fyller det med
 * ett litet *pop* — hjärtat studsar och en ring i samma rosa slår ut och
 * tonar bort — och ett till tömmer det, som hjärtat efter en delad paus. Det
 * går så länge avsändaren inte hunnit se det (SQL:en vägrar annars, och
 * hjärtat står kvar fyllt). Vad det gör står i `accessibilityLabel`.
 *
 * Hjärtats kulör är `dangerSoft`, samma rosa som pausens hjärta: ett hjärta
 * läses bara som ett hjärta i den färgen. `onDark` finns kvar för
 * videoskärmen, men rosa på svart behöver ingen egen ton.
 */
export function SupportHeartButton({ responseId, senderName }: {
  responseId: string | null | undefined;
  senderName: string;
  onDark?: boolean;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const pop = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const firstName = senderName.split(' ')[0];
  // Ett tryck innan svaret kommit vinner: läsningen får inte skriva över det.
  const touchedRef = useRef(false);

  // Hjärtat minns: öppnas svaret igen (historiken) står det fyllt.
  useEffect(() => {
    if (!responseId) return;
    let alive = true;
    hasThankedSupportResponse(responseId).then(on => {
      if (alive && !touchedRef.current) setSent(on);
    });
    return () => { alive = false; };
  }, [responseId]);

  if (!responseId) return null;

  const playPop = async () => {
    const reduce = await AccessibilityInfo.isReduceMotionEnabled().catch(() => false);
    if (reduce) return;
    pop.setValue(0.55);
    ring.setValue(0);
    Animated.parallel([
      Animated.sequence([
        Animated.timing(pop, { toValue: 1.3, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.spring(pop, { toValue: 1, friction: 4, tension: 180, useNativeDriver: true }),
      ]),
      Animated.timing(ring, { toValue: 1, duration: 480, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  };

  const toggle = async () => {
    if (busy) return;
    const next = !sent;
    touchedRef.current = true;
    setBusy(true);
    setSent(next);
    if (next) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      playPop();
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => {});
    }
    const ok = await thankSupportResponse(responseId, next);
    // Gick det inte (t.ex. redan sett) står hjärtat som det var.
    if (!ok) setSent(!next);
    setBusy(false);
  };

  return (
    <TouchableOpacity
      style={styles.btn}
      onPress={toggle}
      activeOpacity={0.7}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{ selected: sent }}
      accessibilityLabel={sent ? `Heart sent to ${firstName}. Tap to take it back.` : `Send a heart back to ${firstName}`}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.ring, {
          opacity: ring.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.7, 0] }),
          transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.25] }) }],
        }]}
      />
      <Animated.View style={{ transform: [{ scale: pop }] }}>
        <FontAwesome5 name="heart" size={HEART} solid={sent} color={Palette.dangerSoft} />
      </Animated.View>
    </TouchableOpacity>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  btn: {
    alignSelf: 'center', width: RING, height: RING,
    alignItems: 'center', justifyContent: 'center',
  },
  ring: {
    position: 'absolute', width: RING, height: RING, borderRadius: RING / 2,
    borderWidth: 2, borderColor: Palette.dangerSoft,
  },
});
