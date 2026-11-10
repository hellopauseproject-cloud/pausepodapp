import { FontAwesome5, Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Linking, Pressable, StyleSheet,
  Text, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OpensPicker, SealedSendOverlay, SEALED_SEND_MS } from '../components/opens-picker';
import { useAuth } from '../contexts/AuthContext';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { uploadSupportMedia } from '../lib/supportMedia';
import { AppPalette, alpha } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';

// Kameran spelar annars in i telefonens förval — 1080p eller 4K på många
// Android-telefoner — och 30 s blev större än Storage tar emot (413,
// EntityTooLarge). 720p i 2,5 Mbit/s ger ~10 MB för en hel inspelning.
// iOS läser bitraten bara när en codec anges i recordAsync, därav 'avc1'.
const VIDEO_QUALITY = '720p';
const VIDEO_BITRATE = 2_500_000;
// Skyddsnät om en telefon ignorerar bitraten: inspelningen stoppas i stället
// för att landa som ett fel först vid Send.
const VIDEO_MAX_BYTES = 40 * 1024 * 1024;

const RING_DOTS = 30;
const RING_R = 50;
const DOT_D = 6;
const RING_SIZE = (RING_R + DOT_D / 2 + 2) * 2;

function CountdownRing({ countdown }: { countdown: number }) {
  const Palette = usePalette();
  const cx = RING_SIZE / 2;
  const cy = RING_SIZE / 2;
  return (
    <View style={{ width: RING_SIZE, height: RING_SIZE, position: 'absolute' }}>
      {Array.from({ length: RING_DOTS }, (_, i) => {
        const angle = (i / RING_DOTS) * 2 * Math.PI - Math.PI / 2;
        const x = cx + RING_R * Math.cos(angle) - DOT_D / 2;
        const y = cy + RING_R * Math.sin(angle) - DOT_D / 2;
        const active = i >= RING_DOTS - countdown;
        return (
          <View key={i} style={{
            position: 'absolute', left: x, top: y,
            width: DOT_D, height: DOT_D, borderRadius: DOT_D / 2,
            backgroundColor: active ? Palette.danger : Palette.ink12,
          }} />
        );
      })}
    </View>
  );
}

type Phase = 'preview' | 'recording' | 'reviewing' | 'uploading' | 'sent';

export default function SupportRespondVideoScreen() {
  const Palette = usePalette();
  const st = useMemo(() => makeSt(Palette), [Palette]);
  const { user } = useAuth();
  const { storyId, ownerName } = useLocalSearchParams<{ storyId: string; ownerName: string }>();
  const [sealed, setSealed] = useState(false);
  const insets = useSafeAreaInsets();

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const permissionsReady = !!(cameraPermission?.granted && micPermission?.granted);
  const cameraDenied = cameraPermission?.canAskAgain === false;
  const micDenied = micPermission?.canAskAgain === false;

  const [phase, setPhase] = useState<Phase>('preview');
  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [recordedUri, setRecordedUri] = useState<string | null>(null);
  const [videoEnded, setVideoEnded] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [countdown, setCountdown] = useState(30);
  const countdownRef = useRef(30);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cameraRef = useRef<CameraView>(null);

  // Be om kamerabehörighet direkt
  useEffect(() => {
    if (!cameraPermission) return;
    if (!cameraPermission.granted && cameraPermission.canAskAgain) {
      requestCameraPermission();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraPermission?.status]);

  // Be om mikrofonbehörighet när kamera är klar
  useEffect(() => {
    if (!cameraPermission?.granted) return;
    if (!micPermission) return;
    if (!micPermission.granted && micPermission.canAskAgain) {
      requestMicPermission();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraPermission?.granted, micPermission?.status]);

  const player = useVideoPlayer(
    phase === 'reviewing' && recordedUri ? { uri: recordedUri } : null,
    p => {
      p.loop = false;
      if (recordedUri) p.play();
    }
  );

  // Lyssna på när videon är klar → visa replay-indikator
  useEffect(() => {
    if (phase !== 'reviewing') return;
    const sub = player.addListener('playToEnd', () => setVideoEnded(true));
    return () => sub.remove();
  }, [player, phase]);

  // replay() och inte seekTo(): den senare finns inte på expo-videos VideoPlayer
  // (det är expo-audios API, se voice.tsx) och kastade TypeError när knappen
  // trycktes. Den egna play() behövs inte heller — replay() gör seek + play i
  // native på båda plattformarna, trots att typdeklarationen bara nämner seek.
  const handleReplay = () => {
    setVideoEnded(false);
    player.replay();
  };

  if (!permissionsReady) {
    const permanentlyDenied = cameraDenied || micDenied;
    const deniedWhat = cameraDenied ? 'Camera' : 'Microphone';
    return (
      <View style={[st.permContainer, { paddingBottom: insets.bottom + 24 }]}>
        <FontAwesome5 name="video" size={36} color={alpha(Palette.community, 0.5)} />
        {permanentlyDenied ? (
          <>
            <Text style={st.permText}>
              {deniedWhat} access was denied.{'\n'}Enable it in Settings → Apps → Privacy.
            </Text>
            <Pressable style={st.permBtn} onPress={() => Linking.openSettings()}>
              <Text style={st.permBtnText}>Open settings</Text>
            </Pressable>
          </>
        ) : cameraPermission?.granted ? (
          <>
            <Text style={st.permText}>Allow microphone access to record video.</Text>
            <Pressable style={st.permBtn} onPress={() => requestMicPermission()}>
              <Text style={st.permBtnText}>Allow microphone</Text>
            </Pressable>
          </>
        ) : (
          <Text style={st.permText}>Requesting camera permission…</Text>
        )}
        <Pressable onPress={() => router.back()} style={[st.closeBtn, { top: insets.top + 12 }]}>
          <FontAwesome5 name="chevron-left" size={15} color="#fff" />
        </Pressable>
      </View>
    );
  }

  const stopRecording = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    cameraRef.current?.stopRecording();
  };

  const startRecording = async () => {
    if (!cameraRef.current) return;
    setPhase('recording');
    setErrorMsg('');
    setCountdown(30);
    countdownRef.current = 30;
    timerRef.current = setInterval(() => {
      countdownRef.current -= 1;
      setCountdown(countdownRef.current);
      if (countdownRef.current <= 0) {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        cameraRef.current?.stopRecording();
      }
    }, 1000);
    try {
      const result = await cameraRef.current.recordAsync({
        maxDuration: 30, maxFileSize: VIDEO_MAX_BYTES, codec: 'avc1',
      });
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (result?.uri) {
        setRecordedUri(result.uri);
        setVideoEnded(false);
        setPhase('reviewing');
      } else {
        setPhase('preview');
      }
    } catch {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setPhase('preview');
    }
  };

  const handleSend = async () => {
    if (!user || !recordedUri || !storyId) return;
    setPhase('uploading');
    try { player.pause(); } catch {}
    try {
      const path = `${user.id}/${Date.now()}.mp4`;
      const contentUrl = await uploadSupportMedia(recordedUri, path, 'video/mp4');

      const { error: dbError } = await supabase.from('support_responses').insert({
        story_id: storyId,
        sender_id: user.id,
        response_type: 'video',
        content_url: contentUrl,
        // Försluten tills mottagaren gjort en paus (supabase/support_sealed.sql).
        // Bara när den är vald, så att *Now* fungerar mot en databas utan kolumnen.
        ...(sealed ? { opens_after_pause: true } : {}),
      });
      if (dbError) throw dbError;

      track('support_response_sent', { response_type: 'video', sealed });
      setPhase('sent');
      setTimeout(() => router.back(), sealed ? SEALED_SEND_MS : 900);
    } catch (e: any) {
      const msg: string = e?.message ?? JSON.stringify(e);
      setErrorMsg(/413|EntityTooLarge/.test(msg)
        ? 'The video is too large to send. Try a shorter one.'
        : 'Upload error: ' + msg);
      setPhase('reviewing');
    }
  };

  const handleReRecord = () => {
    try { player.pause(); } catch {}
    setRecordedUri(null);
    setVideoEnded(false);
    setPhase('preview');
  };

  // Nedre padding = safe area + extra luft
  const bottomPad = insets.bottom + 32;

  return (
    <View style={st.container}>
      <TouchableOpacity
        onPress={() => router.back()}
        style={[st.closeBtn, { top: insets.top + 12 }]}
        activeOpacity={0.7}
      >
        <FontAwesome5 name="chevron-left" size={15} color="#fff" />
      </TouchableOpacity>

      <Text style={[st.title, { top: insets.top + 16 }]}>Support for {ownerName}</Text>

      {phase === 'preview' && (
        <TouchableOpacity
          onPress={() => setFacing(f => f === 'front' ? 'back' : 'front')}
          style={[st.flipBtn, { top: insets.top + 12 }]}
          activeOpacity={0.7}
        >
          <Ionicons name="camera-reverse-outline" size={22} color="#fff" />
        </TouchableOpacity>
      )}

      {(phase === 'preview' || phase === 'recording') ? (
        <CameraView ref={cameraRef} style={st.camera} facing={facing} mode="video"
          videoQuality={VIDEO_QUALITY} videoBitrate={VIDEO_BITRATE}
        />
      ) : phase === 'reviewing' && recordedUri ? (
        <View style={st.camera}>
          <VideoView style={StyleSheet.absoluteFill} player={player} nativeControls={false} />
          {/* Replay-overlay när videon är färdig */}
          {videoEnded && (
            <TouchableOpacity style={st.replayOverlay} onPress={handleReplay} activeOpacity={0.8}>
              <View style={st.replayBtn}>
                <FontAwesome5 name="play" size={26} color="#fff" />
              </View>
              <Text style={st.replayLabel}>Watch again</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <View style={st.camera} />
      )}

      <View style={[st.controls, { paddingBottom: bottomPad }]}>
        {(phase === 'preview' || phase === 'recording') && (
          <>
            {phase === 'preview' && <Text style={st.hint}>Tap to record</Text>}
            <View style={{ width: RING_SIZE, height: RING_SIZE, alignItems: 'center', justifyContent: 'center' }}>
              {phase === 'recording' && <CountdownRing countdown={countdown} />}
              <TouchableOpacity
                style={[st.recordBtn, phase === 'recording' && st.recordBtnActive]}
                onPress={phase === 'recording' ? stopRecording : startRecording}
                activeOpacity={0.85}
              >
                <FontAwesome5 name={phase === 'recording' ? 'stop' : 'circle'} size={28} color="#fff" />
              </TouchableOpacity>
            </View>
          </>
        )}

        {phase === 'reviewing' && (
          <OpensPicker sealed={sealed} onChange={setSealed} ownerName={ownerName ?? ''} onDark />
        )}
        {phase === 'reviewing' && (
          <View style={st.reviewActions}>
            <TouchableOpacity style={st.reRecordBtn} onPress={handleReRecord} activeOpacity={0.75}>
              <FontAwesome5 name="redo" size={13} color={Palette.ink70} />
              <Text style={st.reRecordText}>Record again</Text>
            </TouchableOpacity>
            <TouchableOpacity style={st.sendBtn} onPress={handleSend} activeOpacity={0.85}>
              <FontAwesome5 name="paper-plane" size={13} color="#fff" />
              <Text style={st.sendBtnText}>Send</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase === 'uploading' && (
          <View style={{ alignItems: 'center', gap: 12 }}>
            <ActivityIndicator color={Palette.community} size="large" />
            <Text style={st.hint}>Uploading…</Text>
          </View>
        )}

        {phase === 'sent' && (
          <View style={{ alignItems: 'center', gap: 12 }}>
            <View style={st.sentIcon}>
              <FontAwesome5 name="check" size={24} color="#fff" />
            </View>
            <Text style={st.hint}>Sent!</Text>
          </View>
        )}

        {!!errorMsg && (
          <View style={st.errorBox}>
            <Text style={st.errorText}>{errorMsg}</Text>
          </View>
        )}
      </View>
      {phase === 'sent' && sealed && <SealedSendOverlay />}
    </View>
  );
}

// Den här skärmen byter aldrig läge. Bakgrunden är kamerabilden, inte en yta
// appen målar, och allt som ligger ovanpå den (svart botten bakom, vit
// chrome framför) måste stå kvar mot en bild vi inte känner färgen på. Ett
// ljust tema hade gett vit text på video. Därför är literalerna här med flit
// literaler — det är inte färger som glömdes bort i temaomläggningen.
const makeSt = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  closeBtn: { position: 'absolute', left: 16, zIndex: 10, padding: 14 },
  flipBtn: { position: 'absolute', right: 20, zIndex: 10, padding: 10 },
  title: {
    position: 'absolute', alignSelf: 'center', zIndex: 10,
    color: '#fff', fontSize: 15, fontWeight: '600',
  },
  camera: { flex: 1 },
  controls: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: 32,
    alignItems: 'center', gap: 16,
    backgroundColor: Palette.scrim,
    paddingTop: 20,
  },
  hint: { color: Palette.ink70, fontSize: 14 },
  recordBtn: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: Palette.community, alignItems: 'center', justifyContent: 'center',
    borderWidth: 4, borderColor: Palette.ink30,
  },
  recordBtnActive: { backgroundColor: Palette.danger },
  reviewActions: { flexDirection: 'row', gap: 16, width: '100%' },
  // Spegling av röstskärmens par: samma höjd, radie och ikonstorlek, så de två
  // svarsflödena känns som samma skydd mot en inspelning man inte vill skicka.
  // Tonerna är däremot ett steg starkare (ink15/ink40/ink70 mot ink04/ink10/ink50):
  // här ligger knappen ovanpå en kamerabild bakom en scrim, inte mot appens botten,
  // och röstskärmens spökknapp hade försvunnit i bilden. Samma toner som
  // replayBtn och hint i den här filen redan använder över video.
  reRecordBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 28,
    borderWidth: 1, borderColor: Palette.ink40,
    backgroundColor: Palette.ink15,
  },
  reRecordText: { color: Palette.ink70, fontSize: 14, fontWeight: '600' },
  sendBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 28, backgroundColor: Palette.community,
  },
  sendBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  sentIcon: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: Palette.success, alignItems: 'center', justifyContent: 'center',
  },
  errorBox: {
    backgroundColor: alpha(Palette.danger, 0.12), borderRadius: 12,
    borderWidth: 1, borderColor: alpha(Palette.danger, 0.3),
    padding: 12, width: '100%',
  },
  errorText: { color: Palette.danger, fontSize: 13, textAlign: 'center', lineHeight: 18 },

  // Replay overlay
  replayOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Palette.scrim,
    alignItems: 'center', justifyContent: 'center', gap: 12,
  },
  replayBtn: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: Palette.ink15,
    borderWidth: 2, borderColor: Palette.ink40,
    alignItems: 'center', justifyContent: 'center',
  },
  replayLabel: { color: Palette.ink70, fontSize: 15 },

  permContainer: {
    flex: 1, backgroundColor: Palette.bg,
    alignItems: 'center', justifyContent: 'center',
    padding: 40, gap: 20,
  },
  permText: {
    color: Palette.ink70, fontSize: 16,
    textAlign: 'center', lineHeight: 24,
  },
  permBtn: {
    backgroundColor: Palette.community, paddingVertical: 14, paddingHorizontal: 36,
    borderRadius: 28, marginTop: 8,
  },
  permBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
