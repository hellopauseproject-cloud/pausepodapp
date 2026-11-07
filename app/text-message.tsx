import { FontAwesome5 } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openPauseStart } from '../lib/pauseFlow';
import { supabase } from '../lib/supabase';
import { AppPalette, Radius } from '../constants/appTheme';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { LETTER_PAPER } from '../components/support-envelope';
import { useHand } from '../lib/handFont';
import { SupportHeartButton } from '../components/support-heart-button';

/**
 * Hör till **friends-rummet**. Rummet följer ärendet och inte filträdet — se
 * ROOMS i [constants/appTheme.ts](../constants/appTheme.ts). Skalet är
 * identiskt med de andra rummens: en komponent kan inte läsa sin egen
 * provider, och en bakgrund i skalet täcker varje gren skärmen returnerar.
 */
export default function TextMessageRoom() {
  return (
    <RoomProvider room="friends">
      <View style={roomShell}>
        <ScreenBackground room="friends" />
        <TextMessageScreen />
      </View>
    </RoomProvider>
  );
}

function TextMessageScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { messageId, textContent, senderName, senderAvatarUrl, isSupport } =
    useLocalSearchParams<{
      messageId?: string;
      textContent?: string;
      senderName?: string;
      senderAvatarUrl?: string;
      isSupport?: string;
    }>();

  const [isSending, setIsSending] = useState(false);
  const sendProgress = useRef(new Animated.Value(0)).current;

  const translateY = sendProgress.interpolate({ inputRange: [0, 1], outputRange: [0, -240] });
  const translateX = sendProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 60] });
  const scale = sendProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.15] });
  const acceptOpacity = sendProgress.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.5, 0] });
  const declineOpacity = sendProgress.interpolate({ inputRange: [0, 0.35, 1], outputRange: [1, 0, 0] });

  const hand = useHand();
  // Brevet fortsätter rörelsen från kuvertet: det glider upp en bit och tonar in.
  const letterIn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(letterIn, { toValue: 1, duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [letterIn]);
  const letterRise = letterIn.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });

  const markDelivered = async () => {
    if (isSupport === 'true' && messageId) {
      const ts = new Date().toISOString();
      await supabase
        .from('support_responses')
        .update({ delivered_at: ts, played_at: ts })
        .eq('id', messageId);
    }
  };

  useEffect(() => {
    if (isSupport === 'true' && messageId) {
      markDelivered();
    }
  }, []);

  const handleAccept = () => {
    if (isSending) return;
    setIsSending(true);
    markDelivered();
    Animated.timing(sendProgress, {
      toValue: 1,
      duration: 550,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      openPauseStart('replace');
    });
  };

  const handleDecline = async () => {
    await markDelivered();
    router.replace('/(tabs)');
  };

  const firstName = (senderName ?? 'A friend').split(' ')[0];

  return (
    <View style={styles.container}>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity style={styles.headerBack} onPress={() => router.back()} accessibilityLabel="Back">
          <FontAwesome5 name="chevron-left" size={15} color={Palette.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Brevet. Samma papper som brevet som gled ur kuvertet
          (LETTER_PAPER i components/support-envelope.tsx), så att det man
          läser är det som just öppnades — inte en sms-tråd. Raderna är
          handskrivna och linjerna ritas med samma steg som texten. */}
      <View style={styles.messageArea}>
        <Animated.View style={[styles.letter, { opacity: letterIn, transform: [{ translateY: letterRise }, { rotate: '-1.2deg' }] }]}>
          <View style={styles.letterHead}>
            {senderAvatarUrl ? (
              <Image source={{ uri: senderAvatarUrl }} style={styles.letterAvatar} />
            ) : (
              <View style={[styles.letterAvatar, styles.letterAvatarFallback]}>
                <Text style={styles.letterAvatarLetter}>{firstName[0]?.toUpperCase() ?? '?'}</Text>
              </View>
            )}
            <Text style={[styles.letterFrom, hand(19, true)]} numberOfLines={1}>From {firstName}</Text>
          </View>
          <ScrollView style={styles.letterBody} contentContainerStyle={{ paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
            <View style={{ overflow: 'hidden' }}>
              <View style={StyleSheet.absoluteFill} pointerEvents="none">
                {Array.from({ length: 40 }, (_, i) => (
                  <View key={i} style={[styles.rule, { top: (i + 1) * LINE - 4 }]} />
                ))}
              </View>
              <Text style={[styles.letterText, hand(18), { lineHeight: LINE }]}>{textContent}</Text>
            </View>
          </ScrollView>
        </Animated.View>
      </View>

      {/* Handlingsval */}
      <View style={[styles.actions, { paddingBottom: insets.bottom + 32 }]}>
        {isSupport === 'true' && (
          <Animated.View style={[styles.heartWrap, { opacity: declineOpacity }]}>
            <SupportHeartButton responseId={messageId} senderName={senderName ?? 'A friend'} />
          </Animated.View>
        )}
        <Animated.View style={{ opacity: acceptOpacity, transform: [{ translateY }, { translateX }, { scale }] }}>
          <TouchableOpacity style={styles.acceptBtn} onPress={handleAccept} activeOpacity={0.85} disabled={isSending}>
            <FontAwesome5 name="pause" size={13} color={Palette.onAccent} />
            <Text style={styles.acceptText}>I'll take a pause</Text>
          </TouchableOpacity>
        </Animated.View>
        <Animated.View style={{ opacity: declineOpacity }}>
          <TouchableOpacity style={styles.declineBtn} onPress={handleDecline} activeOpacity={0.8} disabled={isSending}>
            <Text style={styles.declineText}>Not a good time</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </View>
  );
}

const LINE = 32;

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  topBar: {
    paddingHorizontal: 12,
    flexDirection: 'row',
  },
  headerBack: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageArea: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 16,
    paddingBottom: 24,
    justifyContent: 'center',
  },
  letter: {
    backgroundColor: LETTER_PAPER.paper,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: LETTER_PAPER.edge,
    paddingHorizontal: 22,
    paddingTop: 20,
    paddingBottom: 18,
    maxHeight: '100%',
    gap: 14,
    ...Palette.cardShadow,
  },
  letterHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  letterAvatar: { width: 40, height: 40, borderRadius: 20 },
  letterAvatarFallback: { backgroundColor: 'rgba(201,113,75,0.16)', alignItems: 'center', justifyContent: 'center' },
  letterAvatarLetter: { color: '#c9714b', fontSize: 17, fontWeight: '700' },
  letterFrom: { flex: 1, color: LETTER_PAPER.ink },
  letterBody: { flexGrow: 0 },
  rule: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: LETTER_PAPER.rule },
  letterText: { color: LETTER_PAPER.ink, minHeight: LINE * 4 },
  heartWrap: { marginBottom: 14 },
  actions: {
    paddingHorizontal: 24,
    paddingTop: 8,
    gap: 4,
  },
  acceptBtn: {
    backgroundColor: Palette.accent,
    paddingVertical: 16,
    borderRadius: Radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 4,
    ...Palette.cardShadow,
  },
  acceptText: {
    color: Palette.onAccent,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  declineBtn: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  declineText: {
    color: Palette.textSecondary,
    fontSize: 15,
  },
});
