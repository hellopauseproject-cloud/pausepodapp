import { FontAwesome5 } from '@expo/vector-icons';
import { RecordingPresets, getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder } from 'expo-audio';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Linking, StyleSheet,
  Text, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OpensPicker, SealedSendOverlay, SEALED_SEND_MS } from '../components/opens-picker';
import { useAuth } from '../contexts/AuthContext';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { uploadSupportMedia } from '../lib/supportMedia';
import { AppPalette, alpha } from '../constants/appTheme';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../components/screen-background';

type Phase = 'idle' | 'recording' | 'reviewing' | 'uploading' | 'sent';

// iOS vägrar spela in om ljudsessionen inte är satt till det först: recorder.record()
// kastar RecordingDisabledException, och felet nämner inte att det är appens eget
// audio-läge som saknas. Android bryr sig inte, men anropet är ofarligt där.
// Läget måste också tillbaka efteråt — med allowsRecording kvar står iOS i
// PlayAndRecord, och uppspelningen av det inspelade går ut genom hörluren i
// stället för högtalaren, alltså nästan ohörbart.
const RECORDING_AUDIO_MODE = { allowsRecording: true, playsInSilentMode: true } as const;
const PLAYBACK_AUDIO_MODE = { allowsRecording: false, playsInSilentMode: true } as const;

/**
 * Hör till **friends-rummet**. Rummet följer ärendet och inte filträdet — se
 * ROOMS i [constants/appTheme.ts](../constants/appTheme.ts). Skalet är
 * identiskt med de andra rummens: en komponent kan inte läsa sin egen
 * provider, och en bakgrund i skalet täcker varje gren skärmen returnerar.
 */
export default function SupportRespondVoiceRoom() {
  return (
    <RoomProvider room="friends">
      <View style={roomShell}>
        <ScreenBackground room="friends" />
        <SupportRespondVoiceScreen />
      </View>
    </RoomProvider>
  );
}

function SupportRespondVoiceScreen() {
  const Palette = usePalette();
  const st = useMemo(() => makeSt(Palette), [Palette]);
  const { user } = useAuth();
  const { storyId, ownerName } = useLocalSearchParams<{ storyId: string; ownerName: string }>();
  const [sealed, setSealed] = useState(false);
  const insets = useSafeAreaInsets();

  const [permDeniedPerm, setPermDeniedPerm] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [phase, setPhase] = useState<Phase>('idle');
  const [recordedUri, setRecordedUri] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationRef = useRef(0);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);

  const player = useAudioPlayer(recordedUri ? { uri: recordedUri } : null);
  const playerStatus = useAudioPlayerStatus(player);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      try { player.pause(); } catch {}
      // Lämna inte sessionen i inspelningsläge efter oss: nästa skärm som spelar
      // upp något (ringsignalen i call.tsx) skulle då få den i hörluren.
      setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => {});
    };
  }, []);

  const startRecording = async () => {
    setErrorMsg('');
    try {
      // Kolla nuläget utan att visa dialog
      const current = await getRecordingPermissionsAsync();
      if (!current.granted) {
        if (!current.canAskAgain) {
          setPermDeniedPerm(true);
          return;
        }
        const result = await requestRecordingPermissionsAsync();
        if (!result.granted) {
          if (!result.canAskAgain) setPermDeniedPerm(true);
          return;
        }
      }
    } catch { /* fortsätt ändå, låt prepareToRecordAsync kasta om det behövs */ }

    try {
      await setAudioModeAsync(RECORDING_AUDIO_MODE);
      await recorder.prepareToRecordAsync();
      recorder.record();
      setPhase('recording');
      setDuration(0);
      durationRef.current = 0;
      timerRef.current = setInterval(() => {
        durationRef.current += 1;
        setDuration(durationRef.current);
        if (durationRef.current >= 59) {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
          stopRecording();
        }
      }, 1000);

      pulseLoop.current = Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.25, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]));
      pulseLoop.current.start();
    } catch (e: any) {
      await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => {});
      setErrorMsg('Could not start recording: ' + (e?.message ?? 'unknown error'));
    }
  };

  const stopRecording = async () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    pulseLoop.current?.stop();
    pulseAnim.setValue(1);
    try {
      await recorder.stop();
      await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => {});
      const uri = recorder.uri;
      if (uri) {
        setRecordedUri(uri);
        setPhase('reviewing');
      } else {
        setErrorMsg('Recording failed — no file was created.');
        setPhase('idle');
      }
    } catch (e: any) {
      await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => {});
      setErrorMsg('Stop error: ' + (e?.message ?? 'unknown error'));
      setPhase('idle');
    }
  };

  const handleSend = async () => {
    if (!user || !recordedUri || !storyId) return;
    setPhase('uploading');
    try { player.pause(); } catch {}

    try {
      const path = `${user.id}/${Date.now()}.m4a`;
      const contentUrl = await uploadSupportMedia(recordedUri, path, 'audio/m4a');

      const { error: dbError } = await supabase.from('support_responses').insert({
        story_id: storyId,
        sender_id: user.id,
        response_type: 'voice',
        content_url: contentUrl,
        // Försluten tills mottagaren gjort en paus (supabase/support_sealed.sql).
        // Bara när den är vald, så att *Now* fungerar mot en databas utan kolumnen.
        ...(sealed ? { opens_after_pause: true } : {}),
      });
      if (dbError) throw dbError;

      track('support_response_sent', { response_type: 'voice', sealed });
      setPhase('sent');
      setTimeout(() => router.back(), sealed ? SEALED_SEND_MS : 900);
    } catch (e: any) {
      setErrorMsg('Upload error: ' + (e?.message ?? JSON.stringify(e)));
      setPhase('reviewing');
    }
  };

  const handleReRecord = () => {
    try { player.pause(); } catch {}
    setRecordedUri(null);
    setDuration(0);
    setPhase('idle');
  };

  const togglePlay = () => {
    if (playerStatus.playing) player.pause();
    else player.play();
  };

  const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // Permission nekad permanent
  if (permDeniedPerm) {
    return (
      <View style={[st.container, { paddingBottom: insets.bottom + 24 }]}>
        <View style={st.header}>
          <TouchableOpacity onPress={() => router.back()} style={st.closeBtn} activeOpacity={0.7}>
            <FontAwesome5 name="chevron-left" size={15} color={Palette.accent} />
          </TouchableOpacity>
          <Text style={st.title}>Support for {ownerName}</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={st.mainArea}>
          <FontAwesome5 name="microphone-slash" size={40} color={alpha(Palette.community, 0.4)} />
          <Text style={st.permText}>
            Microphone access was denied.{'\n'}Enable it in Settings → Apps → Privacy.
          </Text>
          <TouchableOpacity style={st.sendBtn} onPress={() => Linking.openSettings()} activeOpacity={0.85}>
            <Text style={st.sendBtnText}>Open settings</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[st.container, { paddingBottom: insets.bottom + 24 }]}>
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.closeBtn} activeOpacity={0.7}>
          <FontAwesome5 name="chevron-left" size={15} color={Palette.accent} />
        </TouchableOpacity>
        <Text style={st.title}>Support for {ownerName}</Text>
        <View style={{ width: 40 }} />
      </View>

      <Text style={st.subtitle}>Max 60 seconds.</Text>

      <View style={st.mainArea}>
        {phase === 'idle' && (
          <>
            <TouchableOpacity style={st.recordBtn} onPress={startRecording} activeOpacity={0.85}>
              <FontAwesome5 name="microphone" size={36} color={Palette.onAccent} />
            </TouchableOpacity>
            <Text style={st.hintText}>Tap to start recording</Text>
          </>
        )}

        {phase === 'recording' && (
          <>
            <Animated.View style={[st.recordingRing, { transform: [{ scale: pulseAnim }] }]}>
              <TouchableOpacity style={st.recordBtn} onPress={stopRecording} activeOpacity={0.85}>
                <FontAwesome5 name="stop" size={28} color={Palette.onAccent} />
              </TouchableOpacity>
            </Animated.View>
            <Text style={st.durationText}>{fmtDur(duration)}</Text>
            <Text style={st.hintText}>Tap to stop</Text>
          </>
        )}

        {phase === 'reviewing' && (
          <View style={st.reviewArea}>
            <Text style={st.durationText}>{fmtDur(duration)}</Text>
            <View style={st.reviewBtns}>
              <TouchableOpacity style={st.playBtn} onPress={togglePlay} activeOpacity={0.85}>
                <FontAwesome5 name={playerStatus.playing ? 'pause' : 'play'} size={22} color={Palette.onAccent} />
              </TouchableOpacity>
            </View>
            <OpensPicker sealed={sealed} onChange={setSealed} ownerName={ownerName ?? ''} />
            <View style={st.reviewActions}>
              <TouchableOpacity style={st.reRecordBtn} onPress={handleReRecord} activeOpacity={0.75}>
                <FontAwesome5 name="redo" size={13} color={Palette.ink50} />
                <Text style={st.reRecordText}>Record again</Text>
              </TouchableOpacity>
              <TouchableOpacity style={st.sendBtn} onPress={handleSend} activeOpacity={0.85}>
                <FontAwesome5 name="paper-plane" size={13} color={Palette.onAccent} />
                <Text style={st.sendBtnText}>Send</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {phase === 'uploading' && (
          <>
            <ActivityIndicator color={Palette.community} size="large" />
            <Text style={st.hintText}>Uploading…</Text>
          </>
        )}

        {phase === 'sent' && (
          <>
            <View style={st.sentIcon}>
              <FontAwesome5 name="check" size={28} color={Palette.onAccent} />
            </View>
            <Text style={st.hintText}>Sent!</Text>
          </>
        )}
      </View>

      {!!errorMsg && (
        <View style={st.errorBox}>
          <Text style={st.errorText}>{errorMsg}</Text>
        </View>
      )}
      {phase === 'sent' && sealed && <SealedSendOverlay />}
    </View>
  );
}

const makeSt = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1, backgroundColor: 'transparent',
    paddingHorizontal: 24, paddingTop: 60, gap: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  closeBtn: { width: 44, height: 44, justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '700', color: Palette.textPrimary, letterSpacing: 0.2 },
  subtitle: { fontSize: 14, color: Palette.textTertiary, textAlign: 'center', marginBottom: 12 },
  mainArea: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 },
  permText: { fontSize: 15, color: Palette.textSecondary, textAlign: 'center', lineHeight: 24 },
  recordBtn: {
    width: 100, height: 100, borderRadius: 50,
    backgroundColor: Palette.community, alignItems: 'center', justifyContent: 'center',
    shadowColor: Palette.community, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  recordingRing: {
    width: 130, height: 130, borderRadius: 65,
    backgroundColor: Palette.communityTint,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: alpha(Palette.community, 0.3),
  },
  durationText: { fontSize: 48, fontWeight: '800', color: Palette.textPrimary, letterSpacing: -1 },
  hintText: { fontSize: 14, color: Palette.ink35, textAlign: 'center' },
  reviewArea: { alignItems: 'center', gap: 24, width: '100%' },
  reviewBtns: { flexDirection: 'row', gap: 16 },
  playBtn: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: alpha(Palette.community, 0.2), borderWidth: 1.5, borderColor: Palette.community,
    alignItems: 'center', justifyContent: 'center',
  },
  reviewActions: { flexDirection: 'row', gap: 16, width: '100%' },
  reRecordBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 28,
    borderWidth: 1, borderColor: Palette.ink10,
    backgroundColor: Palette.ink04,
  },
  reRecordText: { color: Palette.ink50, fontSize: 14, fontWeight: '600' },
  sendBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 28, backgroundColor: Palette.community,
  },
  sendBtnText: { color: Palette.onAccent, fontSize: 14, fontWeight: '700' },
  sentIcon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: Palette.success, alignItems: 'center', justifyContent: 'center',
  },
  errorBox: {
    backgroundColor: alpha(Palette.danger, 0.12), borderRadius: 12,
    borderWidth: 1, borderColor: alpha(Palette.danger, 0.3),
    padding: 12, marginBottom: 8,
  },
  errorText: { color: Palette.danger, fontSize: 14, textAlign: 'center', lineHeight: 19 },
});
