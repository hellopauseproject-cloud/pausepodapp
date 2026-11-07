import { FontAwesome } from '@expo/vector-icons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { setAudioModeAsync } from 'expo-audio';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openPauseStart } from '../lib/pauseFlow';
import { supabase } from '../lib/supabase';
import { clearPending, getPending } from '../lib/supportQueue';
import { AppPalette, Radius } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { SupportHeartButton } from '../components/support-heart-button';

export default function VideoScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const [showPauseLink, setShowPauseLink] = useState(false);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [noFile, setNoFile] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const [callerName, setCallerName] = useState<string | null>(null);
  const fadeAnim = useState(new Animated.Value(0))[0];
  const supportResponseIdRef = useRef<string | null>(null);
  // Hjärtat behöver id:t efter att ref:en nollats vid stängning.
  const [responseId, setResponseId] = useState<string | null>(null);

  // Ingen upplyftningston, ingen egen kamerabild i hörnet och ingen röd lur:
  // videosvaret såg ut som ett FaceTime-samtal (och krävde kamerabehörighet
  // för att alls visas), vilket kändes påträngande. Nu är det en video man
  // fått, som öppnas ur kuvertet i support-arrived.tsx.
  const videoEndedRef = useRef(false);

  useEffect(() => {
    const setup = async () => {
      const pending = getPending();

      // Support video response: play from URL
      if (pending?.responseType === 'video' && pending.contentUrl) {
        supportResponseIdRef.current = pending.id;
        setResponseId(pending.id);
        setCallerName(pending.senderName);
        setVideoUri(pending.contentUrl);
        setVideoReady(true);
        clearPending();
        await setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix', shouldRouteThroughEarpiece: false });
        return;
      }

      setNoFile(true);
      setVideoReady(true);
    };
    setup();

    const pauseTimer = setTimeout(() => {
      setShowPauseLink(true);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }).start();
    }, 1500);

    return () => clearTimeout(pauseTimer);
  }, []);

  const player = useVideoPlayer(
    videoReady && videoUri ? { uri: videoUri } : null,
    (player) => {
      if (videoReady && videoUri) player.play();
    }
  );

  useEffect(() => {
    if (!videoReady || !videoUri) return;
    videoEndedRef.current = false;
    player.play();
    const subscription = player.addListener('playToEnd', () => {
      videoEndedRef.current = true;
      setShowReplay(true);
    });
    return () => {
      subscription.remove();
    };
  }, [videoReady, videoUri]);

  const handleClose = async () => {
    if (videoUri) player.pause();
    if (supportResponseIdRef.current) {
      const ts = new Date().toISOString();
      await supabase.from('support_responses').update({ delivered_at: ts, played_at: ts }).eq('id', supportResponseIdRef.current);
      supportResponseIdRef.current = null;
    }
    router.replace('/(tabs)/friends' as never);
  };

  const handlePauseLink = async () => {
    if (videoUri) player.pause();
    if (supportResponseIdRef.current) {
      const ts = new Date().toISOString();
      await supabase.from('support_responses').update({ delivered_at: ts, played_at: ts }).eq('id', supportResponseIdRef.current);
      supportResponseIdRef.current = null;
    }
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
      shouldRouteThroughEarpiece: false,
    });
    openPauseStart('push');
  };

  return (
    <View style={styles.container}>
      {/* Video area fills remaining space above controls */}
      {noFile ? (
        <View style={styles.noFilePlaceholder}>
          <Text style={styles.noFileText}>No message to play</Text>
        </View>
      ) : (
        <View style={styles.videoWrapper}>
          <VideoView
            style={styles.video}
            player={player}
            nativeControls={false}
          />
          {showReplay && (
            <TouchableOpacity
              style={styles.replayOverlay}
              onPress={() => {
                player.replay();
                setShowReplay(false);
              }}
            >
              <MaterialIcons name="replay" size={64} color="white" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {!!callerName && (
        <View style={styles.callerOverlay}>
          <Text style={styles.callerOverlayText}>Support from {callerName}</Text>
        </View>
      )}

      {/* Black controls area — pause button top, close below, both centered */}
      <View style={[styles.controlsArea, { paddingBottom: insets.bottom || 20 }]}>
        <SupportHeartButton responseId={responseId} senderName={callerName ?? 'A friend'} onDark />
        {showPauseLink && (
          <Animated.View style={{ opacity: fadeAnim }}>
            <TouchableOpacity style={styles.pauseBtn} onPress={handlePauseLink} activeOpacity={0.85}>
              <FontAwesome name="pause" size={16} color="white" />
              <Text style={styles.pauseBtnText}>TAKE A PAUSE</Text>
            </TouchableOpacity>
          </Animated.View>
        )}
        <TouchableOpacity style={styles.closeBtn} onPress={handleClose} activeOpacity={0.7}>
          <Text style={styles.closeText}>Close</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Den här skärmen byter aldrig läge. Bakgrunden är kamerabilden, inte en yta
// appen målar, och allt som ligger ovanpå den (svart botten bakom, vit
// chrome framför) måste stå kvar mot en bild vi inte känner färgen på. Ett
// ljust tema hade gett vit text på video. Därför är literalerna här med flit
// literaler — det är inte färger som glömdes bort i temaomläggningen.
const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  videoWrapper: {
    flex: 1,
    width: '100%',
  },
  video: {
    width: '100%',
    flex: 1,
  },
  noFilePlaceholder: {
    flex: 1,
    width: '100%',
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlsArea: {
    width: '100%',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingTop: 20,
  },
  noFileText: {
    color: Palette.textSecondary,
    fontSize: 16,
  },
  replayOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Palette.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pauseBtn: {
    backgroundColor: Palette.accent,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: Radius.pill,
    ...Palette.cardShadow,
  },
  pauseBtnText: {
    color: 'white',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 3,
  },
  closeBtn: { paddingVertical: 10, paddingHorizontal: 20 },
  closeText: { color: 'rgba(255,255,255,0.8)', fontSize: 15, fontWeight: '600' },
  callerOverlay: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    backgroundColor: Palette.scrim,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    zIndex: 10,
  },
  callerOverlayText: {
    color: Palette.communitySoft,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
